// Text to speech (studio#1140, slice 1): the consented piper install, the voice files held to their checksums, and
// the local synthesis. Every edge is stubbed: no Python, no pip, no network, no real cache dir.

import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TTS_ENGINE, TTS_VOICES, ttsVoiceUrl, type TtsVoice } from '../src/voice/tts-manifest.js';
import { TtsService, lockPath, normalizeSpeakText, ttsWavProblem, type PythonInfo, type TtsDeps } from '../src/voice/tts.js';
import { VoiceError, type VoiceSpawn } from '../src/voice/service.js';
import { registerVoiceRoutes } from '../src/voice/routes.js';
import type { AuditLog } from '../src/api/audit.js';
import type { Actor } from '../src/core/types.js';

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
interface Call { command: string; args: string[]; env: NodeJS.ProcessEnv; stdin: string }
type Behaviour = (call: Call) => { code?: number; stderr?: string; hang?: boolean } | void;

/** A process stand-in: records the call, runs `behave` once its stdin closes. */
function fakeSpawn(behave: Behaviour) {
  const calls: Call[] = [];
  const live = { now: 0, max: 0 };
  const spawn = vi.fn((command: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
    const child = new EventEmitter() as FakeChild;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { live.now -= 1; setImmediate(() => child.emit('close', null)); return true; };
    const chunks: Buffer[] = [];
    child.stdin.on('data', (c: Buffer) => chunks.push(c));
    child.stdin.on('finish', () => {
      const call: Call = { command, args: [...args], env: opts.env ?? {}, stdin: Buffer.concat(chunks).toString('utf8') };
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

const PY: PythonInfo = { path: '/usr/bin/python3', version: '3.12.1', minor: 12 };

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
    if (call.args[0] === '-m' && call.args[1] === 'venv') {
      const target = call.args[2]!;
      mkdirSync(join(target, 'bin'), { recursive: true });
      writeFileSync(join(target, 'bin', 'python'), '');
      return;
    }
    return extra(call);
  });
}

function service(extra: Partial<TtsDeps> = {}): TtsService {
  return new TtsService({
    dir, locksDir: locks, platform: 'linux', arch: 'x64', env: { PATH: '/usr/bin', PIP_INDEX_URL: 'https://evil.example', PYTHONPATH: '/x' },
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

/** A piper stand-in: writes `out` to the `-f` file. */
function piper(out: () => Buffer | null, seen: Call[] = []): Behaviour {
  return (call) => {
    seen.push(call);
    const o = out();
    if (o !== null) writeFileSync(call.args[call.args.indexOf('-f') + 1]!, o);
  };
}

describe('tts install', () => {
  it('runs pip hash-locked, isolated, binary-only, from one index, with no config file', async () => {
    const { spawn, calls } = installSpawn();
    const s = service({ spawn });
    expect(s.startInstall([VOICE_A.id])).toEqual({ started: true });
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
    expect(s.status().install).toBeNull();
    expect(s.status().voices[VOICE_A.id]!.installed).toBe(true);
    expect(s.status().voices[VOICE_B.id]!.installed).toBe(false);
  });

  it('a failed pip leaves no venv and says why', async () => {
    const { spawn } = installSpawn((c) => (c.args.includes('pip') ? { code: 1, stderr: 'ERROR: THESE PACKAGES DO NOT MATCH THE HASHES' } : undefined));
    const s = service({ spawn });
    s.startInstall([VOICE_A.id]);
    await s.installDone();
    expect(readdirSync(join(dir, 'tts'))).toEqual([]);
    const st = s.status();
    expect(st.install).toMatchObject({ state: 'failed', step: 'engine' });
    expect(st.install!.error).toContain('DO NOT MATCH');
    expect(st.engine.found).toBe(false);
  });

  it('a failed venv leaves nothing and names the remedy', async () => {
    const { spawn } = fakeSpawn(() => ({ code: 1, stderr: 'ensurepip is not available' }));
    const s = service({ spawn });
    s.startInstall([VOICE_A.id]);
    await s.installDone();
    expect(s.status().install!.error).toContain('python3-venv');
    expect(existsSync(join(dir, 'tts', 'engine'))).toBe(false);
  });

  it('refuses a voice outside the manifest (400) and consent is required at the route', async () => {
    const s = service({ spawn: installSpawn().spawn });
    expect(() => s.startInstall(['en_US-evil-high'])).toThrow(VoiceError);
    try { s.startInstall(['../../etc/passwd']); } catch (e) { expect((e as VoiceError).status).toBe(400); expect((e as VoiceError).code).toBe('voice_unknown'); }
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
      s.startInstall([VOICE_A.id]);
      await s.installDone();
      expect(s.status().install!.state).toBe('failed');
      expect(s.status().install!.error).toMatch(/nothing was kept/);
      const voices = join(dir, 'tts', 'voices');
      expect(readdirSync(voices)).toEqual([]);
    }
  });

  it('says plainly when the platform, architecture or Python is unsupported', () => {
    const win = service({ platform: 'win32' }).status();
    expect(win.supported).toMatchObject({ ok: false });
    expect(win.supported.reason).toMatch(/Windows is not supported/);
    expect(service({ arch: 'ia32' }).status().supported.ok).toBe(false);
    const none = service({ probe: () => null }).status();
    expect(none.python.found).toBe(false);
    expect(none.supported.reason).toMatch(/No Python 3/);
    expect(none.supported.reason).toMatch(/apt install python3 python3-venv/);
    expect(service({ probe: () => null, platform: 'darwin', arch: 'arm64' }).status().supported.reason).toMatch(/Python 3\.12 from python\.org or (with )?Homebrew/);
    const py315 = service({ probe: () => ({ path: '/usr/bin/python3', version: '3.15.0', minor: 15 }) }).status();
    expect(py315.supported.ok).toBe(false);
    expect(py315.supported.reason).toMatch(/3\.15.*not supported/);
    expect(() => service({ platform: 'win32' }).startInstall([VOICE_A.id])).toThrow(/Windows/);
  });

  it('picks Python by WICKED_CREW_PYTHON, then python3, python3.14 ... python3.9, skipping a minor without a lock', () => {
    const probed: string[] = [];
    const table: Record<string, PythonInfo> = {
      python3: { path: '/p/python3', version: '3.13.0', minor: 13 }, // no cp313 lock in the fixture
      'python3.14': { path: '/p/python3.14', version: '3.14.0', minor: 14 }, // none either
      'python3.12': { path: '/p/python3.12', version: '3.12.0', minor: 12 },
      'python3.11': { path: '/p/python3.11', version: '3.11.0', minor: 11 },
      '/x/mine': { path: '/x/mine', version: '3.11.4', minor: 11 },
    };
    const probe = (c: string) => { probed.push(c); return table[c] ?? null; };
    expect(service({ probe }).pickPython().python!.path).toBe('/p/python3.12');
    expect(probed).toEqual(['python3', 'python3.14', 'python3.13', 'python3.12']);
    probed.length = 0;
    const env = { PATH: '/usr/bin', WICKED_CREW_PYTHON: '/x/mine' };
    expect(service({ probe, env }).pickPython().python!.path).toBe('/x/mine');
    expect(probed).toEqual(['/x/mine']);
    const bad = service({ probe, env: { ...env, WICKED_CREW_PYTHON: '/x/none' } }).pickPython();
    expect(bad.python).toBeNull();
    expect(bad.problem).toMatch(/WICKED_CREW_PYTHON/);
  });

  it('Intel Mac with Python 3.14 is unsupported and the person is told plainly', () => {
    expect(lockPath('darwin', 'x64', 14)).toBeNull();
    expect(lockPath('darwin', 'arm64', 14)).not.toBeNull();
    const probe = () => ({ path: '/usr/local/bin/python3', version: '3.14.0', minor: 14 });
    const s = service({ platform: 'darwin', arch: 'x64', probe, locksDir: join(__dirname, '..', 'voice-locks') });
    const st = s.status();
    expect(st.supported.ok).toBe(false);
    expect(st.supported.reason).toMatch(/3\.14.*not supported.*Intel Mac/);
    expect(() => s.startInstall([VOICE_A.id])).toThrow(/Intel Mac/);
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
    s.startInstall([VOICE_A.id]);
    await s.installDone();
    expect(s.remove()).toEqual({ removed: true });
    expect(existsSync(join(dir, 'tts'))).toBe(false);
    expect(s.remove()).toEqual({ removed: false });
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
    expect(c.args.slice(0, 2)).toEqual(['-m', 'piper']);
    expect(c.args.join(' ')).not.toContain('passwd');
    expect(c.args[c.args.indexOf('-m', 2) + 1]).toMatch(/en_test-a\.onnx$/);
    expect(c.args[c.args.indexOf('-c') + 1]).toMatch(/en_test-a\.onnx\.json$/);
    expect(c.stdin).toBe('-m /etc/passwd --output_file x second [ [ph] ] line\n');
    expect(c.stdin.trimEnd()).not.toContain('\n');
    // the temp file is gone
    expect(readdirSync(join(dir, 'tts', 'work'))).toEqual([]);
  });

  it('a timeout, an oversize file and a corrupt WAV each leave no file and answer an error', async () => {
    const cases: Array<[string, Partial<TtsDeps>, Behaviour, number, string]> = [
      ['timeout', { timeoutMs: 80 }, (c) => { writeFileSync(c.args[c.args.indexOf('-f') + 1]!, wav()); return { hang: true }; }, 504, 'voice_timeout'],
      ['oversize while writing', { maxWavBytes: 1000 }, (c) => { writeFileSync(c.args[c.args.indexOf('-f') + 1]!, wav(4000)); return { hang: true }; }, 500, 'voice_tts_failed'],
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
