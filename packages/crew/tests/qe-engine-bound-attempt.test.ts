// crew#1560 — at deliver, the QE run the ENGINE bound on the latest QE attempt decides which of the
// run's verdicts still count, even when the run has no verified tree.
//
// Live case (run 4995811f, crew 0.18.16, 2026-11-16): the floor was overridden by the operator, so
// the session has no `verified_tree`, and every QE `gateEvaluated` carried `assurance.tree = null`.
// A re-plan moved the QE unit from ord 4 to ord 5. Its QE runs: cb8c59f1 (INCONCLUSIVE, 14:45),
// b95cd89c (PASS, 15:28) and 706d2fb2 (PASS, 16:17) — every verdict stamped with the crew run. The
// tree and attempt scoping were both off, so deny-dominates across the three QE runs let the oldest
// INCONCLUSIVE outvote both PASSes and Deliver stayed disabled; the operator had to skip QE.
//
// The engine names the verdict it bound by QE run AND isolated-review session nonce
// (`units[].qe_review.qe_run_id` + its `verdict` turn's `session`). A verdict stamped with a review
// session the engine no longer binds is an earlier attempt's. Never decided by time.
//
//   stale INCONCLUSIVE (old session), engine-bound PASS, no verified tree → delivers on the PASS;
//   the same with an INCONCLUSIVE-valued verdict row                      → delivers;
//   clock skew: the bound PASS dated before its QE run row               → still the bound one;
//   a resumed QE run: its old session's FAIL, the bound session's PASS   → delivers;
//   a FAIL from another writer (no session) after the bound verdict      → refused;
//   a FAIL on the bound session itself (newer than its PASS)             → refused (ledger read too);
//   the bound session's verdict missing from the ledger                  → refused;
//   a second reviewer unit with no bound record (coverage)               → no cut: refused, as before;
//   a record with no qe_run_id / on another tree                         → no cut: refused, as before.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { AuditLog } from '../src/api/audit.js';
import { type CoreAdapter } from '../src/core/adapter.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';
import { removeScratch } from './setup/scratch.js';
import { withRunViews } from './support/run-views.js';

const DELIVER_ORD = 8;
const QE_ORD = 5;
const T0 = Date.parse('2026-11-16T14:00:00.000Z');
const TREE_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TREE_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const REQUIRED = {
  status: 'required', basis: 'operator', score: null, threshold: 20, ord: null, tree: null,
  reason: 'QE acceptance forced by operator: no score waives it', reasons: [],
};
const min = (n: number) => T0 + n * 60_000;

const RUNS = {
  stale: 'run-1560-stale',
  staleInconclusiveValue: 'run-1560-inconclusive-value',
  clockSkew: 'run-1560-skew',
  resumed: 'run-1560-resumed',
  laterForeignFail: 'run-1560-later-fail',
  boundSessionFails: 'run-1560-bound-fail',
  boundMissing: 'run-1560-bound-missing',
  uncovered: 'run-1560-uncovered',
  unboundRecord: 'run-1560-unbound',
  boundOnAnotherTree: 'run-1560-other-tree',
  // round 2
  laterUnknownSession: 'run-1560-r2-unknown-session',
  sameSessionFailThenPass: 'run-1560-r2-fail-then-pass',
  sameSessionPassThenFail: 'run-1560-r2-pass-then-fail',
  boundDatedInOldWindow: 'run-1560-r2-skew-window',
  legacyUnstampedEarlierAttempt: 'run-1560-r2-legacy',
  // coord codex-check on #1580: retirement needs positive supersession evidence.
  unknownSessionBeforeBoundPass: 'run-1560-cc-unknown-earlier',
  olderFailNotRedone: 'run-1560-cc-not-redone',
  // confirmation round: existing engine evidence still retires; each session's newest counts.
  failOnSupersededTree: 'run-1560-cc-old-tree',
  unboundSessionFailThenPass: 'run-1560-cc-unbound-fail-pass',
  unboundSessionPassThenFail: 'run-1560-cc-unbound-pass-fail',
  newerFailOnBoundRunInOldWindow: 'run-1560-cc2-bound-run-newer-fail',
  sessionlessFailThenStampedPass: 'run-1560-cc2-mixed',
  sessionlessNewerFailOnBoundRunInOldWindow: 'run-1560-cc3-sessionless-newer-fail',
  otherSessionFailThenPassOnBoundRun: 'run-1560-cc3-bound-run-fail-pass',
  otherSessionPassThenFailOnBoundRun: 'run-1560-cc3-bound-run-pass-fail',
  freshFailOnRedoneRun: 'run-1560-cc4-fresh-fail-redone-run',
  boundRunSessionlessFailThenStampedPass: 'run-1560-cc4-bound-mixed-a',
  boundRunStampedFailThenSessionlessPass: 'run-1560-cc4-bound-mixed-b',
  postRedoFailInOldWindow: 'run-1560-cc5-post-redo-fail-old-window',
};
/** Runs whose reviewer unit's QE run qe-1 was retired by a "redo the QE check" (`qe_redos`). */
const REDONE = new Set<string>([
  RUNS.stale, RUNS.staleInconclusiveValue, RUNS.clockSkew, RUNS.boundDatedInOldWindow,
  RUNS.laterForeignFail, RUNS.boundSessionFails, RUNS.boundMissing, RUNS.uncovered,
  RUNS.unboundRecord, RUNS.boundOnAnotherTree, RUNS.freshFailOnRedoneRun, RUNS.postRedoFailInOldWindow,
]);
/** Runs whose log has QE attempt windows that judged trees (A, then B) and a verified tree B. */
const TREED = new Set<string>([RUNS.boundDatedInOldWindow, RUNS.legacyUnstampedEarlierAttempt, RUNS.failOnSupersededTree, RUNS.newerFailOnBoundRunInOldWindow, RUNS.sessionlessNewerFailOnBoundRunInOldWindow, RUNS.postRedoFailInOldWindow]);

const LATEST = 'nonce-latest';
const review = (qeRun: string | null, tree = TREE_B) => ({
  outcome: 'pass', reason: 'bound PASS', ...(qeRun !== null ? { qe_run_id: qeRun } : {}), tree, verdict: 'PASS',
  attempts: [
    { seat: 'pi', basis: 'distinct', status: 'seat_failure:quota', session: 'nonce-quota', attempt: 3 },
    { seat: 'codex', basis: 'distinct', status: 'verdict', session: LATEST, attempt: 3 },
  ],
});
/** What each run's QE unit's engine record says (`units[].qe_review`). */
const REVIEW: Record<string, Record<string, unknown>> = Object.fromEntries(
  Object.values(RUNS).map((id) => [id, review('qe-3')]),
);
REVIEW[RUNS.resumed] = review('qe-1');
REVIEW[RUNS.unboundRecord] = review(null);
REVIEW[RUNS.boundOnAnotherTree] = review('qe-3', TREE_A);

let dir: string;
let app: FastifyInstance;
const audit = { record: vi.fn(() => Date.now()), readAll: vi.fn(async () => []) } as unknown as AuditLog;
const gateCache = new GateCache();
const confirmCalls: unknown[][] = [];
const evidenceOf = (id: string) => join(dir, 'walkthroughs', id);

/** The 4995811f log shape: the QE unit dispatched at ord 4, then (after a re-plan) at ord 5; every
 *  QE gate judged no tree (`assurance.tree` null); no `qeAcceptanceDecided` before the deliver. */
const treedEventsOf = (id: string) => [
  { type: 'sessionStarted', session: id, ts: T0, seq: 1 },
  { type: 'qeAcceptanceDecided', session: id, ord: QE_ORD, ts: T0 + 10, seq: 2 },
  { type: 'unitDispatched', session: id, ord: QE_ORD, attempt: 0, ts: min(30), seq: 3 },
  { type: 'gateEvaluated', session: id, ord: QE_ORD, assurance: { attempt: 0, tree: id === RUNS.legacyUnstampedEarlierAttempt ? TREE_B : TREE_A }, ts: min(60), seq: 4 },
  { type: 'unitDispatched', session: id, ord: QE_ORD, attempt: 1, ts: min(120), seq: 5 },
  { type: 'gateEvaluated', session: id, ord: QE_ORD, assurance: { attempt: 1, tree: TREE_B }, ts: min(140), seq: 6 },
];
const eventsOf = (id: string) => TREED.has(id) ? treedEventsOf(id) : [
  { type: 'sessionStarted', session: id, ts: T0, seq: 1 },
  { type: 'unitDispatched', session: id, ord: 4, attempt: 0, ts: min(30), seq: 2 },
  { type: 'gateEvaluated', session: id, ord: 4, assurance: { attempt: 0, tree: null }, ts: min(46), seq: 3 },
  { type: 'unitDispatched', session: id, ord: QE_ORD, attempt: 2, ts: min(84), seq: 4 },
  { type: 'gateEvaluated', session: id, ord: QE_ORD, assurance: { attempt: 2, tree: null }, ts: min(90), seq: 5 },
  { type: 'unitDispatched', session: id, ord: QE_ORD, attempt: 3, ts: min(131), seq: 6 },
  { type: 'gateEvaluated', session: id, ord: QE_ORD, assurance: { attempt: 3, tree: null }, ts: min(138), seq: 7 },
];

function view(id: string) {
  const unit = (ord: number, phase: string, status: string) => ({
    id: `${id}:${phase}`, session_id: id, ord, description: '', stage: 'build', phase_ref: phase,
    assigned_cli: 'claude', assigned_invocation: null, council_task_ref: null, routing: null, status,
  });
  return {
    session: {
      id, workflow_id: 'bug', problem: 'p', entity_mode: 'shared', collection_scope: null,
      clis: ['claude', 'codex'], status: 'awaiting_human', human_confirm: 'all', unit_ix: DELIVER_ORD - 1, attempt: 0,
      workdir: join(dir, 'wt', id), repo_ref: 'repo-1', extra_write_roots: [], evidence_root: evidenceOf(id),
      // The floor was overridden: no verified tree (the boundOnAnotherTree run has one).
      verified_tree: id === RUNS.boundOnAnotherTree || TREED.has(id) ? TREE_B : null,
      archived_at: null, archive_note: null,
      assurance: { mode: 'full', required: ['distinct_evaluator', 'judge', 'qe_acceptance'], qe: REQUIRED },
    },
    units: [
      unit(2, 'build', 'done'),
      unit(4, 'review', 'done'),
      {
        ...unit(QE_ORD, 'test', 'done'), qe_acceptance: REQUIRED, qe_ledger_root: join(evidenceOf(id), '.wicked-qe'), qe_review: REVIEW[id],
        ...(REDONE.has(id) ? { qe_redos: [{ tree: TREE_B, from_attempt: 0, outcome: 'inconclusive', qe_run_id: 'qe-1', reason: 'manifest-2.1 shape', by: 'operator', at: min(46) }] } : {}),
      },
      // A second unit the engine runs a reviewer for, with no bound record yet.
      ...(id === RUNS.uncovered ? [{ ...unit(6, 'test-2', 'done'), qe_acceptance: REQUIRED, qe_ledger_root: join(evidenceOf(id), '.wicked-qe') }] : []),
      unit(DELIVER_ORD, 'deliver', 'pending'),
    ],
  };
}

type V = 'PASS' | 'FAIL' | 'INCONCLUSIVE';
/** A QE run row and its verdicts, as wicked-ledger writes them; everything stamped with the crew run.
 *  Each verdict: [id, value, recorded at, review session (null = none), reason]. */
function qeRun(crewRun: string, qeRunId: string, createdAt: number, verdicts: Array<[string, V, number, string | null, string?]>) {
  const root = join(evidenceOf(crewRun), '.wicked-qe');
  mkdirSync(join(root, 'runs'), { recursive: true });
  mkdirSync(join(root, 'verdicts'), { recursive: true });
  const iso = (t: number) => new Date(t).toISOString();
  writeFileSync(join(root, 'runs', `${qeRunId}.json`), JSON.stringify({
    id: qeRunId, project_id: 'p', scenario_id: 's', created_at: iso(createdAt), started_at: iso(createdAt + 60_000),
    status: 'running', crew_run_id: crewRun, evidence_path: join(root, 'evidence', qeRunId),
  }));
  for (const [vid, verdict, at, session, reason] of verdicts) {
    writeFileSync(join(root, 'verdicts', `${vid}.json`), JSON.stringify({
      id: vid, run_id: qeRunId, verdict, created_at: iso(at), reviewer: 'acceptance-test-reviewer',
      reason: reason ?? (verdict === 'PASS' ? 'All assertions satisfied' : `FAIL ${vid}`), crew_run_id: crewRun,
      ...(session !== null ? { review_session: session } : {}),
    }));
  }
}
const STALE = '[scenario-defect] inconclusive — evidence manifest fails manifest-2.1 validation';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-qe-1560-'));
  mkdirSync(join(dir, 'repo'), { recursive: true });
  const views = Object.values(RUNS).map(view);
  const mockAdapter = {
    sessionsDetail: vi.fn(async () => structuredClone(views)),
    sessions: vi.fn(async () => views.map((v) => v.session.id)),
    listRepos: vi.fn(async () => [{ id: 'repo-1', name: 'repo', root_path: join(dir, 'repo') }]),
    listWorkflows: () => BUILTIN_WORKFLOWS,
    getWorkflow: () => null,
    interactionRequests: vi.fn(async (id: string) => {
      const open = gateCache.get(id);
      return open === undefined ? [] : [{ kind: 'gate', ord: open.ord, prompt: open.prompt, created_at: open.receivedAt }];
    }),
    runEvents: vi.fn(async (id: string) => eventsOf(id)),
    listConformanceClaims: vi.fn(async () => []),
    confirmGate: vi.fn(async (...args: unknown[]) => {
      confirmCalls.push(args);
      return 'executing';
    }),
  };
  app = Fastify({ logger: false });
  registerRoutes(app, withRunViews(mockAdapter as unknown as CoreAdapter), gateCache, new ElicitationCache(), undefined, { audit, authMode: 'off' }, {
    worktreeExists: () => true,
    deliverExec: async () => ({ status: 0, output: '' }),
  });
  await app.ready();
  const ROUND2 = new Set<string>([RUNS.laterUnknownSession, RUNS.sameSessionFailThenPass, RUNS.sameSessionPassThenFail, RUNS.boundDatedInOldWindow, RUNS.legacyUnstampedEarlierAttempt, RUNS.unknownSessionBeforeBoundPass, RUNS.olderFailNotRedone, RUNS.failOnSupersededTree, RUNS.unboundSessionFailThenPass, RUNS.unboundSessionPassThenFail, RUNS.newerFailOnBoundRunInOldWindow, RUNS.sessionlessFailThenStampedPass, RUNS.sessionlessNewerFailOnBoundRunInOldWindow, RUNS.otherSessionFailThenPassOnBoundRun, RUNS.otherSessionPassThenFailOnBoundRun, RUNS.freshFailOnRedoneRun, RUNS.boundRunSessionlessFailThenStampedPass, RUNS.boundRunStampedFailThenSessionlessPass, RUNS.postRedoFailInOldWindow]);
  // The coord repro: the bound run starts 16:11, an unknown session records FAIL at 16:16 on another
  // QE run, the bound PASS lands at 16:17. Nothing proves the PASS supersedes that FAIL.
  qeRun(RUNS.unknownSessionBeforeBoundPass, 'qe-3', min(131), [['v-3', 'PASS', min(137), LATEST]]);
  qeRun(RUNS.unknownSessionBeforeBoundPass, 'qe-5', min(131), [['v-5', 'FAIL', min(136), 'nonce-unknown']]);
  // A session-stamped FAIL inside attempt 0's window (tree A), the bound PASS on tree B, no redo:
  // the engine's tree evidence retires it, as on main.
  qeRun(RUNS.failOnSupersededTree, 'qe-1', min(31), [['v-1', 'FAIL', min(40), 'nonce-1']]);
  qeRun(RUNS.failOnSupersededTree, 'qe-3', min(121), [['v-3', 'PASS', min(130), LATEST]]);
  // An unbound session on QE run X corrects itself; the bound PASS is on run Y.
  qeRun(RUNS.unboundSessionFailThenPass, 'qe-x', min(100), [['v-x1', 'FAIL', min(135), 'nonce-x'], ['v-x2', 'PASS', min(136), 'nonce-x']]);
  qeRun(RUNS.unboundSessionFailThenPass, 'qe-3', min(131), [['v-3', 'PASS', min(137), LATEST]]);
  qeRun(RUNS.unboundSessionPassThenFail, 'qe-x', min(100), [['v-x1', 'PASS', min(135), 'nonce-x'], ['v-x2', 'FAIL', min(136), 'nonce-x']]);
  qeRun(RUNS.unboundSessionPassThenFail, 'qe-3', min(131), [['v-3', 'PASS', min(137), LATEST]]);
  // Clock skew puts the bound PASS (minute 50) and a newer FAIL of another session on the SAME bound
  // run (minute 55) inside attempt 0's tree-A window: the newer FAIL still denies.
  qeRun(RUNS.newerFailOnBoundRunInOldWindow, 'qe-3', min(119), [['v-3', 'PASS', min(50), LATEST], ['v-3x', 'FAIL', min(55), 'nonce-other']]);
  // A sessionless FAIL then a session-stamped PASS on unbound run X; the bound PASS on run Y.
  qeRun(RUNS.sessionlessFailThenStampedPass, 'qe-x', min(100), [['v-x1', 'FAIL', min(135), null], ['v-x2', 'PASS', min(136), 'nonce-x']]);
  qeRun(RUNS.sessionlessFailThenStampedPass, 'qe-3', min(131), [['v-3', 'PASS', min(137), LATEST]]);
  qeRun(RUNS.sessionlessNewerFailOnBoundRunInOldWindow, 'qe-3', min(119), [['v-3', 'PASS', min(50), LATEST], ['v-3s', 'FAIL', min(55), null]]);
  // Another session on the BOUND run corrects itself (FAIL->PASS) or regresses (PASS->FAIL).
  qeRun(RUNS.otherSessionFailThenPassOnBoundRun, 'qe-3', min(131), [['v-3', 'PASS', min(137), LATEST], ['v-3a', 'FAIL', min(138), 'nonce-o'], ['v-3b', 'PASS', min(139), 'nonce-o']]);
  qeRun(RUNS.otherSessionPassThenFailOnBoundRun, 'qe-3', min(131), [['v-3', 'PASS', min(137), LATEST], ['v-3a', 'PASS', min(138), 'nonce-o'], ['v-3b', 'FAIL', min(139), 'nonce-o']]);
  // qe-1 was redone at minute 46; an unknown session writes FAIL on it at minute 139, after the
  // replacement's bound PASS: written after the redo, it still denies.
  qeRun(RUNS.freshFailOnRedoneRun, 'qe-1', min(40), [['v-1', 'FAIL', min(45), 'nonce-1'], ['v-1x', 'FAIL', min(139), 'nonce-fresh']]);
  qeRun(RUNS.freshFailOnRedoneRun, 'qe-3', min(131), [['v-3', 'PASS', min(137), LATEST]]);
  // qe-1 redone at minute 46; an unknown session writes FAIL on it at minute 55, inside attempt 0's
  // tree-A window, with verified tree B: written after the redo, it still denies.
  qeRun(RUNS.postRedoFailInOldWindow, 'qe-1', min(31), [['v-1', 'FAIL', min(40), 'nonce-1'], ['v-1x', 'FAIL', min(55), 'nonce-fresh']]);
  qeRun(RUNS.postRedoFailInOldWindow, 'qe-3', min(121), [['v-3', 'PASS', min(130), LATEST]]);
  // Mixed sessionless / stamped rows after the bound PASS on the bound run: its newest decides.
  qeRun(RUNS.boundRunSessionlessFailThenStampedPass, 'qe-3', min(131), [['v-3', 'PASS', min(137), LATEST], ['v-3a', 'FAIL', min(138), null], ['v-3b', 'PASS', min(139), 'nonce-o']]);
  qeRun(RUNS.boundRunStampedFailThenSessionlessPass, 'qe-3', min(131), [['v-3', 'PASS', min(137), LATEST], ['v-3a', 'FAIL', min(138), 'nonce-o'], ['v-3b', 'PASS', min(139), null]]);
  // An older attempt's FAIL on another QE run that no redo retired still denies.
  qeRun(RUNS.olderFailNotRedone, 'qe-1', min(40), [['v-1', 'FAIL', min(45), 'nonce-1']]);
  qeRun(RUNS.olderFailNotRedone, 'qe-3', min(131), [['v-3', 'PASS', min(137), LATEST]]);
  // Round 2 (codex r2): an unknown session after the bound verdict still denies.
  qeRun(RUNS.laterUnknownSession, 'qe-3', min(131), [['v-3', 'PASS', min(137), LATEST]]);
  qeRun(RUNS.laterUnknownSession, 'qe-4', min(138), [['v-4', 'FAIL', min(139), 'nonce-fresh']]);
  // One reviewer session corrects itself: its newest row is the bound one, either way.
  qeRun(RUNS.sameSessionFailThenPass, 'qe-3', min(131), [['v-3a', 'FAIL', min(136), LATEST], ['v-3', 'PASS', min(137), LATEST]]);
  qeRun(RUNS.sameSessionPassThenFail, 'qe-3', min(131), [['v-3', 'PASS', min(136), LATEST], ['v-3b', 'FAIL', min(137), LATEST]]);
  // Verified tree B; the bound PASS is dated inside attempt 0's window (tree A), and an old-session
  // FAIL sits there too: the window must not drop the bound verdict.
  qeRun(RUNS.boundDatedInOldWindow, 'qe-1', min(31), [['v-1', 'FAIL', min(40), 'nonce-1', STALE]]);
  qeRun(RUNS.boundDatedInOldWindow, 'qe-3', min(119), [['v-3', 'PASS', min(50), LATEST]]);
  // Both attempts judged tree B: an UNSTAMPED FAIL in attempt 0, the bound PASS in attempt 1. The
  // latest-attempt cut still retires the unstamped one, as today.
  qeRun(RUNS.legacyUnstampedEarlierAttempt, 'qe-1', min(31), [['v-1', 'FAIL', min(40), null]]);
  qeRun(RUNS.legacyUnstampedEarlierAttempt, 'qe-3', min(121), [['v-3', 'PASS', min(130), LATEST]]);
  for (const id of Object.values(RUNS)) {
    if (id === RUNS.resumed || ROUND2.has(id)) continue;
    // The 4995811f ledger: an INCONCLUSIVE on QE run 1 and a PASS on QE run 2 (earlier sessions).
    qeRun(id, 'qe-1', min(40), [['v-1', id === RUNS.staleInconclusiveValue ? 'INCONCLUSIVE' : 'FAIL', min(45), 'nonce-1', STALE]]);
    qeRun(id, 'qe-2', min(84), [['v-2', 'PASS', min(88), 'nonce-2']]);
  }
  for (const id of [RUNS.stale, RUNS.staleInconclusiveValue, RUNS.uncovered, RUNS.unboundRecord, RUNS.boundOnAnotherTree]) {
    qeRun(id, 'qe-3', min(131), [['v-3', 'PASS', min(137), LATEST]]);
  }
  // The bound PASS dated BEFORE its own run row (a seat clock behind the engine's).
  qeRun(RUNS.clockSkew, 'qe-3', min(131), [['v-3', 'PASS', min(120), LATEST]]);
  // A same-tree retry resumed QE run 1: its old session's FAIL, then the bound session's PASS.
  qeRun(RUNS.resumed, 'qe-1', min(40), [['v-1', 'FAIL', min(45), 'nonce-1', STALE], ['v-3', 'PASS', min(137), LATEST]]);
  // Another writer (no session) records a FAIL on a new QE run after the bound verdict.
  qeRun(RUNS.laterForeignFail, 'qe-3', min(131), [['v-3', 'PASS', min(137), LATEST]]);
  qeRun(RUNS.laterForeignFail, 'qe-4', min(138), [['v-4', 'FAIL', min(139), null]]);
  // The bound session itself recorded FAIL after its PASS (the engine's record still says pass).
  qeRun(RUNS.boundSessionFails, 'qe-3', min(131), [['v-3', 'PASS', min(137), LATEST], ['v-3b', 'FAIL', min(138), LATEST]]);
  // The bound run holds a verdict of another session only: the bound one is missing.
  qeRun(RUNS.boundMissing, 'qe-3', min(131), [['v-3', 'PASS', min(137), 'nonce-forged']]);
});

beforeEach(() => {
  confirmCalls.length = 0;
  for (const id of Object.values(RUNS)) {
    gateCache.adopt(id, { ord: DELIVER_ORD, prompt: 'Approve deliver?', lifecycle: 'open', receivedAt: '2026-11-16T16:31:00Z' });
  }
});

afterAll(async () => {
  await app.close();
  removeScratch(dir);
});

const decide = (id: string) =>
  app.inject({ method: 'POST', url: `/api/v1/runs/${id}/gate`, payload: { approve: true, ord: DELIVER_ORD } });

const acceptance = async (id: string) =>
  (await app.inject({ method: 'GET', url: `/api/v1/runs/${id}/acceptance` })).json().acceptance;

describe('crew#1560 — the verdict the engine bound on the latest attempt decides what counts', () => {
  for (const id of [RUNS.stale, RUNS.staleInconclusiveValue]) {
    it(`a stale INCONCLUSIVE no longer outvotes the bound PASS with no verified tree (4995811f; ${id})`, async () => {
      const res = await decide(id);
      expect(res.statusCode, res.body).toBe(200);
      const check = res.json().delivery.qeAcceptance;
      expect(check).toMatchObject({ status: 'required', satisfied: true, verdictId: 'v-3' });
      expect(check.reason).toMatch(/^PASS/);
      expect(check.reason).toContain('1 verdict the engine superseded (on a redone QE run, before the bound verdict of the run it re-bound, or outside its attempt windows) no longer counts (the engine bound the latest attempt\'s on qe-3)');
      expect(confirmCalls).toHaveLength(1);
      expect((await acceptance(id)).verdict.id).toBe('v-3');
    });
  }

  it('clock skew between writers never drops the bound verdict', async () => {
    const res = await decide(RUNS.clockSkew);
    expect(res.statusCode, res.body).toBe(200);
    expect((await acceptance(RUNS.clockSkew)).verdict.id).toBe('v-3');
  });

  it("a resumed QE run: the old session's FAIL is retired, the bound session's PASS counts", async () => {
    const res = await decide(RUNS.resumed);
    expect(res.statusCode, res.body).toBe(200);
    expect((await acceptance(RUNS.resumed)).verdict.id).toBe('v-3');
  });

  it('a FAIL from another writer after the bound verdict still refuses', async () => {
    const res = await decide(RUNS.laterForeignFail);
    expect(res.statusCode, res.body).toBe(409);
    expect((await acceptance(RUNS.laterForeignFail)).verdict.id).toBe('v-4');
    expect(confirmCalls).toEqual([]);
  });

  it("a FAIL on the bound session itself refuses, in the ledger read (not only the engine's veto)", async () => {
    const res = await decide(RUNS.boundSessionFails);
    expect(res.statusCode, res.body).toBe(409);
    const acc = await acceptance(RUNS.boundSessionFails);
    expect(acc.verdict).toMatchObject({ id: 'v-3b', verdict: 'FAIL' });
  });

  it('the bound verdict missing from the ledger refuses, naming it', async () => {
    const res = await decide(RUNS.boundMissing);
    expect(res.statusCode, res.body).toBe(409);
    const acc = await acceptance(RUNS.boundMissing);
    expect(acc.verdict).toBeNull();
    expect(acc.attribution.reason).toContain('the verdict the engine bound on QE run qe-3 (isolated review session nonce-latest) is not in the ledger');
  });

  it('codex r2: a FAIL under an unknown session recorded after the bound verdict still refuses', async () => {
    const res = await decide(RUNS.laterUnknownSession);
    expect(res.statusCode, res.body).toBe(409);
    expect((await acceptance(RUNS.laterUnknownSession)).verdict.id).toBe('v-4');
  });

  it('codex r2: one session that corrects itself is read at its newest row, both ways', async () => {
    expect((await decide(RUNS.sameSessionFailThenPass)).statusCode).toBe(200);
    expect((await acceptance(RUNS.sameSessionFailThenPass)).verdict.id).toBe('v-3');
    expect((await decide(RUNS.sameSessionPassThenFail)).statusCode).toBe(409);
    expect((await acceptance(RUNS.sameSessionPassThenFail)).verdict.id).toBe('v-3b');
  });

  it('codex r2: a time window never drops the bound verdict', async () => {
    const res = await decide(RUNS.boundDatedInOldWindow);
    expect(res.statusCode, res.body).toBe(200);
    expect((await acceptance(RUNS.boundDatedInOldWindow)).verdict.id).toBe('v-3');
  });

  it('codex r2: unstamped verdicts keep the latest-attempt cut', async () => {
    const res = await decide(RUNS.legacyUnstampedEarlierAttempt);
    expect(res.statusCode, res.body).toBe(200);
    expect((await acceptance(RUNS.legacyUnstampedEarlierAttempt)).verdict.id).toBe('v-3');
  });

  it('coord codex-check: an unknown session\'s FAIL recorded before the bound PASS still refuses', async () => {
    const res = await decide(RUNS.unknownSessionBeforeBoundPass);
    expect(res.statusCode, res.body).toBe(409);
    const acc = await acceptance(RUNS.unknownSessionBeforeBoundPass);
    expect(acc.verdict).toMatchObject({ id: 'v-5', verdict: 'FAIL' });
    expect(confirmCalls).toEqual([]);
  });

  it('coord codex-check: an older FAIL on a QE run no redo retired still refuses', async () => {
    const res = await decide(RUNS.olderFailNotRedone);
    expect(res.statusCode, res.body).toBe(409);
    expect((await acceptance(RUNS.olderFailNotRedone)).verdict.id).toBe('v-1');
  });

  it('confirmation: a session-stamped FAIL on a superseded tree no longer blocks (engine window evidence)', async () => {
    const res = await decide(RUNS.failOnSupersededTree);
    expect(res.statusCode, res.body).toBe(200);
    expect((await acceptance(RUNS.failOnSupersededTree)).verdict.id).toBe('v-3');
  });

  it('confirmation: an unbound session is read at its newest row, both ways', async () => {
    expect((await decide(RUNS.unboundSessionFailThenPass)).statusCode).toBe(200);
    expect((await decide(RUNS.unboundSessionPassThenFail)).statusCode).toBe(409);
    expect((await acceptance(RUNS.unboundSessionPassThenFail)).verdict.id).toBe('v-x2');
  });

  it('confirmation 2: a newer FAIL on the bound run denies though a skewed window holds it', async () => {
    const res = await decide(RUNS.newerFailOnBoundRunInOldWindow);
    expect(res.statusCode, res.body).toBe(409);
    expect((await acceptance(RUNS.newerFailOnBoundRunInOldWindow)).verdict.id).toBe('v-3x');
  });

  it('confirmation 2: a sessionless FAIL superseded by a newer stamped PASS on its run no longer blocks', async () => {
    const res = await decide(RUNS.sessionlessFailThenStampedPass);
    expect(res.statusCode, res.body).toBe(200);
  });

  it('confirmation 3: a sessionless FAIL newer than the bound PASS denies though a skewed window holds it', async () => {
    const res = await decide(RUNS.sessionlessNewerFailOnBoundRunInOldWindow);
    expect(res.statusCode, res.body).toBe(409);
  });

  it('confirmation 3: another session on the bound run is read at its newest row, both ways', async () => {
    expect((await decide(RUNS.otherSessionFailThenPassOnBoundRun)).statusCode).toBe(200);
    expect((await decide(RUNS.otherSessionPassThenFailOnBoundRun)).statusCode).toBe(409);
  });

  it('confirmation 4: a FAIL written on a redone run after the redo still denies', async () => {
    const res = await decide(RUNS.freshFailOnRedoneRun);
    expect(res.statusCode, res.body).toBe(409);
    expect((await acceptance(RUNS.freshFailOnRedoneRun)).verdict.id).toBe('v-1x');
  });

  it('confirmation 5: a FAIL written on a redone run after the redo denies though an old window holds it', async () => {
    const res = await decide(RUNS.postRedoFailInOldWindow);
    expect(res.statusCode, res.body).toBe(409);
    expect((await acceptance(RUNS.postRedoFailInOldWindow)).verdict.id).toBe('v-1x');
  });

  it('confirmation 4: mixed sessionless and stamped rows on the bound run are read at the newest', async () => {
    expect((await decide(RUNS.boundRunSessionlessFailThenStampedPass)).statusCode).toBe(200);
    expect((await decide(RUNS.boundRunStampedFailThenSessionlessPass)).statusCode).toBe(200);
  });

  it('a reviewer unit with no bound record makes no cut: the stale verdict still refuses, as before', async () => {
    const res = await decide(RUNS.uncovered);
    expect(res.statusCode, res.body).toBe(409);
  });

  it('a record that bound no QE run makes no cut', async () => {
    const res = await decide(RUNS.unboundRecord);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().acceptance.reason).toMatch(/^FAIL/);
  });

  it('a bound record on another tree than the verified tree makes no cut', async () => {
    const res = await decide(RUNS.boundOnAnotherTree);
    expect(res.statusCode, res.body).toBe(409);
  });
});
