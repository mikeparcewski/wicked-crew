// `GET /runs/:id/acceptance` — the acceptance gate's read surface (Phase 6a).
//
// Pins the route contract over a REAL ledger (the committed 6b fixture): a governed run whose
// lifetime contains the repo's PASS reads satisfied; the same requirement over a repo with NO
// ledger — or a run with no repo at all — reads denied with a reason naming the remedy; an
// ungoverned run is vacuously satisfied and labeled as such; and (F-E2E-013) a FRESH run over the
// same ledger is NOT handed the repo's older PASS — a verdict is this run's only when its QE run
// is stamped with the run id or started inside the run's recorded lifetime. Engine reads
// (`sessionsDetail`, `listRepos`, `runEvents`) are stubbed exactly as gate-route.test.ts stubs
// them, because the branch matrix here is over run shape × ledger state × run lifetime, not over
// engine behavior — the functional test drives the same route through a real stub-engine run.
//
// The last block proves the OPT-IN bus seam end to end: a server created with qeGateEvents enabled
// against a temp bus db sees a `wicked.qe.gate.passed` emitted through the real wicked-bus API
// surface on the route's `busEvent` — while the gate decision itself keeps coming from the ledger.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import type { RecordedEvent, RepoEntry, SessionView } from '../../src/core/types.js';
import { removeScratch } from '../setup/scratch.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/qe-ledger-pass', import.meta.url));
const QE_RUN_ID = '7ec47687-fb15-4592-bf69-5121359f8bab';
/** The fixture's QE run started 2026-08-12T02:17:34.799Z and its verdict landed at 02:31:41Z. */
const BEFORE_FIXTURE = Date.parse('2026-08-12T02:00:00.000Z');
const AFTER_FIXTURE = Date.parse('2026-08-12T03:00:00.000Z');

const GOVERNED = 'governed-run';
const UNGOVERNED = 'ungoverned-run';
const REPOLESS = 'repoless-run';
const BARE_REPO_RUN = 'bare-repo-run';
/** A governed run over the SAME ledger that started today — the fixture is not its evidence. */
const FRESH = 'fresh-run';
/** A run whose event log records nothing — no lifetime, so no linkage. */
const NO_HISTORY = 'no-history-run';
/** Cancelled (the engine's `runCancelled` frame) BEFORE the fixture's QE run started (review F1). */
const CANCELLED = 'cancelled-run';
/** Failed before the QE run, then a straggling non-terminal frame — must not reopen the window (F4). */
const POST_TERMINAL = 'post-terminal-run';
/** A run whose event log cannot be read at all (F5). */
const UNREADABLE_LOG = 'unreadable-log-run';
/** A run that contains TWO QE runs: run B FAILED at 02:25, run A (the fixture) PASSED later at 02:31 (F2). */
const CROSS_RUN = 'cross-run';
const BEFORE_QE_RUN = Date.parse('2026-08-12T01:00:00.000Z');
const CANCEL_AT = Date.parse('2026-08-12T01:05:00.000Z');
/** Failed 01:05, RESUMED 02:30 (after the fixture's QE run started 02:17 — in the rescuable gap), completed 03:00 (r2 N1). */
const RESUMED_GAP = 'resumed-gap-run';
/** Failed 01:05, RESUMED 02:00 (the QE run 02:17 falls inside the resumed segment), completed 03:00 (r2 N1). */
const RESUMED_SEGMENT = 'resumed-segment-run';
/** Failed 01:05, resumed 01:30, completed 02:00 — BEFORE the QE run started: closed for good (r2 N1). */
const RESUMED_DONE_EARLY = 'resumed-done-early-run';
/** The engine's REAL rescue shape, still LIVE: failed 01:05, then dispatch_unit's frames at 02:00 — no `resumed`, no terminal yet (r3 N3). */
const RESCUED_LIVE = 'rescued-live-run';
/** The engine's REAL rescue shape, completed: failed 01:05, unitExecuting 02:01, sessionCompleted 03:00 — no `resumed` (r3 N3). */
const RESCUED_DONE = 'rescued-done-run';

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

function ev(type: string, session: string, ts: number, seq: number): RecordedEvent {
  return { type, session, ts, seq } as unknown as RecordedEvent;
}

/** Each run's durable log — its lifetime is what the ledger read links against. */
function historyOf(runId: string): RecordedEvent[] {
  switch (runId) {
    case FRESH:
      // Started now, still live: everything the fixture holds predates it.
      return [ev('sessionStarted', runId, Date.now(), 1)];
    case NO_HISTORY:
      return [];
    case CANCELLED:
      // The engine's cancel frame is `runCancelled` (wicked-core event.rs) — not `sessionCancelled`.
      return [ev('sessionStarted', runId, BEFORE_QE_RUN, 1), ev('runCancelled', runId, CANCEL_AT, 2)];
    case POST_TERMINAL:
      return [
        ev('sessionStarted', runId, BEFORE_QE_RUN, 1),
        ev('sessionFailed', runId, CANCEL_AT, 2),
        ev('heartbeat', runId, CANCEL_AT + 60_000, 3),
      ];
    case UNREADABLE_LOG:
      throw new Error('event-log read binding missing (older addon)');
    case RESUMED_GAP:
      return [
        ev('sessionStarted', runId, BEFORE_QE_RUN, 1),
        ev('sessionFailed', runId, CANCEL_AT, 2),
        ev('resumed', runId, Date.parse('2026-08-12T02:30:00.000Z'), 3),
        ev('sessionCompleted', runId, AFTER_FIXTURE, 4),
      ];
    case RESUMED_SEGMENT:
      return [
        ev('sessionStarted', runId, BEFORE_QE_RUN, 1),
        ev('sessionFailed', runId, CANCEL_AT, 2),
        ev('resumed', runId, BEFORE_FIXTURE, 3),
        ev('unitExecuting', runId, BEFORE_FIXTURE + 1000, 4),
        ev('sessionCompleted', runId, AFTER_FIXTURE, 5),
      ];
    case RESUMED_DONE_EARLY:
      return [
        ev('sessionStarted', runId, BEFORE_QE_RUN, 1),
        ev('sessionFailed', runId, CANCEL_AT, 2),
        ev('resumed', runId, Date.parse('2026-08-12T01:30:00.000Z'), 3),
        ev('sessionCompleted', runId, BEFORE_FIXTURE, 4),
      ];
    case RESCUED_LIVE:
      return [
        ev('sessionStarted', runId, BEFORE_QE_RUN, 1),
        ev('sessionFailed', runId, CANCEL_AT, 2),
        ev('unitDispatched', runId, BEFORE_FIXTURE, 3),
        ev('unitExecuting', runId, BEFORE_FIXTURE + 1000, 4),
      ];
    case RESCUED_DONE:
      return [
        ev('sessionStarted', runId, BEFORE_QE_RUN, 1),
        ev('sessionFailed', runId, CANCEL_AT, 2),
        ev('unitExecuting', runId, BEFORE_FIXTURE + 60_000, 3),
        ev('sessionCompleted', runId, AFTER_FIXTURE, 4),
      ];
    default:
      // Started before the fixture's QE run, completed after its verdict: contains it.
      return [ev('sessionStarted', runId, BEFORE_FIXTURE, 1), ev('sessionCompleted', runId, AFTER_FIXTURE, 2)];
  }
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
  // A third workspace: the fixture PLUS a second QE run (B) that started 02:20 and FAILED at 02:25 —
  // canonical JSON written as the ledger writes it (the reader reads files, not a store).
  const crossRun = join(dir, 'cross-run');
  mkdirSync(crossRun);
  cpSync(join(FIXTURE, '.wicked-testing'), join(crossRun, '.wicked-testing'), { recursive: true });
  writeFileSync(
    join(crossRun, '.wicked-testing', 'runs', 'qe-run-b.json'),
    JSON.stringify({
      id: 'qe-run-b',
      project_id: 'da838fff-9bd7-45df-a452-853516bdd7ae',
      scenario_id: 'other-scenario',
      started_at: '2026-08-12T02:20:00.000Z',
      finished_at: '2026-08-12T02:25:00.000Z',
      status: 'failed',
      created_at: '2026-08-12T02:20:00.000Z',
      updated_at: '2026-08-12T02:25:00.000Z',
      deleted: 0,
      deleted_at: null,
    }),
  );
  writeFileSync(
    join(crossRun, '.wicked-testing', 'verdicts', 'fail-run-b.json'),
    JSON.stringify({
      id: 'fail-run-b',
      run_id: 'qe-run-b',
      verdict: 'FAIL',
      reviewer: 'route-test',
      reason: 'scenario X: step 3 asserted 200, got 500',
      created_at: '2026-08-12T02:25:00.000Z',
      updated_at: '2026-08-12T02:25:00.000Z',
      deleted: 0,
      deleted_at: null,
    }),
  );

  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  adapter.sessionsDetail = async () => [
    // `feature` declares the requirement on its `test` phase; `survey-repo` declares none.
    view(GOVERNED, 'feature', 'repo-ledger'),
    view(UNGOVERNED, 'survey-repo', 'repo-ledger'),
    view(REPOLESS, 'feature', null),
    view(BARE_REPO_RUN, 'feature', 'repo-bare'),
    view(FRESH, 'feature', 'repo-ledger'),
    view(NO_HISTORY, 'feature', 'repo-ledger'),
    view(CANCELLED, 'feature', 'repo-ledger'),
    view(POST_TERMINAL, 'feature', 'repo-ledger'),
    view(UNREADABLE_LOG, 'feature', 'repo-ledger'),
    view(CROSS_RUN, 'feature', 'repo-cross'),
    view(RESUMED_GAP, 'feature', 'repo-ledger'),
    view(RESUMED_SEGMENT, 'feature', 'repo-ledger'),
    view(RESUMED_DONE_EARLY, 'feature', 'repo-ledger'),
    view(RESCUED_LIVE, 'feature', 'repo-ledger'),
    view(RESCUED_DONE, 'feature', 'repo-ledger'),
  ];
  adapter.listRepos = async () => [
    repoEntry('repo-ledger', withLedger),
    repoEntry('repo-bare', bare),
    repoEntry('repo-cross', crossRun),
  ];
  adapter.runEvents = async (runId: string) => historyOf(runId);

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

  it('serves the ledger verdict + manifest summary and satisfies the gate on a PASS inside the run', async () => {
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
      attribution: { kind: 'run-window', qeRunId: QE_RUN_ID },
      ledgerVerdicts: 1,
    });
    expect(res.body['gate']).toMatchObject({
      required: true,
      satisfied: true,
      verdict: 'PASS',
      runStatus: 'passed',
    });
    // The linkage is inferred from the run's lifetime, and the reason says so (review F6).
    expect(field<{ reason: string }>(res.body, 'gate').reason).toContain("INFERRED from this run's lifetime");
    expect(field<{ attributedVerdicts: number }>(res.body, 'acceptance').attributedVerdicts).toBe(1);
  });

  it("does NOT attribute the repo's older PASS to a fresh run that recorded no evidence (F-E2E-013)", async () => {
    // The regression, as observed: an onboarding run that failed at plan time was answered with a
    // July QE PASS from wicked-core's committed legacy ledger — `gate.verdict: PASS` for a run
    // nothing in that ledger knows about. The ledger is still reported (found, how many verdicts,
    // what the newest is) — as what the REPO holds, not as this run's evidence.
    const res = await getAcceptance(FRESH);
    expect(res.status).toBe(200);
    expect(res.body['acceptance']).toMatchObject({
      ledgerDir: '.wicked-testing',
      found: true,
      verdict: null,
      qeRun: null,
      manifest: null,
      ledgerVerdicts: 1,
      attribution: { kind: 'none' },
    });
    const reason = field<{ attribution: { reason: string } }>(res.body, 'acceptance').attribution.reason;
    expect(reason).toContain('newest PASS');
    expect(reason).toContain('before this run started');
    expect(res.body['gate']).toMatchObject({ required: true, satisfied: false, verdict: null, runStatus: null });
    expect(field<{ reason: string }>(res.body, 'gate').reason).toMatch(/no verdict attributed to this run/);
    expect(field<{ reason: string }>(res.body, 'gate').reason).toMatch(/unattributed ⇒ deny/);
  });

  it('links nothing for a run with no recorded history — and says that is why', async () => {
    const res = await getAcceptance(NO_HISTORY);
    expect(res.status).toBe(200);
    expect(res.body['acceptance']).toMatchObject({ found: true, verdict: null, attribution: { kind: 'none' } });
    expect(field<{ reason: string }>(res.body, 'gate').reason).toMatch(/start is not recorded/);
    expect(res.body['gate']).toMatchObject({ satisfied: false, verdict: null });
  });

  it("an explicit ?qeRun pin attributes on the caller's say-so — even for a fresh run", async () => {
    const res = await getAcceptance(FRESH, `?qeRun=${QE_RUN_ID}`);
    expect(res.status).toBe(200);
    expect(res.body['acceptance']).toMatchObject({
      verdict: { verdict: 'PASS', qeRunId: QE_RUN_ID },
      attribution: { kind: 'pinned', qeRunId: QE_RUN_ID },
    });
    expect(res.body['gate']).toMatchObject({ satisfied: true, verdict: 'PASS' });
  });

  it('denies a governed run whose repo has no ledger — missing evidence, with the probed path', async () => {
    const res = await getAcceptance(BARE_REPO_RUN);
    expect(res.status).toBe(200);
    expect(res.body['acceptance']).toMatchObject({ found: false, verdict: null, ledgerVerdicts: 0 });
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
    // The read is still honest about what the ledger holds FOR THIS RUN — display, not gate input.
    expect(field<{ verdict: unknown }>(res.body, 'acceptance').verdict).toMatchObject({ verdict: 'PASS' });
  });

  it('pins the read to one QE run via ?qeRun', async () => {
    const res = await getAcceptance(GOVERNED, `?qeRun=${QE_RUN_ID}`);
    expect(res.status).toBe(200);
    expect(field<{ verdict: { qeRunId: string } }>(res.body, 'acceptance').verdict.qeRunId).toBe(QE_RUN_ID);
  });

  it("a CANCELLED run's window closes at the engine's `runCancelled` frame — a later QE PASS is not its evidence (review F1)", async () => {
    // Reproduced in review: cancel 01:05, QE PASS 02:17 → attributed, gate PASS. The first cut
    // named a `sessionCancelled` frame the engine never emits, so the window never closed.
    const res = await getAcceptance(CANCELLED);
    expect(res.status).toBe(200);
    expect(res.body['acceptance']).toMatchObject({ found: true, verdict: null, qeRun: null, attributedVerdicts: 0, attribution: { kind: 'none' } });
    const reason = field<{ attribution: { reason: string } }>(res.body, 'acceptance').attribution.reason;
    expect(reason).toMatch(/outside this run's lifetime/);
    expect(reason).toContain('finished 2026-08-12T01:05:00.000Z');
    expect(res.body['gate']).toMatchObject({ required: true, satisfied: false, verdict: null, runStatus: null });
  });

  it('a non-terminal frame after the terminal one does not reopen the window (review F4)', async () => {
    const res = await getAcceptance(POST_TERMINAL);
    expect(res.body['acceptance']).toMatchObject({ verdict: null, attributedVerdicts: 0, attribution: { kind: 'none' } });
    expect(field<{ attribution: { reason: string } }>(res.body, 'acceptance').attribution.reason).toContain(
      'finished 2026-08-12T01:05:00.000Z',
    );
    expect(res.body['gate']).toMatchObject({ satisfied: false, verdict: null });
  });

  it('an UNREADABLE event log is named as the cause — not "no sessionStarted" (review F5)', async () => {
    const res = await getAcceptance(UNREADABLE_LOG);
    expect(res.status).toBe(200);
    expect(res.body['acceptance']).toMatchObject({ verdict: null, attribution: { kind: 'none' } });
    const reason = field<{ reason: string }>(res.body, 'gate').reason;
    expect(reason).toContain("the run's event log could not be read (event-log read binding missing (older addon))");
    expect(reason).not.toContain('no sessionStarted');
    expect(res.body['gate']).toMatchObject({ satisfied: false, verdict: null });
    // The conformance half already reads the same failure as unverifiable enforcement.
    expect(field<{ enforcement: { status: string } }>(res.body, 'conformance').enforcement.status).toBe('unverifiable');
  });

  it('deny-dominates ACROSS the attributed QE runs: a later PASS on run A does not mask a FAIL on run B (review F2)', async () => {
    const res = await getAcceptance(CROSS_RUN);
    expect(res.status).toBe(200);
    expect(res.body['acceptance']).toMatchObject({
      ledgerVerdicts: 2,
      attributedVerdicts: 2,
      verdict: { id: 'fail-run-b', verdict: 'FAIL', qeRunId: 'qe-run-b' },
      qeRun: { id: 'qe-run-b', status: 'failed' },
      attribution: { kind: 'run-window', qeRunId: 'qe-run-b' },
    });
    expect(res.body['gate']).toMatchObject({ required: true, satisfied: false, verdict: 'FAIL', runStatus: 'failed' });
    const reason = field<{ reason: string }>(res.body, 'gate').reason;
    expect(reason).toContain('scenario X');
    expect(reason).toContain('2 QE runs are attributed to this run');
    // Each QE run stays individually addressable: the fixture run's PASS by pin.
    const pinned = await getAcceptance(CROSS_RUN, `?qeRun=${QE_RUN_ID}`);
    expect(pinned.body['acceptance']).toMatchObject({ verdict: { verdict: 'PASS' }, attribution: { kind: 'pinned' }, attributedVerdicts: 1 });
  });

  it('a FAILED run that was RESUMED and completed owns the QE run recorded inside its resumed segment (r2 N1)', async () => {
    // POST /runs/:id/resume on a failed run continues the SAME run to sessionCompleted; r2's
    // "first terminal frame" rule froze the window at the failure and denied the rescued run's
    // own evidence as "outside this run's lifetime".
    const res = await getAcceptance(RESUMED_SEGMENT);
    expect(res.status).toBe(200);
    expect(res.body['acceptance']).toMatchObject({
      verdict: { verdict: 'PASS', qeRunId: QE_RUN_ID },
      attribution: { kind: 'run-window', qeRunId: QE_RUN_ID },
      attributedVerdicts: 1,
    });
    expect(res.body['gate']).toMatchObject({ required: true, satisfied: true, verdict: 'PASS' });
  });

  it('…and a QE run started in the gap between the failure and the resume is attributed too — the run was rescuable', async () => {
    const res = await getAcceptance(RESUMED_GAP);
    expect(res.body['acceptance']).toMatchObject({
      verdict: { verdict: 'PASS', qeRunId: QE_RUN_ID },
      attribution: { kind: 'run-window' },
    });
    expect(res.body['gate']).toMatchObject({ satisfied: true, verdict: 'PASS' });
  });

  it('a resumed run whose FINAL completion predates the QE run is closed for good (r2 N1)', async () => {
    const res = await getAcceptance(RESUMED_DONE_EARLY);
    expect(res.body['acceptance']).toMatchObject({ verdict: null, attributedVerdicts: 0, attribution: { kind: 'none' } });
    const reason = field<{ attribution: { reason: string } }>(res.body, 'acceptance').attribution.reason;
    expect(reason).toMatch(/outside this run's lifetime/);
    expect(reason).toContain('finished 2026-08-12T02:00:00.000Z');
    expect(res.body['gate']).toMatchObject({ satisfied: false, verdict: null });
  });

  it("a rescued run that is STILL EXECUTING owns the QE run recorded in its live segment — the engine's real shape has no `resumed` (r3 N3)", async () => {
    // resume_run_inner emits no frame; the rescued run's next frames are dispatch_unit's. Until
    // this fix the live segment read "finished <fail time>" and the QE PASS at 02:17 was denied.
    const res = await getAcceptance(RESCUED_LIVE);
    expect(res.status).toBe(200);
    expect(res.body['acceptance']).toMatchObject({
      verdict: { verdict: 'PASS', qeRunId: QE_RUN_ID },
      attribution: { kind: 'run-window', qeRunId: QE_RUN_ID },
      attributedVerdicts: 1,
    });
    expect(res.body['gate']).toMatchObject({ required: true, satisfied: true, verdict: 'PASS' });
  });

  it('…and once that rescued run completes, its window closes at ITS completion (no `resumed` frame needed)', async () => {
    const res = await getAcceptance(RESCUED_DONE);
    expect(res.body['acceptance']).toMatchObject({ verdict: { verdict: 'PASS' }, attribution: { kind: 'run-window' } });
    expect(res.body['gate']).toMatchObject({ satisfied: true, verdict: 'PASS' });
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
