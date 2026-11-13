/**
 * TEXT TO SPEECH on THIS machine (DES studio#1140, slice 1): a consented, checksummed install of the piper engine
 * and two licence-cleared voices, beside the whisper model in the voice cache dir (`WICKED_CREW_VOICE_DIR`, outside
 * the state home), and a local synthesis that sends nothing off the machine. The text is never logged or audited.
 *
 *  - Engine: a venv built with the machine's Python, then `pip install --require-hashes --no-deps -r <lock>` from
 *    PyPI only, from the lock committed for this (OS, arch, CPython minor) in `voice-locks/`. The venv is built in a
 *    temp dir and renamed into place; any failure removes it. Native Windows and CPython outside 3.9 to 3.14 are
 *    unsupported, and said so.
 *  - Voices: only the manifest's (tts-manifest.ts); each file is fetched to a `.part`, held to its sha256 and size,
 *    and a mismatch keeps nothing.
 *  - Synthesis: `<venv>/bin/python -m piper -m <onnx> -c <json> -f <temp.wav>`, argv only, the text as ONE line on
 *    stdin (piper parses argv with parse_known_args, so text there could be read as an option).
 */

import { spawn as nodeSpawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { arch as osArch, platform as osPlatform } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { fileURLToPath } from 'node:url';
import type { VoiceTtsStatus } from 'wicked-crew-api-types';

import { childEnvWithBootEstateDb } from '../core/governance-store.js';
import { TTS_ENGINE, TTS_VOICES, TTS_VOICES_SOURCE, ttsVoiceUrl, type TtsVoice, type TtsVoiceFile } from './tts-manifest.js';
import { VoiceError, type VoiceSpawn } from './service.js';

/** CPython minors a lock exists for. */
export const TTS_PYTHON_MINORS = [9, 10, 11, 12, 13, 14] as const;
/** At most this many characters of text are spoken. */
export const TTS_MAX_TEXT_CHARS = 2000;
/** One synthesis that runs longer than this is killed. */
export const TTS_TIMEOUT_MS = 30_000;
/** Piper's stdout and stderr are each kept to this much. */
export const TTS_OUTPUT_CAP_BYTES = 64 * 1024;
/** The output file is watched while piper writes and the process killed past this. */
export const TTS_MAX_WAV_BYTES = 16 * 1024 * 1024;
/** The one fixed sentence of a voice sample. */
export const TTS_SAMPLE_TEXT = 'Hello, this is how I sound when I read to you.';
/** The engine install (venv + pip) is given this long. */
export const TTS_INSTALL_TIMEOUT_MS = 10 * 60_000;

const LOCKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'voice-locks');
const SUPPORTED_OS = new Set(['darwin', 'linux']);
const SUPPORTED_ARCH = new Set(['arm64', 'x64']);
/** Targets inside the table above that still have no lock: onnxruntime ships no wheel for them. */
const NO_WHEEL = new Set(['darwin-x64-cp314']);

/** The lock file for an (OS, arch, CPython minor) as Node reports them; null for an unsupported combination. */
export function lockPath(os: string, arch: string, minor: number, locksDir: string = LOCKS_DIR): string | null {
  if (!SUPPORTED_OS.has(os) || !SUPPORTED_ARCH.has(arch)) return null;
  if (!(TTS_PYTHON_MINORS as readonly number[]).includes(minor)) return null;
  if (NO_WHEEL.has(`${os}-${arch}-cp3${minor}`)) return null;
  return join(locksDir, `${os}-${arch}-cp3${minor}.txt`);
}

/**
 * The text as piper reads it: control characters and line breaks gone (a break becomes a space, so words never
 * fuse), runs of space collapsed, piper's `[[ ... ]]` phoneme markup neutralized so it is never interpreted (a
 * space goes between every pair of adjacent brackets, so no run of any length keeps a `[[` or `]]`), at most
 * {@link TTS_MAX_TEXT_CHARS} characters.
 */
export function normalizeSpeakText(text: string): string {
  const flat = text
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .replace(/\[(?=\[)/g, '[ ')
    .replace(/\](?=\])/g, '] ');
  return flat.slice(0, TTS_MAX_TEXT_CHARS).trim();
}

/** A WAV piper wrote: RIFF/WAVE, a PCM `fmt ` chunk and a `data` chunk of non-zero duration; null when sound. */
export function ttsWavProblem(buf: Buffer): string | null {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return 'not a RIFF/WAVE file';
  let at = 12;
  let fmt: { blockAlign: number } | null = null;
  let data = 0;
  let dataBeforeFmt = false;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (body + size > buf.length) return `the ${id.trim() || 'unnamed'} chunk runs past the end of the file`;
    if (id === 'fmt ') {
      if (size < 16) return 'the fmt chunk is too short';
      if (fmt !== null) return 'more than one fmt chunk';
      if (buf.readUInt16LE(body) !== 1) return 'not PCM audio';
      const channels = buf.readUInt16LE(body + 2);
      const rate = buf.readUInt32LE(body + 4);
      const byteRate = buf.readUInt32LE(body + 8);
      const blockAlign = buf.readUInt16LE(body + 12);
      const bits = buf.readUInt16LE(body + 14);
      if (channels < 1) return 'no channels';
      if (rate <= 0) return 'a zero sample rate';
      if (![8, 16, 24, 32].includes(bits)) return `${bits}-bit samples are not PCM audio`;
      if (blockAlign !== (channels * bits) / 8) return 'the block alignment does not match the channels and bit depth';
      if (byteRate !== rate * blockAlign) return 'the byte rate does not match the sample rate and block alignment';
      fmt = { blockAlign };
    } else if (id === 'data') {
      if (fmt === null) dataBeforeFmt = true;
      data += size;
      if (fmt !== null && size % fmt.blockAlign !== 0) return 'the data chunk is not a whole number of blocks';
    }
    at = body + size + (size % 2);
  }
  if (fmt === null) return 'no usable fmt chunk';
  if (dataBeforeFmt) return 'the data chunk comes before the fmt chunk';
  if (data === 0) return 'no audio in the data chunk';
  return null;
}

export interface PythonInfo { path: string; version: string; minor: number }

/** What `<cmd>` is as a CPython 3 interpreter; null when it does not run or is not CPython 3. */
export function probePython(cmd: string): PythonInfo | null {
  try {
    const r = spawnSync(cmd, ['-c', 'import sys,platform;print(platform.python_implementation(), sys.version_info[0], sys.version_info[1], sys.version.split()[0], sys.executable)'], { encoding: 'utf8', timeout: 5000, windowsHide: true, env: childEnvWithBootEstateDb(process.env) });
    if (r.status !== 0) return null;
    const m = /^CPython (\d+) (\d+) (\S+) (.+)$/m.exec(r.stdout ?? '');
    if (m === null || m[1] !== '3') return null;
    return { path: m[4]!.trim() === '' ? cmd : m[4]!.trim(), version: m[3]!, minor: Number(m[2]) };
  } catch {
    return null;
  }
}

/** The one-line remedy when this machine has no usable Python. */
export function pythonHint(plat: NodeJS.Platform): string {
  if (plat === 'darwin') return 'Install Python 3.12 from python.org or with Homebrew (brew install python@3.12).';
  return 'Install Python 3 with its venv module: on Debian or Ubuntu, sudo apt install python3 python3-venv.';
}

/** The status body is the public wire type (`GET /voice/tts`). */
export type TtsStatusBody = VoiceTtsStatus;
type TtsInstallState = NonNullable<VoiceTtsStatus['install']>;

export interface TtsDeps {
  /** The voice cache dir (the engine and voices live under `tts/` in it). */
  dir: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  fetch?: typeof fetch;
  spawn?: VoiceSpawn;
  exists?: (p: string) => boolean;
  /** CPython interpreter facts for a command; tests stand it in. */
  probe?: (cmd: string) => PythonInfo | null;
  locksDir?: string;
  timeoutMs?: number;
  installTimeoutMs?: number;
  maxWavBytes?: number;
  voices?: readonly TtsVoice[];
}

interface RunResult { code: number | null; stdout: string; stderr: string }

export class TtsService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly plat: NodeJS.Platform;
  private readonly arch: string;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: VoiceSpawn;
  private readonly exists: (p: string) => boolean;
  private readonly probe: (cmd: string) => PythonInfo | null;
  private readonly locksDir: string;
  private readonly timeoutMs: number;
  private readonly installTimeoutMs: number;
  private readonly maxWav: number;
  private readonly voices: readonly TtsVoice[];
  private installState: TtsInstallState | null = null;
  private inflight: { gen: number; abort: AbortController; done: Promise<void> } | null = null;
  private gen = 0;
  private busy = false;
  private waiting: Array<() => void> = [];

  constructor(private readonly deps: TtsDeps) {
    this.env = deps.env ?? process.env;
    this.plat = deps.platform ?? osPlatform();
    this.arch = deps.arch ?? osArch();
    this.fetchImpl = deps.fetch ?? fetch;
    this.spawnImpl = deps.spawn ?? (nodeSpawn as VoiceSpawn);
    this.exists = deps.exists ?? existsSync;
    this.probe = deps.probe ?? probePython;
    this.locksDir = deps.locksDir ?? LOCKS_DIR;
    this.timeoutMs = deps.timeoutMs ?? TTS_TIMEOUT_MS;
    this.installTimeoutMs = deps.installTimeoutMs ?? TTS_INSTALL_TIMEOUT_MS;
    this.maxWav = deps.maxWavBytes ?? TTS_MAX_WAV_BYTES;
    this.voices = deps.voices ?? TTS_VOICES;
  }

  private root(): string { return join(this.deps.dir, 'tts'); }
  private enginePath(): string { return join(this.root(), 'engine'); }
  private enginePython(root: string = this.enginePath()): string { return join(root, 'bin', 'python'); }
  private voiceDir(id: string): string { return join(this.root(), 'voices', id); }
  private samplePath(id: string): string { return join(this.root(), 'sample', `${id}-${TTS_ENGINE.version}.wav`); }

  /** Resolves when the install in flight (if any) has finished, whatever its outcome. */
  installDone(): Promise<void> { return this.inflight?.done ?? Promise.resolve(); }

  /** The Python this machine will use: `WICKED_CREW_PYTHON`, else the first of python3, python3.14 ... python3.9 with a lock. */
  pickPython(): { python: PythonInfo | null; lock: string | null; problem: string | null } {
    const set = this.env['WICKED_CREW_PYTHON'];
    const wanted = set !== undefined && set.trim() !== '' ? set : null;
    const names = wanted !== null ? [wanted] : ['python3', ...[...TTS_PYTHON_MINORS].reverse().map((n) => `python3.${n}`)];
    let skipped: PythonInfo | null = null;
    for (const name of names) {
      const info = this.probe(name);
      if (info === null) continue;
      const lock = lockPath(this.plat, this.arch, info.minor, this.locksDir);
      if (lock !== null && this.exists(lock)) return { python: info, lock, problem: null };
      skipped ??= info;
    }
    if (skipped !== null && lockPath(this.plat, this.arch, skipped.minor, this.locksDir) === null && (TTS_PYTHON_MINORS as readonly number[]).includes(skipped.minor)) {
      return { python: null, lock: null, problem: `Python ${skipped.version} at ${skipped.path} is not supported on this machine: the speech engine has no build for it on an Intel Mac. Use Python 3.9 to 3.13 (WICKED_CREW_PYTHON names one).` };
    }
    if (skipped !== null) {
      return { python: null, lock: null, problem: `Python ${skipped.version} at ${skipped.path} is not supported: voice needs CPython 3.9 to 3.14. ${pythonHint(this.plat)}` };
    }
    const why = wanted !== null ? `WICKED_CREW_PYTHON (${wanted}) is not a working CPython 3.` : 'No Python 3 was found on this machine.';
    return { python: null, lock: null, problem: `${why} ${pythonHint(this.plat)}` };
  }

  private platformProblem(): string | null {
    if (!SUPPORTED_OS.has(this.plat)) {
      return this.plat === 'win32'
        ? 'Native Windows is not supported for text to speech; use WSL2 (Linux).'
        : `${this.plat} is not supported for text to speech (macOS and Linux only).`;
    }
    if (!SUPPORTED_ARCH.has(this.arch)) return `The ${this.arch} processor is not supported for text to speech (arm64 and x86_64 only).`;
    return null;
  }

  private engineInstalled(): boolean { return this.exists(this.enginePython()); }

  private voiceInstalled(v: TtsVoice): boolean {
    return this.exists(join(this.voiceDir(v.id), basename(v.model.path))) && this.exists(join(this.voiceDir(v.id), basename(v.config.path)));
  }

  status(): TtsStatusBody {
    const platformProblem = this.platformProblem();
    const picked = platformProblem === null ? this.pickPython() : { python: null, lock: null, problem: null };
    const problem = platformProblem ?? picked.problem;
    const engine = this.engineInstalled();
    const voices: TtsStatusBody['voices'] = {};
    for (const v of this.voices) {
      voices[v.id] = { installed: this.voiceInstalled(v), name: v.name, accent: v.accent, licence: v.licence, bytes: v.model.bytes + v.config.bytes, source: TTS_VOICES_SOURCE };
    }
    return {
      supported: { ok: problem === null, reason: problem },
      python: { found: picked.python !== null, path: picked.python?.path ?? null, version: picked.python?.version ?? null },
      engine: { found: engine, version: engine ? TTS_ENGINE.version : null },
      voices,
      install: this.installState === null ? null : { ...this.installState },
    };
  }

  private voiceById(id: string): TtsVoice {
    const v = this.voices.find((x) => x.id === id);
    if (v === undefined) throw new VoiceError(400, 'voice_unknown', `"${id.slice(0, 80)}" is not a voice this install offers.`);
    return v;
  }

  /**
   * Install the engine if missing, then the named voices. Returns at once; `status().install` reports it. Only
   * manifest voices are accepted (400 `voice_unknown`); an unsupported machine is 409 `voice_tts_unsupported`.
   */
  startInstall(ids: readonly string[]): { started: boolean } {
    const wanted = ids.map((id) => this.voiceById(id));
    if (this.inflight !== null) throw new VoiceError(409, 'voice_install_running', 'The speech install is already running.');
    const problem = this.platformProblem() ?? this.pickPython().problem;
    if (problem !== null) throw new VoiceError(409, 'voice_tts_unsupported', problem);
    if (this.engineInstalled() && wanted.every((v) => this.voiceInstalled(v))) return { started: false };
    const gen = ++this.gen;
    const abort = new AbortController();
    this.installState = { state: 'running', step: 'engine', error: null };
    const done = this.install(wanted, gen, abort.signal).then(
      () => { if (this.gen === gen) this.installState = null; },
      (e: unknown) => {
        if (this.gen !== gen) return;
        this.installState = { state: 'failed', step: this.installState?.step ?? 'engine', error: e instanceof Error ? e.message : String(e) };
      },
    ).finally(() => { if (this.inflight?.gen === gen) this.inflight = null; });
    this.inflight = { gen, abort, done };
    return { started: true };
  }

  private step(gen: number, step: string): void {
    if (this.gen === gen && this.installState !== null) this.installState.step = step;
  }

  private async install(wanted: readonly TtsVoice[], gen: number, signal: AbortSignal): Promise<void> {
    mkdirSync(this.root(), { recursive: true });
    if (!this.engineInstalled()) await this.installEngine(gen, signal);
    for (const v of wanted) {
      if (this.voiceInstalled(v)) continue;
      this.step(gen, `voice:${v.id}`);
      await this.installVoice(v, gen, signal);
    }
  }

  /** Env for a child: no pip or Python variable of the person's reaches it; pip reads no config file. */
  private childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = {};
    for (const [k, val] of Object.entries(this.env)) {
      if (val === undefined || k.startsWith('PIP_') || k.startsWith('PYTHON')) continue;
      out[k] = val;
    }
    return { ...out, ...extra };
  }

  private async installEngine(gen: number, signal: AbortSignal): Promise<void> {
    const picked = this.pickPython();
    if (picked.python === null || picked.lock === null) throw new Error(picked.problem ?? 'No usable Python.');
    const tmp = join(this.root(), `engine.tmp-${randomBytes(4).toString('hex')}`);
    try {
      const venv = await this.run(picked.python.path, ['-m', 'venv', tmp], { env: this.childEnv(), timeoutMs: this.installTimeoutMs, signal });
      if (venv.code !== 0) throw new Error(`Creating the Python environment failed (${tail(venv.stderr)}). ${pythonHint(this.plat)}`);
      const pip = await this.run(this.enginePython(tmp), [
        '-m', 'pip', 'install', '--isolated', '--index-url', TTS_ENGINE.index, '--only-binary=:all:', '--require-hashes', '--no-deps', '-r', picked.lock,
      ], { env: this.childEnv({ PIP_CONFIG_FILE: '/dev/null', PIP_DISABLE_PIP_VERSION_CHECK: '1' }), timeoutMs: this.installTimeoutMs, signal });
      if (pip.code !== 0) throw new Error(`Installing ${TTS_ENGINE.name} ${TTS_ENGINE.version} failed (${tail(pip.stderr)})`);
      if (this.gen !== gen || signal.aborted) throw new Error('The install was cancelled.');
      rmSync(this.enginePath(), { recursive: true, force: true });
      renameSync(tmp, this.enginePath());
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
  }

  private async installVoice(v: TtsVoice, gen: number, signal: AbortSignal): Promise<void> {
    const tmp = join(this.root(), 'voices', `.${v.id}.tmp-${randomBytes(4).toString('hex')}`);
    mkdirSync(tmp, { recursive: true });
    try {
      for (const file of [v.model, v.config]) await this.fetchVoiceFile(file, join(tmp, basename(file.path)), signal);
      if (this.gen !== gen || signal.aborted) throw new Error('The install was cancelled.');
      rmSync(this.voiceDir(v.id), { recursive: true, force: true });
      renameSync(tmp, this.voiceDir(v.id));
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
  }

  private async fetchVoiceFile(file: TtsVoiceFile, dest: string, signal: AbortSignal): Promise<void> {
    const part = `${dest}.part`;
    const res = await this.fetchImpl(ttsVoiceUrl(file), { redirect: 'follow', signal });
    if (!res.ok || res.body === null) throw new Error(`The voice download answered ${res.status}.`);
    const hash = createHash('sha256');
    let size = 0;
    const count = new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        size += chunk.length;
        if (size > file.bytes) return cb(new Error(`The voice file ${basename(file.path)} is larger than its published size (${file.bytes} bytes); nothing was kept.`));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>), count, createWriteStream(part), { signal });
    const got = hash.digest('hex');
    if (size !== file.bytes) throw new Error(`The voice file ${basename(file.path)} is ${size} bytes, not its published ${file.bytes}; nothing was kept.`);
    if (got !== file.sha256) throw new Error(`The voice file ${basename(file.path)} did not match its published checksum (got sha256 ${got}); nothing was kept.`);
    renameSync(part, dest);
  }

  /** Remove the engine, the voices and the cached samples. An install in flight is cancelled first. */
  remove(): { removed: boolean } {
    this.gen += 1;
    this.inflight?.abort.abort();
    this.inflight = null;
    this.installState = null;
    const had = this.exists(this.root());
    rmSync(this.root(), { recursive: true, force: true });
    return { removed: had };
  }

  /** Speak `text` in `voice`; the WAV bytes. Nothing about the text is kept. */
  async speak(text: string, voice: string): Promise<Buffer> {
    const v = this.voiceById(voice);
    this.ready(v);
    const line = normalizeSpeakText(text);
    if (line === '') throw new VoiceError(400, 'voice_text_empty', 'There is nothing to read aloud.');
    return this.exclusive(async () => {
      this.ready(v);
      return this.synthesize(v, line);
    });
  }

  /** A fixed sentence in `voice`, cached per (voice, piper version). */
  async sample(voice: string): Promise<Buffer> {
    const v = this.voiceById(voice);
    this.ready(v);
    return this.exclusive(async () => {
      this.ready(v);
      const cached = this.samplePath(v.id);
      if (this.exists(cached)) {
        try { return readFileSync(cached); } catch { /* re-made below */ }
      }
      const wav = await this.synthesize(v, TTS_SAMPLE_TEXT);
      mkdirSync(dirname(cached), { recursive: true });
      const part = `${cached}.part`;
      writeFileSync(part, wav);
      renameSync(part, cached);
      return wav;
    });
  }

  /** One synthesis at a time and one waiting: a third is refused 429 `voice_busy`. */
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy && this.waiting.length >= 1) throw new VoiceError(429, 'voice_busy', 'Still reading the last thing aloud.');
    if (this.busy) await new Promise<void>((r) => this.waiting.push(r));
    this.busy = true;
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next !== undefined) next();
      else this.busy = false;
    }
  }

  /** The engine and the voice, or the 409 that names what is missing (no fallback). */
  private ready(v: TtsVoice): void {
    if (!this.engineInstalled()) throw new VoiceError(409, 'voice_tts_missing', 'The speech engine is not installed; install it first (it needs your consent).');
    if (!this.voiceInstalled(v)) throw new VoiceError(409, 'voice_tts_missing', `The voice ${v.id} is not installed; install it first.`);
  }

  private async synthesize(v: TtsVoice, line: string): Promise<Buffer> {
    const workDir = join(this.root(), 'work');
    mkdirSync(workDir, { recursive: true });
    const out = join(workDir, `${randomBytes(6).toString('hex')}.wav`);
    try {
      const r = await this.run(this.enginePython(), [
        '-m', 'piper', '-m', join(this.voiceDir(v.id), basename(v.model.path)), '-c', join(this.voiceDir(v.id), basename(v.config.path)), '-f', out,
      ], { env: this.childEnv(), timeoutMs: this.timeoutMs, stdin: `${line}\n`, watch: { file: out, maxBytes: this.maxWav } });
      if (r.code !== 0) throw new VoiceError(500, 'voice_tts_failed', `piper exited ${r.code}: ${tail(r.stderr) || 'no message'}`);
      if (!this.exists(out)) throw new VoiceError(500, 'voice_tts_failed', 'piper wrote no audio.');
      if (statSync(out).size > this.maxWav) throw new VoiceError(500, 'voice_tts_failed', 'The audio is larger than the limit and was dropped.');
      const wav = readFileSync(out);
      const problem = ttsWavProblem(wav);
      if (problem !== null) throw new VoiceError(500, 'voice_tts_failed', `piper wrote audio that is not a usable WAV (${problem}).`);
      return wav;
    } finally {
      rmSync(out, { force: true });
    }
  }

  /** Run a child with argv only (never a shell); stdout and stderr each capped; killed at the timeout or when its output file passes a limit. */
  private run(
    command: string,
    args: readonly string[],
    o: { env: NodeJS.ProcessEnv; timeoutMs: number; stdin?: string; signal?: AbortSignal; watch?: { file: string; maxBytes: number } },
  ): Promise<RunResult> {
    return new Promise<RunResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.spawnImpl(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: childEnvWithBootEstateDb(o.env) });
      } catch (e) {
        reject(new VoiceError(500, 'voice_tts_failed', `Could not start ${command}: ${e instanceof Error ? e.message : String(e)}`));
        return;
      }
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const held = { out: 0, err: 0 };
      let settled = false;
      let watcher: NodeJS.Timeout | null = null;
      const finish = (f: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (watcher !== null) clearInterval(watcher);
        o.signal?.removeEventListener('abort', onAbort);
        f();
      };
      const kill = (): void => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
      const timer = setTimeout(() => {
        kill();
        finish(() => reject(new VoiceError(504, 'voice_timeout', `Reading aloud took longer than ${Math.round(o.timeoutMs / 1000)} s and was stopped.`)));
      }, o.timeoutMs);
      const onAbort = (): void => { kill(); finish(() => reject(new Error('The install was cancelled.'))); };
      o.signal?.addEventListener('abort', onAbort, { once: true });
      if (o.watch !== undefined) {
        const { file, maxBytes } = o.watch;
        watcher = setInterval(() => {
          try {
            if (statSync(file).size > maxBytes) {
              kill();
              finish(() => reject(new VoiceError(500, 'voice_tts_failed', 'The audio grew past its size limit and was stopped.')));
            }
          } catch { /* not written yet */ }
        }, 50);
      }
      // Each stream keeps at most TTS_OUTPUT_CAP_BYTES BYTES; it is decoded only after the cap.
      const keep = (into: Buffer[], which: 'out' | 'err') => (d: Buffer | string): void => {
        const chunk = typeof d === 'string' ? Buffer.from(d) : d;
        const room = TTS_OUTPUT_CAP_BYTES - held[which];
        if (room <= 0) return;
        const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
        into.push(part);
        held[which] += part.length;
      };
      child.stdout?.on('data', keep(out, 'out'));
      child.stderr?.on('data', keep(err, 'err'));
      child.on('error', (e) => finish(() => reject(new VoiceError(500, 'voice_tts_failed', `Could not start ${command}: ${e.message}`))));
      child.on('close', (code) => finish(() => resolve({ code, stdout: decodeCapped(out), stderr: decodeCapped(err) })));
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(o.stdin ?? '');
    });
  }
}

/** Buffers cut at a byte cap, decoded as UTF-8; StringDecoder without `end()` drops a torn trailing character. */
function decodeCapped(chunks: Buffer[]): string {
  return new StringDecoder('utf8').write(Buffer.concat(chunks));
}

/** The last two lines of a child's stderr, for a one-line error. */
function tail(s: string): string { return s.trim().split('\n').slice(-2).join(' ').slice(0, 400); }
