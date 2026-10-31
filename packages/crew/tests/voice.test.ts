// Voice mode, phase 1 (program DES-VOICE): speech to text on this machine, the model only with consent, and the
// per-person voice dashboard. Every edge is stubbed: no whisper.cpp, no network, no real cache dir.

import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  VOICE_MODEL, VoiceService, cleanTranscript, defaultVoiceDir, findWhisper, isWav, parseWhisperVersion, wavProblem, whisperSupported, type VoiceDeps, type VoiceSpawn,
} from '../src/voice/service.js';
import { VoiceDashboardStore, VOICE_DASHBOARD_FILENAME, type VoiceWidgetManifest } from '../src/voice/dashboard.js';
import { registerVoiceRoutes } from '../src/voice/routes.js';
import type { AuditLog } from '../src/api/audit.js';
import type { Actor } from '../src/core/types.js';

/** A minimal WAV: a RIFF/WAVE header and some silence. */
function wav(samples = 1600): Buffer {
  const data = Buffer.alloc(samples * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii'); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

interface FakeChild extends EventEmitter { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: (s?: string) => boolean }

/** A whisper-cli stand-in: records what it was given, answers `out` with exit `code`. */
function fakeSpawn(out: string, code = 0, opts: { hang?: boolean } = {}) {
  const calls: Array<{ bin: string; args: string[]; stdin: Buffer }> = [];
  const live = { now: 0, max: 0 };
  const spawn = vi.fn((bin: string, args: string[]) => {
    live.now += 1; live.max = Math.max(live.max, live.now);
    const child = new EventEmitter() as FakeChild;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { setImmediate(() => child.emit('close', null)); return true; };
    const chunks: Buffer[] = [];
    child.stdin.on('data', (c: Buffer) => chunks.push(c));
    child.stdin.on('finish', () => {
      calls.push({ bin, args, stdin: Buffer.concat(chunks) });
      if (opts.hang === true) return;
      setTimeout(() => { live.now -= 1; child.stdout.end(out); child.stderr.end(code === 0 ? '' : 'error: bad model\n'); child.emit('close', code); }, 5);
    });
    return child;
  });
  return { spawn, calls, live };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'voice-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const BIN = '/opt/whisper/whisper-cli';
function service(extra: Partial<VoiceDeps> = {}): VoiceService {
  return new VoiceService({ dir, bin: BIN, exists: (p) => p === BIN || existsSync(p), versionOf: () => 'whisper.cpp version: 1.9.5', ...extra });
}
function putModel(): void { writeFileSync(join(dir, VOICE_MODEL.file), 'model'); }

describe('voice: finding the pieces', () => {
  it('finds whisper-cli on PATH, honours WICKED_CREW_WHISPER_BIN, and says null when absent', () => {
    const has = new Set(['/b/whisper-cli', '/x/my-whisper']);
    const exists = (p: string) => has.has(p);
    expect(findWhisper({ PATH: '/a:/b' }, 'linux', exists)).toBe('/b/whisper-cli');
    expect(findWhisper({ PATH: '/a:/b', WICKED_CREW_WHISPER_BIN: '/x/my-whisper' }, 'linux', exists)).toBe('/x/my-whisper');
    expect(findWhisper({ PATH: '/a:/b', WICKED_CREW_WHISPER_BIN: '/x/gone' }, 'linux', exists)).toBeNull();
    expect(findWhisper({ PATH: '/a' }, 'linux', exists)).toBeNull();
  });

  it('keeps the model in the OS cache dir, never the state home; WICKED_CREW_VOICE_DIR wins', () => {
    expect(defaultVoiceDir({}, 'darwin', '/h')).toBe('/h/Library/Caches/wicked-crew/voice');
    expect(defaultVoiceDir({ XDG_CACHE_HOME: '/c' }, 'linux', '/h')).toBe('/c/wicked-crew/voice');
    expect(defaultVoiceDir({}, 'linux', '/h')).toBe('/h/.cache/wicked-crew/voice');
    expect(defaultVoiceDir({ WICKED_CREW_VOICE_DIR: '/v' }, 'darwin', '/h')).toBe('/v');
    expect(defaultVoiceDir({}, 'darwin', '/h')).not.toMatch(/\.wicked-crew/);
  });


  it('an engine too old to keep stdin output off disk (1.7.x writes `-.txt`) is refused before any audio is sent (codex on #1238)', async () => {
    expect(parseWhisperVersion('whisper.cpp version: 1.9.5\n')).toBe('1.9.5');
    expect(parseWhisperVersion('error: unknown argument: --version')).toBeNull();
    expect(whisperSupported('1.9.5')).toBe(true);
    expect(whisperSupported('1.8.0')).toBe(true);
    expect(whisperSupported('2.0.0')).toBe(true);
    expect(whisperSupported('1.7.4')).toBe(false);
    expect(whisperSupported(null)).toBe(false);
    putModel();
    const f = fakeSpawn('x');
    for (const out of [null, 'whisper.cpp version: 1.7.4']) {
      const old = service({ spawn: f.spawn as unknown as VoiceSpawn, versionOf: () => out, platform: 'darwin' });
      expect(old.status()).toMatchObject({ ready: false, engine: { found: true, supported: false } });
      expect(old.status().engine.install).toMatch(/too old.*1\.8\.0.*brew upgrade whisper-cpp/);
      await expect(old.transcribe(wav())).rejects.toMatchObject({ status: 409, code: 'voice_engine_outdated' });
    }
    expect(f.calls).toEqual([]);
    const ok = service({ versionOf: () => 'whisper.cpp version: 1.9.5' });
    expect(ok.status()).toMatchObject({ ready: true, engine: { version: '1.9.5', supported: true, install: null } });
  });

  it('status names what is missing: the engine (with the install line) and the model', () => {
    const none = new VoiceService({ dir, bin: null, env: { PATH: '' }, platform: 'darwin' }).status();
    expect(none).toMatchObject({ local: true, ready: false, engine: { found: false, path: null }, model: { name: 'base.en', present: false, bytes: null, download: null } });
    expect(none.engine.install).toMatch(/brew install whisper-cpp/);
    const s = service();
    expect(s.status()).toMatchObject({ ready: false, engine: { found: true, path: BIN, install: null }, model: { present: false } });
    putModel();
    expect(s.status()).toMatchObject({ ready: true, model: { present: true, bytes: 5 } });
  });
});

describe('voice: transcribe', () => {
  it('hands the WAV to whisper-cli on stdin (-f -) and answers clean text; nothing is written to disk', async () => {
    putModel();
    const { spawn, calls } = fakeSpawn('\n [BLANK_AUDIO]  What is running right now?\n(music)\n');
    const s = service({ spawn: spawn as unknown as VoiceSpawn });
    const before = readdirSync(dir);
    const audio = wav();
    const got = await s.transcribe(audio);
    expect(got).toMatchObject({ text: 'What is running right now?', model: 'base.en' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.bin).toBe(BIN);
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['-m', join(dir, VOICE_MODEL.file), '-f', '-', '-nt', '-np', '-l', 'en']));
    // A stdin run prints its text only as the `-otxt` output, which goes to stdout (whisper.cpp 1.9.5, seen live).
    expect(calls[0]!.args).toContain('-otxt');
    expect(calls[0]!.stdin.equals(audio)).toBe(true);
    expect(readdirSync(dir)).toEqual(before);
  });

  it('refuses what is not a WAV, too large, or with a piece missing, each with its code', async () => {
    const s = service({ spawn: fakeSpawn('x').spawn as unknown as VoiceSpawn });
    await expect(s.transcribe(Buffer.from('not audio at all, really not'))).rejects.toMatchObject({ status: 400, code: 'voice_audio_invalid' });
    await expect(s.transcribe(Buffer.alloc(9 * 1024 * 1024))).rejects.toMatchObject({ status: 413, code: 'voice_audio_too_large' });
    await expect(s.transcribe(wav())).rejects.toMatchObject({ status: 409, code: 'voice_model_missing' });
    putModel();
    const noBin = new VoiceService({ dir, bin: null, env: { PATH: '' }, platform: 'linux' });
    await expect(noBin.transcribe(wav())).rejects.toMatchObject({ status: 409, code: 'voice_engine_missing' });
  });

  it('a failing engine says its own last words; a hung one is stopped at the timeout', async () => {
    putModel();
    const bad = service({ spawn: fakeSpawn('', 3).spawn as unknown as VoiceSpawn });
    await expect(bad.transcribe(wav())).rejects.toMatchObject({ status: 500, code: 'voice_failed', message: expect.stringMatching(/exited 3: error: bad model/) });
    const hung = service({ spawn: fakeSpawn('', 0, { hang: true }).spawn as unknown as VoiceSpawn, timeoutMs: 20 });
    await expect(hung.transcribe(wav())).rejects.toMatchObject({ status: 504, code: 'voice_timeout' });
  });

  it('one runs and one waits; a third is refused busy', async () => {
    putModel();
    const { spawn } = fakeSpawn('hi');
    const s = service({ spawn: spawn as unknown as VoiceSpawn });
    const a = s.transcribe(wav());
    const b = s.transcribe(wav());
    await expect(s.transcribe(wav())).rejects.toMatchObject({ status: 429, code: 'voice_busy' });
    await expect(Promise.all([a, b])).resolves.toHaveLength(2);
  });


  it('never runs two at once: the slot is handed to the waiter, and a later caller queues behind it (agy P2)', async () => {
    putModel();
    const f = fakeSpawn('hi');
    const s = service({ spawn: f.spawn as unknown as VoiceSpawn });
    const a = s.transcribe(wav());
    const b = s.transcribe(wav());
    await a; // A done: B now holds the slot; C must wait, not start beside it
    const c = s.transcribe(wav());
    await Promise.all([b, c]);
    expect(f.calls).toHaveLength(3);
    expect(f.live.max).toBe(1);
  });

  it('a waiter whose model was removed meanwhile is told so, and spawns nothing (agy P2)', async () => {
    putModel();
    const f = fakeSpawn('hi');
    const s = service({ spawn: f.spawn as unknown as VoiceSpawn });
    const a = s.transcribe(wav());
    const b = s.transcribe(wav());
    s.removeModel();
    await a;
    await expect(b).rejects.toMatchObject({ status: 409, code: 'voice_model_missing' });
    expect(f.calls).toHaveLength(1);
  });

  it('refuses a WAV that is not 16 kHz mono 16-bit PCM, or has no audio, before the engine starts (codex P3)', async () => {
    putModel();
    const f = fakeSpawn('x');
    const s = service({ spawn: f.spawn as unknown as VoiceSpawn });
    const headerOnly = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(33)]);
    const stereo = wav(); stereo.writeUInt16LE(2, 22);
    const rate = wav(); rate.writeUInt32LE(44100, 24);
    const empty = wav(0);
    const truncated = wav().subarray(0, 60);
    for (const bad of [headerOnly, stereo, rate, empty, truncated]) {
      await expect(s.transcribe(bad)).rejects.toMatchObject({ status: 400, code: 'voice_audio_invalid' });
    }
    expect(wavProblem(stereo)).toMatch(/2 channel/);
    expect(f.calls).toEqual([]);
  });

  it('cleanTranscript drops tags and folds whitespace; isWav reads the header', () => {
    expect(cleanTranscript(' [00:00.000 --> 00:02.000]  hello\n world [BLANK_AUDIO] ')).toBe('hello world');
    expect(isWav(wav())).toBe(true);
    expect(isWav(Buffer.alloc(100))).toBe(false);
  });
});

describe('voice: the model download', () => {
  function body(bytes: Buffer): Response {
    return new Response(new ReadableStream({ start(c) { c.enqueue(bytes.subarray(0, 3)); c.enqueue(bytes.subarray(3)); c.close(); } }), { headers: { 'content-length': String(bytes.length) } });
  }
  const waitFor = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5)); };

  it('a file that fails the published checksum is not kept, and the failure is said', async () => {
    const fetchImpl = vi.fn(async () => body(Buffer.from('not the model')));
    const s = service({ fetch: fetchImpl as unknown as typeof fetch });
    expect(s.startDownload()).toEqual({ started: true });
    expect(fetchImpl).toHaveBeenCalledWith(VOICE_MODEL.url, expect.anything());
    await waitFor(() => s.status().model.download?.state === 'failed');
    expect(s.status().model).toMatchObject({ present: false, download: { state: 'failed', error: expect.stringMatching(/checksum/) } });
    expect(readdirSync(dir)).toEqual([]);
  });


  it('a write that fails (EACCES) marks the download failed; the daemon does not crash (codex/agy P1)', async () => {
    if (process.getuid?.() === 0) return; // root writes anywhere
    const bytes = Buffer.from('pretend model bytes');
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    try {
      const s = new VoiceService({ dir: locked, bin: BIN, exists: (p) => p === BIN || existsSync(p), versionOf: () => 'whisper.cpp version: 1.9.5', fetch: (async () => body(bytes)) as unknown as typeof fetch });
      s.startDownload();
      await waitFor(() => s.status().model.download?.state === 'failed');
      expect(s.status().model).toMatchObject({ present: false, download: { state: 'failed', error: expect.stringMatching(/EACCES|permission/i) } });
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it('removing the model cancels a download in flight: it never lands afterwards (codex/agy P2)', async () => {
    const bytes = Buffer.from('pretend model bytes');
    const sha = createHash('sha1').update(bytes).digest('hex');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = (async (_u: string, init?: { signal?: AbortSignal }) => {
      await gate;
      if (init?.signal?.aborted === true) throw new Error('aborted');
      return body(bytes);
    }) as unknown as typeof fetch;
    const s = service({ fetch: slow, model: { ...VOICE_MODEL, sha1: sha } });
    s.startDownload();
    expect(s.removeModel()).toEqual({ removed: false });
    expect(s.status().model.download).toBeNull();
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(s.status().model).toMatchObject({ present: false, download: null });
    expect(readdirSync(dir)).toEqual([]);
    // And a fresh start after removal works.
    expect(s.startDownload()).toEqual({ started: true });
  });

  it('a matching file lands under its name; a second start does nothing', async () => {
    const bytes = Buffer.from('pretend model bytes');
    const sha = createHash('sha1').update(bytes).digest('hex');
    const s = service({ fetch: (async () => body(bytes)) as unknown as typeof fetch, model: { ...VOICE_MODEL, sha1: sha } });
    s.startDownload();
    await waitFor(() => s.status().model.present);
    expect(readFileSync(join(dir, VOICE_MODEL.file)).equals(bytes)).toBe(true);
    expect(s.status().model.download).toBeNull();
    expect(s.startDownload()).toEqual({ started: false });
    expect(s.removeModel()).toEqual({ removed: true });
    expect(s.status().model.present).toBe(false);
  });
});

const widget = (id: string, extra: Partial<VoiceWidgetManifest> = {}): VoiceWidgetManifest => ({
  id, title: 'Disk free', version: 1, kind: 'metric',
  panels: [{ slot: 'voice-dashboard', id: 'main', title: 'Disk free', order: 40 }],
  metric: { source: 'system', path: 'infra[key=disk].details.freeBytes', display: 'number', unit: 'GB' },
  ...extra,
});

describe('voice routes', () => {
  let app: FastifyInstance;
  const recorded: Array<{ action: string; detail?: unknown }> = [];
  const audit = { record: vi.fn((action: string, _a: unknown, f?: { detail?: unknown }) => { recorded.push({ action, detail: f?.detail }); return 1; }) } as unknown as AuditLog;
  let actor: Actor | undefined;

  async function build(s: VoiceService, dashboard: VoiceDashboardStore | null = VoiceDashboardStore.under(dir)): Promise<FastifyInstance> {
    const a = Fastify({ logger: false });
    a.addHook('onRequest', async (req) => { if (actor !== undefined) (req as unknown as { actor: Actor }).actor = actor; });
    registerVoiceRoutes(a, { voice: s, dashboard, audit });
    await a.ready();
    return a;
  }
  beforeEach(() => { recorded.length = 0; actor = undefined; });
  afterEach(async () => { await app?.close(); });

  it('transcribe takes an audio/wav body and audits nothing about it', async () => {
    putModel();
    app = await build(service({ spawn: fakeSpawn('Approve it and ship it.').spawn as unknown as VoiceSpawn }));
    const res = await app.inject({ method: 'POST', url: '/api/v1/voice/transcribe', headers: { 'content-type': 'audio/wav' }, payload: wav() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ text: 'Approve it and ship it.', model: 'base.en' });
    expect(recorded).toEqual([]);
    const json = await app.inject({ method: 'POST', url: '/api/v1/voice/transcribe', payload: { audio: 'x' } });
    expect(json.statusCode).toBe(415);
  });

  it('the model needs consent, and the download start is audited', async () => {
    const s = service({ fetch: (async () => new Response(null, { status: 503 })) as unknown as typeof fetch });
    app = await build(s);
    const no = await app.inject({ method: 'POST', url: '/api/v1/voice/model', payload: {} });
    expect(no.statusCode).toBe(400);
    expect(no.json()).toMatchObject({ code: 'voice_consent_required' });
    const yes = await app.inject({ method: 'POST', url: '/api/v1/voice/model', payload: { consent: true } });
    expect(yes.statusCode).toBe(202);
    expect(recorded).toEqual([{ action: 'voice.model.download_started', detail: { model: 'base.en' } }]);
  });

  it("is the human operator's alone: a worker's actor is refused before anything runs", async () => {
    const spawn = fakeSpawn('x');
    putModel();
    app = await build(service({ spawn: spawn.spawn as unknown as VoiceSpawn }));
    actor = { id: 'seat:claude', kind: 'agent', trust: 'operator' } as unknown as Actor;
    for (const [method, url] of [['GET', '/api/v1/voice/status'], ['POST', '/api/v1/voice/transcribe'], ['GET', '/api/v1/voice/dashboard']] as const) {
      const res = await app.inject({ method, url, headers: { 'content-type': 'audio/wav' }, ...(method === 'POST' ? { payload: wav() } : {}) });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'human_operator_only' });
    }
    expect(spawn.calls).toEqual([]);
  });


  it('the fence runs before the body is read: a refused caller gets 403, never 413 (agy P3)', async () => {
    app = await build(service());
    const big = Buffer.alloc(9 * 1024 * 1024);
    const res = await app.inject({ method: 'POST', url: '/api/v1/voice/transcribe', remoteAddress: '10.0.0.7', headers: { 'content-type': 'audio/wav' }, payload: big });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'voice_loopback_only' });
  });

  it('only the transcribe route speaks of audio/wav: another voice route with a wrong media type does not (agy P3)', async () => {
    app = await build(service());
    const res = await app.inject({ method: 'POST', url: '/api/v1/voice/model', headers: { 'content-type': 'application/xml' }, payload: '<yes/>' });
    expect(res.statusCode).toBe(415);
    expect(res.body).not.toMatch(/audio\/wav/);
  });

  it('refuses a caller that is not on loopback', async () => {
    app = await build(service());
    const res = await app.inject({ method: 'GET', url: '/api/v1/voice/status', remoteAddress: '10.0.0.7' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'voice_loopback_only' });
  });

  it('the dashboard is saved per person, validated whole, and kept in one daemon- file', async () => {
    app = await build(service());
    const empty = await app.inject({ method: 'GET', url: '/api/v1/voice/dashboard' });
    expect(empty.json()).toEqual({ layout: null, widgets: [], updatedAt: null });
    const body = { layout: ['builtin.load', 'user.disk-free', 'builtin.gates'], widgets: [widget('user.disk-free')] };
    const put = await app.inject({ method: 'PUT', url: '/api/v1/voice/dashboard', payload: body });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject(body);
    expect(readdirSync(dir)).toEqual([VOICE_DASHBOARD_FILENAME]);
    // Another person sees their own (none yet).
    actor = { id: 'alice', kind: 'human', trust: 'operator' } as unknown as Actor;
    expect((await app.inject({ method: 'GET', url: '/api/v1/voice/dashboard' })).json()).toMatchObject({ layout: null });
    actor = undefined;
    expect((await app.inject({ method: 'GET', url: '/api/v1/voice/dashboard' })).json()).toMatchObject(body);
    for (const bad of [
      { layout: ['user.ghost'], widgets: [] },
      { layout: ['builtin.load', 'builtin.load'], widgets: [] },
      { layout: [], widgets: [widget('user.a'), widget('user.a')] },
      { layout: [], widgets: [widget('plugin.a')] },
      { layout: [], widgets: [widget('user.a', { metric: { source: 'system', path: 'constructor.prototype; drop', display: 'number' } })] },
      { layout: [], widgets: [widget('user.a', { title: '<script>' })] },
      { layout: [], widgets: [{ ...widget('user.a'), html: '<p>' }] },
    ]) {
      expect((await app.inject({ method: 'PUT', url: '/api/v1/voice/dashboard', payload: bad })).statusCode).toBe(400);
    }
  });

  it('with no state home the dashboard says so (503) and voice still transcribes', async () => {
    app = await build(service(), null);
    expect((await app.inject({ method: 'GET', url: '/api/v1/voice/dashboard' })).statusCode).toBe(503);
    expect((await app.inject({ method: 'GET', url: '/api/v1/voice/status' })).statusCode).toBe(200);
  });
});
