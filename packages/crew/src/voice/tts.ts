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
 *  - Synthesis: `<venv>/bin/python -I -m piper -m <onnx> -c <json> -f <temp.wav>`, argv only, the text as ONE line on
 *    stdin (piper parses argv with parse_known_args, so text there could be read as an option).
 *  - Every Python launch runs isolated (`-I`: no current directory or user site on sys.path, PYTHON* ignored) with the
 *    voice dir as its cwd, never the daemon's. A child runs in its own process group; a timeout or cancel kills the
 *    group and the call settles only when the child has closed. A child's stderr never reaches an error body.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { type Stats, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { platform as osPlatform, release as osRelease } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
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
/** One voice file download is given this long in all, and may go this long without a byte. */
export const TTS_DOWNLOAD_TIMEOUT_MS = 20 * 60_000;
export const TTS_DOWNLOAD_IDLE_MS = 30_000;
/** A voice download follows at most this many redirects, each of them https. */
export const TTS_MAX_REDIRECTS = 5;
/** The Python probe result is kept this long. */
export const TTS_PROBE_TTL_MS = 60_000;
/** The error text of a failed synthesis: fixed, because the child's stderr can echo the spoken text. */
const SYNTH_FAILED = 'The speech engine could not read that aloud.';
/**
 * The platform baseline the locks were resolved for (`scripts/generate-voice-locks.mjs` TARGETS: macosx_14_0 and the
 * manylinux_2_28 tag). Older machines are refused in status; Linux on musl has no wheels and is unsupported.
 */
export const TTS_MIN_PLATFORM = { darwin: { macos: 14, darwinMajor: 23 }, linux: { glibc: [2, 28] as const } } as const;

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
  if (buf.readUInt32LE(4) + 8 !== buf.length) return 'the RIFF size does not match the length of the file';
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

export interface PythonInfo {
  path: string;
  version: string;
  minor: number;
  /** `platform.machine()` as this Python reports it (an x86_64 Python under Rosetta says x86_64 on an arm64 Mac). */
  machine?: string;
}

/**
 * What `<cmd>` is as a CPython 3 interpreter; null when it does not run or is not CPython 3. Run isolated (`-I`) with
 * `cwd` (the voice dir), so no file of the daemon's working directory is ever imported.
 */
export async function probePython(cmd: string, cwd: string, options: { signal?: AbortSignal; spawn?: VoiceSpawn; timeoutMs?: number } = {}): Promise<PythonInfo | null> {
  try {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(childEnvWithBootEstateDb(process.env))) if (v !== undefined && !k.startsWith('PYTHON')) env[k] = v;
    const r = await runChild(cmd, ['-I', '-c', 'import sys,platform;print(platform.python_implementation(), sys.version_info[0], sys.version_info[1], sys.version.split()[0], platform.machine(), sys.executable)'],
      { env, timeoutMs: options.timeoutMs ?? 5000, ...(options.signal === undefined ? {} : { signal: options.signal }) }, options.spawn ?? (nodeSpawn as VoiceSpawn), cwd);
    if (r.code !== 0) return null;
    const m = /^CPython (\d+) (\d+) (\S+) (\S+) (.+)$/m.exec(r.stdout);
    if (m === null || m[1] !== '3') return null;
    return { path: m[5]!.trim() === '' ? cmd : m[5]!.trim(), version: m[3]!, minor: Number(m[2]), machine: m[4]! };
  } catch {
    return null;
  }
}

/** Node's names (arm64, x64) for what `platform.machine()` reports; null for any other processor. */
export function archOfMachine(machine: string): string | null {
  const m = machine.toLowerCase();
  if (m === 'arm64' || m === 'aarch64') return 'arm64';
  if (m === 'x86_64' || m === 'amd64') return 'x64';
  return null;
}

/** The glibc this Node runs on ("2.35"), null on musl or when it cannot be told. */
function glibcRuntime(): string | null {
  try {
    const rep = process.report as unknown as { excludeNetwork: boolean; getReport(): unknown };
    const was = rep.excludeNetwork;
    rep.excludeNetwork = true;
    const header = (rep.getReport() as { header?: { glibcVersionRuntime?: string } }).header;
    rep.excludeNetwork = was;
    return header?.glibcVersionRuntime ?? null;
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
  fetch?: typeof fetch;
  spawn?: VoiceSpawn;
  exists?: (p: string) => boolean;
  /** CPython interpreter facts for a command, probed with `cwd` as its working directory; tests stand it in. */
  probe?: (cmd: string, cwd: string, signal?: AbortSignal) => PythonInfo | null | Promise<PythonInfo | null>;
  /** `os.release()` (the Darwin kernel version on a Mac) and the glibc version; tests stand them in. */
  osRelease?: () => string;
  glibc?: () => string | null;
  now?: () => number;
  locksDir?: string;
  timeoutMs?: number;
  installTimeoutMs?: number;
  downloadTimeoutMs?: number;
  downloadIdleMs?: number;
  maxWavBytes?: number;
  voices?: readonly TtsVoice[];
}

interface RunResult { code: number | null; stdout: string; stderr: string }
interface Picked { python: PythonInfo | null; lock: string | null; problem: string | null }

export class TtsService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly plat: NodeJS.Platform;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: VoiceSpawn;
  private readonly exists: (p: string) => boolean;
  private readonly probe: (cmd: string, cwd: string, signal?: AbortSignal) => PythonInfo | null | Promise<PythonInfo | null>;
  private readonly release: () => string;
  private readonly glibc: () => string | null;
  private readonly now: () => number;
  private readonly locksDir: string;
  private readonly timeoutMs: number;
  private readonly installTimeoutMs: number;
  private readonly downloadMs: number;
  private readonly idleMs: number;
  private readonly maxWav: number;
  private readonly voices: readonly TtsVoice[];
  private installState: TtsInstallState | null = null;
  private inflight: { gen: number; abort: AbortController; done: Promise<void> } | null = null;
  private gen = 0;
  private busy = false;
  private waiting: Array<() => void> = [];
  /** The last Python probe: kept for a minute, dropped on install and on remove. */
  private picked: { at: number; value: Picked } | null = null;
  private picking: Promise<Picked> | null = null;
  private probeRound = 0;
  private readonly probes = new Set<{ abort: AbortController; done: Promise<unknown> }>();
  private readonly dir: string;
  /** Syntheses in flight: removal cancels them and waits for each to finish its cleanup. */
  /** Bumped by every removal: a synthesis that queued before it never starts after it. */
  private epoch = 0;
  private removing = 0;
  private readonly synths = new Set<{ abort: AbortController; done: Promise<unknown> }>();

  constructor(deps: TtsDeps) {
    this.dir = resolve(deps.dir);
    this.env = { ...(deps.env ?? process.env) };
    const python = this.env['WICKED_CREW_PYTHON'];
    if (python !== undefined && /[\\/]/.test(python)) this.env['WICKED_CREW_PYTHON'] = resolve(python);
    this.plat = deps.platform ?? osPlatform();
    this.fetchImpl = deps.fetch ?? fetch;
    this.spawnImpl = deps.spawn ?? (nodeSpawn as VoiceSpawn);
    this.exists = deps.exists ?? existsSync;
    this.probe = deps.probe ?? ((cmd, cwd, signal) => probePython(cmd, cwd, { ...(signal === undefined ? {} : { signal }), spawn: this.spawnImpl }));
    this.release = deps.osRelease ?? osRelease;
    this.glibc = deps.glibc ?? glibcRuntime;
    this.now = deps.now ?? Date.now;
    this.locksDir = deps.locksDir ?? LOCKS_DIR;
    this.timeoutMs = deps.timeoutMs ?? TTS_TIMEOUT_MS;
    this.installTimeoutMs = deps.installTimeoutMs ?? TTS_INSTALL_TIMEOUT_MS;
    this.downloadMs = deps.downloadTimeoutMs ?? TTS_DOWNLOAD_TIMEOUT_MS;
    this.idleMs = deps.downloadIdleMs ?? TTS_DOWNLOAD_IDLE_MS;
    this.maxWav = deps.maxWavBytes ?? TTS_MAX_WAV_BYTES;
    this.voices = deps.voices ?? TTS_VOICES;
  }

  private root(): string { return join(this.dir, 'tts'); }
  private enginePath(): string { return join(this.root(), 'engine'); }
  private enginePython(root: string = this.enginePath()): string { return join(root, 'bin', 'python'); }
  private voiceDir(id: string): string { return join(this.root(), 'voices', id); }
  private samplePath(id: string): string { return join(this.root(), 'sample', `${id}-${TTS_ENGINE.version}.wav`); }

  /** Resolves when the install in flight (if any) has finished, whatever its outcome. */
  installDone(): Promise<void> { return this.inflight?.done ?? Promise.resolve(); }

  /**
   * The Python this machine will use: `WICKED_CREW_PYTHON`, else the first of python3, python3.14 ... python3.9 with a
   * lock. Probed asynchronously and kept for a minute (`fresh` re-probes: install, remove).
   */
  async pickPython(fresh = false): Promise<Picked> {
    if (this.removing > 0) return { python: null, lock: null, problem: 'The speech engine is being removed.' };
    if (!fresh && this.picked !== null && this.now() - this.picked.at < TTS_PROBE_TTL_MS) return this.picked.value;
    if (!fresh && this.picking !== null) return this.picking;
    const round = ++this.probeRound;
    this.picked = null;
    const entry = { abort: new AbortController(), done: Promise.resolve<unknown>(undefined) };
    const run = this.probeAll(entry.abort.signal).then((value) => {
      if (round === this.probeRound) this.picked = { at: this.now(), value };
      return value;
    }).finally(() => { this.probes.delete(entry); if (this.picking === run) this.picking = null; });
    entry.done = run;
    this.probes.add(entry);
    this.picking = run;
    return run;
  }

  private async probeAll(signal: AbortSignal): Promise<Picked> {
    const set = this.env['WICKED_CREW_PYTHON'];
    const wanted = set !== undefined && set.trim() !== '' ? set : null;
    const names = wanted !== null ? [wanted] : ['python3', ...[...TTS_PYTHON_MINORS].reverse().map((n) => `python3.${n}`)];
    let skipped: PythonInfo | null = null;
    let badArch: string | null = null;
    for (const name of names) {
      if (signal.aborted) break;
      const info = await this.probe(name, this.dir, signal);
      if (signal.aborted) break;
      if (info === null) continue;
      // The lock follows the processor the Python itself runs on (Rosetta: an x86_64 Python on an arm64 Mac).
      const arch = info.machine === undefined ? null : archOfMachine(info.machine);
      if (info.machine !== undefined && arch === null) { badArch ??= info.machine; continue; }
      const lock = arch === null ? null : lockPath(this.plat, arch, info.minor, this.locksDir);
      if (lock !== null && this.exists(lock)) return { python: info, lock, problem: null };
      skipped ??= info;
    }
    if (badArch !== null && skipped === null) {
      return { python: null, lock: null, problem: `The ${badArch} processor is not supported for text to speech (arm64 and x86_64 only).` };
    }
    if (skipped !== null) {
      const arch = skipped.machine === undefined ? null : archOfMachine(skipped.machine);
      if (arch !== null && lockPath(this.plat, arch, skipped.minor, this.locksDir) === null && (TTS_PYTHON_MINORS as readonly number[]).includes(skipped.minor)) {
        return { python: null, lock: null, problem: `Python ${skipped.version} at ${skipped.path} is not supported on this machine: the speech engine has no build for it on an Intel Mac. Use Python 3.9 to 3.13 (WICKED_CREW_PYTHON names one).` };
      }
      return { python: null, lock: null, problem: `Python ${skipped.version} at ${skipped.path} is not supported: voice needs CPython 3.9 to 3.14. ${pythonHint(this.plat)}` };
    }
    const why = wanted !== null ? `WICKED_CREW_PYTHON (${wanted}) is not a working CPython 3.` : 'No Python 3 was found on this machine.';
    return { python: null, lock: null, problem: `${why} ${pythonHint(this.plat)}` };
  }

  /** The OS is one with a lock, and new enough for the wheels the locks were resolved for. */
  private platformProblem(): string | null {
    if (!SUPPORTED_OS.has(this.plat)) {
      return this.plat === 'win32'
        ? 'Native Windows is not supported for text to speech; use WSL2 (Linux).'
        : `${this.plat} is not supported for text to speech (macOS and Linux only).`;
    }
    if (this.plat === 'darwin') {
      const major = Number.parseInt(this.release(), 10);
      if (Number.isFinite(major) && major < TTS_MIN_PLATFORM.darwin.darwinMajor) {
        return `This Mac is older than macOS ${TTS_MIN_PLATFORM.darwin.macos}, which the speech engine needs. Update macOS to use text to speech.`;
      }
    } else {
      const glibc = this.glibc();
      const need = TTS_MIN_PLATFORM.linux.glibc;
      if (glibc === null) return 'This Linux uses musl, not glibc; the speech engine has no build for it (use a glibc distribution such as Debian or Ubuntu).';
      const [maj, min] = glibc.split('.').map((n) => Number.parseInt(n, 10));
      if (Number.isFinite(maj) && Number.isFinite(min) && (maj! < need[0] || (maj === need[0] && min! < need[1]))) {
        return `This Linux has glibc ${glibc}; the speech engine needs glibc ${need[0]}.${need[1]} or newer (Debian 10, Ubuntu 20.04 or later).`;
      }
    }
    return null;
  }

  private engineInstalled(): boolean { return this.exists(this.enginePython()); }

  private voiceInstalled(v: TtsVoice): boolean {
    return this.exists(join(this.voiceDir(v.id), basename(v.model.path))) && this.exists(join(this.voiceDir(v.id), basename(v.config.path)));
  }

  async status(): Promise<TtsStatusBody> {
    const platformProblem = this.platformProblem();
    const picked: Picked = platformProblem === null ? await this.pickPython() : { python: null, lock: null, problem: null };
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
   * Install the engine if missing, then the named voices. Resolves at once; `status().install` reports it. Only
   * manifest voices are accepted (400 `voice_unknown`); an unsupported machine is 409 `voice_tts_unsupported`.
   */
  async startInstall(ids: readonly string[]): Promise<{ started: boolean }> {
    const wanted = ids.map((id) => this.voiceById(id));
    if (this.removing > 0) throw new VoiceError(409, 'voice_tts_missing', 'The speech engine is being removed.');
    if (this.inflight !== null) throw new VoiceError(409, 'voice_install_running', 'The speech install is already running.');
    const before = this.epoch;
    const problem = this.platformProblem() ?? (await this.pickPython(true)).problem;
    // DELETE fences on its own epoch: an install also bumps gen.
    if (this.removing > 0 || this.epoch !== before) throw new VoiceError(409, 'voice_tts_missing', 'The speech engine is being removed.');
    if (this.inflight !== null) throw new VoiceError(409, 'voice_install_running', 'The speech install is already running.');
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
    const picked = await this.pickPython(true);
    if (picked.python === null || picked.lock === null) throw new Error(picked.problem ?? 'No usable Python.');
    const tmp = join(this.root(), `engine.tmp-${randomBytes(4).toString('hex')}`);
    try {
      const venv = await this.run(picked.python.path, ['-I', '-m', 'venv', tmp], { env: this.childEnv(), timeoutMs: this.installTimeoutMs, signal });
      if (venv.code !== 0) throw new Error(`Creating the Python environment failed. ${pythonHint(this.plat)}`);
      const pip = await this.run(this.enginePython(tmp), [
        '-I', '-m', 'pip', 'install', '--isolated', '--index-url', TTS_ENGINE.index, '--only-binary=:all:', '--require-hashes', '--no-deps', '-r', picked.lock,
      ], { env: this.childEnv({ PIP_CONFIG_FILE: '/dev/null', PIP_DISABLE_PIP_VERSION_CHECK: '1' }), timeoutMs: this.installTimeoutMs, signal });
      if (pip.code !== 0) throw new Error(`Installing ${TTS_ENGINE.name} ${TTS_ENGINE.version} failed: pip refused the hash-locked install. Check the connection to pypi.org and try again.`);
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

  /**
   * One voice file: an overall deadline and an idle deadline on the body, every redirect hop https, and the bytes held
   * to the manifest's size and sha256. Any failure leaves no `.part`.
   */
  private async fetchVoiceFile(file: TtsVoiceFile, dest: string, signal: AbortSignal): Promise<void> {
    const part = `${dest}.part`;
    const name = basename(file.path);
    const stop = new AbortController();
    let why: string | null = null;
    const halt = (reason: string): void => { why ??= reason; stop.abort(); };
    const overall = setTimeout(() => halt(`The voice download of ${name} took longer than ${Math.round(this.downloadMs / 1000)} s and was stopped.`), this.downloadMs);
    let idle: NodeJS.Timeout | null = null;
    const touch = (): void => {
      if (idle !== null) clearTimeout(idle);
      idle = setTimeout(() => halt(`The voice download of ${name} stalled (no data for ${Math.round(this.idleMs / 1000)} s) and was stopped.`), this.idleMs);
    };
    const linked = AbortSignal.any([signal, stop.signal]);
    const aborted = new Promise<never>((_, reject) => {
      linked.addEventListener('abort', () => reject(new Error(why ?? 'The install was cancelled.')), { once: true });
    });
    aborted.catch(() => undefined);
    let res: Response | null = null;
    try {
      touch();
      let url = ttsVoiceUrl(file);
      for (let hop = 0; hop <= TTS_MAX_REDIRECTS; hop++) {
        if (new URL(url).protocol !== 'https:') throw new Error(`The voice download for ${name} was refused: it is not https.`);
        const r = await Promise.race([this.fetchImpl(url, { redirect: 'manual', signal: linked }), aborted]);
        if (r.status >= 300 && r.status < 400) {
          const loc = r.headers.get('location');
          void r.body?.cancel().catch(() => undefined);
          if (loc === null) throw new Error(`The voice download answered ${r.status} with no place to go.`);
          url = new URL(loc, url).toString();
          continue;
        }
        res = r;
        break;
      }
      if (res === null) throw new Error(`The voice download for ${name} was redirected too many times.`);
      if (!res.ok || res.body === null) throw new Error(`The voice download answered ${res.status}.`);
      const hash = createHash('sha256');
      let size = 0;
      const count = new Transform({
        transform: (chunk: Buffer, _enc, cb) => {
          touch();
          size += chunk.length;
          if (size > file.bytes) return cb(new Error(`The voice file ${name} is larger than its published size (${file.bytes} bytes); nothing was kept.`));
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      try {
        await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>), count, createWriteStream(part), { signal: linked });
      } catch (e) {
        throw why !== null ? new Error(why) : e;
      }
      const got = hash.digest('hex');
      if (size !== file.bytes) throw new Error(`The voice file ${name} is ${size} bytes, not its published ${file.bytes}; nothing was kept.`);
      if (got !== file.sha256) throw new Error(`The voice file ${name} did not match its published checksum (got sha256 ${got}); nothing was kept.`);
      renameSync(part, dest);
    } catch (e) {
      rmSync(part, { force: true });
      throw e;
    } finally {
      stop.abort();
      if (res?.body !== null && res?.body !== undefined && !res.body.locked) void res.body.cancel().catch(() => undefined);
      clearTimeout(overall);
      if (idle !== null) clearTimeout(idle);
    }
  }

  /** Remove the engine, the voices and the cached samples. An install in flight is cancelled first. */
  async remove(): Promise<{ removed: boolean }> {
    this.gen += 1;
    this.epoch += 1;
    this.removing += 1;
    this.probeRound += 1;
    this.picking = null;
    this.picked = null;
    try {
      const install = this.inflight;
      install?.abort.abort();
      for (const p of this.probes) p.abort.abort();
      for (const s of this.synths) s.abort.abort();
      // The files go only after every child has closed: no descendant can write into a directory being removed.
      await Promise.allSettled([install?.done, ...[...this.probes].map((x) => x.done), ...[...this.synths].map((x) => x.done)]);
      this.inflight = null;
      this.installState = null;
      this.picked = null;
      const had = this.exists(this.root());
      rmSync(this.root(), { recursive: true, force: true });
      return { removed: had };
    } finally {
      this.removing -= 1;
    }
  }

  /** Speak `text` in `voice`; the WAV bytes. Nothing about the text is kept. */
  async speak(text: string, voice: string): Promise<Buffer> {
    const v = this.voiceById(voice);
    this.ready(v);
    const line = normalizeSpeakText(text);
    if (line === '') throw new VoiceError(400, 'voice_text_empty', 'There is nothing to read aloud.');
    const epoch = this.epoch;
    return this.exclusive(async () => {
      this.ready(v, epoch);
      return this.synthesize(v, line);
    });
  }

  /** A fixed sentence in `voice`, cached per (voice, piper version); a cached one is re-verified on every read. */
  async sample(voice: string): Promise<Buffer> {
    const v = this.voiceById(voice);
    this.ready(v);
    const epoch = this.epoch;
    return this.exclusive(async () => {
      this.ready(v, epoch);
      const cached = this.samplePath(v.id);
      const sum = `${cached}.sha256`;
      if (this.exists(cached)) {
        try {
          const st = lstatSync(cached);
          if (!st.isFile() || st.size > this.maxWav) throw new Error('Invalid cached sample.');
          const wav = readFileSync(cached);
          if (ttsWavProblem(wav) === null && readFileSync(sum, 'utf8').trim() === createHash('sha256').update(wav).digest('hex')) return wav;
        } catch { /* unreadable or unrecorded: re-made below */ }
        rmSync(cached, { recursive: true, force: true });
        rmSync(sum, { force: true });
      }
      const wav = await this.synthesize(v, TTS_SAMPLE_TEXT);
      mkdirSync(dirname(cached), { recursive: true });
      const part = `${cached}.part`;
      writeFileSync(part, wav);
      writeFileSync(sum, createHash('sha256').update(wav).digest('hex'));
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
  private ready(v: TtsVoice, epoch: number = this.epoch): void {
    if (this.removing > 0 || epoch !== this.epoch) throw new VoiceError(409, 'voice_tts_missing', 'The speech engine is being removed.');
    if (!this.engineInstalled()) throw new VoiceError(409, 'voice_tts_missing', 'The speech engine is not installed; install it first (it needs your consent).');
    if (!this.voiceInstalled(v)) throw new VoiceError(409, 'voice_tts_missing', `The voice ${v.id} is not installed; install it first.`);
  }

  /**
   * Piper writes into a fresh private directory; the output must be a regular file (lstat, so a symlink or a device
   * is refused), before and while its size is watched. The directory goes only after the child has closed.
   */
  private synthesize(v: TtsVoice, line: string): Promise<Buffer> {
    const entry = { abort: new AbortController(), done: Promise.resolve<unknown>(undefined) };
    const run = this.synthesizeIn(v, line, entry.abort.signal);
    entry.done = run.catch(() => undefined).finally(() => this.synths.delete(entry));
    this.synths.add(entry);
    return run;
  }

  private async synthesizeIn(v: TtsVoice, line: string, signal: AbortSignal): Promise<Buffer> {
    const workDir = join(this.root(), 'work');
    mkdirSync(workDir, { recursive: true });
    const scratch = mkdtempSync(join(workDir, 's-'));
    const out = join(scratch, 'out.wav');
    try {
      const r = await this.run(this.enginePython(), [
        '-I', '-m', 'piper', '-m', join(this.voiceDir(v.id), basename(v.model.path)), '-c', join(this.voiceDir(v.id), basename(v.config.path)), '-f', out,
      ], { env: this.childEnv(), timeoutMs: this.timeoutMs, stdin: `${line}\n`, signal, cancelled: () => new VoiceError(409, 'voice_tts_missing', 'The speech engine was removed while it was reading.'), watch: { file: out, maxBytes: this.maxWav } });
      // The child's stderr can echo the spoken text: it is never put in an error.
      if (r.code !== 0) throw new VoiceError(500, 'voice_tts_failed', SYNTH_FAILED);
      const st = lstatOrNull(out);
      if (st === null) throw new VoiceError(500, 'voice_tts_failed', 'piper wrote no audio.');
      if (!st.isFile()) throw new VoiceError(500, 'voice_tts_failed', 'piper wrote its output as something other than a plain file; it was refused.');
      if (st.size > this.maxWav) throw new VoiceError(500, 'voice_tts_failed', 'The audio is larger than the limit and was dropped.');
      const wav = readFileSync(out);
      const problem = ttsWavProblem(wav);
      if (problem !== null) throw new VoiceError(500, 'voice_tts_failed', `piper wrote audio that is not a usable WAV (${problem}).`);
      return wav;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  /**
   * Run a child with argv only (never a shell), in its own process group, with the voice dir as its cwd; stdout and
   * stderr each capped. A timeout, a cancel or an output file that passes a limit kills the whole group, and the
   * promise settles only on the child's `close`, so no descendant can write after the caller cleans up.
   */
  private run(command: string, args: readonly string[], o: RunOptions): Promise<RunResult> {
    return runChild(command, args, o, this.spawnImpl, this.dir);
  }
}

interface RunOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  stdin?: string;
  signal?: AbortSignal;
  cancelled?: () => Error;
  watch?: { file: string; maxBytes: number };
}

/** Shared by probes, installers and synthesis: kill the group, then await close. */
function runChild(command: string, args: readonly string[], o: RunOptions, spawnImpl: VoiceSpawn, cwd: string): Promise<RunResult> {
  mkdirSync(cwd, { recursive: true });
  return new Promise<RunResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnImpl(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: true, cwd, env: childEnvWithBootEstateDb(o.env) });
    } catch {
      reject(new VoiceError(500, 'voice_tts_failed', 'Could not start the speech engine.'));
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const held = { out: 0, err: 0 };
    let settled = false;
    let pending: Error | null = null;
    let watcher: NodeJS.Timeout | null = null;
    const finish = (f: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (watcher !== null) clearInterval(watcher);
      o.signal?.removeEventListener('abort', onAbort);
      f();
    };
    const kill = (): void => {
      try {
        if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    };
    /** Record why, kill the group, and wait for `close` to settle. */
    const stop = (e: Error): void => {
      if (settled || pending !== null) return;
      pending = e;
      clearTimeout(timer);
      if (watcher !== null) clearInterval(watcher);
      kill();
    };
    const timer = setTimeout(() => stop(new VoiceError(504, 'voice_timeout', `Reading aloud took longer than ${Math.round(o.timeoutMs / 1000)} s and was stopped.`)), o.timeoutMs);
    const onAbort = (): void => stop(o.cancelled?.() ?? new Error('The install was cancelled.'));
    o.signal?.addEventListener('abort', onAbort, { once: true });
    if (o.signal?.aborted === true) onAbort();
    if (o.watch !== undefined) {
      const { file, maxBytes } = o.watch;
      watcher = setInterval(() => {
        const st = lstatOrNull(file);
        if (st === null) return;
        if (!st.isFile()) stop(new VoiceError(500, 'voice_tts_failed', 'piper wrote its output as something other than a plain file; it was refused.'));
        else if (st.size > maxBytes) stop(new VoiceError(500, 'voice_tts_failed', 'The audio grew past its size limit and was stopped.'));
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
    child.on('error', () => { pending ??= new VoiceError(500, 'voice_tts_failed', 'Could not start the speech engine.'); });
    child.on('close', (code) => finish(() => {
      if (pending !== null) reject(pending);
      else resolve({ code, stdout: decodeCapped(out), stderr: decodeCapped(err) });
    }));
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(o.stdin ?? '');
  });
}

function lstatOrNull(p: string): Stats | null {
  try { return lstatSync(p); } catch { return null; }
}

/** Buffers cut at a byte cap, decoded as UTF-8; StringDecoder without `end()` drops a torn trailing character. */
function decodeCapped(chunks: Buffer[]): string {
  return new StringDecoder('utf8').write(Buffer.concat(chunks));
}
