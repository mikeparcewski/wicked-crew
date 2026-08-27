// The `studio.*` settings namespace (crew#323) — the skin's half of the shared settings store.
//
// `PUT /settings` used to filter every patch through a closed three-key allowlist and DISCARD
// the rest at 200, which meant the studio's own `studio.appearance` / `studio.notifications`
// blobs had never once persisted: the write looked like a success, the read looked like a
// fresh install. These tests pin the contract that replaces it —
//
//   - a key matching `^studio\.[a-z][a-z0-9-]*$` round-trips VERBATIM,
//   - an unserializable or oversize value is refused with a 400 that NAMES the key,
//   - anything else unrecognized is still dropped (request bodies stay forward-additive),
//     but named in the audit trail so the drop is no longer invisible,
//   - the three engine keys validate exactly as they did before.
//
// Harness matches settings-worker-root.test.ts: registerRoutes driven directly over an
// in-memory settings store with the adapter's merge semantics (defaults + patch, no disk).

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import Fastify from 'fastify';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { QeGateCache } from '../src/qe/gate-events.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { AuditLog } from '../src/api/audit.js';
import { CoreAdapter, settingsFilePath } from '../src/core/adapter.js';
import type { CrewSystemSettings } from '../src/core/types.js';
import type { FastifyInstance } from 'fastify';

/** The route's per-key cap on a `studio.*` value, restated so a change to it breaks here too. */
const CAP_BYTES = 512 * 1024;

/** In-memory settings store with the adapter's exact merge semantics (defaults + patch). */
function memoryAdapter(initial?: Partial<CrewSystemSettings>): CoreAdapter {
  let store: CrewSystemSettings = { graphNodeLimit: 150, ...initial };
  return {
    getSettings: async () => ({ ...store }),
    updateSettings: async (patch: Partial<CrewSystemSettings>) => {
      store = { ...store, ...patch };
      return { ...store };
    },
  } as unknown as CoreAdapter;
}

function buildApp(adapter: CoreAdapter, audit: AuditLog = AuditLog.noop()): FastifyInstance {
  const app = Fastify({ logger: false });
  // A body a JSON parser could never produce: the serializability guard is defense in depth for
  // any future body parser, so it is exercised through one rather than left unproven.
  app.addContentTypeParser('application/x-circular', { parseAs: 'string' }, (_req, _body, done) => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    done(null, { 'studio.appearance': circular });
  });
  // A body whose PROTOTYPE carries an engine key and whose own properties carry none. `in` would
  // see `graphNodeLimit` here; `Object.hasOwn` does not. 999 is outside the valid 20..500 range,
  // so an `in`-based read is forced to reveal itself as a 400 rather than passing silently.
  app.addContentTypeParser('application/x-proto-engine', { parseAs: 'string' }, (_req, _body, done) => {
    done(null, Object.create({ graphNodeLimit: 999 }) as Record<string, unknown>);
  });
  registerRoutes(
    app,
    adapter,
    new GateCache(),
    new ElicitationCache(),
    new QeGateCache(),
    { bus: null, index: new MembershipIndex(), log: () => undefined },
    { audit, authMode: 'off' },
  );
  return app;
}

const put = (app: FastifyInstance, payload: unknown) =>
  app.inject({ method: 'PUT', url: '/api/v1/settings', payload: payload as object });

const settingsOf = (res: { json: () => unknown }) =>
  (res.json() as { settings: CrewSystemSettings }).settings;

describe('PUT/GET /settings studio.* namespace', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    // Guarded: a pre-assignment failure must surface itself, not this cleanup (Copilot).
    await app?.close();
    app = undefined;
  });

  it('round-trips a studio.* blob VERBATIM through PUT and back out of GET', async () => {
    app = buildApp(memoryAdapter());
    await app.ready();

    const appearance = { accent: '#7c3aed', theme: 'dark', logoDataUri: 'data:image/svg+xml;base64,PHN2Zy8+' };
    const res = await put(app, { 'studio.appearance': appearance });
    expect(res.statusCode).toBe(200);
    expect(settingsOf(res)['studio.appearance']).toEqual(appearance);

    const get = await app.inject({ method: 'GET', url: '/api/v1/settings' });
    expect(settingsOf(get)['studio.appearance']).toEqual(appearance);
    // The engine's own keys are untouched by a skin write.
    expect(settingsOf(get).graphNodeLimit).toBe(150);
  });

  it('persists a studio.* key BESIDE the engine keys in one patch', async () => {
    app = buildApp(memoryAdapter());
    await app.ready();

    const res = await put(app, {
      graphNodeLimit: 300,
      'studio.notifications': { desktop: true },
      'studio.appearance': { accent: '#0ea5e9' },
    });
    expect(res.statusCode).toBe(200);
    const settings = settingsOf(res);
    expect(settings.graphNodeLimit).toBe(300);
    expect(settings['studio.notifications']).toEqual({ desktop: true });
    expect(settings['studio.appearance']).toEqual({ accent: '#0ea5e9' });
  });

  it('accepts every JSON value shape a skin might store, null included', async () => {
    app = buildApp(memoryAdapter());
    await app.ready();

    const res = await put(app, {
      'studio.a': null,
      'studio.b': 'string',
      'studio.c': 7,
      'studio.d': false,
      'studio.multi-word': [1, { nested: true }],
    });
    expect(res.statusCode).toBe(200);
    const settings = settingsOf(res);
    expect(settings['studio.a']).toBeNull();
    expect(settings['studio.b']).toBe('string');
    expect(settings['studio.c']).toBe(7);
    expect(settings['studio.d']).toBe(false);
    expect(settings['studio.multi-word']).toEqual([1, { nested: true }]);
  });

  it('accepts a value exactly AT the per-key cap and 400s the first byte over it', async () => {
    app = buildApp(memoryAdapter());
    await app.ready();

    // JSON.stringify of an n-char ASCII string is n + 2 bytes (the quotes).
    const atCap = await put(app, { 'studio.appearance': 'x'.repeat(CAP_BYTES - 2) });
    expect(atCap.statusCode).toBe(200);
    expect((settingsOf(atCap)['studio.appearance'] as string).length).toBe(CAP_BYTES - 2);

    const overCap = await put(app, { 'studio.appearance': 'x'.repeat(CAP_BYTES - 1) });
    expect(overCap.statusCode).toBe(400);
    const error = (overCap.json() as { error: string }).error;
    // The 400 names the key AND the limit — this path must never be silent (#323).
    expect(error).toContain('studio.appearance');
    expect(error).toContain(String(CAP_BYTES));
  });

  it('an oversize key REJECTS the whole patch — no half-write of its engine keys', async () => {
    const adapter = memoryAdapter();
    app = buildApp(adapter);
    await app.ready();

    const res = await put(app, {
      graphNodeLimit: 400,
      'studio.appearance': 'x'.repeat(CAP_BYTES),
    });
    expect(res.statusCode).toBe(400);
    expect((await adapter.getSettings()).graphNodeLimit).toBe(150);
  });

  it('400s a value it cannot serialize, naming the key', async () => {
    app = buildApp(memoryAdapter());
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: { 'content-type': 'application/x-circular' },
      payload: 'ignored — the parser fabricates the circular body',
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe(
      'studio.appearance must be a JSON-serializable value',
    );
  });

  it('DROPS an unrecognized key that is not in the namespace, and names it in the audit trail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-settings-audit-'));
    const audit = new AuditLog(join(dir, 'audit.log'));
    const adapter = memoryAdapter();
    app = buildApp(adapter, audit);
    await app.ready();

    try {
      // `Studio.appearance` (capital) and `studio.a.b` (two segments) are NOT the namespace —
      // the regex is one lowercase segment, so both land in the dropped pile with `nonsense`.
      const res = await put(app, {
        'studio.appearance': { accent: '#111' },
        nonsense: 'dropped',
        'Studio.appearance': 'dropped',
        'studio.a.b': 'dropped',
      });
      expect(res.statusCode).toBe(200); // dropped, NOT refused — request bodies stay additive
      const settings = settingsOf(res);
      expect(settings['studio.appearance']).toEqual({ accent: '#111' });
      expect(settings).not.toHaveProperty('nonsense');
      expect(settings).not.toHaveProperty('Studio.appearance');
      expect(settings).not.toHaveProperty('studio.a.b');

      await audit.flush();
      const entries = await audit.read({ action: 'settings.updated' });
      expect(entries).toHaveLength(1);
      const detail = entries[0]?.detail as { changed: string[]; ignored?: string[] };
      // The namespaced key is recorded as CHANGED alongside the engine keys it rides with...
      expect(detail.changed).toEqual(['studio.appearance']);
      // ...and the drop is no longer invisible.
      expect(detail.ignored).toEqual(['nonsense', 'Studio.appearance', 'studio.a.b']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names a dropped key even when it collides with an Object.prototype member', async () => {
    // `k in safe` would report `toString`/`valueOf`/`constructor` as KEPT (the prototype chain
    // answers for them), so they would be dropped without ever reaching `detail.ignored` — the
    // silent drop #323 is about. The filter uses Object.hasOwn precisely so this bites.
    const dir = mkdtempSync(join(tmpdir(), 'studio-settings-proto-'));
    const audit = new AuditLog(join(dir, 'audit.log'));
    const adapter = memoryAdapter();
    app = buildApp(adapter, audit);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/settings',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          'studio.appearance': { accent: '#111' },
          toString: 'dropped',
          valueOf: 'dropped',
          constructor: 'dropped',
          hasOwnProperty: 'dropped',
        }),
      });
      expect(res.statusCode).toBe(200);
      const settings = settingsOf(res);
      // None of them are persisted...
      for (const key of ['toString', 'valueOf', 'constructor', 'hasOwnProperty']) {
        expect(Object.hasOwn(settings, key)).toBe(false);
      }
      await audit.flush();
      const detail = (await audit.read({ action: 'settings.updated' }))[0]?.detail as {
        changed: string[];
        ignored?: string[];
      };
      expect(detail.changed).toEqual(['studio.appearance']);
      // ...and every one of them is NAMED as dropped.
      expect(detail.ignored).toEqual(['toString', 'valueOf', 'constructor', 'hasOwnProperty']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores an engine key that exists only on the body prototype (Copilot on #324)', async () => {
    const adapter = memoryAdapter();
    app = buildApp(adapter);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: { 'content-type': 'application/x-proto-engine' },
      payload: 'ignored — the parser fabricates a body with graphNodeLimit on its prototype',
    });

    // Not a 400: the validator must never even look at an inherited key, so the out-of-range
    // 999 is not reachable. And not persisted: the caller sent no own properties at all.
    expect(res.statusCode).toBe(200);
    expect((res.json() as { settings: { graphNodeLimit: number } }).settings.graphNodeLimit).toBe(
      150,
    );
    const stored = await adapter.getSettings();
    expect(stored.graphNodeLimit).toBe(150);
  });

  it('omits `ignored` from the audit entry when nothing was dropped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-settings-audit-'));
    const audit = new AuditLog(join(dir, 'audit.log'));
    app = buildApp(memoryAdapter(), audit);
    await app.ready();

    try {
      await put(app, { graphNodeLimit: 200, 'studio.notifications': { desktop: false } });
      await audit.flush();
      const detail = (await audit.read({ action: 'settings.updated' }))[0]?.detail as {
        changed: string[];
        ignored?: string[];
      };
      expect(detail.changed).toEqual(['graphNodeLimit', 'studio.notifications']);
      expect(detail.ignored).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PUT /settings engine keys validate as before (crew#323 regression guard)', () => {
  let app: FastifyInstance | undefined;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'studio-settings-engine-'));
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    rmSync(dir, { recursive: true, force: true });
    delete process.env['WICKED_WORKER_HOME'];
  });

  it('graphNodeLimit: 20..500 integers only', async () => {
    app = buildApp(memoryAdapter());
    await app.ready();

    expect((await put(app, { graphNodeLimit: 300 })).statusCode).toBe(200);
    for (const bad of [19, 501, 100.5, '300', null]) {
      const res = await put(app, { graphNodeLimit: bad });
      expect(res.statusCode, `graphNodeLimit: ${JSON.stringify(bad)}`).toBe(400);
      expect((res.json() as { error: string }).error).toContain('graphNodeLimit');
    }
  });

  it('workerStallMinutes: 1..1440 integers only (crew#287)', async () => {
    app = buildApp(memoryAdapter());
    await app.ready();

    expect((await put(app, { workerStallMinutes: 30 })).statusCode).toBe(200);
    for (const bad of [0, 1441, 2.5, '30']) {
      const res = await put(app, { workerStallMinutes: bad });
      expect(res.statusCode, `workerStallMinutes: ${JSON.stringify(bad)}`).toBe(400);
      expect((res.json() as { error: string }).error).toContain('workerStallMinutes');
    }
  });

  it('worker_config_root: an absolute path or "" (seat sign-in)', async () => {
    app = buildApp(memoryAdapter());
    await app.ready();

    expect((await put(app, { worker_config_root: dir })).statusCode).toBe(200);
    expect((await put(app, { worker_config_root: '' })).statusCode).toBe(200);
    for (const bad of ['relative/worker-homes', 42]) {
      const res = await put(app, { worker_config_root: bad });
      expect(res.statusCode, `worker_config_root: ${JSON.stringify(bad)}`).toBe(400);
      expect((res.json() as { error: string }).error).toContain('worker_config_root');
    }
  });

  it('still refuses a non-object body', async () => {
    app = buildApp(memoryAdapter());
    await app.ready();

    expect((await put(app, ['studio.appearance'])).statusCode).toBe(400);
  });
});

// The READ half of the cap (crew#325). PUT refuses an over-cap `studio.*` write, but the cap bound
// only the write path: `getSettings()` served a hand-edited 600KB blob in full, and because
// `updateSettings()` reads through it, an unrelated patch rewrote all of it back to disk — so the
// route could refuse to CREATE that state but not to PROPAGATE it, and the cap could never be
// lowered. Driven against the real CoreAdapter with $HOME redirected, matching the harness in
// settings-worker-root.test.ts: neither getSettings nor updateSettings touches engine state, so
// calling them off the prototype avoids spawning a Core.
describe('adapter getSettings enforces the studio.* cap on READ (crew#325)', () => {
  const savedHome = process.env['HOME'];
  let fakeHome: string;
  // Typed off the helper rather than off `vi.spyOn` directly — the MockInstance type parameters
  // have changed shape across vitest majors, the inferred one never does.
  const silenceWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  let warn: ReturnType<typeof silenceWarn>;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'studio-cap-home-'));
    process.env['HOME'] = fakeHome; // os.homedir() honours $HOME on POSIX
    warn = silenceWarn();
  });

  afterEach(() => {
    warn.mockRestore();
    if (savedHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = savedHome;
    rmSync(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function writeSettings(content: unknown): void {
    // settingsFilePath() reads $HOME at call time, which beforeEach points at the fixture.
    const file = settingsFilePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(content));
  }

  const readSettings = (): Record<string, unknown> =>
    JSON.parse(readFileSync(settingsFilePath(), 'utf8')) as Record<string, unknown>;

  const read = (): Promise<CrewSystemSettings> =>
    CoreAdapter.prototype.getSettings.call({} as CoreAdapter);

  // `updateSettings` calls `this.getSettings()`, so the fake `this` carries that one method.
  const update = (patch: Partial<CrewSystemSettings>): Promise<CrewSystemSettings> =>
    CoreAdapter.prototype.updateSettings.call(
      { getSettings: CoreAdapter.prototype.getSettings } as unknown as CoreAdapter,
      patch,
    );

  it('drops a hand-edited over-cap studio.* key, naming the key and the limit', async () => {
    writeSettings({ graphNodeLimit: 150, 'studio.appearance': 'x'.repeat(CAP_BYTES) });

    const settings = await read();
    expect(settings).not.toHaveProperty('studio.appearance');
    // Everything else survives — this drops ONE key, it is not a settings.json reset.
    expect(settings.graphNodeLimit).toBe(150);

    // Loud, not silent (#323): the operator whose theme "reset itself" is told which key went,
    // how big it was, and what the ceiling is.
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('studio.appearance');
    expect(line).toContain(String(CAP_BYTES + 2)); // n-char ASCII string → n + 2 bytes of JSON
    expect(line).toContain(String(CAP_BYTES));
  });

  it('keeps a value exactly AT the cap, and the first byte over it is the one that goes', async () => {
    writeSettings({ graphNodeLimit: 150, 'studio.appearance': 'x'.repeat(CAP_BYTES - 2) });
    expect((await read())['studio.appearance']).toBe('x'.repeat(CAP_BYTES - 2));
    expect(warn).not.toHaveBeenCalled();

    writeSettings({ graphNodeLimit: 150, 'studio.appearance': 'x'.repeat(CAP_BYTES - 1) });
    expect(await read()).not.toHaveProperty('studio.appearance');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('leaves under-cap siblings alone when it drops one key', async () => {
    writeSettings({
      'studio.appearance': 'x'.repeat(CAP_BYTES),
      'studio.notifications': { desktop: true },
    });

    const settings = await read();
    expect(settings).not.toHaveProperty('studio.appearance');
    expect(settings['studio.notifications']).toEqual({ desktop: true });
  });

  it('does NOT carry an over-cap value forward through a patch that never names it', async () => {
    writeSettings({ graphNodeLimit: 150, 'studio.appearance': 'x'.repeat(CAP_BYTES) });

    const next = await update({ graphNodeLimit: 100 });
    expect(next.graphNodeLimit).toBe(100);
    expect(next).not.toHaveProperty('studio.appearance');
    // And the rewritten file no longer stores it — otherwise the cap is un-lowerable, because
    // anything already past the limit reappears on the next unrelated write.
    const onDisk = readSettings();
    expect(onDisk).not.toHaveProperty('studio.appearance');
    expect(onDisk['graphNodeLimit']).toBe(100);
  });
});
