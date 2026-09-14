// wicked-core#461's typed `NoEligibleSeat` intake refusal on the wire (crew#556; hardening S5).
//
// The engine refuses a launch SYNCHRONOUSLY when the plan needs a seat and every seat of a non-empty
// roster was benched by the launcher (`health.usable: false` — crew's `council_eligible: false`):
// nothing persisted, nothing on the wire, a Display of the shape
// `no eligible seat for <run>: N of N seats benched: <seat> (<cause> — launcher), … — sign a seat in,
// or add one, before launching`. Through the napi seam that is a plain rejection whose message IS
// that text, and `POST /runs` used to answer it **400** — the generic arm (`busy ? 409 : 400`) —
// as if the caller had sent a malformed body. Now:
//
//   • the recogniser reads exactly the engine's shape — run id and the bench summary — and nothing
//     else (a message of any other shape is not this refusal);
//   • `POST /runs` answers **409** `{ code: 'no_eligible_seat', error, runId, benched, remedy }` —
//     the roster's standing conflicts with the request, which succeeds unchanged once a seat is
//     signed in (the `state_home_unregistered` rule); not a 5xx: the engine is healthy and said no;
//   • the engine-busy refusal keeps its bare 409 and an unrecognised message keeps its 400.
//
// Same headless recipe as state-home-routes.test.ts: a real `createServer` over a scratch state home,
// a stub adapter whose `launchRun` throws the engine's text for one sentinel problem, every seam
// disabled — the skills seam too, and no handed snapshot, so the state-home pre-check never fires.
//
// FIX-IT-ALL L8-0b / DES-L3 PR-3A: this INTAKE refusal stays a synchronous 409 with a byte-identical
// Display (L3 F10 — the recogniser below keeps matching). The OTHER all-benched path — every seat
// benched by the council's ballots at DISTRIBUTION, today `sessionFailed` in ~2 s — becomes the
// `dead_seat` escalation gate in core-ts 0.7.27; its NOT_FIXED_YET expectation is
// `tests/integration/dead-seat-distribution-gate.test.ts` (real engine, two dead wrapped seats).

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { NoEligibleSeatBody } from 'wicked-crew-api-types';

import type { CoreAdapter } from '../src/core/adapter.js';
import type { LaunchRunInput } from '../src/core/types.js';
import { createServer } from '../src/api/server.js';
import {
  NO_ELIGIBLE_SEAT_CODE,
  NO_ELIGIBLE_SEAT_REMEDY,
  noEligibleSeatBody,
  parseNoEligibleSeat,
} from '../src/core/engine-roster.js';
import { SKILLS_SNAPSHOT_ENGINE_ENV } from '../src/skills/engine-env.js';
import { removeScratch } from './setup/scratch.js';

/** wicked-core `NoEligibleSeat`'s Display, as a napi rejection carries it (two launcher-benched seats). */
const BENCHED = '2 of 2 seats benched: codex (signed out — launcher), copilot (quota exhausted — launcher)';
const CORE_REFUSAL = `no eligible seat for run-dead-roster: ${BENCHED} — sign a seat in, or add one, before launching`;
const CORE_BUSY = 'a run with this id is already in flight';
const CORE_OTHER = 'workflow `nope` is not a registered workflow';

let scratch: string;
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
      if (input.problem === 'dead-roster') throw new Error(CORE_REFUSAL);
      if (input.problem === 'engine-busy') throw new Error(CORE_BUSY);
      if (input.problem === 'engine-other') throw new Error(CORE_OTHER);
      launched.push(input.sessionId);
      return input.sessionId;
    },
  } as unknown as CoreAdapter;
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'crew-no-eligible-seat-route-'));
  const home = join(scratch, 'state-home');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'core.db'), 'not-a-real-sqlite-file', 'utf8');

  // No handed snapshot: the state-home pre-check surveys for information only and never 409s.
  savedSnapshot = process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
  delete process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
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

describe('parseNoEligibleSeat — the recogniser reads exactly the engine Display', () => {
  it('extracts the run id and the bench summary, seat by seat with its cause', () => {
    expect(parseNoEligibleSeat(CORE_REFUSAL)).toEqual({ runId: 'run-dead-roster', benched: BENCHED });
    // A single-seat roster and surrounding whitespace parse the same way.
    expect(
      parseNoEligibleSeat(
        '  no eligible seat for 7f1c: 1 of 1 seats benched: claude (not installed — launcher) — sign a seat in, or add one, before launching\n',
      ),
    ).toEqual({ runId: '7f1c', benched: '1 of 1 seats benched: claude (not installed — launcher)' });
  });

  it('recognises nothing else — busy, state-home, workflow and prose-only messages are not this refusal', () => {
    for (const msg of [
      CORE_BUSY,
      CORE_OTHER,
      "configuration error: the daemon's state home /x holds 1 entry the worker Read fence cannot classify",
      'no eligible seat', // the words without the shape
      `no eligible seat for run-1: ${BENCHED}`, // the closing clause missing
      '',
    ]) {
      expect(parseNoEligibleSeat(msg), msg).toBeNull();
    }
  });

  it('builds the typed body: the engine text verbatim, the code, run id, bench and remedy', () => {
    const body = noEligibleSeatBody(CORE_REFUSAL, { runId: 'run-dead-roster', benched: BENCHED });
    expect(body).toEqual({
      error: CORE_REFUSAL,
      code: NO_ELIGIBLE_SEAT_CODE,
      runId: 'run-dead-roster',
      benched: BENCHED,
      remedy: NO_ELIGIBLE_SEAT_REMEDY,
    });
    expect(NO_ELIGIBLE_SEAT_CODE).toBe('no_eligible_seat');
  });
});

describe("POST /runs on the engine's NoEligibleSeat intake refusal (wicked-core#461 / crew#556)", () => {
  it('answers the typed 409 — code, the engine text, run id, every benched seat with its cause, the remedy — and launches NOTHING', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: { problem: 'dead-roster', sessionId: 'run-dead-roster' },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as NoEligibleSeatBody;
    expect(body.code).toBe('no_eligible_seat');
    expect(body.error).toBe(CORE_REFUSAL);
    expect(body.runId).toBe('run-dead-roster');
    // The bench names the class of every seat — signed out, quota — not just a count.
    expect(body.benched).toBe(BENCHED);
    expect(body.benched).toContain('codex (signed out — launcher)');
    expect(body.benched).toContain('copilot (quota exhausted — launcher)');
    expect(body.remedy).toBe(NO_ELIGIBLE_SEAT_REMEDY);
    expect(launched).toEqual([]);
  });

  it('keeps the engine-busy refusal a bare 409 and an unrecognised engine message a 400', async () => {
    const busy = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'engine-busy' } });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toEqual({ error: CORE_BUSY });

    const other = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'engine-other' } });
    expect(other.statusCode).toBe(400);
    expect(other.json()).toEqual({ error: CORE_OTHER });
    expect(launched).toEqual([]);
  });

  it('a roster with an eligible seat still launches — the mapping is on the refusal, not the route', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: { problem: 'fix the thing', sessionId: 'run-live-roster' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ runId: 'run-live-roster' });
    expect(launched).toEqual(['run-live-roster']);
  });
});
