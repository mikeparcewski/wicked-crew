// A note said by voice (program DES-VOICE §3 "Talking to a running job"): studio confirms a spoken steer on screen and
// sends it through the same inject / working-document routes with `input: "voice"`. Crew keeps it on the audit line,
// on the working document's steer, and stamps it on the note's queued/injected frames so the thread says
// "You (by voice)". It grants nothing: same route, same checks; a worker or plugin bearer cannot claim it.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { AuditLog } from '../src/api/audit.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { Actor } from '../src/core/types.js';
import { PER_RUN, RUNS, VoiceInjectInputs } from '../src/voice/inject-input.js';
import { UndeterminedWriteError, WorkingDocService, type DocBackend } from '../src/working-doc/service.js';
import { registerWorkingDocRoutes } from '../src/working-doc/routes.js';
import { WorkingDocStore } from '../src/working-doc/store.js';

import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';

const RUN = 'run-voice-inject';
const NOTE = 'Keep the old URL working';

describe('VoiceInjectInputs', () => {
  const q = (message: string, target = 'all', ts?: number) => ({ type: 'workerMessageQueued', session: RUN, message, target, ...(ts !== undefined ? { ts } : {}) });
  const inj = (message: string, target = 'all', ts?: number) => ({ type: 'workerMessageInjected', session: RUN, message, target, ...(ts !== undefined ? { ts } : {}) });
  const held = (v: VoiceInjectInputs, run: string, message: string): boolean =>
    v.stampHistory(run, [{ type: 'workerMessageInjected', session: run, message, target: 'all', ts: 10_000 }])[0]!['input' as never] === 'voice';

  it('stamps only the spoken send’s own queued and injected frames, for its own run and target', () => {
    const v = new VoiceInjectInputs(() => 1_000);
    v.remember(RUN, NOTE);
    v.settle(RUN);
    expect(v.stamp(q(NOTE))).toMatchObject({ input: 'voice' });
    expect(v.stamp(inj(NOTE))).toMatchObject({ input: 'voice' });
    // A typed note, another run's, another target, or another frame type is left exactly as it was.
    for (const f of [inj('typed'), { ...inj(NOTE), session: 'run-other' }, { type: 'unitOutputDelta', session: RUN, message: NOTE }]) expect(v.stamp(f)).toBe(f);
    v.remember(RUN, NOTE, 'claude');
    const codex = inj(NOTE, 'codex');
    expect(v.stamp(codex)).toBe(codex);
  });

  it('a typed note with the same words, sent after the spoken one, is not labelled (live)', () => {
    const v = new VoiceInjectInputs(() => 1_000);
    v.remember(RUN, 'Continue');
    expect(v.stamp(q('Continue'))).toMatchObject({ input: 'voice' });
    expect(v.stamp(inj('Continue'))).toMatchObject({ input: 'voice' });
    // The typed "Continue" after it: its frames stay plain.
    expect(v.stamp(q('Continue'))).not.toHaveProperty('input');
    expect(v.stamp(inj('Continue'))).not.toHaveProperty('input');
  });

  it('history: typed notes with the same words before and after the spoken one stay plain', () => {
    const v = new VoiceInjectInputs(() => 50_000);
    v.remember(RUN, 'Continue');
    const out = v.stampHistory(RUN, [q('Continue', 'all', 10_000), inj('Continue', 'all', 11_000), q('Continue', 'all', 50_100), inj('Continue', 'all', 51_000), inj('Continue', 'all', 90_000)]);
    expect(out.map((e) => (e as { input?: string }).input)).toEqual([undefined, undefined, 'voice', 'voice', undefined]);
    // Pure: the same history reads the same, and live claims are untouched.
    const plain = out.map((e) => { const copy: Record<string, unknown> = { ...e }; delete copy['input']; return copy as typeof e; });
    expect(v.stampHistory(RUN, plain)).toEqual(out);
    expect(v.stamp(inj('Continue'))).toMatchObject({ input: 'voice' });
  });

  it('a send the engine refused is forgotten: it labels nothing and evicts nothing', () => {
    const v = new VoiceInjectInputs(() => 1_000);
    const send = (run: string, m: string): void => { v.remember(run, m); v.settle(run); };
    for (let i = 0; i < PER_RUN; i++) send(RUN, `note ${i}`);
    v.forget(RUN, v.remember(RUN, 'refused'));
    expect(held(v, RUN, 'refused')).toBe(false);
    expect(held(v, RUN, 'note 0')).toBe(true);
    // At the run bound too: a refused send to a new run evicts no other run.
    for (let i = 1; i < RUNS; i++) send(`run-${i}`, NOTE);
    v.forget('run-new', v.remember('run-new', NOTE));
    expect(held(v, RUN, 'note 0')).toBe(true);
    expect(held(v, 'run-new', NOTE)).toBe(false);
  });

  it('is bounded: the oldest sends per run, and the oldest runs, are dropped; a repeated note is a new send', () => {
    const v = new VoiceInjectInputs(() => 1_000);
    const send = (run: string, m: string): void => { v.remember(run, m); v.settle(run); };
    send(RUN, 'Continue');
    for (let i = 1; i < PER_RUN; i++) send(RUN, `note ${i}`);
    send(RUN, 'Continue');
    send(RUN, 'one more');
    // The first "Continue" fell off; the one just said is held.
    expect(held(v, RUN, 'Continue')).toBe(true);
    expect(held(v, RUN, 'note 1')).toBe(false);
    for (let i = 0; i < RUNS; i++) send(`run-${i}`, NOTE);
    expect(held(v, RUN, 'Continue')).toBe(false);
    expect(held(v, `run-${RUNS - 1}`, NOTE)).toBe(true);
  });
});

describe('POST /runs/:id/inject {input: "voice"}', () => {
  let app: FastifyInstance;
  let actor: Actor = { id: 'local', kind: 'human', trust: 'admin' };
  const injected: unknown[][] = [];
  const cancelled: unknown[][] = [];
  const recorded: Array<{ action: string; detail?: Record<string, unknown> }> = [];
  const voiceInputs = new VoiceInjectInputs();
  const audit = {
    record: vi.fn((action: string, _actor: unknown, fields?: { detail?: Record<string, unknown> }) => {
      recorded.push({ action, ...(fields?.detail !== undefined ? { detail: fields.detail } : {}) });
      return Date.now();
    }),
  } as unknown as AuditLog;

  beforeAll(async () => {
    const adapter = {
      sessions: vi.fn().mockResolvedValue([RUN]),
      sessionsDetail: vi.fn().mockResolvedValue([{ session: { id: RUN, status: 'executing' }, units: [] }]),
      listRepos: vi.fn().mockResolvedValue([]),
      listWorkflows: () => BUILTIN_WORKFLOWS,
      injectWorkerMessage: vi.fn(async (...args: unknown[]) => {
        if (args[2] === 'ghost') throw new Error('no worker ghost');
        injected.push(args);
      }),
      cancelRun: vi.fn(async (...args: unknown[]) => { cancelled.push(args); return 'cancelled'; }),
      // The engine's log, captured as the sends happen (after them).
      runEvents: vi.fn(async () => [
        { type: 'workerMessageQueued', session: RUN, message: NOTE, target: 'all', seq: 1, ts: Date.now() },
        { type: 'workerMessageInjected', session: RUN, message: NOTE, target: 'all', seq: 2, ts: Date.now() },
        { type: 'workerMessageInjected', session: RUN, message: 'typed later', target: 'all', seq: 3, ts: Date.now() },
        { type: 'workerMessageInjected', session: RUN, message: 'refused', target: 'ghost', seq: 4, ts: Date.now() },
      ]),
    };
    app = Fastify({ logger: false });
    app.addHook('onRequest', async (req) => { (req as { actor?: Actor }).actor = actor; });
    registerRoutes(app, adapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), undefined, { audit, authMode: 'off' }, { voiceInputs });
    await app.ready();
  });
  beforeEach(() => { injected.length = 0; cancelled.length = 0; recorded.length = 0; actor = { id: 'local', kind: 'human', trust: 'admin' }; });
  afterAll(async () => { await app.close(); });

  it('sends the note exactly like a typed one, says voice on the audit line, and stamps the history', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN}/inject`, payload: { message: NOTE, target: 'all', input: 'voice' } });
    expect(res.statusCode).toBe(200);
    expect(injected).toEqual([[RUN, NOTE, 'all']]);
    expect(recorded.find((r) => r.action === 'run.injected')?.detail).toEqual({ target: 'all', input: 'voice' });
    const ev = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN}/events` });
    const events = (ev.json() as { events: Array<Record<string, unknown>> }).events;
    expect(events.map((e) => e['input'])).toEqual(['voice', 'voice', undefined, undefined]);
  });

  it('a typed note records no input, and any other input word is a 400', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN}/inject`, payload: { message: 'typed', target: 'all' } })).statusCode).toBe(200);
    expect(recorded.find((r) => r.action === 'run.injected')?.detail).toEqual({ target: 'all' });
    const bad = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN}/inject`, payload: { message: 'x', input: 'typing' } });
    expect(bad.statusCode).toBe(400);
  });

  it('a send the engine refused (409) is not remembered as spoken', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN}/inject`, payload: { message: 'refused', target: 'ghost', input: 'voice' } });
    expect(res.statusCode).toBe(409);
    const ev = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN}/events?type=workerMessageInjected` });
    const events = (ev.json() as { events: Array<Record<string, unknown>> }).events;
    expect(events.find((e) => e['message'] === 'refused')).not.toHaveProperty('input');
  });

  it('a worker’s bearer cannot claim a note was spoken (403, nothing sent)', async () => {
    actor = { id: 'worker-1', kind: 'agent', trust: 'operator' };
    const res = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN}/inject`, payload: { message: 'from a worker', input: 'voice' } });
    expect(res.statusCode).toBe(403);
    expect(injected).toHaveLength(0);
    expect(voiceInputs.stampHistory(RUN, [{ type: 'workerMessageInjected', session: RUN, message: 'from a worker', target: 'all' }])[0]).not.toHaveProperty('input');
  });
});

describe('POST /runs/:id/cancel {reason, input}', () => {
  let app: FastifyInstance;
  let actor: Actor = { id: 'local', kind: 'human', trust: 'admin' };
  const cancelled: unknown[][] = [];
  const recorded: Array<{ action: string; detail?: Record<string, unknown> }> = [];
  const audit = {
    record: vi.fn((action: string, _actor: unknown, fields?: { detail?: Record<string, unknown> }) => {
      recorded.push({ action, ...(fields?.detail !== undefined ? { detail: fields.detail } : {}) });
      return Date.now();
    }),
  } as unknown as AuditLog;
  beforeAll(async () => {
    const adapter = {
      sessions: vi.fn().mockResolvedValue([RUN]),
      sessionsDetail: vi.fn().mockResolvedValue([{ session: { id: RUN, status: 'executing' }, units: [] }]),
      listRepos: vi.fn().mockResolvedValue([]),
      listWorkflows: () => BUILTIN_WORKFLOWS,
      runEvents: vi.fn(async () => []),
      cancelRun: vi.fn(async (...args: unknown[]) => { cancelled.push(args); return 'cancelled'; }),
    };
    app = Fastify({ logger: false });
    app.addHook('onRequest', async (req) => { (req as { actor?: Actor }).actor = actor; });
    registerRoutes(app, adapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), undefined, { audit, authMode: 'off' });
    await app.ready();
  });
  beforeEach(() => { cancelled.length = 0; recorded.length = 0; actor = { id: 'local', kind: 'human', trust: 'admin' }; });
  afterAll(async () => { await app.close(); });

  it('a bodiless cancel is unchanged', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN}/cancel` });
    expect(res.statusCode).toBe(200);
    expect(cancelled).toEqual([[RUN]]);
    expect(recorded.find((r) => r.action === 'run.cancelled')?.detail).toEqual({ status: 'cancelled' });
  });

  it('an empty text body is no body', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN}/cancel`, headers: { 'content-type': 'text/plain' }, payload: '' });
    expect(res.statusCode).toBe(200);
    expect(recorded.find((r) => r.action === 'run.cancelled')?.detail).toEqual({ status: 'cancelled' });
  });

  it('keeps the reason and voice on the audit line', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN}/cancel`, payload: { reason: '  wrong repo  ', input: 'voice' } });
    expect(res.statusCode).toBe(200);
    expect(recorded.find((r) => r.action === 'run.cancelled')?.detail).toEqual({ status: 'cancelled', reason: 'wrong repo', input: 'voice' });
  });

  it('refuses an unknown field (400) and voice from a worker (403), stopping nothing', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN}/cancel`, payload: { why: 'x' } })).statusCode).toBe(400);
    actor = { id: 'worker-1', kind: 'agent', trust: 'operator' };
    expect((await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN}/cancel`, payload: { input: 'voice' } })).statusCode).toBe(403);
    expect(cancelled).toHaveLength(0);
  });
});

describe('a working-document edit said by voice', () => {
  const homes: string[] = [];
  afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

  class Backend implements DocBackend {
    versions: string[] = [];
    hold: (() => void) | null = null;
    holdNext = false;
    async create(_p: string, _d: string, _r: string, html: string) { this.versions = [html]; return { head: 0 }; }
    async read() { return this.versions.length === 0 ? null : { head: this.versions.length - 1, html: this.versions.at(-1)! }; }
    async readVersion(_p: string, _d: string, v: number) { return this.versions[v] ?? null; }
    async edit(_p: string, _d: string, batch: { expectHead: number; items: Array<{ selector: string; value: string }> }) {
      const head = this.versions.length - 1;
      if (batch.expectHead !== head) return { headMoved: true as const, head };
      if (this.holdNext) {
        this.holdNext = false;
        this.hold = () => { this.holdNext = false; void this.edit(_p, _d, batch); };
        throw new UndeterminedWriteError('it may still land');
      }
      let html = this.versions[head]!;
      for (const it of batch.items) html = html.replace(new RegExp(`(<div\\b[^>]*data-wid="${it.selector}"[^>]*>)[\\s\\S]*?(</div>)`, 'u'), `$1${it.value}$2`);
      this.versions.push(html);
      return { version: head + 1, parent: head };
    }
  }

  function service() {
    const h = mkdtempSync(join(tmpdir(), 'wdv-'));
    homes.push(h);
    const audits: Array<{ action: string; detail: Record<string, unknown> }> = [];
    const backend = new Backend();
    const s = new WorkingDocService({
      store: new WorkingDocStore({ stateHome: h }),
      backend,
      engine: { injectWorkerMessage: async () => 'queued' },
      run: async () => ({ title: 't', problem: 'p', projectId: 'default', terminal: false, stepOf: () => null }),
      audit: (action, _a, _r, detail) => audits.push({ action, detail }),
      now: () => 1_000,
    });
    return { s, audits, backend };
  }
  const HUMAN: Actor = { id: 'local', kind: 'human', trust: 'admin' };

  it('keeps voice on the steer and its audit line', async () => {
    const { s, audits } = service();
    await s.ensure(RUN);
    const r = await s.propose(RUN, { base: 0, author: 'operator', sections: { constraints: NOTE }, input: 'voice' }, HUMAN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.steer).toMatchObject({ kind: 'standing', input: 'voice' });
    expect(r.view.steers.at(-1)?.input).toBe('voice');
    expect(audits.at(-1)?.detail).toMatchObject({ input: 'voice' });
  });

  it('a typed edit has no input; voice on a plugin’s write, or another word, is a 400', async () => {
    const { s } = service();
    await s.ensure(RUN);
    const typed = await s.propose(RUN, { base: 0, author: 'operator', sections: { next: 'Add tests' } }, HUMAN);
    expect(typed.ok && typed.steer).not.toHaveProperty('input');
    const plugin = await s.propose(RUN, { base: 1, author: 'plugin', plugin: { id: 'wicked-phase-report', version: '0.13.1' }, sections: { next: 'x' }, input: 'voice' }, HUMAN);
    expect(plugin).toMatchObject({ ok: false, code: 400 });
    const other = await s.propose(RUN, { base: 1, author: 'operator', sections: { next: 'y' }, input: 'typing' as 'voice' }, HUMAN);
    expect(other).toMatchObject({ ok: false, code: 400 });
  });

  it('an edit whose outcome was unknown keeps voice once it is settled', async () => {
    const { s, audits, backend } = service();
    await s.ensure(RUN);
    backend.holdNext = true;
    await expect(s.propose(RUN, { base: 0, author: 'operator', sections: { next: 'Add GBP tests' }, input: 'voice' }, HUMAN)).rejects.toThrow(/may still land/u);
    backend.hold!();
    const v = await s.view(RUN);
    expect(v.steers.at(-1)).toMatchObject({ input: 'voice' });
    expect(audits.at(-1)?.detail).toMatchObject({ input: 'voice' });
  });

  it('over HTTP: 200 for a person, 400 on a plugin write, 403 for a worker claiming to be the operator', async () => {
    const { s } = service();
    await s.ensure(RUN);
    let actor: Actor = HUMAN;
    const app = Fastify({ logger: false });
    app.addHook('onRequest', async (req) => { (req as { actor?: Actor }).actor = actor; });
    registerWorkingDocRoutes(app, { service: s, exists: async () => true });
    await app.ready();
    try {
      const url = `/api/v1/runs/${RUN}/working-doc/versions`;
      const ok = await app.inject({ method: 'POST', url, payload: { base: 0, author: 'operator', sections: { next: 'Add GBP tests' }, input: 'voice' } });
      expect(ok.statusCode).toBe(200);
      expect((ok.json() as { steer: { input?: string } }).steer.input).toBe('voice');
      const plugin = await app.inject({ method: 'POST', url, payload: { base: 1, author: 'plugin', plugin: { id: 'wicked-phase-report', version: '0.13.1' }, sections: { next: 'x' }, input: 'voice' } });
      expect(plugin.statusCode).toBe(400);
      actor = { id: 'worker-1', kind: 'agent', trust: 'operator' };
      const worker = await app.inject({ method: 'POST', url, payload: { base: 1, author: 'operator', sections: { next: 'y' }, input: 'voice' } });
      expect(worker.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
