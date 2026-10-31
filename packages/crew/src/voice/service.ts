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

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
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
    /** How to install it on this platform, when it is not found. */
    install: string | null;
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

/** Is it a RIFF/WAVE file (the only shape studio sends)? */
export function isWav(buf: Buffer): boolean {
  return buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE';
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
  private download: VoiceDownloadState | null = null;
  private running = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly deps: VoiceDeps) {
    this.env = deps.env ?? process.env;
    this.plat = deps.platform ?? osPlatform();
    this.exists = deps.exists ?? existsSync;
    this.fetchImpl = deps.fetch ?? fetch;
    this.spawnImpl = deps.spawn ?? nodeSpawn;
    this.timeoutMs = deps.timeoutMs ?? TRANSCRIBE_TIMEOUT_MS;
    this.model = deps.model ?? VOICE_MODEL;
  }

  modelPath(): string {
    return join(this.deps.dir, this.model.file);
  }

  private bin(): string | null {
    if (this.deps.bin !== undefined && this.deps.bin !== null) return this.exists(this.deps.bin) ? this.deps.bin : null;
    return findWhisper(this.env, this.plat, this.exists);
  }

  private modelBytes(): number | null {
    const p = this.modelPath();
    if (!this.exists(p)) return null;
    try { return statSync(p).size; } catch { return null; }
  }

  status(): VoiceStatusBody {
    const path = this.bin();
    const bytes = this.modelBytes();
    return {
      local: true,
      ready: path !== null && bytes !== null,
      engine: { name: 'whisper.cpp', found: path !== null, path, install: path === null ? installHint(this.plat) : null },
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
    if (this.download?.state === 'running') throw new VoiceError(409, 'voice_download_running', 'The speech model is already downloading.');
    this.download = { state: 'running', receivedBytes: 0, totalBytes: null, startedAt: new Date().toISOString(), error: null };
    void this.fetchModel().then(
      () => { this.download = null; },
      (e: unknown) => {
        this.download = {
          ...(this.download ?? { receivedBytes: 0, totalBytes: null, startedAt: new Date().toISOString() }),
          state: 'failed', error: e instanceof Error ? e.message : String(e),
        };
      },
    );
    return { started: true };
  }

  private async fetchModel(): Promise<void> {
    mkdirSync(this.deps.dir, { recursive: true });
    const part = `${this.modelPath()}.part`;
    rmSync(part, { force: true });
    const res = await this.fetchImpl(this.model.url, { redirect: 'follow' });
    if (!res.ok || res.body === null) throw new Error(`the model download answered ${res.status}`);
    const len = Number(res.headers.get('content-length'));
    if (this.download !== null && Number.isFinite(len) && len > 0) this.download.totalBytes = len;
    const hash = createHash('sha1');
    const out = createWriteStream(part);
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        if (this.download !== null) this.download.receivedBytes += value.byteLength;
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    } catch (e) {
      out.destroy();
      rmSync(part, { force: true });
      throw e;
    }
    const got = hash.digest('hex');
    if (got !== this.model.sha1) {
      rmSync(part, { force: true });
      throw new Error(`the downloaded model did not match its published checksum (got sha1 ${got}); nothing was kept`);
    }
    renameSync(part, this.modelPath());
  }

  /** Remove the model (the person's "Remove the speech model"). */
  removeModel(): { removed: boolean } {
    const p = this.modelPath();
    const had = this.exists(p);
    rmSync(p, { force: true });
    rmSync(`${p}.part`, { force: true });
    if (this.download?.state === 'failed') this.download = null;
    return { removed: had };
  }

  /** Transcribe one WAV held in memory. The bytes go to whisper.cpp on stdin and are dropped after. */
  async transcribe(audio: Buffer): Promise<{ text: string; ms: number; model: string }> {
    if (audio.length > VOICE_MAX_AUDIO_BYTES) {
      throw new VoiceError(413, 'voice_audio_too_large', `The recording is over ${Math.round(VOICE_MAX_AUDIO_BYTES / 1048576)} MiB; speak in shorter turns.`);
    }
    if (!isWav(audio)) throw new VoiceError(400, 'voice_audio_invalid', 'Send the recording as a WAV file (audio/wav).');
    const bin = this.bin();
    if (bin === null) throw new VoiceError(409, 'voice_engine_missing', `whisper.cpp is not installed on this machine. ${installHint(this.plat)}`);
    if (this.modelBytes() === null) throw new VoiceError(409, 'voice_model_missing', 'The speech model is not on this machine yet; download it first (it needs your consent).');
    if (this.running >= 1 && this.waiting.length >= 1) throw new VoiceError(429, 'voice_busy', 'Still transcribing the last thing you said.');
    if (this.running >= 1) await new Promise<void>((r) => this.waiting.push(r));
    this.running += 1;
    const started = Date.now();
    try {
      const raw = await this.run(bin, audio);
      return { text: cleanTranscript(raw), ms: Date.now() - started, model: this.model.name };
    } finally {
      this.running -= 1;
      this.waiting.shift()?.();
    }
  }

  private run(bin: string, audio: Buffer): Promise<string> {
    const args = ['-m', this.modelPath(), '-f', '-', '-nt', '-np', '-l', 'en', '-t', String(TRANSCRIBE_THREADS)];
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
