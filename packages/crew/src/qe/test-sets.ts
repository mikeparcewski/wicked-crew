/**
 * Test-set registration — the produced tests of a completed `qe-author-tests` run become a durable
 * record the Test landing can show (wave 6, F-7R2-014).
 *
 * The landing (`GET /campaigns` → studio `/testing/campaigns`) used to stay "No tests yet" after a
 * completed New test: a single-repo launch registered no engine campaign (`campaignRegistered:
 * false`), no label group, and its verdicts existed nowhere the Testing UI reads. Two things fix it:
 *
 *  - the launch files the run under a LABEL GROUP (`groupLabel`, `RunGroup` on `GET /campaigns`) —
 *    the run is on the surface from the moment it launches;
 *  - at the run's TERMINAL frame this module reads the verify phase's transcript (the
 *    `QE-VERIFY` report — what was produced, what ran, what passed), and registers a {@link TestSet}:
 *    a durable `testing.testset.registered` audit entry (the daemon's system of record for run
 *    provenance, task #88) plus this read-side index, hydrated from the trail at boot like the
 *    retry/group/delivery indexes. `GET /campaigns` serves the sets as `test_sets`.
 *
 * NOT an engine campaign: `launchCampaign` schedules NODES that would RUN; a finished test set is a
 * record of tests that exist, keyed by the run that produced them — a campaign-shaped read over a
 * completed run, never a second execution.
 *
 * Deny-dominates on the wire: a run whose verify phase FAILED (a produced test failed, or was never
 * executed) is registered too, `verified: false` with the counts — the landing must show a red set
 * honestly rather than hide the run. A run that never reached its verify verdict registers with a
 * `null` report.
 */

import type { CoreAdapter } from '../core/adapter.js';
import type { Actor, AuditEntry, SessionView, WorkflowDef } from '../core/types.js';
import type { AuditLog } from '../api/audit.js';
import { coreUnitId } from '../api/evidence.js';
import { resolveRunWorkflow } from './acceptance.js';
import {
  QE_AUTHOR_TESTS_WORKFLOW,
  QE_VERIFY_PHASE_ID,
  parseQeVerifyOutput,
  type QeVerifyReport,
} from './author-workflow.js';

/** The audit action a registration writes — the durable record the index hydrates from. */
export const TEST_SET_REGISTERED_ACTION = 'testing.testset.registered';

/** The actor a daemon-side registration writes under. */
export const TEST_SET_ACTOR: Actor = { id: 'daemon', kind: 'system', trust: 'admin' };

/** A registered test set — published as `TestSet` in wicked-crew-api-types (0.36.0). */
export interface TestSet {
  /** `testset-<run id>`: one set per producing run. */
  id: string;
  run_id: string;
  workflow_id: typeof QE_AUTHOR_TESTS_WORKFLOW;
  /** The label group the launch filed the run under, when it did (`RunGroup.label`). */
  label?: string;
  repo_ref: string | null;
  repo_name?: string;
  /** Unix millis. */
  registered_at: number;
  /** The producing run's terminal status (`completed` | `failed` | `cancelled`). */
  run_status: string;
  /** The verify unit's status (`done` | `rejected` | …), `null` when the run never planned one. */
  verify_status: string | null;
  /** `true` only when the verify phase PASSED: every produced test executed and green, plan present. */
  verified: boolean;
  /** The produced test files and the harness verdict on each (empty when no report). */
  files: Array<{ path: string; harness: string; status: 'passed' | 'failed' | 'not-executed' }>;
  produced: number;
  executed: number;
  passed: number;
  failed: number;
  not_executed: number;
  /** The produced `tests/PLAN-*.md`, `null` when none was produced. */
  plan: string | null;
  /** The harnesses the produced tests ran under (unique, in first-use order). */
  harnesses: string[];
  /** The delivered PR, when the engine's deliver phase opened one. */
  deliverUrl?: string;
}

function isTestSet(v: unknown): v is TestSet {
  if (typeof v !== 'object' || v === null) return false;
  const t = v as Partial<TestSet>;
  return typeof t.id === 'string' && typeof t.run_id === 'string' && typeof t.registered_at === 'number';
}

/** Read-side index over the trail's `testing.testset.registered` entries. */
export class TestSetIndex {
  private readonly byRun = new Map<string, TestSet>();

  /** Hydrate from trail entries (newest first, as `readAll` returns them) — the first seen per run wins. */
  hydrateFromEntries(entries: AuditEntry[]): void {
    for (const entry of entries) {
      if (entry.action !== TEST_SET_REGISTERED_ACTION) continue;
      const set = entry.detail?.['testSet'];
      if (!isTestSet(set) || this.byRun.has(set.run_id)) continue;
      this.byRun.set(set.run_id, set);
    }
  }

  async hydrate(audit: AuditLog, log?: (msg: string) => void): Promise<void> {
    try {
      this.hydrateFromEntries(await audit.readAll({ action: TEST_SET_REGISTERED_ACTION }));
    } catch (err) {
      log?.(
        `[testing] test-set index hydrate failed (prior sets absent until restart): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  set(set: TestSet): void {
    this.byRun.set(set.run_id, set);
  }

  forRun(runId: string): TestSet | undefined {
    return this.byRun.get(runId);
  }

  /** Every set, newest registration first. */
  list(): TestSet[] {
    return [...this.byRun.values()].sort((a, b) => b.registered_at - a.registered_at);
  }
}

/** The label group `POST /testing/author` files a run under — `qe-tests-<repo name>` (one group per
 *  repo, so the landing shows every authoring run over a repo together), `qe-tests` when unscoped. */
export function qeTestsGroupLabel(repoName: string | null | undefined): string {
  const safe = (repoName ?? '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return safe === '' ? 'qe-tests' : `qe-tests-${safe}`;
}

export interface RegisterTestSetDeps {
  adapter: Pick<CoreAdapter, 'sessionsDetail' | 'workOutput' | 'listRepos'>;
  audit: AuditLog;
  index: TestSetIndex;
  /** The registry the run's workflow is resolved against (`adapter.listWorkflows()`). */
  workflows: () => WorkflowDef[];
  /** The delivered PR URL for a run, when one is recorded (`DeliveryIndex.urlFor`). */
  deliveryUrlFor?: (runId: string) => string | undefined;
  /** The launch-time label group, when one was filed (`GroupIndex.attachOf`). */
  labelFor?: (runId: string) => string | undefined;
  log?: (msg: string) => void;
}

/** Whether this run IS a `qe-author-tests` run (by id, or by phase sequence for an instance id). */
export function isQeAuthorRun(run: SessionView, workflows: WorkflowDef[]): boolean {
  if (typeof run.session.workflow_id !== 'string') return false;
  return resolveRunWorkflow(run, workflows)?.id === QE_AUTHOR_TESTS_WORKFLOW;
}

/** Build the record from the run view + the verify report (pure — tests drive it directly). */
export function buildTestSet(
  view: SessionView,
  report: QeVerifyReport | null,
  extra: { registeredAt: number; label?: string; repoName?: string; deliverUrl?: string },
): TestSet {
  const verify = view.units.find((u) => u.id.endsWith(`:${QE_VERIFY_PHASE_ID}`)) ?? null;
  const harnesses: string[] = [];
  for (const f of report?.files ?? []) if (!harnesses.includes(f.harness)) harnesses.push(f.harness);
  const verified =
    verify?.status === 'done' &&
    report !== null &&
    report.produced > 0 &&
    report.notExecuted === 0 &&
    report.failed === 0 &&
    report.checksFailed === 0 &&
    report.plan !== null;
  return {
    id: `testset-${view.session.id}`,
    run_id: view.session.id,
    workflow_id: QE_AUTHOR_TESTS_WORKFLOW,
    ...(extra.label !== undefined ? { label: extra.label } : {}),
    repo_ref: view.session.repo_ref,
    ...(extra.repoName !== undefined ? { repo_name: extra.repoName } : {}),
    registered_at: extra.registeredAt,
    run_status: view.session.status,
    verify_status: verify?.status ?? null,
    verified,
    files: (report?.files ?? []).map((f) => ({ path: f.path, harness: f.harness, status: f.status })),
    produced: report?.produced ?? 0,
    executed: report?.executed ?? 0,
    passed: report?.passed ?? 0,
    failed: report?.failed ?? 0,
    not_executed: report?.notExecuted ?? 0,
    plan: report?.plan ?? null,
    harnesses,
    ...(extra.deliverUrl !== undefined ? { deliverUrl: extra.deliverUrl } : {}),
  };
}

/**
 * Register the test set of a TERMINAL run when it is a `qe-author-tests` run. Idempotent per run
 * (a resume/retry re-terminal never double-writes the trail). Best-effort by construction — a
 * failure here is logged and never fails the run. Returns the set, or `null` when the run is not a
 * qe-author run (or is unknown).
 */
export async function registerTestSetForRun(deps: RegisterTestSetDeps, runId: string): Promise<TestSet | null> {
  if (deps.index.forRun(runId) !== undefined) return deps.index.forRun(runId) ?? null;
  const views = await deps.adapter.sessionsDetail();
  const view = views.find((v) => v.session.id === runId);
  if (view === undefined) return null;
  if (!isQeAuthorRun(view, deps.workflows())) return null;
  const verify = view.units.find((u) => u.id.endsWith(`:${QE_VERIFY_PHASE_ID}`));
  let report: QeVerifyReport | null = null;
  if (verify !== undefined) {
    // A rejected unit stores no work_output past a deny (deny-dominates writes none), but a verify
    // that FAILED its own script still stores its transcript when the engine kept it; either way a
    // missing transcript reads as "no report", never as a pass.
    const output = await deps.adapter.workOutput(coreUnitId(runId, verify)).catch(() => null);
    report = output === null ? null : parseQeVerifyOutput(output);
    if (report === null && typeof verify.denial_reason === 'string') {
      report = parseQeVerifyOutput(verify.denial_reason);
    }
  }
  let repoName: string | undefined;
  if (view.session.repo_ref !== null) {
    repoName = (await deps.adapter.listRepos().catch(() => []))
      .find((r) => r.id === view.session.repo_ref)?.name;
  }
  const label = deps.labelFor?.(runId);
  const deliverUrl = deps.deliveryUrlFor?.(runId);
  const set = buildTestSet(view, report, {
    registeredAt: Date.now(),
    ...(label !== undefined ? { label } : {}),
    ...(repoName !== undefined ? { repoName } : {}),
    ...(deliverUrl !== undefined ? { deliverUrl } : {}),
  });
  // Durable record first, read-side index second — the same write order as the delivery record.
  deps.audit.record(TEST_SET_REGISTERED_ACTION, TEST_SET_ACTOR, {
    runId,
    detail: { testSet: set as unknown as Record<string, unknown> },
  });
  deps.index.set(set);
  deps.log?.(
    `[testing] registered test set ${set.id}: ${set.produced} produced, ${set.executed} executed, ` +
      `${set.passed} passed, ${set.failed} failed${set.verified ? '' : ' — NOT verified'}`,
  );
  return set;
}
