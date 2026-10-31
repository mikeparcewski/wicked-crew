/**
 * VOICE MODE, PHASE 1 (program DES-VOICE §3): speech to text on THIS machine.
 *
 * Studio records the person's speech in the browser, encodes it as a 16 kHz mono WAV, and posts it to
 * `POST /voice/transcribe`. Crew hands the bytes to whisper.cpp's CLI on stdin (`-f -`) and answers with the
 * text. The audio is held in memory for that one call and dropped: it is never written to disk, never kept with
 * a run, never sent off the machine.
 *
 * Two local pieces, each said plainly in `GET /voice/status`:
 *  - the whisper.cpp CLI (`whisper-cli`): found on PATH, or named by `WICKED_CREW_WHISPER_BIN`. Crew does not
 *    install it; the status names the install command for this platform.
 *  - one model file (`ggml-base.en.bin`, 142 MiB): downloaded ONLY when the person consents
 *    (`POST /voice/model {consent: true}`), checked against its published SHA-1, kept in the voice cache dir
 *    (`WICKED_CREW_VOICE_DIR`, default the OS cache dir). Not under the state home: the worker fence classifies
 *    every top-level entry there, and a model directory is not one of them.
 *
 * One transcription runs at a time and one may wait; a third is refused with 429 `voice_busy` (a streaming
 * partial just skips that beat).
 */

import { spawn as nodeSpawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { homedir, platform as osPlatform } from 'node:os';
import { delimiter, join } from 'node:path';

/** The one model phase 1 ships with. Published by whisper.cpp (models/README.md: 142 MiB, this SHA-1). */
export const VOICE_MODEL: Readonly<VoiceModel> = Object.freeze({
  name: 'base.en',
  file: 'ggml-base.en.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
  sha1: '137c40403d78fd54d454da0f9bd998f78703390c',
  /** What the consent says before anything is fetched. */
  approxBytes: 142 * 1024 * 1024,
  source: 'huggingface.co/ggerganov/whisper.cpp',
});

/** A WAV over this is refused (about 4 minutes of 16 kHz mono 16-bit speech). */
export const VOICE_MAX_AUDIO_BYTES = 8 * 1024 * 1024;
/** One transcription that runs longer than this is killed and answered 504. */
export const TRANSCRIBE_TIMEOUT_MS = 60_000;
/** Threads whisper.cpp may use (the host runs seats and checks too). */
export const TRANSCRIBE_THREADS = 4;

export type VoiceErrorCode =
  | 'voice_engine_missing'
  | 'voice_engine_outdated'
  | 'voice_model_missing'
  | 'voice_audio_invalid'
  | 'voice_audio_too_large'
  | 'voice_busy'
  | 'voice_timeout'
  | 'voice_failed'
  | 'voice_consent_required'
  | 'voice_download_running'
  | 'voice_download_failed';

export class VoiceError extends Error {
  constructor(readonly status: number, readonly code: VoiceErrorCode, message: string) {
    super(message);
  }
  body(): { error: string; code: VoiceErrorCode } {
    return { error: this.message, code: this.code };
  }
}

export interface VoiceDownloadState {
  state: 'running' | 'failed';
  receivedBytes: number;
  totalBytes: number | null;
  startedAt: string;
  error: string | null;
}

/** `GET /voice/status` (api-types `VoiceStatus`). */
export interface VoiceStatusBody {
  /** Audio is transcribed on this machine; nothing is sent anywhere. Always true in phase 1. */
  local: true;
  /** Transcription can run now: the engine and the model are both here. */
  ready: boolean;
  engine: {
    name: 'whisper.cpp';
    found: boolean;
    /** Where it was found (a path); null when not found. */
    path: string | null;
    /** How to install (or upgrade) it on this platform, when it is missing or too old. */
    install: string | null;
    /** The version it reports (`--version`); null when not found or when it reports none (too old). */
    version: string | null;
    /** It is new enough: a stdin transcription prints its text to stdout and writes no file. */
    supported: boolean;
  };
  model: {
    name: string;
    present: boolean;
    bytes: number | null;
    approxBytes: number;
    source: string;
    download: VoiceDownloadState | null;
  };
}

/** The injectable edges (tests stub every one). */
/** How whisper.cpp is started (tests give a stand-in). */
export type VoiceSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface VoiceDeps {
  /** The voice cache dir (the model lives here). */
  dir: string;
  /** The whisper.cpp CLI, or null to look it up on PATH. */
  bin?: string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  fetch?: typeof fetch;
  spawn?: VoiceSpawn;
  exists?: (p: string) => boolean;
  timeoutMs?: number;
  /** The model to fetch and use (tests give their own checksum). */
  model?: VoiceModel;
  /** What `<bin> --version` prints (tests stand it in); null when it fails. */
  versionOf?: (bin: string) => string | null;
}

export interface VoiceModel { name: string; file: string; url: string; sha1: string; approxBytes: number; source: string }

/** The OS cache dir for crew's voice files (`WICKED_CREW_VOICE_DIR` wins). */
export function defaultVoiceDir(env: NodeJS.ProcessEnv = process.env, plat: NodeJS.Platform = osPlatform(), home: string = homedir()): string {
  const set = env['WICKED_CREW_VOICE_DIR'];
  if (set !== undefined && set.trim() !== '') return set;
  if (plat === 'darwin') return join(home, 'Library', 'Caches', 'wicked-crew', 'voice');
  if (plat === 'win32') return join(env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), 'wicked-crew', 'voice');
  return join(env['XDG_CACHE_HOME'] ?? join(home, '.cache'), 'wicked-crew', 'voice');
}

/** How to install whisper.cpp here, in one line. */
export function installHint(plat: NodeJS.Platform): string {
  if (plat === 'darwin') return 'Install whisper.cpp with Homebrew: brew install whisper-cpp (it provides whisper-cli).';
  if (plat === 'win32') return 'Download whisper.cpp for Windows from github.com/ggml-org/whisper.cpp/releases, then set WICKED_CREW_WHISPER_BIN to whisper-cli.exe.';
  return 'Install whisper.cpp from your package manager or build it from github.com/ggml-org/whisper.cpp, so whisper-cli is on PATH (or set WICKED_CREW_WHISPER_BIN).';
}

/** The oldest engine voice runs: it must report `--version` (whisper.cpp 1.8.0 does not), and be at least this. */
export const MIN_WHISPER = [1, 8, 0] as const;

/** `whisper.cpp version: 1.9.5` → `1.9.5`; anything else → null. */
export function parseWhisperVersion(out: string | null): string | null {
  const m = out === null ? null : /version:?\s*v?(\d+)\.(\d+)\.(\d+)/i.exec(out);
  return m === null ? null : `${m[1]}.${m[2]}.${m[3]}`;
}

/**
 * Is this engine safe to hand audio on stdin? From whisper.cpp 1.8.0 a stdin run (`-f -`) writes its `-otxt` output
 * to stdout; 1.7.x writes it to a FILE named `-.txt` in the working directory, which would keep a transcript on disk.
 * 1.8.0 itself cannot say its version, so voice asks for an engine that reports one (`--version`) at 1.8.0 or later,
 * and refuses the rest before any audio is sent.
 */
export function whisperSupported(version: string | null): boolean {
  if (version === null) return false;
  const v = version.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((v[i] ?? 0) !== MIN_WHISPER[i]) return (v[i] ?? 0) > MIN_WHISPER[i]!;
  }
  return true;
}

function runVersion(bin: string): string | null {
  try {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    return r.status === 0 ? `${r.stdout ?? ''}${r.stderr ?? ''}` : null;
  } catch {
    return null;
  }
}

/** How to upgrade whisper.cpp here, in one line. */
export function upgradeHint(plat: NodeJS.Platform): string {
  if (plat === 'darwin') return 'Upgrade it: brew upgrade whisper-cpp.';
  return 'Install a current whisper.cpp from github.com/ggml-org/whisper.cpp (or set WICKED_CREW_WHISPER_BIN to one).';
}

/** Find the whisper.cpp CLI: `WICKED_CREW_WHISPER_BIN`, else `whisper-cli` (or the older `whisper-cpp`) on PATH. */
export function findWhisper(env: NodeJS.ProcessEnv, plat: NodeJS.Platform, exists: (p: string) => boolean): string | null {
  const set = env['WICKED_CREW_WHISPER_BIN'];
  if (set !== undefined && set.trim() !== '') return exists(set) ? set : null;
  const names = plat === 'win32' ? ['whisper-cli.exe', 'whisper-cpp.exe'] : ['whisper-cli', 'whisper-cpp'];
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue;
    for (const n of names) {
      const p = join(dir, n);
      if (exists(p)) return p;
    }
  }
  return null;
}

/**
 * Is it the WAV studio sends: RIFF/WAVE with a PCM `fmt ` chunk (16 kHz, mono, 16-bit) and a non-empty `data`
 * chunk, every chunk inside the buffer? Anything else is refused before the engine is started.
 */
export function wavProblem(buf: Buffer): string | null {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return 'not a RIFF/WAVE file';
  let at = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let data = 0;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (body + size > buf.length) return `the ${id.trim() || 'unnamed'} chunk runs past the end of the file`;
    if (id === 'fmt ') {
      if (size < 16) return 'the fmt chunk is too short';
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      data += size;
    }
    at = body + size + (size % 2);
  }
  if (fmt === null) return 'no fmt chunk';
  if (fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== 16_000 || fmt.bits !== 16) {
    return `expected 16 kHz mono 16-bit PCM, got format ${fmt.format}, ${fmt.channels} channel(s), ${fmt.rate} Hz, ${fmt.bits}-bit`;
  }
  if (data === 0) return 'no audio in the data chunk';
  return null;
}

/** Is it a WAV this route takes? */
export function isWav(buf: Buffer): boolean {
  return wavProblem(buf) === null;
}

/** whisper.cpp's plain-text output as one line: no timestamps, no non-speech tags ([BLANK_AUDIO], (music)). */
export function cleanTranscript(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\((?:[a-z ]*(?:music|noise|silence|applause|laughter|inaudible|blank)[a-z ]*)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class VoiceService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly plat: NodeJS.Platform;
  private readonly exists: (p: string) => boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: VoiceSpawn;
  private readonly timeoutMs: number;
  private readonly model: VoiceModel;
  private readonly versionOf: (bin: string) => string | null;
  /** `--version` per engine path, read once. */
  private readonly versions = new Map<string, string | null>();
  private download: VoiceDownloadState | null = null;
  /** The download in flight: removal aborts it and bumps the generation, so it can never land afterwards. */
  private inflight: { gen: number; abort: AbortController } | null = null;
  private gen = 0;
  /** One transcription holds the slot; one waits for it (the slot is handed over, never re-contested). */
  private busy = false;
  private waiting: Array<() => void> = [];

  constructor(private readonly deps: VoiceDeps) {
    this.env = deps.env ?? process.env;
    this.plat = deps.platform ?? osPlatform();
    this.exists = deps.exists ?? existsSync;
    this.fetchImpl = deps.fetch ?? fetch;
    this.spawnImpl = deps.spawn ?? nodeSpawn;
    this.timeoutMs = deps.timeoutMs ?? TRANSCRIBE_TIMEOUT_MS;
    this.model = deps.model ?? VOICE_MODEL;
    this.versionOf = deps.versionOf ?? runVersion;
  }

  modelPath(): string {
    return join(this.deps.dir, this.model.file);
  }

  private bin(): string | null {
    if (this.deps.bin !== undefined && this.deps.bin !== null) return this.exists(this.deps.bin) ? this.deps.bin : null;
    return findWhisper(this.env, this.plat, this.exists);
  }

  private engineVersion(bin: string): string | null {
    if (!this.versions.has(bin)) this.versions.set(bin, parseWhisperVersion(this.versionOf(bin)));
    return this.versions.get(bin) ?? null;
  }

  private tooOld(bin: string): string {
    return `whisper.cpp at ${bin} is too old for voice: it needs 1.8.0 or later (one that answers --version), so a transcription never writes a file. ${upgradeHint(this.plat)}`;
  }

  private modelBytes(): number | null {
    const p = this.modelPath();
    if (!this.exists(p)) return null;
    try { return statSync(p).size; } catch { return null; }
  }

  status(): VoiceStatusBody {
    const path = this.bin();
    const bytes = this.modelBytes();
    const version = path !== null ? this.engineVersion(path) : null;
    const supported = path !== null && whisperSupported(version);
    return {
      local: true,
      ready: supported && bytes !== null,
      engine: {
        name: 'whisper.cpp', found: path !== null, path, version, supported,
        install: path === null ? installHint(this.plat) : supported ? null : this.tooOld(path),
      },
      model: {
        name: this.model.name, present: bytes !== null, bytes, approxBytes: this.model.approxBytes,
        source: this.model.source, download: this.download === null ? null : { ...this.download },
      },
    };
  }

  /**
   * Fetch the model, once, with the person's consent. Returns at once; the download runs on and
   * `status().model.download` reports it. The file lands under a `.part` name, is checked against the published
   * SHA-1, and only then takes its real name; a failed or mismatched download leaves nothing behind.
   */
  startDownload(): { started: boolean } {
    if (this.modelBytes() !== null) return { started: false };
    if (this.inflight !== null) throw new VoiceError(409, 'voice_download_running', 'The speech model is already downloading.');
    const gen = ++this.gen;
    const abort = new AbortController();
    this.inflight = { gen, abort };
    this.download = { state: 'running', receivedBytes: 0, totalBytes: null, startedAt: new Date().toISOString(), error: null };
    void this.fetchModel(gen, abort.signal).then(
      () => { if (this.gen === gen) this.download = null; },
      (e: unknown) => {
        if (this.gen !== gen) return; // removed meanwhile: nothing to report
        this.download = {
          ...(this.download ?? { receivedBytes: 0, totalBytes: null, startedAt: new Date().toISOString() }),
          state: 'failed', error: e instanceof Error ? e.message : String(e),
        };
      },
    ).finally(() => { if (this.inflight?.gen === gen) this.inflight = null; });
    return { started: true };
  }

  private async fetchModel(gen: number, signal: AbortSignal): Promise<void> {
    mkdirSync(this.deps.dir, { recursive: true });
    const part = `${this.modelPath()}.part`;
    rmSync(part, { force: true });
    try {
      const res = await this.fetchImpl(this.model.url, { redirect: 'follow', signal });
      if (!res.ok || res.body === null) throw new Error(`the model download answered ${res.status}`);
      const len = Number(res.headers.get('content-length'));
      if (this.download !== null && Number.isFinite(len) && len > 0) this.download.totalBytes = len;
      const hash = createHash('sha1');
      const count = new Transform({
        transform: (chunk: Buffer, _enc, cb) => {
          hash.update(chunk);
          if (this.gen === gen && this.download !== null) this.download.receivedBytes += chunk.length;
          cb(null, chunk);
        },
      });
      // One pipeline: a read, write or disk error (EACCES, ENOSPC) rejects here, never an unhandled 'error'.
      await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>), count, createWriteStream(part), { signal });
      const got = hash.digest('hex');
      if (got !== this.model.sha1) throw new Error(`the downloaded model did not match its published checksum (got sha1 ${got}); nothing was kept`);
      if (this.gen !== gen || signal.aborted) throw new Error('the download was cancelled');
      renameSync(part, this.modelPath());
    } catch (e) {
      rmSync(part, { force: true });
      throw e;
    }
  }

  /** Remove the model (the person's "Remove the speech model"). A download in flight is cancelled first. */
  removeModel(): { removed: boolean } {
    this.gen += 1;
    this.inflight?.abort.abort();
    this.inflight = null;
    this.download = null;
    const p = this.modelPath();
    const had = this.exists(p);
    rmSync(p, { force: true });
    rmSync(`${p}.part`, { force: true });
    return { removed: had };
  }

  /** Transcribe one WAV held in memory. The bytes go to whisper.cpp on stdin and are dropped after. */
  async transcribe(audio: Buffer): Promise<{ text: string; ms: number; model: string }> {
    if (audio.length > VOICE_MAX_AUDIO_BYTES) {
      throw new VoiceError(413, 'voice_audio_too_large', `The recording is over ${Math.round(VOICE_MAX_AUDIO_BYTES / 1048576)} MiB; speak in shorter turns.`);
    }
    const problem = wavProblem(audio);
    if (problem !== null) throw new VoiceError(400, 'voice_audio_invalid', `Send the recording as a 16 kHz mono 16-bit WAV (${problem}).`);
    this.ready();
    if (this.busy && this.waiting.length >= 1) throw new VoiceError(429, 'voice_busy', 'Still transcribing the last thing you said.');
    if (this.busy) await new Promise<void>((r) => this.waiting.push(r)); // the slot is handed to us
    this.busy = true;
    const started = Date.now();
    try {
      // Checked again with the slot held: the model may have been removed while this one waited.
      const bin = this.ready();
      const raw = await this.run(bin, audio);
      return { text: cleanTranscript(raw), ms: Date.now() - started, model: this.model.name };
    } finally {
      const next = this.waiting.shift();
      if (next !== undefined) next(); // hand the slot over: `busy` stays true, nobody can slip in between
      else this.busy = false;
    }
  }

  /** The engine and the model, or the refusal that names the missing one. */
  private ready(): string {
    const bin = this.bin();
    if (bin === null) throw new VoiceError(409, 'voice_engine_missing', `whisper.cpp is not installed on this machine. ${installHint(this.plat)}`);
    if (!whisperSupported(this.engineVersion(bin))) throw new VoiceError(409, 'voice_engine_outdated', this.tooOld(bin));
    if (this.modelBytes() === null) throw new VoiceError(409, 'voice_model_missing', 'The speech model is not on this machine yet; download it first (it needs your consent).');
    return bin;
  }

  private run(bin: string, audio: Buffer): Promise<string> {
    // `-f -` reads the WAV from stdin; with stdin as the input, whisper-cli (1.8.0 and later, checked in `ready()`)
    // writes its output "file" to stdout, and `-otxt` is the format it writes there (without it a stdin run prints
    // nothing: 1.9.5, seen live). No file is written. An older engine would write `-.txt`, so it never gets here.
    const args = ['-m', this.modelPath(), '-f', '-', '-otxt', '-nt', '-np', '-l', 'en', '-t', String(TRANSCRIBE_THREADS)];
    return new Promise<string>((resolve, reject) => {
      const child = this.spawnImpl(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      let err = '';
      let settled = false;
      const done = (f: () => void): void => { if (!settled) { settled = true; clearTimeout(timer); f(); } };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        done(() => reject(new VoiceError(504, 'voice_timeout', `Transcription took longer than ${Math.round(this.timeoutMs / 1000)} s and was stopped.`)));
      }, this.timeoutMs);
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (d: string) => { out += d; });
      child.stderr?.on('data', (d: string) => { if (err.length < 4000) err += d; });
      child.on('error', (e) => done(() => reject(new VoiceError(500, 'voice_failed', `whisper.cpp could not start: ${e.message}`))));
      child.on('close', (code) => done(() => {
        if (code === 0) resolve(out);
        else reject(new VoiceError(500, 'voice_failed', `whisper.cpp exited ${code}: ${err.trim().split('\n').slice(-2).join(' ') || 'no message'}`));
      }));
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(audio);
    });
  }
}
