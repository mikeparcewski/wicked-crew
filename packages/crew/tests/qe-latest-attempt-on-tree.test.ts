// j4-gates — at deliver, the LATEST QE attempt on the delivered tree is the one that counts, and the
// operator can skip QE acceptance at the deliver gate with a reason (labelled).
//
// Live case (rig run 29bcace4, crew 0.16.3): verify attempt 0's isolated QE reviewer recorded an
// inconclusive FAIL, then a daemon restart orphaned that attempt before its gate ran; attempt 1
// re-ran on the SAME tree and its reviewer recorded PASS. The deliver gate stayed refused: the
// orphaned attempt's window never closed and judged no tree, so its FAIL was kept, and
// deny-dominates across both QE runs let the stale FAIL outvote the later PASS. The only remedy was
// relaunching a ~10 h job with QE off.
//
//   orphaned FAIL, then PASS on the current tree          → delivers on the PASS;
//   FAIL then PASS, both attempts judged the current tree → delivers on the PASS (latest counts);
//   PASS then FAIL on the current tree                    → refused (a current-tree FAIL denies);
//   a FAIL and a PASS inside the latest attempt           → refused (deny-dominates within it);
//   `skip_qe` with a reason at the deliver gate           → delivers, its check says "skipped".
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
import { qeAttemptsFromEvents } from '../src/qe/acceptance.js';
import { removeScratch } from './setup/scratch.js';

const DELIVER_ORD = 3;
const QE_ORD = 2;
const T0 = Date.parse('2026-10-26T07:20:00.000Z');
const TREE_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const REQUIRED = {
  status: 'required', basis: 'diff', score: 50, threshold: 20, ord: QE_ORD, tree: TREE_B,
  reason: 'required: impact score 50 above the waiver line 20', reasons: [],
};

const RUNS = {
  orphanedFailThenPass: 'run-j4-orphaned',
  failThenPassSameTree: 'run-j4-same-tree',
  passThenFail: 'run-j4-pass-then-fail',
  failAndPassInLatest: 'run-j4-both-latest',
  skipAtDeliver: 'run-j4-skip',
  olderStampCarriesNewerFail: 'run-j4-stamp-carries',
  foreignVerdictSetsNoCutoff: 'run-j4-foreign',
  unboundReviewLedgerPass: 'run-1153-unbound',
};

let dir: string;
let app: FastifyInstance;
const audit = { record: vi.fn(() => Date.now()), readAll: vi.fn(async () => []) } as unknown as AuditLog;
const gateCache = new GateCache();
const confirmCalls: unknown[][] = [];
const evidenceOf = (id: string) => join(dir, 'walkthroughs', id);

/** Attempt 0 orphaned (no gate) — the 29bcace4 shape; attempt 1 judged tree B. */
const orphaned = (id: string) => [
  { type: 'sessionStarted', session: id, ts: T0, seq: 1 },
  { type: 'qeAcceptanceDecided', session: id, ord: QE_ORD, ts: T0 + 10, seq: 2 },
  { type: 'unitDispatched', session: id, ord: QE_ORD, attempt: 0, ts: T0 + 100, seq: 3 },
  { type: 'runOrphaned', session: id, ts: T0 + 250, seq: 4 },
  { type: 'unitDispatched', session: id, ord: QE_ORD, attempt: 1, ts: T0 + 300, seq: 5 },
  { type: 'gateEvaluated', session: id, ord: QE_ORD, assurance: { attempt: 1, tree: TREE_B }, ts: T0 + 400, seq: 6 },
];
/** Both attempts judged tree B (a same-tree re-run). */
const judgedTwice = (id: string) => [
  { type: 'sessionStarted', session: id, ts: T0, seq: 1 },
  { type: 'qeAcceptanceDecided', session: id, ord: QE_ORD, ts: T0 + 10, seq: 2 },
  { type: 'unitDispatched', session: id, ord: QE_ORD, attempt: 0, ts: T0 + 100, seq: 3 },
  { type: 'gateEvaluated', session: id, ord: QE_ORD, assurance: { attempt: 0, tree: TREE_B }, ts: T0 + 200, seq: 4 },
  { type: 'unitDispatched', session: id, ord: QE_ORD, attempt: 1, ts: T0 + 300, seq: 5 },
  { type: 'gateEvaluated', session: id, ord: QE_ORD, assurance: { attempt: 1, tree: TREE_B }, ts: T0 + 400, seq: 6 },
];
const eventsOf = (id: string) => (id === RUNS.orphanedFailThenPass ? orphaned(id) : judgedTwice(id));

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
      verified_tree: TREE_B, archived_at: null, archive_note: null,
      assurance: { mode: 'full', required: ['distinct_evaluator', 'judge', 'qe_acceptance'], qe: REQUIRED },
    },
    units: [
      unit(1, 'fix', 'done'),
      {
        ...unit(QE_ORD, 'verify', 'done'),
        qe_acceptance: REQUIRED,
        // The engine's isolated review record (wicked-core#1153): a PASS, except on the run whose
        // reviewer's verdict could not be bound.
        qe_review: id === RUNS.unboundReviewLedgerPass
          ? { outcome: 'invalid', reason: "the reviewer's verdict could not be bound: the reviewer recorded no verdict", tree: TREE_B, verdict: null }
          : { outcome: 'pass', reason: 'bound PASS', tree: TREE_B, verdict: 'PASS' },
      },
      unit(DELIVER_ORD, 'deliver', 'pending'),
    ],
  };
}

/** One QE run + its verdict, as canonical JSON (what wicked-ledger writes), stamped with the crew run. */
function verdictAt(runId: string, n: number, verdict: 'PASS' | 'FAIL', at: number) {
  const root = join(evidenceOf(runId), '.wicked-qe');
  mkdirSync(join(root, 'runs'), { recursive: true });
  mkdirSync(join(root, 'verdicts'), { recursive: true });
  const iso = new Date(at).toISOString();
  const qeRun = `qe-${runId}-${n}`;
  writeFileSync(join(root, 'runs', `${qeRun}.json`), JSON.stringify({ id: qeRun, created_at: iso, started_at: iso, status: verdict === 'PASS' ? 'passed' : 'failed', crew_run_id: runId }));
  writeFileSync(join(root, 'verdicts', `v-${runId}-${n}.json`), JSON.stringify({ id: `v-${runId}-${n}`, created_at: iso, run_id: qeRun, verdict, reviewer: 'qe-reviewer', reason: verdict === 'FAIL' ? `FAIL #${n}` : null, crew_run_id: runId }));
}

/** A QE run + one verdict with every linkage field chosen (codex r1 on #1152). */
function rawVerdict(
  ledgerOf: string,
  qeRun: string,
  vid: string,
  verdict: 'PASS' | 'FAIL',
  at: number,
  opts: { verdictStamp?: string; runStamp?: string; runStartedAt?: number },
) {
  const root = join(evidenceOf(ledgerOf), '.wicked-qe');
  mkdirSync(join(root, 'runs'), { recursive: true });
  mkdirSync(join(root, 'verdicts'), { recursive: true });
  const started = new Date(opts.runStartedAt ?? at).toISOString();
  writeFileSync(join(root, 'runs', `${qeRun}.json`), JSON.stringify({ id: qeRun, created_at: started, started_at: started, status: 'failed', ...(opts.runStamp !== undefined ? { crew_run_id: opts.runStamp } : {}) }));
  writeFileSync(join(root, 'verdicts', `${vid}.json`), JSON.stringify({ id: vid, created_at: new Date(at).toISOString(), run_id: qeRun, verdict, reviewer: 'qe-reviewer', reason: verdict === 'FAIL' ? `FAIL ${vid}` : null, ...(opts.verdictStamp !== undefined ? { crew_run_id: opts.verdictStamp } : {}) }));
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-qe-latest-'));
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
  // (studio#923) A request may name its actor (`x-test-actor: kind/trust`), as an authenticated
  // principal would be: a seat's token is an `agent`, a standing order is `system`.
  app.addHook('onRequest', async (req) => {
    const named = req.headers['x-test-actor'];
    if (typeof named === 'string') {
      const [kind, trust] = named.split('/');
      (req as unknown as { actor: unknown }).actor = { id: `test-${kind}`, kind, trust };
    }
  });
  registerRoutes(app, mockAdapter as unknown as CoreAdapter, gateCache, new ElicitationCache(), undefined, { audit, authMode: 'off' }, {
    worktreeExists: () => true,
    deliverExec: async () => ({ status: 0, output: '' }),
  });
  await app.ready();
  verdictAt(RUNS.orphanedFailThenPass, 1, 'FAIL', T0 + 150);
  verdictAt(RUNS.orphanedFailThenPass, 2, 'PASS', T0 + 350);
  verdictAt(RUNS.failThenPassSameTree, 1, 'FAIL', T0 + 150);
  verdictAt(RUNS.failThenPassSameTree, 2, 'PASS', T0 + 350);
  verdictAt(RUNS.passThenFail, 1, 'PASS', T0 + 150);
  verdictAt(RUNS.passThenFail, 2, 'FAIL', T0 + 350);
  verdictAt(RUNS.failAndPassInLatest, 1, 'FAIL', T0 + 320);
  verdictAt(RUNS.failAndPassInLatest, 2, 'PASS', T0 + 350);
  verdictAt(RUNS.skipAtDeliver, 1, 'FAIL', T0 + 350);
  // A PASS in the ledger (the executor's own) while the isolated reviewer bound nothing.
  verdictAt(RUNS.unboundReviewLedgerPass, 1, 'PASS', T0 + 350);
  // QE run X is this run's only through an OLDER stamped verdict (its run row predates the crew run
  // and is unstamped); its newer FAIL inside the latest attempt is unstamped. QE run Y passes there.
  {
    const id = RUNS.olderStampCarriesNewerFail;
    rawVerdict(id, 'qe-x', 'vx-1', 'PASS', T0 + 150, { verdictStamp: id, runStartedAt: T0 - 1000 });
    rawVerdict(id, 'qe-x', 'vx-2', 'FAIL', T0 + 350, { runStartedAt: T0 - 1000 });
    rawVerdict(id, 'qe-y', 'vy-1', 'PASS', T0 + 360, { verdictStamp: id, runStamp: id });
  }
  // This run: a FAIL in attempt 0, no verdict of its own in attempt 1, a PASS after every gate.
  // Another crew run's verdict sits inside attempt 1: it must not become the cutoff.
  {
    const id = RUNS.foreignVerdictSetsNoCutoff;
    rawVerdict(id, 'qe-own-1', 'vo-1', 'FAIL', T0 + 150, { verdictStamp: id, runStamp: id });
    rawVerdict(id, 'qe-own-2', 'vo-2', 'PASS', T0 + 500, { verdictStamp: id, runStamp: id });
    rawVerdict(id, 'qe-foreign', 'vf-1', 'PASS', T0 + 350, { verdictStamp: 'another-run', runStamp: 'another-run', runStartedAt: T0 - 1000 });
  }
});

beforeEach(() => {
  confirmCalls.length = 0;
  (audit.record as ReturnType<typeof vi.fn>).mockClear();
  for (const id of Object.values(RUNS)) {
    gateCache.adopt(id, { ord: DELIVER_ORD, prompt: 'Approve deliver?', lifecycle: 'open', receivedAt: '2026-10-26T08:20:00Z' });
  }
});

afterAll(async () => {
  await app.close();
  removeScratch(dir);
});

const decide = (id: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: `/api/v1/runs/${id}/gate`, payload: { approve: true, ord: DELIVER_ORD, ...payload } });

describe('j4-gates — the latest QE attempt on the delivered tree counts', () => {
  it('an orphaned QE attempt (no gate) ends where the next dispatch begins', () => {
    expect(qeAttemptsFromEvents(orphaned('x') as never)).toEqual([
      { start: T0 + 100, end: T0 + 300, tree: null },
      { start: T0 + 300, end: T0 + 400, tree: TREE_B },
    ]);
  });

  it('a restart-orphaned FAIL does not outvote the later PASS on the same tree (rig 29bcace4)', async () => {
    const res = await decide(RUNS.orphanedFailThenPass);
    expect(res.statusCode, res.body).toBe(200);
    const check = res.json().delivery.qeAcceptance;
    expect(check).toMatchObject({ status: 'required', satisfied: true });
    expect(check.reason).toMatch(/^PASS/);
    expect(check.reason).toContain('1 earlier verdict on this tree, recorded before its latest QE attempt, no longer counts');
    expect(confirmCalls).toHaveLength(1);
  });

  it('FAIL then PASS, both judging the current tree: the latest attempt counts', async () => {
    const res = await decide(RUNS.failThenPassSameTree);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().delivery.qeAcceptance.reason).toMatch(/^PASS/);
  });

  it('a FAIL in the latest attempt on the current tree still refuses', async () => {
    const res = await decide(RUNS.passThenFail);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().acceptance.reason).toMatch(/^FAIL/);
    expect(confirmCalls).toEqual([]);
  });

  it('deny-dominates still holds inside the latest attempt', async () => {
    const res = await decide(RUNS.failAndPassInLatest);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().acceptance.reason).toMatch(/^FAIL/);
    expect(confirmCalls).toEqual([]);
  });
});

describe('j4-gates — the cutoff never weakens attribution (codex r1 on #1152)', () => {
  it('a QE run tied to this run by an older stamped verdict still denies with its newer FAIL', async () => {
    const res = await decide(RUNS.olderStampCarriesNewerFail);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().acceptance.reason).toMatch(/^FAIL/);
    expect(confirmCalls).toEqual([]);
  });

  it("another run's verdict inside an attempt never supersedes this run's FAIL", async () => {
    const res = await decide(RUNS.foreignVerdictSetsNoCutoff);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().acceptance.reason).toMatch(/^FAIL/);
    expect(confirmCalls).toEqual([]);
  });
});

describe('j4-gates — skip QE acceptance at the deliver gate, with a reason', () => {
  it('a skip with a reason delivers without the PASS, and its check says so', async () => {
    const res = await decide(RUNS.skipAtDeliver, { action: 'skip_qe', amend: 'the sandbox probe cannot run on Linux seats; verified on macOS' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().delivery.qeAcceptance).toEqual({
      status: 'skipped',
      satisfied: true,
      reason: 'QE acceptance skipped by operator: the sandbox probe cannot run on Linux seats; verified on macOS',
      verdictId: null,
      reviewer: null,
    });
    expect(confirmCalls).toHaveLength(1);
    expect(confirmCalls[0]!.slice(1, 4)).toEqual([true, 'the sandbox probe cannot run on Linux seats; verified on macOS', 'skip_qe']);
  });

  it('a skip without a reason is a 400, and without the skip the FAIL still refuses', async () => {
    const blank = await decide(RUNS.skipAtDeliver, { action: 'skip_qe', amend: '  ' });
    expect(blank.statusCode).toBe(400);
    const none = await decide(RUNS.skipAtDeliver, { action: 'skip_qe' });
    expect(none.statusCode).toBe(400);
    const plain = await decide(RUNS.skipAtDeliver);
    expect(plain.statusCode, plain.body).toBe(409);
    expect(confirmCalls).toEqual([]);
  });
});

describe('studio#923 — the QE-refused deliver gate offers the skip in place, to a human operator only', () => {
  const gate = (id: string) => app.inject({ method: 'GET', url: `/api/v1/runs/${id}/gate` });
  const audited = (action: string) =>
    (audit.record as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === action);

  it('GET /gate on a QE-refused deliver gate carries the skipQe offer with its stable key', async () => {
    const res = await gate(RUNS.skipAtDeliver);
    expect(res.statusCode, res.body).toBe(200);
    const offer = res.json().skipQe;
    expect(offer).toMatchObject({
      action: 'skip_qe',
      reasonRequired: true,
      actor: 'human_operator',
      label: 'QE acceptance skipped by operator',
      qeAcceptance: { status: 'required', satisfied: false },
    });
    expect(offer.qeAcceptance.reason).toMatch(/^FAIL/);
  });

  it('a deliver gate whose QE passed offers no skip', async () => {
    const res = await gate(RUNS.failThenPassSameTree);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().skipQe).toBeUndefined();
  });

  it('a seat (agent) or a standing order (system) is refused 403 and audited; nothing is confirmed', async () => {
    for (const actor of ['agent/operator', 'system/operator', 'human/observer']) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/runs/${RUNS.skipAtDeliver}/gate`,
        headers: { 'x-test-actor': actor },
        payload: { approve: true, ord: DELIVER_ORD, action: 'skip_qe', amend: 'skip it' },
      });
      expect(res.statusCode, `${actor}: ${res.body}`).toBe(403);
      expect(res.json().code).toBe('human_operator_only');
    }
    expect(confirmCalls).toEqual([]);
    expect(audited('gate.skip_qe_refused')).toHaveLength(3);
    expect(audited('gate.qe_skipped')).toHaveLength(0);
  });

  it("the human operator's skip is confirmed on this gate and audited with the reason", async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${RUNS.skipAtDeliver}/gate`,
      headers: { 'x-test-actor': 'human/operator' },
      payload: { approve: true, ord: DELIVER_ORD, action: 'skip_qe', amend: 'seats could not run vitest; checked by hand' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(confirmCalls).toHaveLength(1);
    expect(confirmCalls[0]!.slice(1, 4)).toEqual([true, 'seats could not run vitest; checked by hand', 'skip_qe']);
    const skipped = audited('gate.qe_skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]![1]).toMatchObject({ kind: 'human', trust: 'operator' });
    expect(skipped[0]![2]).toMatchObject({ runId: RUNS.skipAtDeliver, detail: { reason: 'seats could not run vitest; checked by hand', ord: DELIVER_ORD } });
  });
});

describe('wicked-core#1153 — a ledger PASS counts only beside the engine-bound review', () => {
  it('refuses delivery when the isolated review bound no verdict, and offers the skip in place', async () => {
    const res = await decide(RUNS.unboundReviewLedgerPass);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().acceptance.reason).toContain('the isolated QE review did not bind a PASS (invalid');
    expect(confirmCalls).toEqual([]);
    const gate = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUNS.unboundReviewLedgerPass}/gate` });
    expect(gate.json().skipQe?.action).toBe('skip_qe');
    const skip = await decide(RUNS.unboundReviewLedgerPass, { action: 'skip_qe', amend: 'reviewed by hand' });
    expect(skip.statusCode, skip.body).toBe(200);
  });
});
