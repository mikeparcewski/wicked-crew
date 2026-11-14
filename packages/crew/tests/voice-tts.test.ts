// Text to speech (studio#1140, slice 1): the consented piper install, the voice files held to their checksums, and
// the local synthesis. Every edge is stubbed: no Python, no pip, no network, no real cache dir.

import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { TTS_ENGINE, TTS_VOICES, ttsVoiceUrl, type TtsVoice } from '../src/voice/tts-manifest.js';
import { TTS_MIN_PLATFORM, TtsService, lockPath, normalizeSpeakText, probePython, ttsWavProblem, type PythonInfo, type TtsDeps } from '../src/voice/tts.js';
import { VoiceError, type VoiceSpawn } from '../src/voice/service.js';
import { registerVoiceRoutes } from '../src/voice/routes.js';
import { registerServerErrorBody } from '../src/api/server-error-body.js';
import type { AuditLog } from '../src/api/audit.js';
import type { Actor } from '../src/core/types.js';

// Suite-wide: the package directory holds no new entry once every test in this file has run, whichever test leaked.
let packageDirAtStart: string[] = [];
beforeAll(() => { packageDirAtStart = readdirSync(process.cwd()).sort(); });
afterAll(() => {
  const added = readdirSync(process.cwd()).filter((n) => !packageDirAtStart.includes(n));
  expect(added, `new entries in the package directory: ${added.join(', ')}`).toEqual([]);
});

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function wav(samples = 1600): Buffer {
  const data = Buffer.alloc(samples * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(22050, 24); h.writeUInt32LE(44100, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii'); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

interface FakeChild extends EventEmitter { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: (s?: string) => boolean }
interface Call { command: string; args: string[]; env: NodeJS.ProcessEnv; stdin: string; cwd?: string | undefined; detached?: boolean | undefined }
type Behaviour = (call: Call) => { code?: number; stderr?: string; hang?: boolean } | void;

/** A process stand-in: records the call, runs `behave` once its stdin closes. */
function fakeSpawn(behave: Behaviour) {
  const calls: Call[] = [];
  const live = { now: 0, max: 0 };
  const spawn = vi.fn((command: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string; detached?: boolean }) => {
    const child = new EventEmitter() as FakeChild;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { live.now -= 1; setImmediate(() => child.emit('close', null)); return true; };
    const chunks: Buffer[] = [];
    child.stdin.on('data', (c: Buffer) => chunks.push(c));
    child.stdin.on('finish', () => {
      const call: Call = { command, args: [...args], env: opts.env ?? {}, cwd: opts.cwd, detached: opts.detached, stdin: Buffer.concat(chunks).toString('utf8') };
      calls.push(call);
      live.now += 1; live.max = Math.max(live.max, live.now);
      const r = behave(call) ?? {};
      if (r.hang === true) return;
      setTimeout(() => { live.now -= 1; child.stderr.end(r.stderr ?? ''); child.stdout.end(''); child.emit('close', r.code ?? 0); }, 5);
    });
    return child;
  });
  return { spawn: spawn as unknown as VoiceSpawn, calls, live };
}

const PY: PythonInfo = { path: '/usr/bin/python3', version: '3.12.1', minor: 12, machine: 'x86_64' };

let dir: string;
let locks: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tts-'));
  locks = join(dir, 'locks');
  mkdirSync(locks);
  writeFileSync(join(locks, 'linux-x64-cp312.txt'), 'piper-tts==1.8.0 \\\n    --hash=sha256:aa\n');
  writeFileSync(join(locks, 'linux-x64-cp311.txt'), 'piper-tts==1.8.0 \\\n    --hash=sha256:aa\n');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** Two tiny voices whose files hash to what the stub fetch serves. */
const BODIES = new Map<string, Buffer>();
function testVoice(id: string): TtsVoice {
  const model = Buffer.from(`model-${id}`);
  const config = Buffer.from(`{"id":"${id}"}`);
  BODIES.set(ttsVoiceUrl({ path: `${id}.onnx`, sha256: '', bytes: 0 }), model);
  BODIES.set(ttsVoiceUrl({ path: `${id}.onnx.json`, sha256: '', bytes: 0 }), config);
  return {
    id, name: id, accent: 'test', licence: 'CC0', clearance: { basis: 'test', reviewed: '2026-11-12' },
    model: { path: `${id}.onnx`, sha256: sha(model), bytes: model.length },
    config: { path: `${id}.onnx.json`, sha256: sha(config), bytes: config.length },
  };
}
const VOICE_A = testVoice('en_test-a');
const VOICE_B = testVoice('en_test-b');

const okFetch = (async (url: string) => {
  const body = BODIES.get(url);
  return body === undefined ? new Response('no', { status: 404 }) : new Response(new Uint8Array(body), { status: 200 });
}) as unknown as typeof fetch;

/** `venv` creates <dir>/bin/python; `pip` and piper follow `extra`. */
function installSpawn(extra: Behaviour = () => undefined) {
  return fakeSpawn((call) => {
    if (call.args[0] === '-I' && call.args[1] === '-m' && call.args[2] === 'venv') {
      const target = call.args[3]!;
      mkdirSync(join(target, 'bin'), { recursive: true });
      writeFileSync(join(target, 'bin', 'python'), '');
      return;
    }
    return extra(call);
  });
}

function service(extra: Partial<TtsDeps> = {}): TtsService {
  return new TtsService({
    dir, locksDir: locks, platform: 'linux', osRelease: () => '23.6.0', glibc: () => '2.35', env: { PATH: '/usr/bin', PIP_INDEX_URL: 'https://evil.example', PYTHONPATH: '/x' },
    probe: (cmd) => (cmd === 'python3' ? PY : null), fetch: okFetch, voices: [VOICE_A, VOICE_B], ...extra,
  });
}

/** The engine and a voice, as an install leaves them. */
function installed(s: TtsService, voice: TtsVoice = VOICE_A): void {
  void s;
  mkdirSync(join(dir, 'tts', 'engine', 'bin'), { recursive: true });
  writeFileSync(join(dir, 'tts', 'engine', 'bin', 'python'), '');
  mkdirSync(join(dir, 'tts', 'voices', voice.id), { recursive: true });
  writeFileSync(join(dir, 'tts', 'voices', voice.id, `${voice.id}.onnx`), 'm');
  writeFileSync(join(dir, 'tts', 'voices', voice.id, `${voice.id}.onnx.json`), 'c');
}

/**
 * The output path of a piper launch: the argument after `-f`, and only for an argv that is a piper launch
 * (`-I -m piper ... -f <out>`). Any other argv is a test bug and fails loudly, never a stray file named after an entry.
 */
function outputArg(args: readonly string[]): string {
  const f = args.indexOf('-f');
  if (args[0] !== '-I' || args[1] !== '-m' || args[2] !== 'piper' || f < 0 || args[f + 1] === undefined || args[f + 1]!.startsWith('-')) {
    throw new Error(`unexpected argv for a piper stand-in: ${args.join(' ')}`);
  }
  return args[f + 1]!;
}

/** A piper stand-in: writes `out` to the `-f` file. */
function piper(out: () => Buffer | null, seen: Call[] = []): Behaviour {
  return (call) => {
    seen.push(call);
    const o = out();
    if (o !== null) writeFileSync(outputArg(call.args), o);
  };
}

describe('tts install', () => {
  it('runs pip hash-locked, isolated, binary-only, from one index, with no config file', async () => {
    const { spawn, calls } = installSpawn();
    const s = service({ spawn });
    expect(await s.startInstall([VOICE_A.id])).toEqual({ started: true });
    await s.installDone();
    const pip = calls.find((c) => c.args.includes('pip'))!;
    expect(pip.command).toMatch(/\/tts\/engine\.tmp-[0-9a-f]+\/bin\/python$/);
    for (const flag of ['--isolated', '--only-binary=:all:', '--require-hashes', '--no-deps']) expect(pip.args).toContain(flag);
    expect(pip.args.filter((a) => a === '--index-url')).toHaveLength(1);
    expect(pip.args[pip.args.indexOf('--index-url') + 1]).toBe('https://pypi.org/simple');
    expect(pip.args.slice(pip.args.indexOf('-r'))).toEqual(['-r', join(locks, 'linux-x64-cp312.txt')]);
    expect(pip.env['PIP_CONFIG_FILE']).toBe('/dev/null');
    expect(pip.env['PIP_INDEX_URL']).toBeUndefined();
    expect(pip.env['PYTHONPATH']).toBeUndefined();
    // the venv is made by the machine's Python, then renamed into place
    expect(calls[0]!.command).toBe(PY.path);
    expect(existsSync(join(dir, 'tts', 'engine', 'bin', 'python'))).toBe(true);
    expect(readdirSync(join(dir, 'tts')).filter((n) => n.includes('.tmp-'))).toEqual([]);
    const st = await s.status();
    expect(st.install).toBeNull();
    expect(st.voices[VOICE_A.id]!.installed).toBe(true);
    expect(st.voices[VOICE_B.id]!.installed).toBe(false);
  });

  it('a failed pip leaves no venv and says why', async () => {
    const { spawn } = installSpawn((c) => (c.args.includes('pip') ? { code: 1, stderr: 'ERROR: THESE PACKAGES DO NOT MATCH THE HASHES' } : undefined));
    const s = service({ spawn });
    await s.startInstall([VOICE_A.id]);
    await s.installDone();
    expect(readdirSync(join(dir, 'tts'))).toEqual([]);
    const st = await s.status();
    expect(st.install).toMatchObject({ state: 'failed', step: 'engine' });
    expect(st.install!.error).toMatch(/pip refused/);
    expect(st.install!.error).not.toContain('DO NOT MATCH'); // a child's stderr never reaches an error
    expect(st.engine.found).toBe(false);
  });

  it('a failed venv leaves nothing and names the remedy', async () => {
    const { spawn } = fakeSpawn(() => ({ code: 1, stderr: 'ensurepip is not available' }));
    const s = service({ spawn });
    await s.startInstall([VOICE_A.id]);
    await s.installDone();
    expect((await s.status()).install!.error).toContain('python3-venv');
    expect(existsSync(join(dir, 'tts', 'engine'))).toBe(false);
  });

  it('refuses a voice outside the manifest (400) and consent is required at the route', async () => {
    const s = service({ spawn: installSpawn().spawn });
    await expect(s.startInstall(['en_US-evil-high'])).rejects.toBeInstanceOf(VoiceError);
    const bad = await s.startInstall(['../../etc/passwd']).then(() => null, (e: unknown) => e as VoiceError);
    expect([bad?.status, bad?.code]).toEqual([400, 'voice_unknown']);
    const { app, audit } = await routes(s);
    const noConsent = await app.inject({ method: 'POST', url: '/api/v1/voice/tts', payload: { voices: [VOICE_A.id] } });
    expect(noConsent.statusCode).toBe(400);
    const falseConsent = await app.inject({ method: 'POST', url: '/api/v1/voice/tts', payload: { consent: false, voices: [VOICE_A.id] } });
    expect(falseConsent.statusCode).toBe(400);
    const unknown = await app.inject({ method: 'POST', url: '/api/v1/voice/tts', payload: { consent: true, voices: ['nope'] } });
    expect(unknown.statusCode).toBe(400);
    expect(audit.record).not.toHaveBeenCalled();
    const ok = await app.inject({ method: 'POST', url: '/api/v1/voice/tts', payload: { consent: true, voices: [VOICE_A.id] } });
    expect(ok.statusCode).toBe(202);
    expect(audit.record).toHaveBeenCalledWith('voice.tts.install_started', expect.anything(), expect.anything());
    await s.installDone();
    await app.close();
  });

  it('a voice whose sha256 or size mismatches keeps nothing', async () => {
    for (const bad of ['sha', 'size-short', 'size-long']) {
      rmSync(join(dir, 'tts'), { recursive: true, force: true });
      const body = BODIES.get(ttsVoiceUrl(VOICE_A.model))!;
      const served = bad === 'sha' ? Buffer.from(body.toString().replace('model', 'MODEL')) : bad === 'size-short' ? body.subarray(0, 3) : Buffer.concat([body, Buffer.from('x')]);
      const fetchBad = (async (url: string) => (url === ttsVoiceUrl(VOICE_A.model) ? new Response(new Uint8Array(served)) : okFetch(url))) as unknown as typeof fetch;
      const s = service({ spawn: installSpawn().spawn, fetch: fetchBad });
      await s.startInstall([VOICE_A.id]);
      await s.installDone();
      const failed = (await s.status()).install!;
      expect(failed.state).toBe('failed');
      expect(failed.error).toMatch(/nothing was kept/);
      const voices = join(dir, 'tts', 'voices');
      expect(readdirSync(voices)).toEqual([]);
    }
  });

  it('says plainly when the platform, architecture or Python is unsupported', async () => {
    const win = await service({ platform: 'win32' }).status();
    expect(win.supported).toMatchObject({ ok: false });
    expect(win.supported.reason).toMatch(/Windows is not supported/);
    expect((await service({ probe: () => ({ ...PY, machine: 'i686' }) }).status()).supported.ok).toBe(false);
    const none = await service({ probe: () => null }).status();
    expect(none.python.found).toBe(false);
    expect(none.supported.reason).toMatch(/No Python 3/);
    expect(none.supported.reason).toMatch(/apt install python3 python3-venv/);
    expect((await service({ probe: () => null, platform: 'darwin' }).status()).supported.reason).toMatch(/Python 3\.12 from python\.org or (with )?Homebrew/);
    const py315 = await service({ probe: () => ({ path: '/usr/bin/python3', version: '3.15.0', minor: 15, machine: 'x86_64' }) }).status();
    expect(py315.supported.ok).toBe(false);
    expect(py315.supported.reason).toMatch(/3\.15.*not supported/);
    await expect(service({ platform: 'win32' }).startInstall([VOICE_A.id])).rejects.toThrow(/Windows/);
  });

  it('picks Python by WICKED_CREW_PYTHON, then python3, python3.14 ... python3.9, skipping a minor without a lock', async () => {
    const probed: string[] = [];
    const table: Record<string, PythonInfo> = {
      python3: { path: '/p/python3', version: '3.13.0', minor: 13 }, // no cp313 lock in the fixture
      'python3.14': { path: '/p/python3.14', version: '3.14.0', minor: 14 }, // none either
      'python3.12': { path: '/p/python3.12', version: '3.12.0', minor: 12 },
      'python3.11': { path: '/p/python3.11', version: '3.11.0', minor: 11 },
      '/x/mine': { path: '/x/mine', version: '3.11.4', minor: 11 },
    };
    const probe = (c: string) => { probed.push(c); const t = table[c]; return t === undefined ? null : { ...t, machine: 'x86_64' }; };
    expect((await service({ probe }).pickPython()).python!.path).toBe('/p/python3.12');
    expect(probed).toEqual(['python3', 'python3.14', 'python3.13', 'python3.12']);
    probed.length = 0;
    const env = { PATH: '/usr/bin', WICKED_CREW_PYTHON: '/x/mine' };
    expect((await service({ probe, env }).pickPython()).python!.path).toBe('/x/mine');
    expect(probed).toEqual(['/x/mine']);
    const bad = await service({ probe, env: { ...env, WICKED_CREW_PYTHON: '/x/none' } }).pickPython();
    expect(bad.python).toBeNull();
    expect(bad.problem).toMatch(/WICKED_CREW_PYTHON/);
  });

  it('Intel Mac with Python 3.14 is unsupported and the person is told plainly', async () => {
    expect(lockPath('darwin', 'x64', 14)).toBeNull();
    expect(lockPath('darwin', 'arm64', 14)).not.toBeNull();
    const probe = () => ({ path: '/usr/local/bin/python3', version: '3.14.0', minor: 14, machine: 'x86_64' });
    const s = service({ platform: 'darwin', probe, locksDir: join(__dirname, '..', 'voice-locks') });
    const st = await s.status();
    expect(st.supported.ok).toBe(false);
    expect(st.supported.reason).toMatch(/3\.14.*not supported.*Intel Mac/);
    await expect(s.startInstall([VOICE_A.id])).rejects.toThrow(/Intel Mac/);
  });

  it('lockPath uses the names Node reports and refuses what has no lock', () => {
    expect(lockPath('linux', 'arm64', 12, '/l')).toBe('/l/linux-arm64-cp312.txt');
    expect(lockPath('darwin', 'x64', 9, '/l')).toBe('/l/darwin-x64-cp39.txt');
    expect(lockPath('win32', 'x64', 12)).toBeNull();
    expect(lockPath('linux', 'x64', 15)).toBeNull();
    expect(lockPath('linux', 'x64', 8)).toBeNull();
    expect(lockPath('linux', 'aarch64', 12)).toBeNull();
  });

  it('removes the engine and voices', async () => {
    const s = service({ spawn: installSpawn().spawn });
    await s.startInstall([VOICE_A.id]);
    await s.installDone();
    expect(await s.remove()).toEqual({ removed: true });
    expect(existsSync(join(dir, 'tts'))).toBe(false);
    expect(await s.remove()).toEqual({ removed: false });
  });
});

describe('tts text and synthesis', () => {
  it('normalizes control characters, line breaks, phoneme markup and length', () => {
    expect(normalizeSpeakText('a\u0000b\u0007c')).toBe('a b c');
    expect(normalizeSpeakText('one\ntwo\r\nthree\tfour')).toBe('one two three four');
    for (const t of ['[[x]]', '[[[x]]]', '[[[[a]]]] [[b]]', 'a[[', ']]b', '[[ [[']) expect(normalizeSpeakText(t)).not.toMatch(/\[\[|\]\]/);
    expect(normalizeSpeakText('[[x]]')).toContain('x');
    expect(normalizeSpeakText('keep [one] bracket')).toBe('keep [one] bracket');
    expect(normalizeSpeakText('a'.repeat(5000))).toHaveLength(2000);
    expect(normalizeSpeakText('  \n ')).toBe('');
  });

  it('sends the text to piper on stdin as one line, never in argv', async () => {
    const seen: Call[] = [];
    const s = service({ spawn: fakeSpawn(piper(() => wav(), seen)).spawn });
    installed(s);
    const text = '-m /etc/passwd --output_file x\nsecond [[ph]] line';
    const out = await s.speak(text, VOICE_A.id);
    expect(ttsWavProblem(out)).toBeNull();
    const c = seen[0]!;
    expect(c.args.slice(0, 3)).toEqual(['-I', '-m', 'piper']);
    expect(c.args.join(' ')).not.toContain('passwd');
    expect(c.args[c.args.indexOf('-m', 3) + 1]).toMatch(/en_test-a\.onnx$/);
    expect(c.args[c.args.indexOf('-c') + 1]).toMatch(/en_test-a\.onnx\.json$/);
    expect(c.stdin).toBe('-m /etc/passwd --output_file x second [ [ph] ] line\n');
    expect(c.stdin.trimEnd()).not.toContain('\n');
    // the temp file is gone
    expect(readdirSync(join(dir, 'tts', 'work'))).toEqual([]);
  });

  it('a timeout, an oversize file and a corrupt WAV each leave no file and answer an error', async () => {
    const cases: Array<[string, Partial<TtsDeps>, Behaviour, number, string]> = [
      ['timeout', { timeoutMs: 80 }, (c) => { writeFileSync(outputArg(c.args), wav()); return { hang: true }; }, 504, 'voice_timeout'],
      ['oversize while writing', { maxWavBytes: 1000 }, (c) => { writeFileSync(outputArg(c.args), wav(4000)); return { hang: true }; }, 500, 'voice_tts_failed'],
      ['oversize after exit', { maxWavBytes: 1000 }, piper(() => wav(4000)), 500, 'voice_tts_failed'],
      ['corrupt', {}, piper(() => Buffer.from('RIFF....garbage')), 500, 'voice_tts_failed'],
      ['empty audio', {}, piper(() => wav(0)), 500, 'voice_tts_failed'],
      ['no file', {}, () => undefined, 500, 'voice_tts_failed'],
      ['exit 1', {}, () => ({ code: 1, stderr: 'boom' }), 500, 'voice_tts_failed'],
    ];
    for (const [name, deps, behave, status, code] of cases) {
      const s = service({ spawn: fakeSpawn(behave).spawn, ...deps });
      installed(s);
      const err = await s.speak('hello', VOICE_A.id).then(() => null, (e: unknown) => e as VoiceError);
      expect(err, name).toBeInstanceOf(VoiceError);
      expect(err!.status, name).toBe(status);
      expect(err!.code, name).toBe(code);
      expect(readdirSync(join(dir, 'tts', 'work')), name).toEqual([]);
      rmSync(join(dir, 'tts'), { recursive: true, force: true });
    }
  });

  it('refuses a malformed PCM header and leaves no file', async () => {
    const bad = (mut: (b: Buffer) => void, trim = 0): Buffer => { const b = wav(); mut(b); return trim > 0 ? b.subarray(0, b.length - trim) : b; };
    const cases: Array<[string, Buffer]> = [
      ['bad blockAlign', bad((b) => b.writeUInt16LE(3, 32))],
      ['bad byteRate', bad((b) => b.writeUInt32LE(12345, 28))],
      ['zero channels', bad((b) => b.writeUInt16LE(0, 22))],
      ['zero sample rate', bad((b) => b.writeUInt32LE(0, 24))],
      ['odd bit depth', bad((b) => b.writeUInt16LE(12, 34))],
      ['data not whole blocks', bad((b) => b.writeUInt32LE(b.readUInt32LE(40) - 1, 40), 1)],
    ];
    for (const [name, out] of cases) {
      expect(ttsWavProblem(out), name).not.toBeNull();
      const s = service({ spawn: fakeSpawn(piper(() => out)).spawn });
      installed(s);
      const err = await s.speak('hello', VOICE_A.id).then(() => null, (e: unknown) => e as VoiceError);
      expect([err?.status, err?.code], name).toEqual([500, 'voice_tts_failed']);
      expect(readdirSync(join(dir, 'tts', 'work')), name).toEqual([]);
      rmSync(join(dir, 'tts'), { recursive: true, force: true });
    }
    expect(ttsWavProblem(wav())).toBeNull();
  });

  it('caps what piper may print in bytes, not characters', async () => {
    // a child that writes 30,000 three-byte characters on stderr (90,000 bytes)
    const spawn = vi.fn(() => {
      const c = new EventEmitter() as FakeChild;
      c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.kill = () => true;
      setImmediate(() => { c.stderr.write(Buffer.from('€'.repeat(30_000))); c.stderr.end(); setImmediate(() => c.emit('close', 1)); });
      return c;
    });
    const capped = service({ spawn: spawn as unknown as VoiceSpawn });
    const r = await (capped as unknown as { run: (c: string, a: string[], o: object) => Promise<{ stderr: string }> }).run('x', [], { env: {}, timeoutMs: 5000 });
    const bytes = Buffer.byteLength(r.stderr);
    expect(bytes).toBeLessThanOrEqual(65_536);
    expect(bytes).toBeGreaterThan(65_536 - 4);
    expect(r.stderr.length).toBeLessThan(30_000);
  });

  it('caps what piper may print', async () => {
    const big = 'x'.repeat(200_000);
    const s = service({ spawn: fakeSpawn(() => ({ code: 1, stderr: big })).spawn });
    installed(s);
    const err = await s.speak('hi', VOICE_A.id).then(() => null, (e: unknown) => e as VoiceError);
    expect(err!.message.length).toBeLessThan(1000);
  });

  it('refuses 409 voice_tts_missing when the engine or the voice is not installed, and 400 for an unknown voice', async () => {
    const s = service({ spawn: fakeSpawn(piper(() => wav())).spawn });
    const { app } = await routes(s);
    const speak = (voice: string) => app.inject({ method: 'POST', url: '/api/v1/voice/speak', payload: { text: 'hi', voice } });
    expect((await speak(VOICE_A.id)).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: `/api/v1/voice/tts/sample/${VOICE_A.id}` })).json()).toMatchObject({ code: 'voice_tts_missing' });
    installed(s, VOICE_A);
    expect((await speak(VOICE_A.id)).statusCode).toBe(200);
    const r = await speak(VOICE_B.id);
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('voice_tts_missing');
    expect((await speak('nope')).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/v1/voice/tts/sample/${VOICE_B.id}` })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/v1/voice/speak', payload: { text: 5, voice: VOICE_A.id } })).statusCode).toBe(400);
    await app.close();
  });

  it('answers audio/wav, and caches the sample per voice and piper version', async () => {
    const seen: Call[] = [];
    const s = service({ spawn: fakeSpawn(piper(() => wav(), seen)).spawn });
    installed(s);
    const { app } = await routes(s);
    const a = await app.inject({ method: 'POST', url: '/api/v1/voice/speak', payload: { text: 'hello', voice: VOICE_A.id } });
    expect(a.headers['content-type']).toBe('audio/wav');
    expect(ttsWavProblem(a.rawPayload)).toBeNull();
    const one = await app.inject({ method: 'GET', url: `/api/v1/voice/tts/sample/${VOICE_A.id}` });
    const two = await app.inject({ method: 'GET', url: `/api/v1/voice/tts/sample/${VOICE_A.id}` });
    expect(one.headers['content-type']).toBe('audio/wav');
    expect(two.rawPayload.equals(one.rawPayload)).toBe(true);
    expect(seen).toHaveLength(2); // the speak call and one sample synthesis
    expect(existsSync(join(dir, 'tts', 'sample', `${VOICE_A.id}-${TTS_ENGINE.version}.wav`))).toBe(true);
    await app.close();
  });

  it('runs one synthesis at a time with one waiting; a third gets 429 voice_busy', async () => {
    const f = fakeSpawn(piper(() => wav()));
    const s = service({ spawn: f.spawn });
    installed(s);
    const results = await Promise.allSettled([s.speak('1', VOICE_A.id), s.speak('2', VOICE_A.id), s.speak('3', VOICE_A.id)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
    const err = (results[2] as PromiseRejectedResult).reason as VoiceError;
    expect([err.status, err.code]).toEqual([429, 'voice_busy']);
    expect(f.live.max).toBe(1);
  });
});

describe('tts routes', () => {
  it('are fenced like /voice/model: loopback and human operator only', async () => {
    const s = service();
    const urls: Array<[string, string]> = [['GET', '/api/v1/voice/tts'], ['POST', '/api/v1/voice/tts'], ['DELETE', '/api/v1/voice/tts'], ['POST', '/api/v1/voice/speak'], ['GET', `/api/v1/voice/tts/sample/${VOICE_A.id}`]];
    const worker: Actor = { id: 'w', kind: 'worker', trust: 'untrusted' } as unknown as Actor;
    const { app } = await routes(s, worker);
    for (const [method, url] of urls) {
      const r = await app.inject({ method: method as 'GET', url, ...(method === 'GET' ? {} : { payload: { consent: true, voices: [], text: 'x', voice: VOICE_A.id } }) });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
      expect(r.json().code, url).toBe('human_operator_only');
    }
    await app.close();
    const remote = await routes(s);
    for (const [method, url] of urls) {
      const r = await remote.app.inject({ method: method as 'GET', url, remoteAddress: '10.0.0.5' });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
      expect(r.json().code).toBe('voice_loopback_only');
    }
    await remote.app.close();
  });

  it('GET /voice/tts reports the machine; DELETE removes and audits', async () => {
    const s = service({ spawn: installSpawn().spawn });
    installed(s);
    const { app, audit } = await routes(s);
    const st = (await app.inject({ method: 'GET', url: '/api/v1/voice/tts' })).json();
    expect(st).toMatchObject({ supported: { ok: true, reason: null }, python: { found: true, path: PY.path, version: '3.12.1' }, engine: { found: true, version: '1.8.0' }, install: null });
    expect(st.voices[VOICE_A.id]).toMatchObject({ installed: true, licence: 'CC0', source: 'huggingface.co/rhasspy/piper-voices' });
    const del = await app.inject({ method: 'DELETE', url: '/api/v1/voice/tts' });
    expect(del.json().engine.found).toBe(false);
    expect(audit.record).toHaveBeenCalledWith('voice.tts.removed', expect.anything(), expect.anything());
    await app.close();
  });

  it('never logs or audits the text', async () => {
    const s = service({ spawn: fakeSpawn(piper(() => wav())).spawn });
    installed(s);
    const { app, audit } = await routes(s);
    await app.inject({ method: 'POST', url: '/api/v1/voice/speak', payload: { text: 'SECRET WORDS', voice: VOICE_A.id } });
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('SECRET');
    await app.close();
  });
});

async function routes(tts: TtsService, actor?: Actor): Promise<{ app: FastifyInstance; audit: { record: ReturnType<typeof vi.fn> } }> {
  const app = Fastify();
  if (actor !== undefined) app.addHook('onRequest', async (req) => { (req as unknown as { actor: Actor }).actor = actor; });
  const audit = { record: vi.fn() };
  registerVoiceRoutes(app, { voice: {} as never, tts, dashboard: null, audit: audit as unknown as Pick<AuditLog, 'record'> });
  await app.ready();
  return { app, audit };
}

describe('tts manifest', () => {
  it('pins exactly the two voices and the engine', () => {
    expect(TTS_ENGINE).toMatchObject({ name: 'piper-tts', version: '1.8.0', licence: 'GPL-3.0-or-later', index: 'https://pypi.org/simple' });
    expect(TTS_VOICES.map((v) => v.id)).toEqual(['en_US-joe-medium', 'en_GB-cori-high']);
    const [joe, cori] = TTS_VOICES;
    expect([joe!.model, joe!.config]).toEqual([
      { path: 'en/en_US/joe/medium/en_US-joe-medium.onnx', sha256: 'abf4b998e34045cbd00eaf050de2de620f81ded6eb8b85a24b022a1c2b3f08d2', bytes: 63221984 },
      { path: 'en/en_US/joe/medium/en_US-joe-medium.onnx.json', sha256: '7b5f0293c0bf5bda8e377be1696da84af798befeef31038e43beefc01fe858da', bytes: 5465 },
    ]);
    expect([cori!.model, cori!.config]).toEqual([
      { path: 'en/en_GB/cori/high/en_GB-cori-high.onnx', sha256: '470b4dd634c98f8a4850d7626ffc3dfc90774628eeef6605a6dd8f88f30a5903', bytes: 114219352 },
      { path: 'en/en_GB/cori/high/en_GB-cori-high.onnx.json', sha256: '9e7fb5b5671612c22f3c81cbe46c1ae87b031a4632bcb509e499dad6f1e2adec', bytes: 4963 },
    ]);
    expect(joe!.clearance).toEqual({ basis: 'dataset CC0 (MODEL_CARD); fine-tuned from the rdh base, CC0; no attribution needed', reviewed: '2026-11-12' });
    expect(cori!.clearance.basis).toContain('LibriVox');
    expect(ttsVoiceUrl(joe!.model)).toBe('https://huggingface.co/rhasspy/piper-voices/resolve/2f358b6a560e3a913ebf509b2f3344f20b367f94/en/en_US/joe/medium/en_US-joe-medium.onnx');
  });
});

describe('voice locks (committed data)', () => {
  const real = join(__dirname, '..', 'voice-locks');
  const names = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'].flatMap((t) => [9, 10, 11, 12, 13, 14].map((m) => `${t}-cp3${m}.txt`)).filter((n) => n !== 'darwin-x64-cp314.txt'); // 23: onnxruntime has no Intel Mac wheel for 3.14

  it('has one lock per supported (OS, arch, CPython minor)', () => {
    expect(existsSync(real) ? readdirSync(real).sort() : []).toEqual([...names].sort());
  });

  it('every requirement is name==version with at least one --hash=sha256, and piper-tts==1.8.0 is in each', () => {
    for (const n of names) {
      const file = join(real, n);
      if (!existsSync(file)) continue; // the completeness test above reports a missing lock
      const logical = readFileSync(file, 'utf8').replace(/\\\n/g, ' ').split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
      expect(logical.length, n).toBeGreaterThan(0);
      for (const l of logical) {
        expect(l, n).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*==[A-Za-z0-9.!+_-]+( +--hash=sha256:[0-9a-f]{64})+$/);
      }
      expect(logical.some((l) => l.startsWith('piper-tts==1.8.0 ')), n).toBe(true);
    }
  });

  it('the npm package includes the locks, and the code finds them where the package puts them', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { files: string[] };
    expect(pkg.files).toContain('voice-locks');
    expect(lockPath('linux', 'x64', 12)).toBe(join(real, 'linux-x64-cp312.txt'));
  });
});

describe('tts revision: isolation, deadlines, cleanup and verification', () => {
  const HAS_PYTHON = spawnSync('python3', ['-I', '-c', '0']).status === 0;

  it('every Python launch is isolated (-I) and runs with the voice dir as cwd, never the daemon cwd', async () => {
    const probes: Array<[string, string]> = [];
    const seen: Call[] = [];
    const writer = piper(() => wav(), seen);
    const { spawn, calls } = installSpawn((c) => (c.args.includes('piper') ? writer(c) : undefined));
    const s = service({ spawn, probe: (cmd, cwd) => { probes.push([cmd, cwd]); return cmd === 'python3' ? PY : null; } });
    await s.status();
    await s.startInstall([VOICE_A.id]);
    await s.installDone();
    await s.speak('hello', VOICE_A.id);
    expect(probes.length).toBeGreaterThan(0);
    for (const [, cwd] of probes) expect(cwd).toBe(dir);
    expect(calls.length).toBeGreaterThanOrEqual(3); // venv, pip, piper
    for (const c of calls) {
      expect(c.args[0], c.args.join(' ')).toBe('-I');
      expect(c.cwd).toBe(dir);
      expect(c.cwd).not.toBe(process.cwd());
    }
    expect(calls.some((c) => c.args.includes('venv'))).toBe(true);
    expect(calls.some((c) => c.args.includes('pip'))).toBe(true);
    expect(calls.some((c) => c.args.includes('piper'))).toBe(true);
  });

  it.skipIf(!HAS_PYTHON)('the real probe never imports a platform.py planted in its working directory', async () => {
    const planted = mkdtempSync(join(tmpdir(), 'planted-'));
    const marker = join(planted, 'EXECUTED');
    for (const mod of ['platform', 'pip', 'piper']) writeFileSync(join(planted, `${mod}.py`), `open(${JSON.stringify(marker)}, 'w').write('x')\n`);
    try {
      const info = await probePython('python3', planted);
      expect(info).not.toBeNull();
      expect(info!.machine).toBeTruthy();
      expect(existsSync(marker)).toBe(false);
    } finally { rmSync(planted, { recursive: true, force: true }); }
  });

  it('a download that stalls fails the install, removes the .part and frees the slot', async () => {
    const stalled = (async (url: string) => {
      if (url !== ttsVoiceUrl(VOICE_A.model)) return okFetch(url);
      const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(Buffer.from('mod'))); } }); // never closes
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const s = service({ spawn: installSpawn().spawn, fetch: stalled, downloadIdleMs: 60 });
    await s.startInstall([VOICE_A.id]);
    await s.installDone();
    const st = (await s.status()).install!;
    expect(st.state).toBe('failed');
    expect(st.error).toMatch(/stalled/);
    expect(readdirSync(join(dir, 'tts', 'voices'))).toEqual([]);
    // the slot is free: a second install is accepted, not 409 running
    await expect(s.startInstall([VOICE_A.id])).resolves.toEqual({ started: true });
    await s.installDone();
  });

  it('a download that never answers or never ends is stopped by the overall deadline', async () => {
    const hang = (async () => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const a = service({ spawn: installSpawn().spawn, fetch: hang, downloadTimeoutMs: 80 });
    await a.startInstall([VOICE_A.id]);
    await a.installDone();
    expect((await a.status()).install!.error).toMatch(/took longer than/);
    const drip = (async (url: string) => {
      if (url !== ttsVoiceUrl(VOICE_A.model)) return okFetch(url);
      const t: { id?: NodeJS.Timeout } = {};
      const body = new ReadableStream<Uint8Array>({
        start(c) { t.id = setInterval(() => { try { c.enqueue(new Uint8Array([1])); } catch { /* closed */ } }, 10); },
        cancel() { clearInterval(t.id); },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const b = service({ spawn: installSpawn().spawn, fetch: drip, downloadTimeoutMs: 120, downloadIdleMs: 5000 });
    await b.startInstall([VOICE_A.id]);
    await b.installDone();
    expect((await b.status()).install!.error).toMatch(/took longer than/);
    expect(readdirSync(join(dir, 'tts', 'voices'))).toEqual([]);
  });

  it('every redirect hop must be https', async () => {
    const urls: string[] = [];
    const hop = (to: string) => (async (url: string) => {
      urls.push(url);
      if (url === ttsVoiceUrl(VOICE_A.model)) return new Response(null, { status: 302, headers: { location: to } });
      return okFetch(url);
    }) as unknown as typeof fetch;
    const bad = service({ spawn: installSpawn().spawn, fetch: hop('http://cdn.example/model.onnx') });
    await bad.startInstall([VOICE_A.id]);
    await bad.installDone();
    expect((await bad.status()).install!.error).toMatch(/not https/);
    expect(urls).toEqual([ttsVoiceUrl(VOICE_A.model)]); // the http hop was never requested
    expect(readdirSync(join(dir, 'tts', 'voices'))).toEqual([]);
    // an https hop to a body that matches the sha256 and size is accepted
    const cdn = 'https://cdn.example/m.onnx';
    const good = (async (url: string) => {
      if (url === ttsVoiceUrl(VOICE_A.model)) return new Response(null, { status: 302, headers: { location: cdn } });
      if (url === cdn) return new Response(new Uint8Array(BODIES.get(ttsVoiceUrl(VOICE_A.model))!), { status: 200 });
      return okFetch(url);
    }) as unknown as typeof fetch;
    const ok = service({ spawn: installSpawn().spawn, fetch: good });
    await ok.startInstall([VOICE_A.id]);
    await ok.installDone();
    expect((await ok.status()).voices[VOICE_A.id]!.installed).toBe(true);
  });

  it('a timeout kills the process group and holds the slot and the temp file until the child has closed', async () => {
    const killed: Array<[number, string | number | undefined]> = [];
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => { killed.push([pid, sig]); return true; }) as typeof process.kill);
    const opts: Array<{ detached?: boolean }> = [];
    let starts = 0;
    let closeChild: (() => void) | null = null;
    const spawn = vi.fn((_c: string, args: string[], o: { detached?: boolean }) => {
      opts.push(o);
      starts += 1;
      const child = new EventEmitter() as FakeChild & { pid: number };
      child.pid = 4242; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => true;
      child.stdin.resume();
      child.stdin.on('finish', () => {
        writeFileSync(outputArg(args), wav());
        if (starts === 2) setTimeout(() => child.emit('close', 0), 5);
      });
      closeChild = () => child.emit('close', null);
      return child;
    }) as unknown as VoiceSpawn;
    try {
      const s = service({ spawn, timeoutMs: 40 });
      installed(s);
      const first = s.speak('one', VOICE_A.id).then(() => null, (e: unknown) => e as VoiceError);
      const second = s.speak('two', VOICE_A.id).then(() => 'ok', (e: unknown) => e);
      await new Promise((r) => setTimeout(r, 200)); // well past the timeout; the child has not closed
      expect(killed).toContainEqual([-4242, 'SIGKILL']);
      expect(opts[0]!.detached).toBe(true);
      expect(starts).toBe(1); // the waiting synthesis has not been given the slot
      expect(readdirSync(join(dir, 'tts', 'work'))).toHaveLength(1); // the temp dir is still there
      closeChild!();
      const err = await first;
      expect([err!.status, err!.code]).toEqual([504, 'voice_timeout']);
      expect(await second).toBe('ok');
      expect(readdirSync(join(dir, 'tts', 'work'))).toEqual([]);
    } finally { killSpy.mockRestore(); }
  });

  /** A child that has a pid, ignores everything until `release()`, and records process-group kills. */
  function stubbornSpawn(onStdinDone?: (args: string[]) => void) {
    const killed: Array<[number, string | number | undefined]> = [];
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => { killed.push([pid, sig]); return true; }) as typeof process.kill);
    let release: () => void = () => undefined;
    let started = 0;
    const spawn = vi.fn((_c: string, args: string[]) => {
      started += 1;
      const child = new EventEmitter() as FakeChild & { pid: number };
      child.pid = 777; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
      child.stdin.resume();
      child.stdin.on('finish', () => onStdinDone?.(args));
      release = () => child.emit('close', null);
      return child;
    }) as unknown as VoiceSpawn;
    return { spawn, killed, killSpy, release: () => release(), started: () => started };
  }

  it('removing while a synthesis runs kills its group and deletes nothing until the child has closed', async () => {
    const st = stubbornSpawn((args) => writeFileSync(outputArg(args), wav()));
    try {
      const s = service({ spawn: st.spawn });
      installed(s);
      const speaking = s.speak('hello', VOICE_A.id).then(() => null, (e: unknown) => e as VoiceError);
      await new Promise((r) => setTimeout(r, 60));
      expect(st.started()).toBe(1);
      let removed = false;
      const removal = s.remove().then((r) => { removed = true; return r; });
      await new Promise((r) => setTimeout(r, 150));
      expect(st.killed).toContainEqual([-777, 'SIGKILL']);
      expect(removed).toBe(false); // the child has not closed
      expect(readdirSync(join(dir, 'tts', 'work'))).toHaveLength(1); // its temp dir is still there
      st.release();
      expect(await removal).toEqual({ removed: true });
      expect(existsSync(join(dir, 'tts'))).toBe(false);
      const err = await speaking;
      expect([err?.status, err?.code]).toEqual([409, 'voice_tts_missing']);
    } finally { st.killSpy.mockRestore(); }
  });

  it('a synthesis queued behind the one being cancelled never starts, and none starts while removing', async () => {
    const st = stubbornSpawn((args) => writeFileSync(outputArg(args), wav()));
    try {
      const s = service({ spawn: st.spawn });
      installed(s);
      const settle = (p: Promise<Buffer>) => p.then(() => null, (e: unknown) => e as VoiceError);
      const active = settle(s.speak('one', VOICE_A.id));
      await new Promise((r) => setTimeout(r, 60));
      const queued = settle(s.speak('two', VOICE_A.id));
      const removal = s.remove();
      const during = await settle(s.speak('three', VOICE_A.id)); // while the removal waits for the child
      expect([during?.status, during?.code]).toEqual([409, 'voice_tts_missing']);
      await new Promise((r) => setTimeout(r, 100));
      st.release();
      await removal;
      expect(st.started()).toBe(1); // neither the queued nor the late call ever spawned
      expect((await queued)?.code).toBe('voice_tts_missing');
      expect((await active)?.code).toBe('voice_tts_missing');
      expect(existsSync(join(dir, 'tts'))).toBe(false);
    } finally { st.killSpy.mockRestore(); }
  });

  it('cancelling an install (remove) kills the child group and waits for its close before removing anything', async () => {
    const st = stubbornSpawn();
    try {
      const s = service({ spawn: st.spawn });
      await s.startInstall([VOICE_A.id]);
      await new Promise((r) => setTimeout(r, 60));
      expect(st.started()).toBe(1); // the venv child, hanging
      let removed = false;
      const removal = s.remove().then(() => { removed = true; });
      await new Promise((r) => setTimeout(r, 100));
      expect(st.killed).toContainEqual([-777, 'SIGKILL']);
      expect(removed).toBe(false);
      st.release();
      await removal;
      expect(existsSync(join(dir, 'tts'))).toBe(false);
    } finally { st.killSpy.mockRestore(); }
  });

  it('a removal that lands during the install probe cancels that install', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const probe = async (cmd: string) => { await gate; return cmd === 'python3' ? PY : null; };
    const inst = installSpawn();
    const s = service({ spawn: inst.spawn, probe });
    const starting = s.startInstall([VOICE_A.id]);
    const caught = starting.catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 20));
    await s.remove();
    release();
    expect(await caught).toMatchObject({ code: 'voice_tts_missing' });
    expect(existsSync(join(dir, 'tts'))).toBe(false);
  });

  it('install errors carry no child stderr (the venv failure names only the remedy)', async () => {
    const { spawn } = fakeSpawn(() => ({ code: 1, stderr: 'SECRET-STDERR-TEXT' }));
    const s = service({ spawn });
    await s.startInstall([VOICE_A.id]);
    await s.installDone();
    const err = (await s.status()).install!.error!;
    expect(err).not.toContain('SECRET-STDERR-TEXT');
    expect(err).toContain('python3-venv');
  });

  it('a failing child that echoes its input leaks it into no log, audit record or response', async () => {
    const lines: string[] = [];
    const stream = { write: (l: string) => { lines.push(l); } };
    const app = Fastify({ logger: { level: 'trace', stream } });
    registerServerErrorBody(app); // the production error hook: it logs a 500's body
    const audit = { record: vi.fn() };
    const s = service({ spawn: fakeSpawn((c) => ({ code: 1, stderr: `Traceback: could not say: ${c.stdin}` })).spawn });
    installed(s);
    registerVoiceRoutes(app, { voice: {} as never, tts: s, dashboard: null, audit: audit as unknown as Pick<AuditLog, 'record'> });
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/api/v1/voice/speak', payload: { text: 'PURPLE ELEPHANT SECRET', voice: VOICE_A.id } });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toMatch(/PURPLE|ELEPHANT/);
    expect(res.json().code).toBe('voice_tts_failed');
    expect(lines.join('\n')).not.toMatch(/PURPLE|ELEPHANT/);
    expect(JSON.stringify(audit.record.mock.calls)).not.toMatch(/PURPLE|ELEPHANT/);
    expect(lines.join('\n')).toContain('voice_tts_failed'); // the hook did log the failure, without the text
    await app.close();
  });

  it('status does not block: the probe is asynchronous and cached; install, remove and a minute re-probe', async () => {
    let probes = 0;
    let t = 1_000_000;
    const probe = async (cmd: string) => { probes += 1; await new Promise((r) => setTimeout(r, 5)); return cmd === 'python3' ? PY : null; };
    const s = service({ spawn: installSpawn().spawn, probe, now: () => t });
    const pending = s.status();
    expect(pending).toBeInstanceOf(Promise);
    await Promise.all([pending, s.status()]); // concurrent calls share one probe round
    const round = probes;
    expect(round).toBe(1);
    await s.status();
    expect(probes).toBe(round); // cached
    t += 61_000;
    await s.status();
    expect(probes).toBeGreaterThan(round); // a minute on
    const afterTtl = probes;
    await s.status();
    expect(probes).toBe(afterTtl);
    await s.remove();
    await s.status();
    expect(probes).toBeGreaterThan(afterTtl); // DELETE
    const afterRemove = probes;
    await s.startInstall([VOICE_A.id]);
    await s.installDone();
    expect(probes).toBeGreaterThan(afterRemove); // install
    // and the real probe is a promise, not a blocking spawnSync
    expect(probePython('python3-that-does-not-exist', dir)).toBeInstanceOf(Promise);
  });

  it('picks the lock by the architecture Python reports, not Node\'s (Rosetta)', async () => {
    mkdirSync(locks, { recursive: true });
    for (const a of ['arm64', 'x64']) writeFileSync(join(locks, `darwin-${a}-cp312.txt`), 'piper-tts==1.8.0 \\\n    --hash=sha256:aa\n');
    const pick = async (machine: string) => (await service({ platform: 'darwin', probe: () => ({ ...PY, machine }) }).pickPython()).lock;
    expect(await pick('x86_64')).toBe(join(locks, 'darwin-x64-cp312.txt'));
    expect(await pick('arm64')).toBe(join(locks, 'darwin-arm64-cp312.txt'));
    expect(await pick('aarch64')).toBe(join(locks, 'darwin-arm64-cp312.txt'));
  });

  it('refuses a synthesis output that is not a regular file, and removes it', async () => {
    const secret = join(dir, 'target.txt');
    writeFileSync(secret, 'untouched');
    const s = service({ spawn: fakeSpawn((c) => { symlinkSync(secret, outputArg(c.args)); }).spawn });
    installed(s);
    const err = await s.speak('hello', VOICE_A.id).then(() => null, (e: unknown) => e as VoiceError);
    expect([err?.status, err?.code]).toEqual([500, 'voice_tts_failed']);
    expect(err!.message).toMatch(/plain file/);
    expect(readFileSync(secret, 'utf8')).toBe('untouched');
    expect(readdirSync(join(dir, 'tts', 'work'))).toEqual([]);
  });

  it('the synthesis output lives in a fresh private directory under work/', async () => {
    const seen: Call[] = [];
    const s = service({ spawn: fakeSpawn(piper(() => wav(), seen)).spawn });
    installed(s);
    await s.speak('hello', VOICE_A.id);
    const out = outputArg(seen[0]!.args);
    expect(out).toMatch(/\/tts\/work\/s-[^/]+\/out\.wav$/);
  });

  it('checks the RIFF container: the size field must match the file length', () => {
    expect(ttsWavProblem(wav())).toBeNull();
    const big = wav(); big.writeUInt32LE(big.readUInt32LE(4) + 100, 4);
    expect(ttsWavProblem(big)).toMatch(/RIFF size/);
    const small = wav(); small.writeUInt32LE(4, 4);
    expect(ttsWavProblem(small)).toMatch(/RIFF size/);
    const trailing = Buffer.concat([wav(), Buffer.from('junk')]);
    expect(ttsWavProblem(trailing)).toMatch(/RIFF size/);
    const noWave = wav(); noWave.write('WAVX', 8, 'ascii');
    expect(ttsWavProblem(noWave)).toMatch(/RIFF\/WAVE/);
    const noRiff = wav(); noRiff.write('RIFX', 0, 'ascii');
    expect(ttsWavProblem(noRiff)).toMatch(/RIFF\/WAVE/);
  });

  it('refuses a machine older than the baseline the locks were resolved for, and musl', async () => {
    const generator = readFileSync(join(__dirname, '..', 'scripts', 'generate-voice-locks.mjs'), 'utf8');
    expect(generator).toContain(`macosx_${TTS_MIN_PLATFORM.darwin.macos}_0_arm64`);
    expect(generator).toContain(`manylinux_${TTS_MIN_PLATFORM.linux.glibc.join('_')}_x86_64`);
    const mac = await service({ platform: 'darwin', osRelease: () => '22.6.0' }).status(); // macOS 13
    expect(mac.supported.ok).toBe(false);
    expect(mac.supported.reason).toMatch(/macOS 14/);
    await expect(service({ platform: 'darwin', osRelease: () => '22.6.0' }).startInstall([VOICE_A.id])).rejects.toThrow(/macOS 14/);
    expect((await service({ platform: 'darwin', osRelease: () => '23.0.0', probe: () => ({ ...PY, machine: 'x86_64' }), locksDir: locks }).status()).supported.reason).not.toMatch(/macOS 14/);
    const old = await service({ glibc: () => '2.27' }).status();
    expect(old.supported.ok).toBe(false);
    expect(old.supported.reason).toMatch(/glibc 2\.27.*2\.28/);
    const musl = await service({ glibc: () => null }).status();
    expect(musl.supported.ok).toBe(false);
    expect(musl.supported.reason).toMatch(/musl/);
    expect((await service({ glibc: () => '2.28' }).status()).supported.ok).toBe(true);
    expect((await service({ glibc: () => '2.39' }).status()).supported.ok).toBe(true);
  });

  it('re-verifies a cached sample on every read: a corrupt or tampered one is removed and regenerated', async () => {
    const seen: Call[] = [];
    const s = service({ spawn: fakeSpawn(piper(() => wav(), seen)).spawn });
    installed(s);
    const cached = join(dir, 'tts', 'sample', `${VOICE_A.id}-${TTS_ENGINE.version}.wav`);
    const first = await s.sample(VOICE_A.id);
    expect(seen).toHaveLength(1);
    expect((await s.sample(VOICE_A.id)).equals(first)).toBe(true);
    expect(seen).toHaveLength(1); // a good one is served from the cache
    writeFileSync(cached, Buffer.from('RIFF....garbage')); // corrupt
    expect((await s.sample(VOICE_A.id)).equals(first)).toBe(true);
    expect(seen).toHaveLength(2);
    writeFileSync(cached, wav(800)); // a valid WAV, but not the recorded one
    expect((await s.sample(VOICE_A.id)).equals(first)).toBe(true);
    expect(seen).toHaveLength(3);
    expect(readFileSync(cached).equals(first)).toBe(true);
  });
});

describe('voice suite hygiene', () => {
  it('outputArg refuses an argv that is not a piper launch', () => {
    expect(() => outputArg(['-I', '-m', 'pip', 'install'])).toThrow(/unexpected argv/);
    expect(() => outputArg(['-I', '-m', 'piper', '-m', 'x'])).toThrow(/unexpected argv/);
    expect(() => outputArg(['-I', '-m', 'piper', '-f'])).toThrow(/unexpected argv/);
    expect(outputArg(['-I', '-m', 'piper', '-f', '/o.wav'])).toBe('/o.wav');
  });

  it('a speak, sample and install leave no new file in the package directory', async () => {
    const before = readdirSync(process.cwd()).sort();
    const writer = piper(() => wav());
    const s = service({ spawn: installSpawn((c) => (c.args.includes('piper') ? writer(c) : undefined)).spawn });
    await s.startInstall([VOICE_A.id]);
    await s.installDone();
    await s.speak('hello', VOICE_A.id);
    await s.sample(VOICE_A.id);
    expect(readdirSync(process.cwd()).sort()).toEqual(before);
  });
});
