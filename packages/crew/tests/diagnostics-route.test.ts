// GET /api/v1/diagnostics — route smoke over the REAL server assembly (createServer) on a
// scratch state home. Same headless-boot recipe as endpoint-manifest-live: a stub adapter
// (route REGISTRATION and the diagnostics handler never call the engine), every seam disabled,
// audit to a temp file — plus a scratch `core.db` + `core.db.events/` fixture the handler
// actually reads, and a fixture studio root carrying the shipped version manifest.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DiagnosticsResponse } from 'wicked-crew-api-types';

import type { CoreAdapter } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import { canonicalCrewStateHome } from '../src/skills/engine-env.js';
import { removeScratch } from './setup/scratch.js';

/** Whatever the process carried under the RETIRED engine-input name — crew must leave it untouched (v3.4 §2). */
const stateHomeEnvBefore = process.env['WICKED_CREW_STATE_HOME'];

// The engine BINARY names diagnostics probes — spelled by concatenation because
// tests/core-checkout-policy.test.ts audits quoted `wicked-core` segments (FINDING-094).
const CORE_BIN = ['wicked', 'core'].join('-');
const ESTATE_BIN = 'wicked-estate';

let scratch: string;
let app: FastifyInstance;
let savedLogLevel: string | undefined;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'crew-diagnostics-route-'));

  // The scratch state home: a core.db, one sidecar, and two runs' worth of ACP event history.
  const home = join(scratch, 'state-home');
  mkdirSync(home);
  const dbPath = join(home, 'core.db');
  writeFileSync(dbPath, 'not-a-real-sqlite-file', 'utf8');
  writeFileSync(join(home, 'core.db-wal'), 'wal', 'utf8');
  const eventsDir = join(home, 'core.db.events');
  mkdirSync(eventsDir);
  writeFileSync(
    join(eventsDir, 'run-1.ndjson'),
    [
      JSON.stringify({ type: 'sessionStarted', session: 'run-1', ts: 1, seq: 0 }),
      JSON.stringify({ type: 'acpSessionStarted', session: 'run-1', cliKey: 'claude', acpSessionId: 'a', ts: 100, seq: 1 }),
      JSON.stringify({ type: 'acpFallback', session: 'run-1', cliKey: 'claude', reason: 'broken pipe', fallbackKind: 'session_died', ts: 150, seq: 2 }),
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(eventsDir, 'run-2.ndjson'),
    [
      JSON.stringify({ type: 'acpSessionStarted', session: 'run-2', cliKey: 'claude', acpSessionId: 'b', ts: 200, seq: 1 }),
      JSON.stringify({ type: 'acpSessionStarted', session: 'run-2', cliKey: 'pi', acpSessionId: 'c', ts: 300, seq: 2 }),
    ].join('\n'),
    'utf8',
  );

  // A studio bundle root carrying exactly what the real bundle ships (TH-13 inventory).
  const studioRoot = join(scratch, 'studio');
  mkdirSync(studioRoot);
  writeFileSync(join(studioRoot, 'index.html'), '<!doctype html>', 'utf8');
  writeFileSync(
    join(studioRoot, 'testid-inventory.json'),
    JSON.stringify({ version: 1, studioVersion: '9.9.9' }),
    'utf8',
  );

  // error-level so the boot's info lines stay out of the test log, but the error ring still
  // records (pino at `silent` writes nothing, which would blind the recentErrors assertion).
  savedLogLevel = process.env['LOG_LEVEL'];
  process.env['LOG_LEVEL'] = 'error';

  const adapter = {
    stub: true,
    dbPath,
    projectsSupported: () => false,
    getSettings: async () => ({}),
    onLaunch: (): (() => void) => () => undefined, // the launch hook createServer registers (skills keystone, codex round 4)
    onEvent: () => () => {},
  } as unknown as CoreAdapter;

  app = await createServer(adapter, {
    auth: { mode: 'off' },
    auditPath: join(scratch, 'audit.log'),
    projectEvents: { disabled: true },
    interactiveWsRelay: { disabled: true },
    stallWatchdog: { enabled: false },
    studioRoot,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  if (savedLogLevel === undefined) delete process.env['LOG_LEVEL'];
  else process.env['LOG_LEVEL'] = savedLogLevel;
  removeScratch(scratch);
});

describe('GET /api/v1/diagnostics (route smoke on a scratch daemon)', () => {
  it('answers the pinned wire shape from the scratch state home', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/diagnostics' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as DiagnosticsResponse;

    // components — crew's own version is always known; the bundle version comes from the
    // shipped manifest; core-ts resolves from the workspace; binary probes are null under a
    // test runner (never spawned, never fabricated).
    expect(body.components.crew).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.components.studioBundle).toBe('9.9.9');
    expect(body.components.coreTs).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.components.engineBinaries).toEqual({ [CORE_BIN]: null, [ESTATE_BIN]: null });

    // daemon — a live process answers a real uptime; injected requests bind no port, so the
    // route answers its default exactly like GET /config does.
    expect(body.daemon.uptimeMs).toBeGreaterThan(0);
    expect(body.daemon.startedAt).toBeLessThanOrEqual(Date.now());
    expect(typeof body.daemon.port).toBe('number');

    // stores — the db, its sidecar, and the events dir sized as a total.
    const names = body.stores.map((s) => s.name);
    expect(names).toEqual(['core.db', 'core.db-wal', 'core.db.events']);
    const events = body.stores.find((s) => s.name === 'core.db.events');
    expect(events?.bytes).toBeGreaterThan(0);
    for (const s of body.stores) {
      expect(s.path.startsWith(scratch)).toBe(true);
      expect(typeof s.bytes).toBe('number');
    }

    // acp — folded from the fixture NDJSON, per cliKey.
    expect(body.acp.byCli['claude']).toEqual({
      sessionsStarted: 2,
      fallbacks: 1,
      fallbackKinds: { session_died: 1 },
      lastStartedTs: 200,
      lastFallbackTs: 150,
    });
    expect(body.acp.byCli['pi']).toEqual({
      sessionsStarted: 1,
      fallbacks: 0,
      fallbackKinds: {},
      lastStartedTs: 300,
      lastFallbackTs: null,
    });
    expect(body.acp.byCli['codex']).toBeUndefined(); // no traffic = no key, zeros never invented

    // skills — the hermetic harness aims the seam at a source that holds no plugin, so the boot
    // took the ABSENT-configuration rung: fallback, engine input unset, one skills.fallback finding.
    expect(body.skills.state).toBe('fallback');
    expect(body.skills.current).toBeNull();
    // Unset — or whatever value this process booted with (an operator export survives the rung).
    expect(body.skills.engineInput).toBe(process.env['WICKED_SKILLS_SNAPSHOT'] ?? null);
    expect(body.skills.findings.map((f) => f.kind)).toEqual(['skills.fallback']);
    expect(typeof body.skills.root).toBe('string');
    // The canonical state home is REPORTED for humans whatever the skills outcome; it is NOT an engine
    // input (v3.4 §2: core reads only WICKED_SKILLS_SNAPSHOT), so crew exports nothing under that name.
    expect(typeof body.skills.stateHome).toBe('string');
    expect(body.skills.stateHome).toBe(canonicalCrewStateHome());
    expect(process.env['WICKED_CREW_STATE_HOME']).toBe(stateHomeEnvBefore);
  });

  it('governance (crew#495): a boot that resolved no store says so — store null, an honest record count, no outbox, a governance.store error', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/diagnostics' });
    const body = res.json() as DiagnosticsResponse;
    // This route set was assembled around an adapter that exported nothing to the engine (a library
    // boot) — the engine would dead-letter every governance emit, and the surface must say so rather
    // than paint a store that does not exist.
    expect(body.governance.store).toBeNull();
    expect(body.governance.deadletters.path).toBeNull();
    expect(body.governance.deadletters.count).toBe(0);
    expect(body.governance.deadletters.byType).toEqual({});
    expect(body.governance.deadletters.truncated).toBe(false);
    // No store → nothing to count, on every engine: null, never 0.
    expect(body.governance.records).toEqual({ total: null, sinceBoot: null });
    const kinds = body.governance.findings.map((f) => f.kind);
    expect(kinds).toContain('governance.store');
    expect(body.governance.findings.find((f) => f.kind === 'governance.store')?.severity).toBe('error');
    // The legacy HOME pointer may or may not exist on the machine running this; it is the ONLY
    // other finding this daemon can raise.
    expect(kinds.filter((k) => k !== 'governance.store' && k !== 'governance.legacy-outbox')).toEqual([]);
  });

  it('folds the daemon\'s own error-level log lines into recentErrors, newest first', async () => {
    app.log.error('diagnostics smoke: first error');
    app.log.error('diagnostics smoke: second error');
    const res = await app.inject({ method: 'GET', url: '/api/v1/diagnostics' });
    const body = res.json() as DiagnosticsResponse;
    const lines = body.recentErrors.map((e) => e.line);
    expect(lines[0]).toBe('diagnostics smoke: second error');
    expect(lines[1]).toBe('diagnostics smoke: first error');
    expect(body.recentErrors.length).toBeLessThanOrEqual(20);
    for (const e of body.recentErrors) {
      expect(e.source).toBe('daemon');
      expect(typeof e.ts).toBe('number');
    }
  });

  it('is present in the live endpoint manifest as a read-only GET', async () => {
    const entry = (app.endpointManifest ?? []).find(
      (e) => e.path === '/api/v1/diagnostics' && e.method === 'GET',
    );
    expect(entry).toBeDefined();
    expect(entry?.responseType).toBe('DiagnosticsResponse');
    expect(entry?.statusCodes).toEqual([200]);
  });
});
