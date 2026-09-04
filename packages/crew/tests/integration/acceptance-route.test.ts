// `GET /runs/:id/acceptance` — the acceptance gate's read surface (Phase 6a).
//
// Pins the route contract over a REAL ledger (the committed 6b fixture): a governed run whose
// repo carries a PASS ledger reads satisfied; the same requirement over a repo with NO ledger — or
// a run with no repo at all — reads denied with a reason naming the remedy; an ungoverned run is
// vacuously satisfied and labeled as such. Engine reads (`sessionsDetail`, `listRepos`) are
// stubbed exactly as gate-route.test.ts stubs them, because the branch matrix here is over run
// shape × ledger state, not over engine behavior — the functional test drives the same route
// through a real stub-engine run.
//
// The last block proves the OPT-IN bus seam end to end: a server created with qeGateEvents enabled
// against a temp bus db sees a `wicked.qe.gate.passed` emitted through the real wicked-bus API
// surface on the route's `busEvent` — while the gate decision itself keeps coming from the ledger.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import type { RepoEntry, SessionView } from '../../src/core/types.js';
import { removeScratch } from '../setup/scratch.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/qe-ledger-pass', import.meta.url));
const QE_RUN_ID = '7ec47687-fb15-4592-bf69-5121359f8bab';

const GOVERNED = 'governed-run';
const UNGOVERNED = 'ungoverned-run';
const REPOLESS = 'repoless-run';
const BARE_REPO_RUN = 'bare-repo-run';

let app: Awaited<ReturnType<typeof createServer>>;
let adapter: CoreAdapter;
let dir: string;
let baseUrl: string;

function view(id: string, workflowId: string, repoRef: string | null): SessionView {
  return {
    session: { id, status: 'completed', workflow_id: workflowId, repo_ref: repoRef },
    units: [],
  } as unknown as SessionView;
}

function repoEntry(id: string, rootPath: string): RepoEntry {
  return { id, name: id, root_path: rootPath, default_branch: 'main', registered_at: 0 };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'acceptance-route-'));
  // Two workspaces: one carrying a copy of the fixture ledger, one bare.
  const withLedger = join(dir, 'with-ledger');
  mkdirSync(withLedger);
  // Deliberately the LEGACY dirname: the route must dual-read a pre-6c ledger.
  cpSync(join(FIXTURE, '.wicked-testing'), join(withLedger, '.wicked-testing'), { recursive: true });
  const bare = join(dir, 'bare');
  mkdirSync(bare);

  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  adapter.sessionsDetail = async () => [
    // `feature` declares the requirement on its `test` phase; `survey-repo` declares none.
    view(GOVERNED, 'feature', 'repo-ledger'),
    view(UNGOVERNED, 'survey-repo', 'repo-ledger'),
    view(REPOLESS, 'feature', null),
    view(BARE_REPO_RUN, 'feature', 'repo-bare'),
  ];
  adapter.listRepos = async () => [
    repoEntry('repo-ledger', withLedger),
    repoEntry('repo-bare', bare),
  ];

  app = await createServer(adapter);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await app.close();
  adapter.close();
  removeScratch(dir);
});

async function getAcceptance(id: string, query = '') {
  const res = await fetch(`${baseUrl}/api/v1/runs/${id}/acceptance${query}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Narrow one nested object field for an assertion (the body is untyped JSON on purpose). */
function field<T>(body: Record<string, unknown>, key: string): T {
  return body[key] as T;
}

describe('GET /runs/:id/acceptance', () => {
  it('404s an unknown run', async () => {
    const res = await getAcceptance('no-such-run');
    expect(res.status).toBe(404);
    expect(res.body['error']).toBe('Run not found');
  });

  it('serves the ledger verdict + manifest summary and satisfies the gate on PASS', async () => {
    const res = await getAcceptance(GOVERNED);
    expect(res.status).toBe(200);
    expect(res.body['requirement']).toEqual({ declared: true, phases: ['test'] });
    expect(res.body['repo']).toMatchObject({ id: 'repo-ledger' });
    expect(res.body['acceptance']).toMatchObject({
      ledgerDir: '.wicked-testing',
      found: true,
      verdict: { verdict: 'PASS', reviewer: 'wicked-garden-qe-acceptance-test-reviewer' },
      qeRun: { id: QE_RUN_ID, status: 'passed' },
      manifest: { manifestVersion: '1.1.0', artifactCount: 9, scenarioName: 'csv-stats-basic' },
    });
    expect(res.body['gate']).toMatchObject({
      required: true,
      satisfied: true,
      verdict: 'PASS',
      runStatus: 'passed',
    });
  });

  it('denies a governed run whose repo has no ledger — missing evidence, with the probed path', async () => {
    const res = await getAcceptance(BARE_REPO_RUN);
    expect(res.status).toBe(200);
    expect(res.body['acceptance']).toMatchObject({ found: false, verdict: null });
    expect(res.body['gate']).toMatchObject({ required: true, satisfied: false, verdict: null });
    expect(field<{ reason: string }>(res.body, 'gate').reason).toMatch(/no QE ledger at .*bare/);
  });

  it('denies a governed run that has no repo context', async () => {
    const res = await getAcceptance(REPOLESS);
    expect(res.status).toBe(200);
    expect(res.body['repo']).toBeNull();
    expect(res.body['acceptance']).toBeNull();
    expect(res.body['gate']).toMatchObject({ required: true, satisfied: false });
    expect(field<{ reason: string }>(res.body, 'gate').reason).toMatch(/no repo context/);
  });

  it('is vacuously satisfied for an ungoverned run — labeled, with the evidence still shown', async () => {
    const res = await getAcceptance(UNGOVERNED);
    expect(res.status).toBe(200);
    expect(res.body['requirement']).toEqual({ declared: false, phases: [] });
    expect(res.body['gate']).toMatchObject({ required: false, satisfied: true });
    expect(field<{ reason: string }>(res.body, 'gate').reason).toMatch(/no acceptance requirement/);
    // The read is still honest about what the ledger holds — display, not gate input.
    expect(field<{ verdict: unknown }>(res.body, 'acceptance').verdict).toMatchObject({ verdict: 'PASS' });
  });

  it('pins the read to one QE run via ?qeRun', async () => {
    const res = await getAcceptance(GOVERNED, `?qeRun=${QE_RUN_ID}`);
    expect(res.status).toBe(200);
    expect(field<{ verdict: { qeRunId: string } }>(res.body, 'acceptance').verdict.qeRunId).toBe(QE_RUN_ID);
  });
});

describe('opt-in bus seam (qeGateEvents)', () => {
  it('folds a real wicked-bus gate event into the route response; ledger still decides the gate', async () => {
    const busDir = mkdtempSync(join(tmpdir(), 'acceptance-bus-'));
    const busDbPath = join(busDir, 'bus.db');
    const bus = await import('wicked-bus');
    // Create the db BEFORE the server subscribes, then start a server with the seam armed.
    const db = bus.openDb({ db_path: busDbPath });
    const app2 = await createServer(adapter, {
      qeGateEvents: { enabled: true, dbPath: busDbPath, pollIntervalMs: 50 },
    });
    await app2.listen({ port: 0, host: '127.0.0.1' });
    const addr = app2.server.address();
    const base2 = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    try {
      // The wire contract, verbatim (old gate.mjs → garden's qe skills): 8 canonical
      // payload fields under wicked.qe.gate.passed, DEC-00010 idempotency key shape.
      bus.emit(db, bus.loadConfig(), {
        event_type: 'wicked.qe.gate.passed',
        domain: 'qe',
        subdomain: 'gate',
        payload: {
          run_id: QE_RUN_ID,
          context: 'da838fff-9bd7-45df-a452-853516bdd7ae',
          gate_verdict: 'PASS',
          exit_code: 0,
          verdict_summary: '15/15 assertions passed',
          mode: 'gate',
          completed_at: '2026-08-12T03:00:00Z',
          scenario_count: 1,
        },
        idempotency_key: 'qe:gate.result:da838fff-9bd7-45df-a452-853516bdd7ae:deadbeefdeadbeef:0',
      });

      // The durable subscriber polls; wait for the event to surface on the route.
      let busEvent: Record<string, unknown> | null = null;
      for (let i = 0; i < 100 && busEvent === null; i++) {
        const res = await fetch(`${base2}/api/v1/runs/${GOVERNED}/acceptance`);
        const body = (await res.json()) as { busEvent: Record<string, unknown> | null };
        busEvent = body.busEvent;
        if (busEvent === null) await new Promise((r) => setTimeout(r, 50));
      }
      expect(busEvent, 'the armed seam must surface the gate event').not.toBeNull();
      expect(busEvent).toMatchObject({
        eventType: 'wicked.qe.gate.passed',
        runId: QE_RUN_ID,
        gateVerdict: 'PASS',
        scenarioCount: 1,
      });

      // And the ledger remains the system of record: same gate answer as the bus-less server.
      const res = await fetch(`${base2}/api/v1/runs/${GOVERNED}/acceptance`);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['gate']).toMatchObject({ satisfied: true, verdict: 'PASS' });
    } finally {
      await app2.close(); // stops the subscriber via the onClose hook
      removeScratch(busDir);
    }
  });

  it('a server WITHOUT the seam serves the same gate answers with busEvent null', async () => {
    const res = await getAcceptance(GOVERNED);
    expect(res.body['busEvent']).toBeNull();
    expect(res.body['gate']).toMatchObject({ satisfied: true });
  });
});
