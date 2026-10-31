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
import { WorkingDocService, type DocBackend } from '../src/working-doc/service.js';
import { WorkingDocStore } from '../src/working-doc/store.js';

import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';

const RUN = 'run-voice-inject';
const NOTE = 'Keep the old URL working';

describe('VoiceInjectInputs', () => {
  it('stamps only the spoken note’s queued and injected frames, for its own run', () => {
    const v = new VoiceInjectInputs();
    v.remember(RUN, NOTE);
    expect(v.stamp({ type: 'workerMessageQueued', session: RUN, message: NOTE, target: 'all' })).toMatchObject({ input: 'voice' });
    expect(v.stamp({ type: 'workerMessageInjected', session: RUN, message: NOTE, target: 'all' })).toMatchObject({ input: 'voice' });
    // A typed note, another run's, or another frame type is left exactly as it was.
    const typed = { type: 'workerMessageInjected', session: RUN, message: 'typed', target: 'all' };
    expect(v.stamp(typed)).toBe(typed);
    const other = { type: 'workerMessageInjected', session: 'run-other', message: NOTE, target: 'all' };
    expect(v.stamp(other)).toBe(other);
    const delta = { type: 'unitOutputDelta', session: RUN, message: NOTE };
    expect(v.stamp(delta)).toBe(delta);
  });

  it('is bounded: oldest notes per run, and oldest runs, are dropped', () => {
    const v = new VoiceInjectInputs();
    for (let i = 0; i <= PER_RUN; i++) v.remember(RUN, `note ${i}`);
    expect(v.spoken(RUN, 'note 0')).toBe(false);
    expect(v.spoken(RUN, `note ${PER_RUN}`)).toBe(true);
    for (let i = 0; i < RUNS; i++) v.remember(`run-${i}`, NOTE);
    expect(v.spoken(RUN, `note ${PER_RUN}`)).toBe(false);
    expect(v.spoken(`run-${RUNS - 1}`, NOTE)).toBe(true);
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
      injectWorkerMessage: vi.fn(async (...args: unknown[]) => { injected.push(args); }),
      cancelRun: vi.fn(async (...args: unknown[]) => { cancelled.push(args); return 'cancelled'; }),
      runEvents: vi.fn(async () => [
        { type: 'workerMessageQueued', session: RUN, message: NOTE, target: 'all', seq: 1, ts: 1 },
        { type: 'workerMessageInjected', session: RUN, message: NOTE, target: 'all', seq: 2, ts: 2 },
        { type: 'workerMessageInjected', session: RUN, message: 'typed later', target: 'all', seq: 3, ts: 3 },
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
    expect(events.map((e) => e['input'])).toEqual(['voice', 'voice', undefined]);
  });

  it('a typed note records no input, and any other input word is a 400', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN}/inject`, payload: { message: 'typed', target: 'all' } })).statusCode).toBe(200);
    expect(recorded.find((r) => r.action === 'run.injected')?.detail).toEqual({ target: 'all' });
    const bad = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN}/inject`, payload: { message: 'x', input: 'typing' } });
    expect(bad.statusCode).toBe(400);
  });

  it('a worker’s bearer cannot claim a note was spoken (403, nothing sent)', async () => {
    actor = { id: 'worker-1', kind: 'agent', trust: 'operator' };
    const res = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN}/inject`, payload: { message: 'from a worker', input: 'voice' } });
    expect(res.statusCode).toBe(403);
    expect(injected).toHaveLength(0);
    expect(voiceInputs.spoken(RUN, 'from a worker')).toBe(false);
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
    async create(_p: string, _d: string, _r: string, html: string) { this.versions = [html]; return { head: 0 }; }
    async read() { return this.versions.length === 0 ? null : { head: this.versions.length - 1, html: this.versions.at(-1)! }; }
    async readVersion(_p: string, _d: string, v: number) { return this.versions[v] ?? null; }
    async edit(_p: string, _d: string, batch: { expectHead: number; items: Array<{ selector: string; value: string }> }) {
      const head = this.versions.length - 1;
      if (batch.expectHead !== head) return { headMoved: true as const, head };
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
    const s = new WorkingDocService({
      store: new WorkingDocStore({ stateHome: h }),
      backend: new Backend(),
      engine: { injectWorkerMessage: async () => 'queued' },
      run: async () => ({ title: 't', problem: 'p', projectId: 'default', terminal: false, stepOf: () => null }),
      audit: (action, _a, _r, detail) => audits.push({ action, detail }),
      now: () => 1_000,
    });
    return { s, audits };
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
});
