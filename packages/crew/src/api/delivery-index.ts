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
import { DELIVER_LIFT_CONFLICT_MARKER } from '../core/deliver.js';

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
 *  derivation without staging real repos; production wires the memoized git probes below.
 *
 *  FAILURE CONTRACT (PR #435 review): a production git probe THROWS
 *  {@link VacuityProbeUnavailable} when git could not answer — spawn failure, timeout, a
 *  worktree or repo racing teardown, a non-git directory. That is the ABSENCE of an answer, not
 *  a verdict, and the caller owns the degrade: the delivery cache retries WITHOUT recording
 *  (never caching a failed probe as an honest label), and the campaigns rollup serves that one
 *  request the stat-only tri-state. Injected test probes return plain booleans. */
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
 * Thrown by the production probes when git COULD NOT ANSWER — infrastructure absence, not a
 * verdict. The old behavior folded this into `false` ("not clean" / "not empty"), which was
 * safe while every consumer re-probed within a TTL, but the delivery cache records derivations:
 * caching a raced probe's `false` pinned a WRONG 'stranded' on a vacuous run (forever, where no
 * sweep ticks). Distinguishing absence from verdict at the probe layer is what lets the cache
 * refuse to record it.
 */
export class VacuityProbeUnavailable extends Error {
  constructor(what: string, cause: unknown) {
    super(`${what}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'VacuityProbeUnavailable';
  }
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
 * Both shapes now read `'vacuous'`, and only on POSITIVE reads. A missing repo RECORD still
 * reads `false` from the branch probe (a permanent state — the label honestly falls back to
 * `'none'`), but a git failure now PROPAGATES as {@link VacuityProbeUnavailable} instead of
 * silently keeping the pre-existing label: the caller owns the degrade (see the failure
 * contract on {@link VacuityProbes}). (One honest edge: an operator who hand-deleted a
 * completed run's branch has made its work unreachable — it reads vacuous, which is what the
 * run now amounts to.)
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

/** How long a FAILED probe ({@link VacuityProbeUnavailable}) is memoized before a real
 *  re-probe. Deliberately short: a failure is usually a raced teardown or a load spike, and
 *  the delivery cache's retry needs a genuine re-probe in ~a second — but a request-path
 *  consumer (the campaigns rollup) polling over a persistently broken repo must not spawn two
 *  10s-timeout gits per poll tick either. */
export const PROBE_FAILURE_TTL_MS = 1_000;

type ProbeMemo<T> = { at: number; value: T } | { at: number; err: VacuityProbeUnavailable };

/** The shared memo shape for both probes: verdicts live for `ttlMs`, failures for
 *  {@link PROBE_FAILURE_TTL_MS} (re-thrown, not re-spawned, within that window). */
function memoized<T>(
  probe: (key: string) => Promise<T>,
  ttlMs: number,
  now: () => number,
): (key: string) => Promise<T> {
  const memo = new Map<string, ProbeMemo<T>>();
  return async (key: string): Promise<T> => {
    const hit = memo.get(key);
    if (hit !== undefined && now() - hit.at < ('err' in hit ? PROBE_FAILURE_TTL_MS : ttlMs)) {
      if ('err' in hit) throw hit.err;
      return hit.value;
    }
    try {
      const value = await probe(key);
      memo.set(key, { at: now(), value });
      return value;
    } catch (err) {
      const e =
        err instanceof VacuityProbeUnavailable
          ? err
          : new VacuityProbeUnavailable('vacuity probe failed', err);
      memo.set(key, { at: now(), err: e });
      throw e;
    }
  };
}

/**
 * The production `worktreeIsClean` probe: the SAME two read-only instruments as the engine's
 * `worktree_is_clean` — uncommitted paths (`git status --porcelain`, untracked included) and
 * run-branch-only commits (`git log --oneline HEAD --not --exclude=wicked/* --branches`) —
 * memoized per worktree path for {@link WORKTREE_CLEAN_TTL_MS}.
 *
 * A verdict comes only from git ANSWERING: exit 0 with empty/non-empty output. Any failure —
 * git unspawnable, a timeout kill, a 128 "not a git repository", ENOENT from a worktree racing
 * the terminal reap — throws {@link VacuityProbeUnavailable} (memoized for
 * {@link PROBE_FAILURE_TTL_MS}) so no consumer can mistake absence for "not clean" and pin a
 * wrong 'stranded' (PR #435 review). Callers degrade per the {@link VacuityProbes} contract.
 */
export function gitWorktreeIsClean(
  ttlMs: number = WORKTREE_CLEAN_TTL_MS,
  now: () => number = Date.now,
): (path: string) => Promise<boolean> {
  const probe = async (path: string): Promise<boolean> => {
    const gitEmpty = async (args: string[]): Promise<boolean> => {
      try {
        // Read-only git plumbing over the run's own worktree; argv array, never a shell string.
        // GIT_OPTIONAL_LOCKS=0 (git ≥2.15): `git status` otherwise takes index.lock
        // opportunistically to write back a refreshed index — a background probe must never
        // hold a lock a concurrent deliver's `git add`/`git commit` can collide with.
        const { stdout } = await execCapped('git', args, {
          cwd: path,
          timeout: 10_000,
          windowsHide: true,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        });
        return stdout.trim() === '';
      } catch (err) {
        throw new VacuityProbeUnavailable(`git ${args[0] ?? ''} could not answer over ${path}`, err);
      }
    };
    return (
      (await gitEmpty(['status', '--porcelain'])) &&
      (await gitEmpty(['log', '--oneline', 'HEAD', '--not', '--exclude=wicked/*', '--branches']))
    );
  };
  return memoized(probe, ttlMs, now);
}

/**
 * The production `runBranchIsEmpty` probe — the reaped-worktree half of vacuity (crew#311).
 *
 * TRUE only on positive proof that the run left nothing on its branch: either
 * `refs/heads/wicked/<runId>` no longer exists in the run's repo, or it exists and
 * `git log <branch> --not --exclude=wicked/* --branches` is empty (the branch carries no commit
 * of its own — the exact second instrument of the engine's `worktree_is_clean`, aimed at the
 * branch instead of a checkout). A repo the registry no longer RESOLVES reads FALSE — a
 * permanent state, the label honestly falls back to `'none'` — while a git failure or a
 * registry read failure throws {@link VacuityProbeUnavailable} (absence of an answer, PR #435
 * review), memoized for {@link PROBE_FAILURE_TTL_MS}; callers degrade per the
 * {@link VacuityProbes} contract.
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
  const probe = async (key: string): Promise<boolean> => {
    const [repoRef, runId] = key.split('\0') as [string, string];
    let root: string | undefined;
    try {
      root = await resolveRepoRoot(repoRef);
    } catch (err) {
      // A registry READ failure is transient infrastructure — not the same fact as the
      // registry answering "no such repo".
      throw new VacuityProbeUnavailable(`repo registry could not answer for ${repoRef}`, err);
    }
    if (root === undefined) return false; // repo record gone — permanent, honestly 'none'
    const branch = `refs/heads/wicked/${runId}`;
    const gitOut = (args: string[]) =>
      // Read-only git plumbing over the registered repo root; argv array, never a shell string.
      // GIT_OPTIONAL_LOCKS=0: same no-opportunistic-locks posture as the worktree probe — this
      // root is the repo a deliver (or the operator) may be writing in right now.
      execCapped('git', args, {
        cwd: root,
        timeout: 10_000,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      });
    try {
      await gitOut(['rev-parse', '--verify', '--quiet', branch]);
    } catch (err) {
      // `--verify --quiet` on a missing ref is a CLEAN exit 1 — the one verifiable "branch
      // gone". Anything else (git unspawnable, deleted root ⇒ ENOENT, a 128 "not a git
      // repository", a timeout kill) is git NOT ANSWERING.
      if ((err as { code?: unknown }).code === 1) return true;
      throw new VacuityProbeUnavailable(`git rev-parse could not answer over ${root}`, err);
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
    } catch (err) {
      throw new VacuityProbeUnavailable(`git log could not answer over ${root}`, err);
    }
  };
  const run = memoized(probe, ttlMs, now);
  return (repoRef: string, runId: string) => run(`${repoRef}\0${runId}`);
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

/**
 * Is this a `failed` run whose ONLY failure was a recoverable deliver LIFT failure (crew#418/#432)?
 *
 * The deliver phase is the LAST phase, so a rejected deliver unit whose `denial_reason` carries
 * the deliver script's {@link DELIVER_LIFT_CONFLICT_MARKER} — with EVERY non-deliver unit still
 * `done` — means the run's WORK is complete and committed on its `wicked/<id>` branch: only the
 * lift into origin could not complete (a rebase conflict the changelog union merge could not
 * clear, a non-fast-forward push, or a transport/auth/remote rejection). The engine reports the run `failed` because a Tool phase exited
 * non-zero; crew reinterprets THIS shape on the wire as `completed` + `delivery: 'stranded'`
 * (recoverable via `POST /runs/:id/deliver`) — the same wire-derivation posture as `delivery`
 * itself, leaving the engine's durable `failed` record untouched. The deliver unit stays
 * `rejected` with its marker-bearing `denial_reason`, so WHY it stranded is still on the wire.
 *
 * FALSE — the run stays `failed` — for every genuine failure, because each misses a condition:
 *   - a rejected NON-deliver unit (a build/test/work phase failed) — `some(rejected)` guard;
 *   - a deliver rejection WITHOUT the marker: a spawn/infra fault (the crew#400 posture), a
 *     `gh` failure, nothing-to-deliver, or a wrong-worktree-branch refusal — the marker is the
 *     deliver script's own authority on WHY it refused, so crew never guesses from git's output;
 *   - a repo-less run (nothing to strand), or any non-`failed` status.
 */
export function isDeliverConflictStranded(view: SessionView): boolean {
  if (view.session.status !== 'failed') return false;
  if (view.session.repo_ref == null) return false;
  const deliver = deliverUnitOf(view);
  if (deliver === null || deliver.status !== 'rejected') return false;
  // A rejected unit that is NOT the deliver phase = a genuine work/build/test failure, not a
  // clean run whose only casualty was the lift.
  if (view.units.some((u) => u.id !== deliver.id && u.status === 'rejected')) return false;
  return (deliver.denial_reason ?? '').includes(DELIVER_LIFT_CONFLICT_MARKER);
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
