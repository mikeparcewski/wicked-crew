/**
 * The run→delivered-PR index (CREW-UX-8, crew#321).
 *
 * `LaunchRunBody.deliver?: 'pr'` is input-only; the deliver phase computes the PR URL
 * (`core/deliver.ts` — re-derived from the remote, refused without one) and prints it as the
 * unit's last output line, which is console text, not a wire. This index is the read-side
 * latency layer that lets the run DTOs echo `session.delivery` on BOTH `GET /runs` and
 * `GET /runs/:id` without a `workOutput` read per request — the persisted field that makes a
 * list surface's "4 of 5 siblings delivered" rollup affordable without an N-fetch fan-out
 * (wicked-studio#27).
 *
 * Mirrors `RetryIndex`/`GuidanceIndex`'s posture exactly: the DURABLE record is the audit
 * trail (the engine run record has no such field) — action `run.delivered`, `detail.url` —
 * hydrated once at server start (best-effort: a missing or unreadable trail leaves deliveries
 * blank, the pre-#321 behavior, not an error) and updated at the same post-terminal point
 * that writes the audit entry.
 *
 * KNOWN LIMIT (stated in the contract too): runs that delivered before this landed have no
 * `run.delivered` entry and carry no field. Do NOT backfill by scanning `work_output` at
 * hydrate — that is an unbounded boot cost. Historical runs still resolve their URL through
 * the per-run output endpoint.
 */

import type { AuditLog } from './audit.js';
import type { AgentSession, SessionView, WorkUnit } from '../core/types.js';
import { execCapped } from '../core/exec.js';

/** What `AgentSession.delivery` + `deliverUrl` spell on the wire (api-types 0.18.0, crew#393). */
export interface DeliveryState {
  delivery: 'delivered' | 'stranded' | 'vacuous' | 'none';
  /** Present exactly when `delivery === 'delivered'`. */
  deliverUrl?: string;
}

/**
 * The tri-state delivery derivation (crew#393) — HONEST by construction, computed at DTO
 * assembly from three facts and nothing else:
 *
 *   1. a recorded PR URL (the `run.delivered` trail via {@link DeliveryIndex}) ⇒ `'delivered'`;
 *   2. otherwise a COMPLETED repo-scoped run whose worktree still exists on disk ⇒ `'stranded'`
 *      — reviewable work nobody lifted into a PR. This is a derivation over the run record's
 *      existing fields (`status`, `repo_ref`, `workdir`) plus one stat, so runs recorded BEFORE
 *      this field existed (the run 83052f0b class) read `'stranded'` exactly like new ones;
 *   3. everything else ⇒ `'none'`: repo-less runs, non-terminal runs, failed/cancelled runs
 *      (their unit rejection already spells the failure), and completed runs whose worktree
 *      was cleaned up (nothing left to lift).
 *
 * `worktreeExists` is injected (a `fs.existsSync` in production) so route tests can pin the
 * derivation without staging real directories.
 */
export function deliveryStateOf(
  session: Pick<AgentSession, 'status' | 'repo_ref' | 'workdir'>,
  url: string | undefined,
  worktreeExists: (path: string) => boolean,
): DeliveryState {
  if (url !== undefined) return { delivery: 'delivered', deliverUrl: url };
  if (
    session.status === 'completed' &&
    session.repo_ref != null &&
    typeof session.workdir === 'string' &&
    session.workdir !== '' &&
    worktreeExists(session.workdir)
  ) {
    return { delivery: 'stranded' };
  }
  return { delivery: 'none' };
}

/** The probes behind the `'vacuous'` derivation (crew#311) — injected so route tests can pin the
 *  derivation without staging real repos; production wires the memoized git probes below. */
export interface VacuityProbes {
  /** One stat — the `'stranded'` gate (crew#393; `fs.existsSync` in production). */
  worktreeExists: (path: string) => boolean;
  /** True ⇔ the worktree POSITIVELY carries no contribution (both git instruments empty). */
  worktreeIsClean: (path: string) => Promise<boolean>;
  /** True ⇔ the run's `wicked/<runId>` branch in the repo `repoRef` names POSITIVELY carries no
   *  commits of its own (or no longer exists) — the reaped-worktree half of vacuity. */
  runBranchIsEmpty: (repoRef: string, runId: string) => Promise<boolean>;
}

/**
 * The delivery derivation WITH the vacuity split (crew#311) — the async refinement over
 * {@link deliveryStateOf} the run DTOs actually use.
 *
 * The crew#311 class — units all reach `done` while producing NOTHING (three governed builds
 * folded "done" on 280–509 bytes of read-narration over a worktree clean at main's HEAD) — used
 * to be indistinguishable on the wire from real outcomes, in BOTH of its shapes:
 *
 *   - worktree still on disk and clean ⇒ it read `'stranded'`, pointing the operator at a
 *     post-hoc deliver that must refuse (there is nothing to lift);
 *   - worktree already REAPED ⇒ it read `'none'`, silently green. This is the shape a vacuous
 *     completion normally lands in: the engine's terminal reap (FINDING-003,
 *     `reap_worktree_if_clean`) removes exactly the clean trees, and never touches the
 *     `wicked/<runId>` branch — so "reaped tree + empty run branch" is PROOF the run left no
 *     work anywhere, while "reaped tree + commits on the branch" is landed work and stays
 *     `'none'` (nothing left in a worktree to lift).
 *
 * Both shapes now read `'vacuous'`, and only on POSITIVE reads: every probe fails toward the
 * pre-existing label (`'stranded'` / `'none'`), so a non-git directory, a missing repo record,
 * a deleted repo, or a git failure reads exactly as it did before this existed. (One honest
 * edge: an operator who hand-deleted a completed run's branch has made its work unreachable —
 * it reads vacuous, which is what the run now amounts to.)
 */
export async function deliveryStateWithVacuity(
  session: Pick<AgentSession, 'id' | 'status' | 'repo_ref' | 'workdir'>,
  url: string | undefined,
  probes: VacuityProbes,
): Promise<DeliveryState> {
  const state = deliveryStateOf(session, url, probes.worktreeExists);
  if (state.delivery === 'stranded') {
    // `deliveryStateOf` only answers 'stranded' after proving workdir is a non-empty string.
    return (await probes.worktreeIsClean(session.workdir as string))
      ? { delivery: 'vacuous' }
      : state;
  }
  if (
    state.delivery === 'none' &&
    session.status === 'completed' &&
    session.repo_ref != null &&
    (await probes.runBranchIsEmpty(session.repo_ref, session.id))
  ) {
    return { delivery: 'vacuous' };
  }
  return state;
}

/** How long a per-worktree cleanliness read is trusted before the next request re-probes. A
 *  terminal run's worktree only changes under operator hands, and `GET /runs` is polled — an
 *  unmemoized probe would be two git subprocesses per stranded run per poll. */
export const WORKTREE_CLEAN_TTL_MS = 30_000;

/**
 * The production `worktreeIsClean` probe: the SAME two read-only instruments as the engine's
 * `worktree_is_clean` — uncommitted paths (`git status --porcelain`, untracked included) and
 * run-branch-only commits (`git log --oneline HEAD --not --exclude=wicked/* --branches`) —
 * memoized per worktree path for {@link WORKTREE_CLEAN_TTL_MS}.
 *
 * Fails toward NOT-clean (see {@link deliveryStateWithVacuity} — a failure must keep the
 * pre-existing 'stranded' label, never invent 'vacuous'), and failures obey the TTL too, so a
 * transient git error doesn't pin a run's label until restart.
 */
export function gitWorktreeIsClean(
  ttlMs: number = WORKTREE_CLEAN_TTL_MS,
  now: () => number = Date.now,
): (path: string) => Promise<boolean> {
  const memo = new Map<string, { at: number; clean: boolean }>();
  const probe = async (path: string): Promise<boolean> => {
    const gitEmpty = async (args: string[]): Promise<boolean> => {
      // Read-only git plumbing over the run's own worktree; argv array, never a shell string.
      const { stdout } = await execCapped('git', args, {
        cwd: path,
        timeout: 10_000,
        windowsHide: true,
      });
      return stdout.trim() === '';
    };
    try {
      return (
        (await gitEmpty(['status', '--porcelain'])) &&
        (await gitEmpty(['log', '--oneline', 'HEAD', '--not', '--exclude=wicked/*', '--branches']))
      );
    } catch {
      return false;
    }
  };
  return async (path: string): Promise<boolean> => {
    const hit = memo.get(path);
    if (hit !== undefined && now() - hit.at < ttlMs) return hit.clean;
    const clean = await probe(path);
    memo.set(path, { at: now(), clean });
    return clean;
  };
}

/**
 * The production `runBranchIsEmpty` probe — the reaped-worktree half of vacuity (crew#311).
 *
 * TRUE only on positive proof that the run left nothing on its branch: either
 * `refs/heads/wicked/<runId>` no longer exists in the run's repo, or it exists and
 * `git log <branch> --not --exclude=wicked/* --branches` is empty (the branch carries no commit
 * of its own — the exact second instrument of the engine's `worktree_is_clean`, aimed at the
 * branch instead of a checkout). An unresolvable repo, a git failure, or any commit on the
 * branch reads FALSE — the label falls back to `'none'`, never inventing vacuity.
 *
 * `resolveRepoRoot` is injected (routes wire it to the adapter's repo registry) and its answer
 * rides the same TTL memo as the verdict, so a `GET /runs` poll costs at most one registry read
 * + one git pair per run per window.
 */
export function gitRunBranchIsEmpty(
  resolveRepoRoot: (repoRef: string) => Promise<string | undefined>,
  ttlMs: number = WORKTREE_CLEAN_TTL_MS,
  now: () => number = Date.now,
): (repoRef: string, runId: string) => Promise<boolean> {
  const memo = new Map<string, { at: number; empty: boolean }>();
  const probe = async (repoRef: string, runId: string): Promise<boolean> => {
    let root: string | undefined;
    try {
      root = await resolveRepoRoot(repoRef);
    } catch {
      root = undefined; // registry read failed — fall toward 'none', never invent vacuity
    }
    if (root === undefined) return false;
    const branch = `refs/heads/wicked/${runId}`;
    const gitOut = (args: string[]) =>
      // Read-only git plumbing over the registered repo root; argv array, never a shell string.
      execCapped('git', args, { cwd: root, timeout: 10_000, windowsHide: true });
    try {
      await gitOut(['rev-parse', '--verify', '--quiet', branch]);
    } catch (err) {
      // `--verify --quiet` on a missing ref is a CLEAN exit 1 — the one verifiable "branch
      // gone". Anything else (git unspawnable, deleted root ⇒ ENOENT, a 128 "not a git
      // repository", a timeout kill) is an infra failure and must never invent vacuity.
      return (err as { code?: unknown }).code === 1;
    }
    try {
      const { stdout } = await gitOut([
        'log',
        '--oneline',
        branch,
        '--not',
        '--exclude=wicked/*',
        '--branches',
      ]);
      return stdout.trim() === '';
    } catch {
      return false;
    }
  };
  return async (repoRef: string, runId: string): Promise<boolean> => {
    const key = `${repoRef} ${runId}`;
    const hit = memo.get(key);
    if (hit !== undefined && now() - hit.at < ttlMs) return hit.empty;
    const empty = await probe(repoRef, runId);
    memo.set(key, { at: now(), empty });
    return empty;
  };
}

/**
 * The PR URL in a deliver transcript — crew's own extraction, mirrored
 * (`core/deliver.ts`: `grep -Eo 'https://[^[:space:]]+/pull/[0-9]+' | tail -1`). Requiring
 * the digits keeps `…/pull/new/<branch>` — the create-PR form git prints on every push —
 * from ever matching; the LAST match wins, same as `tail -1`.
 */
export function prUrlFrom(text: string): string | null {
  const matches = text.match(/https:\/\/\S+\/pull\/\d+/g);
  return matches === null ? null : (matches[matches.length - 1] ?? null);
}

/**
 * This run's deliver unit, or `null`. The composed id suffix (`<base>:deliver`) is the
 * primary key; the `tool_cmd` probe is the fallback for an operator OVERLAY that carried the
 * deliver phase under its own name — do NOT key on `workflow_id`, which is plain for
 * overlay-carried deliver phases (crew#321).
 */
export function deliverUnitOf(view: SessionView): WorkUnit | null {
  const byId = view.units.find((u) => u.id.endsWith(':deliver'));
  if (byId !== undefined) return byId;
  return view.units.find((u) => (u.tool_cmd ?? []).join(' ').includes('gh pr create')) ?? null;
}

export class DeliveryIndex {
  private readonly runToUrl = new Map<string, string>();

  /**
   * Load deliveries from EVERY `run.delivered` entry in the trail — exhaustively, not capped
   * (BRIEF-UX-002 C5, the same defect class as `RetryIndex.hydrate`: a durable record must
   * not vanish because 1000+ newer writes landed on top of it). The trail answers newest
   * first, so the FIRST entry seen per run wins; older entries for the same run are
   * superseded and skipped. Still best-effort, like its siblings; cost is one full-file scan
   * at boot. (Third exhaustive trail scan at boot, after RetryIndex and GuidanceIndex — a
   * FOURTH should trigger consolidating them into one pass, per crew#321.)
   */
  async hydrate(audit: AuditLog, log?: (msg: string) => void): Promise<void> {
    try {
      const seen = new Set<string>();
      for (const entry of await audit.readAll({ action: 'run.delivered' })) {
        if (typeof entry.runId !== 'string') continue;
        if (seen.has(entry.runId)) continue;
        // Newest entry decides, even when malformed — marking the run seen BEFORE the url
        // check keeps a corrupt newest write from resurrecting an older one (the #312 rule).
        seen.add(entry.runId);
        const url = entry.detail?.['url'];
        if (typeof url !== 'string' || url === '') continue;
        this.runToUrl.set(entry.runId, url);
      }
    } catch (err) {
      log?.(
        `[runs] delivery-index hydrate failed (prior runs read as undelivered until restart): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Record the run's delivered PR URL (idempotent — the newest write wins). */
  set(runId: string, url: string): void {
    this.runToUrl.set(runId, url);
  }

  /**
   * The recorded PR URL for this run, or `undefined` — the fact {@link deliveryStateOf} turns
   * into the wire's `delivery: 'delivered'` + `deliverUrl` (api-types 0.18.0; the 0.11.0 object
   * spelling `{ kind: 'pull_request', url }` is gone from the wire, crew#393).
   */
  urlFor(runId: string): string | undefined {
    return this.runToUrl.get(runId);
  }
}
