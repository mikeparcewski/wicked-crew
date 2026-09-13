// The state-home blocker on the wire (wicked-core#411 / crew#497; acceptance findings F-RC1-011,
// F-RC2-020, F-005/F-032/F-033) — a REAL `createServer` boot over a scratch state home whose handed
// skills snapshot derives a state home holding entries the worker Read fence cannot classify:
//
//   • the boot logs one error line per entry (→ `/diagnostics.recentErrors`, which showed nothing
//     before — the daemon "booted green" over the very condition that refused every launch);
//   • `GET /diagnostics.stateHome` reports the survey — every entry, its level, who classified;
//   • `GET /health` still answers `ok` (the daemon SERVES; studio must load and show the blocker)
//     with one `warnings[]` entry per finding;
//   • `POST /runs` answers the typed **409** `state_home_unregistered` — nothing launched, nothing
//     committed — until the entries are gone, then launches again without a restart;
//   • the engine's own intake refusal (core's `StateHomeConfigError` text) maps onto the same 409;
//   • a `WICKED_*` root pointed INSIDE the state home refuses the boot itself (`StateHomePlacementError`).
//
// Same headless recipe as diagnostics-route.test.ts: a stub adapter (the routes never reach the
// engine), every seam disabled — the skills seam too, so `WICKED_SKILLS_SNAPSHOT` is exactly what
// this test hands. On the pinned addon `Core.preflightStateHome` is absent, so crew classifies with
// its registry copy (`source: 'crew'`); an addon carrying it answers `engine` — both are accepted.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DiagnosticsResponse, HealthResponse, StateHomeBlockerBody } from 'wicked-crew-api-types';

import type { CoreAdapter } from '../src/core/adapter.js';
import type { LaunchRunInput } from '../src/core/types.js';
import { createServer } from '../src/api/server.js';
import { crewStateHome } from '../src/projects/state-home.js';
import { STATE_HOME_REMEDY, StateHomePlacementError } from '../src/projects/state-home-preflight.js';
import { SKILLS_SNAPSHOT_ENGINE_ENV } from '../src/skills/engine-env.js';
import { removeScratch } from './setup/scratch.js';

/** wicked-core `StateHomeConfigError`'s Display, as a napi rejection carries it. */
const CORE_REFUSAL =
  "configuration error: the daemon's state home /elsewhere/state (derived from WICKED_SKILLS_SNAPSHOT=/elsewhere/state/skills/snapshots/000002) " +
  'holds 1 entry the worker Read fence cannot classify — `stray.txt` — so every worker launch from this daemon would be refused; ' +
  `the run was not started. Remedy: ${STATE_HOME_REMEDY}`;

const NO_FIXTURE_PATH = /tests\/fixtures|state-home-subtrees\.json/;
const DEBRIS = 'skills.fixture-debris-20260909';

let scratch: string;
let home: string;
let app: FastifyInstance;
let savedLogLevel: string | undefined;
let savedSnapshot: string | undefined;
const launched: string[] = [];

function stubAdapter(dbPath: string): CoreAdapter {
  return {
    stub: true,
    dbPath,
    projectsSupported: () => false,
    getSettings: async () => ({}),
    onLaunch: (): (() => void) => () => undefined,
    onEvent: () => () => {},
    ping: async () => 'pong',
    sessions: async () => [],
    sessionsDetail: async () => [],
    listRepos: async () => [],
    listWorkflows: () => [],
    getWorkflow: () => null,
    launchRun: async (input: LaunchRunInput) => {
      if (input.problem === 'engine-refuses') throw new Error(CORE_REFUSAL);
      launched.push(input.sessionId);
      return input.sessionId;
    },
  } as unknown as CoreAdapter;
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'crew-state-home-routes-'));
  // The state home the handed snapshot derives: `<home>/skills/snapshots/000001` — with the live
  // daemon's debris shape, a stray file, and a scratch dir under the skills root.
  home = join(scratch, 'state-home');
  const snapshot = join(home, 'skills', 'snapshots', '000001');
  mkdirSync(snapshot, { recursive: true });
  writeFileSync(join(home, 'core.db'), 'not-a-real-sqlite-file', 'utf8');
  mkdirSync(join(home, DEBRIS));
  writeFileSync(join(home, 'stray.txt'), '', 'utf8');
  mkdirSync(join(home, 'skills', 'scratch'));

  savedSnapshot = process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
  process.env[SKILLS_SNAPSHOT_ENGINE_ENV] = snapshot;
  // error-level so the boot's info lines stay out of the test log, but the error ring still records.
  savedLogLevel = process.env['LOG_LEVEL'];
  process.env['LOG_LEVEL'] = 'error';

  app = await createServer(stubAdapter(join(home, 'core.db')), {
    auth: { mode: 'off' },
    auditPath: join(scratch, 'audit.log'),
    projectEvents: { disabled: true },
    interactiveWsRelay: { disabled: true },
    stallWatchdog: { enabled: false },
    skills: { disabled: true },
    studioRoot: join(scratch, 'no-studio'),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  if (savedSnapshot === undefined) delete process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
  else process.env[SKILLS_SNAPSHOT_ENGINE_ENV] = savedSnapshot;
  if (savedLogLevel === undefined) delete process.env['LOG_LEVEL'];
  else process.env['LOG_LEVEL'] = savedLogLevel;
  removeScratch(scratch);
});

describe('a state home the fence cannot classify — said at boot, on /diagnostics, on /health, and as POST /runs 409', () => {
  it('GET /diagnostics.stateHome names EVERY unregistered entry at once with its level, derived from the handed snapshot, refusing launches', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/diagnostics' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as DiagnosticsResponse;
    const sh = body.stateHome;
    expect(sh).not.toBeNull();
    expect(sh).toBeDefined();
    if (sh === null || sh === undefined) return;
    expect(['engine', 'crew']).toContain(sh.source);
    expect(sh.derivedFrom).toBe('snapshot');
    expect([home, realpathSync(home)]).toContain(sh.stateHome);
    expect(sh.unregistered.map((u) => [u.name, u.level])).toEqual([
      [DEBRIS, 'state-home'],
      ['stray.txt', 'state-home'],
      ['scratch', 'skills-root'],
    ]);
    expect(sh.refusesLaunches).toBe(true);
    expect(sh.error).toBeNull();
    expect(sh.remedy).toBe(STATE_HOME_REMEDY);
    expect(sh.findings).toHaveLength(3);
    for (const f of sh.findings) {
      expect(f.kind).toBe('state-home.unregistered');
      expect(f.severity).toBe('error');
      expect(f.message).not.toMatch(NO_FIXTURE_PATH);
    }
    expect(typeof sh.checkedAt).toBe('number');
  });

  it('the boot logged ONE error line per entry — the daemon no longer boots green over the blocker (F-RC2-027 shape)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/diagnostics' });
    const body = res.json() as DiagnosticsResponse;
    const lines = body.recentErrors.map((e) => e.line).filter((l) => l.startsWith('[state-home]'));
    expect(lines).toHaveLength(3);
    expect(lines.some((l) => l.includes(`\`${DEBRIS}\``))).toBe(true);
    expect(lines.some((l) => l.includes('`stray.txt`'))).toBe(true);
    expect(lines.some((l) => l.includes('`scratch` (under the skills root)'))).toBe(true);
    for (const l of lines) {
      expect(l).toContain('EVERY worker launch from this daemon is refused');
      expect(l).toContain(`Remedy: ${STATE_HOME_REMEDY}`);
      expect(l).not.toMatch(NO_FIXTURE_PATH);
    }
  });

  it('GET /health stays `ok` (the daemon serves) and carries one warning per finding', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as HealthResponse;
    expect(body.status).toBe('ok');
    expect(body.warnings).toBeDefined();
    expect(body.warnings).toHaveLength(3);
    for (const w of body.warnings ?? []) {
      expect(w.kind).toBe('state-home.unregistered');
      expect(w.severity).toBe('error');
      expect(w.message).toContain('is not in the state-home registry');
      expect(w.message).not.toMatch(NO_FIXTURE_PATH);
    }
  });

  it('POST /runs answers the typed 409 — code, every entry, the remedy — and launches NOTHING', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'fix the thing' } });
    expect(res.statusCode).toBe(409);
    const body = res.json() as StateHomeBlockerBody;
    expect(body.code).toBe('state_home_unregistered');
    expect(body.unregistered.map((u) => u.name)).toEqual([DEBRIS, 'stray.txt', 'scratch']);
    expect(body.remedy).toBe(STATE_HOME_REMEDY);
    expect(body.error).toContain('configuration error');
    expect(body.error).toContain('holds 3 entries');
    expect(body.error).toContain('the run was not started');
    expect(body.error).not.toMatch(NO_FIXTURE_PATH);
    expect(body.error).not.toMatch(/triage|judge/);
    expect(launched).toEqual([]);
  });

  it('remove the entries and — without a restart — the warning clears, diagnostics reads clean, and POST /runs launches', async () => {
    rmSync(join(home, DEBRIS), { recursive: true });
    rmSync(join(home, 'stray.txt'));
    rmSync(join(home, 'skills', 'scratch'), { recursive: true });

    const health = (await app.inject({ method: 'GET', url: '/api/v1/health' })).json() as HealthResponse;
    expect(health.status).toBe('ok');
    expect(health.warnings).toBeUndefined();

    const diag = (await app.inject({ method: 'GET', url: '/api/v1/diagnostics' })).json() as DiagnosticsResponse;
    expect(diag.stateHome?.refusesLaunches).toBe(false);
    expect(diag.stateHome?.unregistered).toEqual([]);
    expect(diag.stateHome?.findings).toEqual([]);

    const res = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'fix the thing', sessionId: 'run-after-repair' } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ runId: 'run-after-repair' });
    expect(launched).toEqual(['run-after-repair']);
  });

  it("the engine's own intake refusal (core's StateHomeConfigError) is the same typed 409, not a 400", async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'engine-refuses' } });
    expect(res.statusCode).toBe(409);
    const body = res.json() as StateHomeBlockerBody;
    expect(body.code).toBe('state_home_unregistered');
    // The pre-check saw a clean state home (the entries are gone), the engine did not: the engine's
    // own text rides as `error`, the remedy as a field, nothing invented into `unregistered`.
    expect(body.error).toBe(CORE_REFUSAL);
    expect(body.unregistered).toEqual([]);
    expect(body.remedy).toBe(STATE_HOME_REMEDY);
    expect(launched).toEqual(['run-after-repair']);
  });
});

describe("a WICKED_* root pointed inside the state home refuses the BOOT (the rig's F-RC1-011 shape)", () => {
  it('createServer rejects with StateHomePlacementError naming the variable and the entry it would create', async () => {
    const prior = process.env['WICKED_WORKFLOWS_DIR'];
    const inside = join(crewStateHome(), 'workflows');
    process.env['WICKED_WORKFLOWS_DIR'] = inside;
    const dir = mkdtempSync(join(tmpdir(), 'crew-state-home-boot-refusal-'));
    try {
      let thrown: unknown;
      try {
        const refused = await createServer(stubAdapter(join(dir, 'core.db')), {
          auth: { mode: 'off' },
          auditPath: join(dir, 'audit.log'),
          projectEvents: { disabled: true },
          interactiveWsRelay: { disabled: true },
          stallWatchdog: { enabled: false },
          skills: { disabled: true },
          studioRoot: join(dir, 'no-studio'),
        });
        await refused.close();
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(StateHomePlacementError);
      const e = thrown as StateHomePlacementError;
      expect(e.variable).toBe('WICKED_WORKFLOWS_DIR');
      expect(e.value).toBe(inside);
      expect(e.entry).toBe('workflows');
      expect(e.message).toContain('Refusing to start');
      expect(e.message).toContain('point WICKED_WORKFLOWS_DIR at a directory OUTSIDE');
      expect(e.message).not.toMatch(NO_FIXTURE_PATH);
    } finally {
      if (prior === undefined) delete process.env['WICKED_WORKFLOWS_DIR'];
      else process.env['WICKED_WORKFLOWS_DIR'] = prior;
      removeScratch(dir);
    }
  });
});
