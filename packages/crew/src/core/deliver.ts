/**
 * The first-class deliver phase (crew#293) — a run opens its own PR, opt-in.
 *
 * Productizes the operator-side `feature-pr` overlay proven during the DES-MERGE-001 campaign:
 * a Tool phase appended after the workflow's last phase that COMMITS the run's work, pushes the
 * run's branch and opens a PR via `gh`. What was data on one machine becomes a launch option
 * (`deliver: "pr"` on `POST /runs`), composed PER RUN — the shared workflow def is never mutated.
 *
 * Field-proven hardening, replicated here:
 *  (a) the branch is derived from the run worktree's basename (`wicked/<run-id>`), falling back
 *      to the current branch when that ref does not exist;
 *  (b) the script REFUSES to push `main`/`master` (or an empty/detached branch name) — the
 *      deliver phase only ever pushes run branches;
 *  (b2) with the engine's `WICKED_DELIVER_VERIFIED_BASE` pin set (wicked-core#431 / #433: the
 *      remote-tip commit the engine lifted the work onto and re-verified against), it REFUSES —
 *      before staging anything — when origin's default branch no longer resolves to that commit
 *      after its own fetch ({@link DELIVER_BASE_MOVED_MARKER}): a base that moved past the verified
 *      one is re-verified by the engine's retry, never rebased past by this script;
 *  (b3) the crew#426 preflight (lockfile re-sync + codegen) runs AFTER the engine's verification;
 *      when it changes the worktree, an engine-driven delivery REFUSES and names the files
 *      ({@link DELIVER_PREFLIGHT_CHANGED_MARKER}) — a post-hoc lift ({@link DELIVER_POSTHOC_ENV})
 *      keeps the regeneration and says so;
 *  (c) it STAGES AND COMMITS the run's work, then rebases onto origin's default branch before
 *      pushing. A conflict whose conflicted paths are ALL `CHANGELOG.md` is union-merged (both
 *      sides' additive lines kept) and the rebase continues — the crew#418 collision magnet, made
 *      to just deliver; ANY other conflict aborts the rebase (pushing nothing) and exits carrying
 *      {@link DELIVER_LIFT_CONFLICT_MARKER}, which crew reads as a recoverable STRAND, never a
 *      pushed conflicted tree;
 *  (d) `git push -u origin <branch>` — every rejected push carries the recovery marker. The run
 *      work is already committed locally, so an operator can repair auth/transport and retry;
 *  (e) `gh pr create --head <branch> --title … --body-file …`, with gh's output and exit status
 *      captured SEPARATELY so a gh failure fails the phase carrying gh's own message. The title
 *      and body are COMPOSED FROM THE RUN (crew#524 / F-3R2-014, `core/deliver-text.ts`): the
 *      script asks the daemon that launched it (`GET /runs/:id/deliver-text`) for the text derived
 *      from the persisted run record — intent, `Fixes #N`, run link, phases + seats + gate
 *      outcomes, repo checks with exit codes, the evaluator verdict — and falls back to the same
 *      composer's launch-time text (embedded in the script) when the daemon cannot answer. The
 *      commit the phase makes for uncommitted work carries that same text (`git commit -F`), so
 *      ITS subject is the PR title; a run that committed incrementally keeps its own commits;
 *  (f) the PR URL is the last line of the phase output.
 *
 * One deliberate change from the field version: NO gh account is baked into crew code (the
 * overlay guarded a personal account). Instead, when the `GH_ACCOUNT` env var is set the script
 * compares it against `gh api user -q .login` and REFUSES when they differ (DES-L9 D-18, crew#549):
 * the daemon's push identity is what its gh — or an exported `GH_TOKEN` — holds, disclosed on the
 * deliver gate card, never switched at push time (the switch this replaced pushed under whatever
 * account it could flip to, and a 403 hard-failed the run). Unset ⇒ whatever gh holds, said aloud.
 *
 * REVISION mode (DES-L9 / crew#550, `POST /runs {revisesPr}`): the run was based on an OPEN pull
 * request's head branch; the script pushes `wicked/<run>` onto `refs/heads/<that branch>` (the PR
 * gains exactly the run's commits — no rebase onto the default branch, no `gh pr create`), proves
 * the remote tip, comments the run record on the PR and prints the PR's URL last. A head that moved
 * or vanished since the run based on it is REFUSED before anything is staged (no LIFT-CONFLICT
 * marker — a re-push cannot succeed; the operator launches a new revision or rebases by hand).
 *
 * Merge stays human: the phase opens the PR, never merges it.
 *
 * ## crew#317 — "pushed an empty branch and reported success"
 *
 * Run `d1bc72c2` (wicked-studio) delivered nothing while reporting `completed`. The persisted
 * unit is the evidence, and it names the cause precisely. Its `tool_cmd` was NOT this script —
 * it was the operator's hand-written `feature-pr` OVERLAY def, which begins `set -e` with **no
 * `pipefail`**, so `gh pr create … | tail -1` reported `tail`'s status (0) and the phase passed
 * with gh's error text where the PR URL belongs:
 *
 * ```text
 * could not compute title or body defaults: could not find any commits between origin/main and
 * wicked/d1bc72c2-…
 * ```
 *
 * So the masking mechanism the issue hypothesised is real, but it belonged to the overlay, not
 * here: `pipefail` IS in force for this executor (it is line 1 of this script, `bash -lc` runs it
 * verbatim, and core's `run_tool_cmd` maps any non-zero exit to `StepStatus::Failed`). The three
 * defects this script genuinely shared with the overlay are fixed below:
 *
 *  1. **No commit.** Agents write files and do not commit, so the pushed branch equalled the
 *     default branch. The script now stages and commits the run's work itself, and REFUSES to
 *     push when there is nothing to deliver.
 *  2. **A masked result.** `| tail -1` discarded everything gh said except one line and made the
 *     phase's verdict depend on a pipe option. gh's output and status are now captured
 *     separately, and success is re-derived from a real PR URL rather than from an exit code.
 *  3. **Ungoverned.** The phase shipped `verified_evidence: false` / `validator_pin: null`, so
 *     nothing re-derived what it claimed. It now declares `verified_evidence: true` — see
 *     {@link deliverPrPhase}.
 */

import { execFile } from 'node:child_process';
import { childEnvWithBootEstateDb } from './governance-store.js';
import type { PhaseDef, WorkflowDef } from './types.js';
import { DELIVER_STRANDED_SENTINEL } from './deliver-exclusions.js';
import {
  composeEmbeddedDeliverText,
  factsFromWorkflow,
  framedDeliverText,
  runUrlFor,
  configuredPublicOrigin,
  commitSubject,
  urlPathSegment,
  type DeliverTextFacts,
} from './deliver-text.js';

/**
 * The content-address of wicked-core's built-in evidence floor (`builtin_floors::EVIDENCE_FLOOR_PIN`,
 * criterion "the run left a change in its worktree (done is re-derived from the diff, never
 * asserted)"). Carried explicitly on every phase crew composes or mirrors that declares
 * `verified_evidence` or writes code: since wicked-core#414 the engine judges a def AS AUTHORED at
 * registration — it REFUSES an `executes_code` agent phase with no pin and no human gate, and a
 * `verified_evidence` phase with no pin — so nothing is armed on crew's behalf any more.
 *
 * Duplicating a hash is a real cost, paid because the alternative is worse: a `null` here would
 * be a refused registration for every deliver-composed run. The floor is seeded on core's plan
 * path (`pre_distribute`), so this pin always resolves without a provision/approve step. The drift
 * guards in `tests/armed-workflow-served.test.ts` and `tests/deliver-phase.test.ts` fail loudly on
 * a developer machine the moment core's value moves.
 */
export const EVIDENCE_FLOOR_PIN = 'e2e7af1db9e48454';

/** The id of the appended phase — also the collision probe when a def already delivers. */
export const DELIVER_PHASE_ID = 'deliver';

/**
 * The sentinel the deliver script prints when the RUN'S WORK has been committed but its LIFT did
 * not complete (crew#418): a rebase onto the remote default branch hit a conflict outside the
 * changelog. The work is safe on its `wicked/<id>` branch; an operator resolves the collision and
 * retries delivery. A push the REMOTE refused is not a lift collision and carries
 * {@link DELIVER_PUSH_REJECTED_MARKER} instead (N4).
 *
 * crew keys the "stranded, recoverable" reinterpretation on this EXACT substring appearing in
 * the deliver unit's `denial_reason` (which carries the head+TAIL excerpt of the script's
 * output, and the marker is always the script's last line — see {@link isDeliverConflictStranded}
 * in `api/delivery-index.ts`). The script's OTHER loud refusals — wrong worktree branch, nothing
 * to deliver, `gh` failure — and a spawn/infra failure deliberately OMIT the marker, so they stay
 * terminal run failures exactly as before (the crew#400 refusal-vs-infra posture).
 */
export const DELIVER_LIFT_CONFLICT_MARKER = 'deliver: LIFT-CONFLICT';

/**
 * The sentinel the deliver script prints LAST when the REMOTE REFUSED the push after the run's work
 * was committed and its lift came out clean (N4, ship re-proof): a pre-receive hook, a protected
 * ref, an auth 403, a transport failure, or a non-fast-forward on the run branch. It used to carry
 * {@link DELIVER_LIFT_CONFLICT_MARKER}, which mislabelled a refusal as a lift collision — the lift
 * read `unchanged` — and, because the engine EXEMPTS that marker from its deterministic
 * deliver-refusal arm, sent the failure to the LLM triage judge, which re-ran the push once with no
 * gate. Without the lift marker the failure takes the engine's deterministic arm: the run parks at
 * an `escalation` gate on the deliver unit, and nothing is pushed again until a human approves.
 * The untracked recovery sentinel ({@link DELIVER_STRANDED_SENTINEL}) still keeps the worktree.
 */
export const DELIVER_PUSH_REJECTED_MARKER = 'deliver: PUSH-REJECTED';

/**
 * The machine line the deliver script prints LAST on a successful PUSH-ONLY delivery (N1, the half
 * of F2 that did not hold): the branch is on the remote, and no pull request was opened because gh
 * could not resolve the origin to a GitHub repository. `deliver: PUSHED-NO-PR <branch> <remote>` —
 * the branch has no spaces (git forbids them in a ref), and the remote is the rest of the line.
 * The daemon reads it from the APPROVED deliver unit's output ({@link pushedOnlyFrom}) into the
 * durable `run.delivered` record, so the run reads `delivery: 'pushed'` instead of `'stranded'`.
 */
export const DELIVER_PUSHED_NO_PR_MARKER = 'deliver: PUSHED-NO-PR';

/** What a push-only delivery left on the record: the branch, and the remote it is on. */
export interface PushedOnlyDelivery {
  branch: string;
  /** The origin's push URL, with any `user[:password]@` userinfo removed. */
  remote: string;
}

/** A remote URL with its userinfo removed — `https://tok@host/r` → `https://host/r`. A scp-like
 *  `git@host:path` keeps its user (it names an SSH login, not a secret). */
export function remoteWithoutUserinfo(url: string): string {
  return url.trim().replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^@/]*@/, '$1');
}

/**
 * The push-only delivery a deliver transcript records, or `null`. The LAST
 * {@link DELIVER_PUSHED_NO_PR_MARKER} line wins. Whether it outranks a PR URL in the same transcript
 * is decided by position in `deliveryRecordFrom` (`api/delivery-index.ts`): the script's verdict is
 * the last of the two, and anything earlier may be the remote's echo.
 */
export function pushedOnlyFrom(text: string): PushedOnlyDelivery | null {
  let found: PushedOnlyDelivery | null = null;
  for (const line of text.split('\n')) {
    const m = /^deliver: PUSHED-NO-PR (\S+) (.+)$/.exec(line.trimEnd());
    if (m !== null) found = { branch: m[1]!, remote: remoteWithoutUserinfo(m[2]!) };
  }
  return found;
}

/** What the script carries for its PR/commit text (crew#524). All optional: the bare script still
 *  composes a title and a body from the intent alone. */
export interface DeliverScriptOptions {
  /** The run this script delivers; names the run in the fallback text. */
  runId?: string;
  /** Everything known when the script was composed — the embedded fallback is built from it.
   *  Defaults to the intent + run id alone (no workflow, no phases). */
  facts?: DeliverTextFacts;
  /** The launching daemon's own origin (`http://127.0.0.1:7701`). When set, the script first asks
   *  it for the run-derived text; unset (or unreachable) ⇒ the embedded fallback. */
  apiOrigin?: string | null;
  /** DES-L9 / crew#550 — REVISION mode: the open pull request this run revises. The script pushes
   *  `wicked/<run>` onto `refs/heads/<headRef>` (the PR gains exactly the run's commits), proves the
   *  remote tip, comments the run record on the PR and prints `url` last; no `gh pr create`. */
  revisesPr?: RevisedPullRequest | null;
  /** The daemon's configured push identity (the `deliverIdentityLogin` setting, else
   *  `GH_ACCOUNT`) for the gate card; `null` = unset. */
  ghAccount?: string | null;
  /** Whether `GH_TOKEN` is exported in the daemon environment — presence only, never the value. */
  ghTokenPinned?: boolean;
  /** (F2) The repo's `git remote get-url origin`, read at compose time so the deliver GATE CARD
   *  says what will actually happen. `undefined`/`null` ⇒ it could not be read (the card keeps the
   *  generic sentence); `''` ⇒ read, and the repository has NO `origin` remote. The SCRIPT never
   *  uses this — it asks git itself at delivery time. */
  originUrl?: string | null;
  /** (crew#549) The DELIVER IDENTITY from system settings (`deliverIdentityLogin`) — the login the
   *  push must run as, baked into the script so the refusal holds even when the daemon was started
   *  without `GH_ACCOUNT` exported. A token is NEVER carried here (or anywhere in the settings):
   *  the credential stays in gh's keyring or in `GH_TOKEN`. `null`/absent ⇒ `GH_ACCOUNT` decides.
   *  Refused at compose time when it is not a GitHub login, so nothing unsafe is spliced. */
  deliverIdentity?: string | null;
}

/** A GitHub login as GitHub itself allows it — alphanumerics and single hyphens, ≤ 39 chars. The
 *  ONE validator for the deliver identity: the setting's 400 and the script's splice share it, so
 *  a value that passed the route can always be baked into a single-quoted shell literal. */
export function isGitHubLogin(login: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(login);
}

/** The pull request a revision run pushes onto (DES-L9). `headRef` is a same-repository branch. */
export interface RevisedPullRequest {
  number: number;
  headRef: string;
  url: string;
}

/** A branch name the script may splice into a single-quoted literal and hand to git: the ref
 *  charset git accepts for `wicked/<run>`-style heads, no `..`, no leading `-`, no quotes. */
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
export function isSafeRefName(name: string): boolean {
  return SAFE_REF.test(name) && !name.includes('..') && !name.endsWith('/') && !name.endsWith('.lock');
}

/** The one shape a PR URL may take before it is baked into the script and printed as the phase's
 *  last line (crew re-derives "delivered" from that line — `prUrlFrom`). */
const SAFE_PR_URL = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/[0-9]+$/;

/** The `bug` def's `fix` phase instructions — the SAME literal wicked-core's `bug_def()` carries
 *  (`BUG_FIX_SWEEP_INSTRUCTIONS`, DES-L9 BC-60 / core#432): both carriers are live (`deliver:pr`
 *  plans from this mirror, `deliver:none` from core's def), so one string, pinned by a test. Short
 *  (≤ 90 ASCII bytes) on purpose — the PTY carrier's whole prompt is 1000 B and core's budget test
 *  keeps ≥ 300 B of intent headroom. */
export const BUG_FIX_SWEEP_INSTRUCTIONS =
  'Update every consumer of behaviour this fix retires or changes: tests, docs, comments.';

/** What `gh pr view` answers for a revision target (DES-L9 `resolvePullRequest`). */
export interface ResolvedPullRequest extends RevisedPullRequest {
  state: string;
}

export type PullRequestResolution =
  | { ok: true; pr: ResolvedPullRequest }
  | { ok: false; error: string };

/** The exec seam `resolvePullRequest` reads `gh` through — injectable so tests answer without gh. */
export type GhExec = (
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

export const defaultGhExec: GhExec = (args, opts) =>
  new Promise((resolve) => {
    // The daemon's governance-store variables never ride into a child (crew#495): the boot value is
    // restored and the exported store URL is stripped, the same helper every other spawn site uses.
    execFile('gh', args, { cwd: opts.cwd, timeout: opts.timeoutMs, encoding: 'utf8', env: childEnvWithBootEstateDb(process.env) }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : null;
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code });
    });
  });

/**
 * `git remote get-url --push origin` in `rootPath` — the deliver gate's origin preflight (F2).
 *
 * `--push` because the sentence is about the PUSH: `git push origin` uses `remote.origin.pushurl`
 * when one is configured, so a repo whose FETCH url is GitHub while its PUSH url is not (or the
 * reverse) would otherwise get a card describing a destination the branch never reaches (codex
 * review of this PR, HIGH). With no `pushurl` configured git answers the fetch url, so the common
 * case is unchanged.
 *
 *  - the trimmed URL when git answered one;
 *  - `''` when git said there is NO such remote — the one answer that licenses the card to claim
 *    "this repository has no origin";
 *  - `null` for everything else (git missing, a timeout, a root that is not a checkout). "Could
 *    not read it" is not a licence to claim anything about it either way, so the card keeps its
 *    generic sentence.
 *
 * A run worktree shares its repository's remotes and does not exist yet at compose time, so this
 * reads the REGISTERED repo root. Bounded to 5 s, once per delivering launch.
 */
export async function readDeliverOriginUrl(rootPath: string): Promise<string | null> {
  const res = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
    execFile(
      'git',
      ['remote', 'get-url', '--push', 'origin'],
      { cwd: rootPath, timeout: 5_000, encoding: 'utf8', env: childEnvWithBootEstateDb(process.env) },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null;
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code });
      },
    );
  });
  if (res.code === 0) {
    const url = res.stdout.trim();
    // git can exit 0 with nothing for a remote configured with an empty URL — unknown, not absent.
    return url === '' ? null : url;
  }
  return /no such remote/i.test(res.stderr) ? '' : null;
}

/**
 * Resolve `revisesPr` (a PR number) to the head branch the run will base on and push to — the
 * daemon's job, since the engine has no GitHub client (DES-L9 §2). Bounded to 5 s; every failure
 * is a NAMED refusal (the route answers 409), never a silent second PR:
 *  - not OPEN (merged / closed) — only an open pull request can be revised;
 *  - a fork PR (`isCrossRepository`) — the run's clone cannot push to another repository's branch;
 *  - a head branch name the script cannot splice safely;
 *  - `gh` unavailable, unauthenticated, timed out or answering anything but the JSON asked for.
 */
export async function resolvePullRequest(
  repoRoot: string,
  number: number,
  exec: GhExec = defaultGhExec,
): Promise<PullRequestResolution> {
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: `revisesPr must be a positive pull request number (got ${number})` };
  let out: { stdout: string; stderr: string; code: number | null };
  try {
    out = await exec(['pr', 'view', String(number), '--json', 'headRefName,state,isCrossRepository,url'], { cwd: repoRoot, timeoutMs: 5000 });
  } catch (err) {
    return { ok: false, error: `gh could not read PR #${number}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (out.code !== 0) {
    const why = (out.stderr || out.stdout).trim().split('\n').slice(-2).join(' ').slice(0, 300);
    return { ok: false, error: `gh could not read PR #${number}: ${why || (out.code === null ? 'gh timed out or could not be spawned' : `exit ${out.code}`)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(out.stdout);
  } catch {
    return { ok: false, error: `gh could not read PR #${number}: its answer was not the JSON asked for` };
  }
  const r = (parsed ?? {}) as Record<string, unknown>;
  const headRef = r['headRefName'];
  const state = r['state'];
  const url = r['url'];
  if (typeof headRef !== 'string' || typeof state !== 'string' || typeof url !== 'string') {
    return { ok: false, error: `gh could not read PR #${number}: headRefName / state / url missing from its answer` };
  }
  if (state !== 'OPEN') return { ok: false, error: `revisesPr #${number} is ${state} — only an open pull request can be revised` };
  if (r['isCrossRepository'] === true) {
    return { ok: false, error: `revisesPr #${number} is a fork pull request (its head lives in another repository) — only a same-repository branch can be revised` };
  }
  if (!isSafeRefName(headRef)) return { ok: false, error: `revisesPr #${number}'s head branch name cannot be used as a push target: ${JSON.stringify(headRef)}` };
  if (!SAFE_PR_URL.test(url)) return { ok: false, error: `revisesPr #${number}: gh answered a URL that is not a pull request URL (${url.slice(0, 120)})` };
  return { ok: true, pr: { number, headRef, url, state } };
}

/**
 * The env var the engine hands the deliver command with the remote-tip commit it VERIFIED the
 * run's work against (wicked-core#431 / #433, `deliver_lift.rs` `VERIFIED_BASE_ENV`): set on a
 * lift outcome of `unchanged` or `lifted`, absent when the lift was skipped (no remote, no default
 * ref, a branch carrying its own commits) — and never set on a post-hoc `POST /runs/:id/deliver`,
 * which has no engine verification to pin to (`api/post-hoc-deliver.ts` strips it).
 */
export const DELIVER_VERIFIED_BASE_ENV = 'WICKED_DELIVER_VERIFIED_BASE';

/**
 * The sentinel the deliver script prints when `origin/<default>` no longer resolves to
 * {@link DELIVER_VERIFIED_BASE_ENV} after the script's own fetch: the remote advanced between the
 * engine's re-verify and the push window, so the rebase below would carry the base PAST what was
 * verified. The script refuses BEFORE staging anything. Deliberately NOT a
 * {@link DELIVER_LIFT_CONFLICT_MARKER}: a moved base is not a recoverable strand — a post-hoc lift
 * would push a tree nobody verified on the new base; the remedy is the engine's own retry (approve
 * the deliver gate: it lifts onto the new tip and re-runs the repository's checks first).
 */
export const DELIVER_BASE_MOVED_MARKER = 'deliver: BASE MOVED since verification';

/**
 * The env var the daemon sets on a POST-HOC lift (`POST /runs/:id/deliver`, `api/post-hoc-deliver.ts`)
 * and the engine never does. A post-hoc lift has no engine verification to protect, so the
 * crew#426 preflight may regenerate tracked files and deliver them (disclosed); an engine-driven
 * deliver Tool unit — the variable absent — refuses instead ({@link DELIVER_PREFLIGHT_CHANGED_MARKER}).
 */
export const DELIVER_POSTHOC_ENV = 'WICKED_DELIVER_POSTHOC';

/**
 * The sentinel the deliver script prints when the crew#426 preflight (`npm install` + the
 * `manifest:endpoints` / `generate:api-tests` codegen) CHANGED the worktree AFTER the engine had
 * verified it (wicked-core#433 review addendum): the tree that would ship is then not the tree the
 * repository's checks certified, and the script refuses before staging anything, leaving the
 * regenerated files in the worktree. Not a {@link DELIVER_LIFT_CONFLICT_MARKER}: the remedy is to
 * approve the retry — the engine re-verifies the changed tree first, and the retry's preflight
 * regenerates nothing more.
 */
export const DELIVER_PREFLIGHT_CHANGED_MARKER = 'deliver: PREFLIGHT CHANGED the verified tree';

/**
 * The BASE heredoc delimiter the script writes its fallback text through. A QUOTED heredoc expands
 * nothing — `$`, backticks, quotes and backslashes in the intent are inert — so the only way the
 * caller-supplied text could break out is a line equal to the delimiter. That line is never
 * removed or altered (it may be the title itself — Copilot on #525): {@link heredocDelimiter}
 * picks a delimiter no line of the text equals, so the text rides verbatim and the heredoc still
 * ends exactly where the script says it ends.
 */
export const DELIVER_TEXT_HEREDOC = 'WICKED_CREW_DELIVER_TEXT_EOF';

/**
 * The framed PR/commit text as heredoc body lines. This is a containment boundary, not cosmetics:
 * the intent is caller-supplied free text off `POST /runs` and it is being spliced into a bash
 * script. CR and every control character other than tab and newline are removed (a bare CR could
 * split a line in the CLI's eyes); nothing else is touched.
 */
export function heredocLines(framed: string): string[] {
  return framed
    .replace(/\r/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\n$/, '')
    .split('\n');
}

/**
 * A heredoc delimiter none of `lines` equals: the base, or the base with a numeric suffix
 * (`…_EOF_1`, `…_EOF_2`, …) when the text happens to carry the base as a whole line. The framing
 * (line 1 = title) is therefore never disturbed by containment.
 */
export function heredocDelimiter(lines: readonly string[]): string {
  let delimiter = DELIVER_TEXT_HEREDOC;
  for (let n = 1; lines.includes(delimiter); n += 1) delimiter = `${DELIVER_TEXT_HEREDOC}_${n}`;
  return delimiter;
}

/**
 * The daemon origin as a single-quoted shell literal, or `''` when it is not a plain http(s)
 * origin. Same containment logic as the heredoc: nothing that is not `scheme://host[:port]` is
 * ever spliced into the script, so a hostile value can only cost the callback, never a line.
 */
function apiOriginLiteral(origin: string | null | undefined): string {
  if (origin === null || origin === undefined) return '';
  const trimmed = origin.replace(/\/+$/, '');
  return /^https?:\/\/[A-Za-z0-9.\-[\]:]+$/.test(trimmed) ? trimmed : '';
}

/**
 * The hardened deliver script, run as `bash -lc <script>` (login shell so the operator's PATH —
 * where `gh` lives — is loaded, same as the field overlay).
 *
 * `set -euo pipefail` is load-bearing and verified in force for this executor (crew#317): the
 * engine spawns `bash -lc` with this text verbatim, and `run_tool_cmd` turns a non-zero exit into
 * `StepStatus::Failed`. It is no longer the ONLY thing standing between a failed `gh` and a green
 * phase, though — the gh result is captured explicitly and success is re-derived from evidence.
 *
 * `intent` (the run's problem statement) is what the PR title and the commit subject are composed
 * from (`core/deliver-text.ts`); `opts` carries the rest of the launch-time facts and the daemon
 * origin the script asks for the run-derived text (crew#524).
 */
export function deliverPrScript(intent?: string, opts: DeliverScriptOptions = {}): string {
  const runId = opts.runId ?? opts.facts?.runId ?? '';
  const facts =
    opts.facts ??
    factsFromWorkflow({
      runId,
      intent,
      workflowId: null,
      repoRef: null,
      phases: [],
      runUrl: null,
      revisesPr: opts.revisesPr == null ? null : { number: opts.revisesPr.number, url: opts.revisesPr.url },
    });
  // The EMBEDDED fallback is bounded (`EMBEDDED_INTENT_CAP`): this script is one argv entry, and an
  // unbounded intent could exceed the platform's single-argument limit and E2BIG the phase before
  // it runs (Copilot on #525). The daemon-fetched text is never bounded this way. The issue
  // references (`Fixes #N` / `Refs:`) are derived from the FULL intent before the cut, so a closing
  // reference written past the cap still reaches the PR body (wave-3 isolation review).
  const fallback = composeEmbeddedDeliverText(facts);
  const api = apiOriginLiteral(opts.apiOrigin);
  const fallbackLines = heredocLines(framedDeliverText(fallback));
  const heredoc = heredocDelimiter(fallbackLines);
  // crew#550: the PR title may run to GitHub's 256 characters, the commit subject stays at git's 72.
  // The subject is composed here from the same title; the script puts it above the full text when
  // the two differ, so the commit body opens with the whole title.
  const subjectLines = heredocLines(commitSubject(fallback.title));
  const fallbackTitleLines = heredocLines(fallback.title);
  // Never the text heredoc's own delimiter, so each heredoc has exactly one closing line.
  const subjectHeredoc = heredocDelimiter([...fallbackLines, ...subjectLines, ...fallbackTitleLines, heredoc]);
  // The run id for the daemon URL: the LAUNCH id when the composer knows it, pre-encoded as one
  // strict path segment (only `[A-Za-z0-9._~%-]` survive, so the single-quoted literal is safe);
  // otherwise derived from the branch at run time and percent-encoded byte-wise by the script.
  const runIdSegment = runId === '' ? '' : urlPathSegment(runId);
  // Revision inputs (DES-L9): fail CLOSED at compose time on anything the script could not splice
  // safely — a revision that silently fell back to a new PR is the duplicate the field is for.
  const revises = opts.revisesPr ?? null;
  if (revises !== null) {
    if (!Number.isInteger(revises.number) || revises.number <= 0) throw new Error(`revisesPr: not a pull request number: ${String(revises.number)}`);
    if (!isSafeRefName(revises.headRef)) throw new Error(`revisesPr #${revises.number}: head branch name cannot be a push target: ${JSON.stringify(revises.headRef)}`);
    if (!SAFE_PR_URL.test(revises.url)) throw new Error(`revisesPr #${revises.number}: not a pull request URL: ${JSON.stringify(revises.url)}`);
  }
  // (crew#549) The configured deliver identity, baked as a single-quoted literal. Fail CLOSED at
  // compose time on anything that is not a GitHub login: a run that silently delivered under an
  // unchecked identity is the defect, and a value that reached a shell literal unvalidated would
  // be worse than either.
  const identity = (opts.deliverIdentity ?? '').trim();
  if (identity !== '' && !isGitHubLogin(identity)) {
    throw new Error(`deliver identity: not a GitHub login: ${JSON.stringify(identity)}`);
  }
  const prNum = revises === null ? '' : String(revises.number);
  const target = revises === null ? '' : revises.headRef;
  const prUrl = revises === null ? '' : revises.url;
  return [
    'set -euo pipefail',
    // The engine concatenates the child's stdout and THEN its stderr, so anything git writes to
    // stderr would land after the PR URL and break "(f) the URL is the last line". Folding stderr
    // into stdout for the whole phase keeps the output in true chronological order and makes the
    // final `echo "$URL"` genuinely last.
    'exec 2>&1',
    // IDENTITY (DES-L9 D-18, crew#549 / F-RC1-010) — read ONCE, up front, before anything is
    // fetched, staged or pushed, so the refusal is the phase's WHOLE output (the engine's head-150
    // carries it). With GH_ACCOUNT set, a differing or unreadable active login REFUSES: the
    // daemon's push identity is what its gh (or an exported GH_TOKEN — then `gh api user` IS the
    // token's login) holds, disclosed on the gate card, never switched at push time. Unset ⇒
    // today's behaviour, now said aloud. No account name is baked into crew code (env-driven).
    'L=$(gh api user -q .login 2>/dev/null || true)',
    // (crew#549) The CONFIGURED identity is the system setting `deliverIdentityLogin` — baked
    // here at compose time, validated against the GitHub login charset before it is spliced —
    // and the `GH_ACCOUNT` env var when the setting is empty (still supported; the setting wins
    // so a daemon started without the export is not silently unpinned). `GH_ACCOUNT` is then the
    // ONE name the refusals use, whichever source set it.
    `CFG='${identity}'`,
    'if [ -n "$CFG" ]; then GH_ACCOUNT="$CFG"; fi',
    'if [ -n "${GH_ACCOUNT:-}" ]; then',
    '  [ "$L" = "$GH_ACCOUNT" ] || { echo "deliver: identity mismatch — GH_ACCOUNT is $GH_ACCOUNT but gh\'s active login is ${L:-unreadable}; nothing was staged, committed or pushed. Fix the daemon\'s gh login (switch gh\'s active account, or export GH_TOKEN in the daemon environment) and approve to retry the deliver phase"; exit 1; }',
    '  if [ -n "${GH_TOKEN:-}" ]; then echo "deliver: pushing as $L (GH_ACCOUNT pinned by GH_TOKEN)"; else echo "deliver: pushing as $L (GH_ACCOUNT from the gh keyring — export GH_TOKEN to pin it)"; fi',
    'elif [ -n "$L" ]; then echo "deliver: pushing as $L (GH_ACCOUNT not set — not pinned)"',
    'else echo "deliver: pushing as an unknown login (gh not authenticated; GH_ACCOUNT not set — not pinned)"; fi',
    // (crew#549 / F-RC1-010) THE CREDENTIAL CROSS-CHECK. `gh api user` says who gh is; it says
    // NOTHING about the credential `git push` will use. On the RC1 rig those two disagreed —
    // `git credential fill` handed git one account while `gh api user` reported another — and the
    // run pushed under an identity the operator had not chosen (or took a 403 that hard-failed
    // it). So ask git itself, for the remote's own host, BEFORE anything is fetched or staged,
    // and REFUSE when both logins are concrete and differ — naming both, whether or not an
    // identity is configured. `GIT_TERMINAL_PROMPT=0` keeps a helperless host from prompting (it
    // errors instead, which reads as unresolved). Only an https remote has a git credential; an
    // ssh or local remote authenticates another way, so the check does not apply and says so.
    // A placeholder username (`x-access-token`, `oauth2`, `token`) identifies a TOKEN, not an
    // account: unresolved, disclosed, never a refusal (the token's own login is what `gh api
    // user` already reported).
    //
    // THE REMOTE'S OWN USERNAME COMES FIRST (codex review on #727). A remote spelled
    // `https://other-bot@github.com/o/r.git` tells git which account to authenticate as, and git
    // uses it whatever the helper would have answered for the bare host. Stripping it and asking
    // only about the host left exactly the defect this guard exists for alive: gh reports
    // `release-bot`, the URL says `other-bot`, the helper agrees with gh, and the push goes out as
    // `other-bot`. So the URL username is read, refused against gh's login when both are concrete,
    // and passed INTO the credential query so the helper answers for the account git will use.
    'RU=$(git remote get-url origin 2>/dev/null || true)',
    'case "$RU" in',
    '  https://*)',
    '    RH=${RU#https://}; RH=${RH%%/*}; RU_USER=""',
    '    case "$RH" in *@*) RU_USER=${RH%@*}; RH=${RH##*@};; esac',
    // A `user:password@host` remote carries the secret in the URL; take the user, never the rest.
    '    case "$RU_USER" in *:*) RU_USER=${RU_USER%%:*};; esac',
    '    case "${RU_USER:-}" in',
    '      ""|x-access-token|oauth2|token|PRIVATE-TOKEN) ;;',
    '      *) if [ -n "$L" ] && [ "$RU_USER" != "$L" ]; then echo "deliver: identity mismatch — gh\'s active login is $L but origin\'s URL authenticates as $RU_USER (https://$RU_USER@$RH/…); nothing was staged, committed or pushed. The push would use $RU_USER, not $L. Point origin at https://$RH/… and pin ONE identity (export GH_TOKEN in the daemon environment, or fix the credential helper for $RH), then approve to retry the deliver phase"; exit 1; fi',
    '         echo "deliver: origin authenticates as $RU_USER (agrees with gh)";; esac',
    '    GC=$(printf "protocol=https\\nhost=%s\\n%s\\n" "$RH" "${RU_USER:+username=$RU_USER}" | GIT_TERMINAL_PROMPT=0 git credential fill 2>/dev/null | sed -n "s/^username=//p" | head -1 || true)',
    '    case "${GC:-}" in',
    '      "") echo "deliver: git\'s credential identity for $RH is unresolved (no credential helper answered) — the push uses whatever the helper hands git at push time";;',
    '      x-access-token|oauth2|token|PRIVATE-TOKEN) echo "deliver: git\'s credential for $RH is a token ($GC), so it names no account — gh reports ${L:-an unknown login}";;',
    '      *)',
    '        if [ -n "$L" ] && [ "$GC" != "$L" ]; then echo "deliver: identity mismatch — gh\'s active login is $L but git\'s credential for $RH is $GC; nothing was staged, committed or pushed. The push would use $GC, not $L. Pin ONE identity (export GH_TOKEN in the daemon environment, or fix the credential helper for $RH) and approve to retry the deliver phase"; exit 1; fi',
    '        echo "deliver: git\'s credential for $RH is $GC (agrees with gh)";;',
    '    esac;;',
    '  "") echo "deliver: this worktree has no origin remote — no git credential applies";;',
    '  *) echo "deliver: origin is not an https remote — no git credential applies (ssh keys or a local path authenticate the push)";;',
    'esac',
    // REVISION MODE inputs (DES-L9 / crew#550) — baked at compose time from the resolved PR, each
    // validated against a strict charset before it is spliced into a single-quoted literal. Empty
    // TARGET ⇒ today's new-PR delivery.
    `PRNUM='${prNum}'`,
    `TARGET='${target}'`,
    `PRURL='${prUrl}'`,
    // (a) The run branch: wicked/<worktree-basename> (the engine names run worktrees by run id),
    // falling back to the currently checked-out branch when that ref does not exist.
    'R=$(basename "$PWD")',
    'B="wicked/$R"',
    'git rev-parse --verify "$B" >/dev/null 2>&1 || B=$(git branch --show-current)',
    // Derive origin's default branch FIRST — the refusal below must cover a repo whose
    // default is trunk/develop/anything, not just main/master (Copilot on #303).
    'git fetch origin',
    // …the way the ENGINE derives it (wicked-core `deliver_lift.rs`, review F-527-003): origin/HEAD
    // when it resolves to a commit — a DANGLING origin/HEAD (the remote's default branch renamed or
    // deleted since the clone) is tolerated — else origin/main, else origin/master, else origin/main
    // for the refusal texts. A repo whose base is origin/master must never read as a moved base.
    'D=$(git symbolic-ref -q --short refs/remotes/origin/HEAD || true)',
    'if [ -z "$D" ] || ! git rev-parse --verify -q "$D^{commit}" >/dev/null; then if git rev-parse --verify -q origin/main^{commit} >/dev/null; then D=origin/main; elif git rev-parse --verify -q origin/master^{commit} >/dev/null; then D=origin/master; else D=origin/main; fi; fi',
    'DEF="${D#origin/}"',
    // (b) Refuse the repo's own default branch (by derived name), the classic names, and an
    // empty name (detached HEAD), which would otherwise turn the push into a garbage ref.
    'case "$B" in ""|main|master|"$DEF") echo "deliver: refusing to push branch \'$B\' — the deliver phase only pushes run branches, never the default branch"; exit 1;; esac',
    // The commit below writes to whatever HEAD is, while the push sends $B. When those differ
    // (a `wicked/<run-id>` ref exists but is NOT what this worktree has checked out) committing
    // would put one branch's work on another and push a branch that never saw it. Refuse instead.
    'C=$(git branch --show-current)',
    '[ "$C" = "$B" ] || { echo "deliver: the worktree is on \'$C\' but the run branch is \'$B\' — refusing to commit one branch\'s work onto another; nothing was pushed"; exit 1; }',
    // REVISION MODE (DES-L9 / crew#550): the run was based on origin/$TARGET — the open PR's head.
    // The target must still exist and must still be an ANCESTOR of the run branch: a head that
    // moved since the mint (another push to the PR) cannot be fast-forwarded to $B, and a re-push
    // could never succeed — so this is a REFUSAL before staging (no LIFT-CONFLICT marker; the
    // operator launches a new revision on the current head or rebases by hand), not a strand. The
    // short trailing `deliver:` line survives the engine's tail-250 excerpt after the fetch chatter
    // (review F-527-001), so crew classifies it. The default branch can never be a revision target.
    'if [ -n "$TARGET" ]; then',
    '  case "$TARGET" in ""|main|master|"$DEF") echo "deliver: refusing to revise pull request #$PRNUM — its head branch \'$TARGET\' is the default branch; nothing was staged, committed or pushed"; exit 1;; esac',
    // Asked of the REMOTE (`ls-remote`), not of the clone's `origin/*` refs — a plain fetch never
    // prunes a branch deleted after the PR merged, so the local ref would still resolve and the
    // push would silently RE-CREATE the branch under a closed PR.
    '  git ls-remote --exit-code --heads origin "$TARGET" >/dev/null 2>&1 && git rev-parse --verify -q "origin/$TARGET^{commit}" >/dev/null || { echo "deliver: pull request #$PRNUM\'s branch origin/$TARGET no longer exists on the remote; nothing was staged, committed or pushed"; exit 1; }',
    '  git merge-base --is-ancestor "origin/$TARGET" "$B" || { echo "deliver: pull request #$PRNUM\'s branch moved since this run based on it (origin/$TARGET is no longer an ancestor of $B); nothing was staged, committed or pushed — launch a new revision on the current head, or rebase $B onto origin/$TARGET by hand and approve to retry"; echo "deliver: pull request #$PRNUM\'s branch moved — refused; nothing was pushed"; exit 1; }',
    'fi',
    // (a2) VERIFIED-BASE PIN (wicked-core#431 / #433). Before this script runs, the engine LIFTED the
    // run's work onto the remote default branch's tip and re-ran the repository's checks when the
    // lift changed the tree; it hands the tip it verified against as WICKED_DELIVER_VERIFIED_BASE
    // (absent when its lift was skipped — no remote, no default ref, a branch carrying its own
    // commits — and on a post-hoc `POST /runs/:id/deliver`, which has no engine verification to pin
    // to). The engine's fetch and this script's fetch are two moments: a remote that advances in
    // between would make the rebase below carry the base PAST what was verified — F-3R2-013's
    // verified≠delivered gap, one window later. So when the pin is set and origin/<default> no
    // longer resolves to it, REFUSE, here, before anything is staged or committed: the worktree
    // stays exactly as the engine left it, so an approved retry re-lifts onto the new tip and
    // re-verifies from scratch. Deliberately NO LIFT-CONFLICT marker (see
    // DELIVER_BASE_MOVED_MARKER). An unresolvable default ref with the pin set refuses the same way
    // (fail closed): the script cannot prove the base it is about to rebase onto. The MARKER TRAILS
    // the line (review F-527-001): the engine keeps head-150 + tail-250 chars of the WHOLE output, and
    // this line follows the fetch's chatter, so a marker at its head would be elided while a trailing
    // one always lands in the tail — as the LIFT-CONFLICT push-failure line below already does.
    'if [ -n "${WICKED_DELIVER_VERIFIED_BASE:-}" ] && [ -z "$TARGET" ]; then',
    '  T=$(git rev-parse --verify -q "$D^{commit}" || true)',
    `  [ "$T" = "$WICKED_DELIVER_VERIFIED_BASE" ] || { echo "deliver: the engine verified this work against $WICKED_DELIVER_VERIFIED_BASE but $D is now \${T:-unresolvable} — refusing to rebase past the verified base; approve to retry the deliver phase (the engine lifts onto the new tip and re-runs the repository checks before pushing). Nothing was staged, committed or pushed; ${DELIVER_BASE_MOVED_MARKER} ($D now \${T:-unresolvable}, verified $WICKED_DELIVER_VERIFIED_BASE)"; exit 1; }`,
    'fi',
    // A failed PUSH happens after the product was committed. Keep its worktree from being reaped
    // by leaving this reserved, untracked recovery sentinel; it is removed HERE (before staging)
    // so a normal delivery never sees it, and a retry removes it before another attempt (crew#432).
    `S=${DELIVER_STRANDED_SENTINEL}`,
    'rm -f -- "$S"',
    // (c1) COMMIT THE RUN'S WORK (crew#317). Agents write files; they do not commit — which is
    // the premise of core#291 and the reason `d1bc72c2` pushed a branch identical to origin/main.
    // Author identity is deliberately NOT set here: the run worktree belongs to the operator's
    // own clone, so `git commit` uses the repo/user config that already exists (and fails loudly,
    // pushing nothing, if that config is missing). Staging is two passes (see below): tracked
    // changes always ride; untracked paths ride UNLESS a scratch/key-material classifier excludes
    // them — and every exclusion is reported loudly (crew#434).
    //
    // (c1-text) THE PR TITLE + BODY AND THE COMMIT MESSAGE (crew#524 / F-3R2-014). `--fill` gave
    // wicked-studio#249 a title cut mid-word and an EMPTY body. The text now comes from the run:
    // the script asks the daemon that launched it for `GET /runs/<id>/deliver-text` — composed from
    // the persisted run record (phases + seats + gate outcomes, repo checks with exit codes, the
    // evaluator verdict, the run link) — and falls back to the launch-time composition embedded
    // below (intent, `Fixes #N`, run id, phase list) when the daemon cannot answer: no origin
    // known, no `curl`, an auth-required daemon (401), a daemon that went away. Either way the text
    // is FRAMED the same (line 1 title, line 2 blank, then the body), it is the commit message
    // verbatim (`git commit -F`: git takes the first paragraph as the subject), and the PR is
    // opened with `--title` + `--body-file` from it. WHICH text was used is always said in the
    // output — every branch below prints its reason (Copilot on #525): no origin known, no curl,
    // the daemon did not answer, or the run record was fetched.
    'TD=$(mktemp -d)',
    "trap 'rm -rf \"$TD\"' EXIT",
    // One URL path segment, RFC 3986: unreserved bytes verbatim, everything else `%XX` (byte-wise
    // under LC_ALL=C so multibyte characters encode per byte, as a URL requires). Used only when
    // the composer did not bake the launch id in (Copilot on #525: `/`, `#`, `?` in an id must
    // not change the request path).
    "_urlenc() { local LC_ALL=C s=\"$1\" out=\"\" i c; for ((i=0; i<${#s}; i++)); do c=\"${s:i:1}\"; case \"$c\" in [A-Za-z0-9._~-]) out+=\"$c\";; *) out+=$(printf '%%%02X' \"'$c\");; esac; done; printf '%s' \"$out\"; }",
    `RUNID='${runIdSegment}'`,
    '[ -n "$RUNID" ] || RUNID=$(_urlenc "${B#wicked/}")',
    // Is the fetched text FRAMED as promised — non-empty title line, blank line 2, a non-empty body?
    // Anything else (a proxy page, a stale endpoint's JSON, a bare title) is not the run record
    // and must not become the PR text (Copilot on #525).
    "_framed() { [ -s \"$1\" ] && [ -n \"$(sed -n 1p \"$1\")\" ] && [ -z \"$(sed -n 2p \"$1\")\" ] && [ -n \"$(sed -n '3,$p' \"$1\" | tr -d '[:space:]' | head -c 1)\" ]; }",
    `API='${api}'`,
    'if [ -z "$API" ]; then',
    '  echo "deliver: no daemon origin was known when this run launched — using the launch-time PR text"',
    'elif ! command -v curl >/dev/null 2>&1; then',
    '  echo "deliver: curl is not available in this shell — using the launch-time PR text"',
    // `--noproxy "*"`: the daemon is loopback; an operator shell's http_proxy must not swallow it.
    'elif curl -fsS -m 20 --noproxy "*" -H "Accept: text/plain" "$API/api/v1/runs/$RUNID/deliver-text" -o "$TD/text" 2>/dev/null && _framed "$TD/text"; then',
    '  echo "deliver: PR text composed from the run record ($API)"',
    'else',
    '  rm -f "$TD/text"',
    '  echo "deliver: the daemon at $API did not answer with the run record — using the launch-time PR text"',
    'fi',
    'if [ ! -s "$TD/text" ]; then',
    // The delimiter is chosen so no line of the text equals it (heredocDelimiter) — the text,
    // title line included, is never filtered.
    `  cat > "$TD/text" <<'${heredoc}'`,
    ...fallbackLines,
    heredoc,
    'fi',
    'TITLE=$(sed -n 1p "$TD/text")',
    `cat > "$TD/subject" <<'${subjectHeredoc}'`,
    ...subjectLines,
    subjectHeredoc,
    `cat > "$TD/fbtitle" <<'${subjectHeredoc}'`,
    ...fallbackTitleLines,
    subjectHeredoc,
    // The subject for the title actually used: the composed one when the daemon's title is the
    // embedded fallback's; else (the daemon titled it differently) a plain word-boundary cut at 72.
    'if [ "$(cat "$TD/fbtitle")" != "$TITLE" ]; then printf \'%s\\n\' "$TITLE" | awk \'{ if (length($0) <= 72) print; else { s = substr($0, 1, 71); sub(/ [^ ]*$/, "", s); print s "…" } }\' > "$TD/subject"; fi',
    // The commit message: the text verbatim when its title fits the subject width, else the 72-column
    // subject, a blank line, then the text (whose first line is the full title) — crew#550.
    'if [ "$(cat "$TD/subject")" = "$TITLE" ]; then cp "$TD/text" "$TD/commit"; else { cat "$TD/subject"; echo; cat "$TD/text"; } > "$TD/commit"; fi',
    "sed '1,2d' \"$TD/text\" > \"$TD/body\"",
    // (c0) DELIVER PREFLIGHT (crew#426) — a governed run that bumps an internal WORKSPACE package's
    // version (e.g. packages/crew-api-types) leaves its version-derived codegen AND the lockfile
    // stale. A per-run worktree is provisioned with `git worktree add` alone — no `node_modules` —
    // so the version-stamping generators resolve the PARENT checkout's node_modules (its UN-bumped
    // version) and nothing ever re-syncs package-lock.json to the worktree's own package.json. CI
    // then reddens on the delivered PR: `endpoint-manifest.test.ts` fails once CI's `npm ci` relinks
    // api-types to the worktree's bumped version and the committed manifest disagrees, and the
    // lockfile↔package.json drift is a latent install hazard (a repo that pins the dep instead of `*`
    // would fail `npm ci` outright). This blocks EVERY governed run that changes an API field. Re-sync
    // BOTH here, BEFORE the commit, so the tracked-only staging below stages the regenerated
    // endpoint-manifest.json, the generated api-sample test, and the re-synced package-lock.json.
    //
    // Scoped to the CREW WORKSPACE — the whole preflight (lockfile re-sync AND codegen) runs only
    // when the root package.json + package-lock.json AND packages/crew + packages/crew-api-types are
    // present. `deliverPrScript` is otherwise repo-agnostic, so a bare `npm install` on any repo that
    // merely happens to carry a root lockfile would run its install-time scripts, add latency, and —
    // worse — strand an otherwise-deliverable run whose external deps are not cached under a
    // restricted network (Copilot, crew#428). The #426 invariant only applies to crew's own codegen,
    // so gate the entire block on crew's machinery; every other repo is a byte-for-byte NO-OP. For the
    // crew workspace it is also unchanged when nothing was bumped (an already-in-sync `npm install`
    // rewrites neither the lockfile nor the codegen). `npm install` (never `npm ci`, which cannot
    // re-sync a lockfile and would itself fail on a pinned-dep mismatch) re-syncs the lockfile;
    // `--prefer-offline` keeps it off the registry
    // for a workspace-internal bump (no new tarball to fetch), so a restricted network does not fail
    // delivery. A genuine failure of a step that DID apply stays LOUD (no LIFT-CONFLICT marker →
    // terminal run failure), preserving the phase's refusal posture — the preflight adds no new strand.
    //
    // (c0-guard) THE PREFLIGHT MUST NOT WEAKEN THE VERIFIED TREE (wicked-core#433 review addendum).
    // The engine verified the worktree BEFORE this script runs; the re-sync above runs AFTER it. If
    // the regeneration changes any file, the tree that would ship is no longer the tree the
    // repository's checks certified. So the worktree CONTENT is snapshotted as a tree id before and
    // after (through a scratch index — the real index is untouched) and compared. An engine-driven
    // delivery (a Tool unit; WICKED_DELIVER_POSTHOC unset) REFUSES on a change and names the files.
    // The regenerated files stay in the worktree, so the remedy is simply to approve the retry: the
    // engine re-verifies the changed tree (tree ≠ recorded verified tree ⇒ the checks run) before
    // this script runs again, and the retry's preflight regenerates nothing. The crew#426 repair
    // thus costs one gate approval on an engine-driven run and ships verified. A post-hoc lift
    // (WICKED_DELIVER_POSTHOC=1, `POST /runs/:id/deliver`) has no engine verification to protect and
    // keeps the crew#426 behaviour — but SAYS which tracked files it regenerated, so the PR reviewer
    // sees it. Deliberately NO LIFT-CONFLICT marker: a regenerated tree is not a recoverable strand.
    // The scratch index is SEEDED from HEAD before `add -A` (review F-527-007), so a tracked path a
    // `.gitignore` also matches is still in both snapshots and its regeneration is seen; a git failure
    // is loud (no swallowed stderr — a partial snapshot on both sides would compare equal).
    '_tree() { rm -f "$TD/preidx"; GIT_INDEX_FILE="$TD/preidx" git read-tree HEAD && GIT_INDEX_FILE="$TD/preidx" git add -A -- . && GIT_INDEX_FILE="$TD/preidx" git write-tree; }',
    'if [ -f package.json ] && [ -f package-lock.json ] && [ -f packages/crew/package.json ] && [ -f packages/crew-api-types/package.json ]; then',
    '  T0=$(_tree) || { echo "deliver: could not snapshot the worktree before the preflight; nothing was staged, committed or pushed"; exit 1; }',
    '  npm install --prefer-offline --no-audit --no-fund',
    '  npm run manifest:endpoints -w packages/crew',
    '  npm run generate:api-tests -w packages/crew',
    '  T1=$(_tree) || { echo "deliver: could not snapshot the worktree after the preflight; nothing was staged, committed or pushed"; exit 1; }',
    '  if [ "$T0" != "$T1" ]; then',
    '    CH=$(git diff-tree -r --name-only "$T0" "$T1" | tr "\\n" " ")',
    // The marker TRAILS the line, followed by the file list, so both survive the engine's tail-250
    // excerpt after the install/codegen chatter (review F-527-001).
    `    if [ -z "\${WICKED_DELIVER_POSTHOC:-}" ]; then echo "deliver: the crew#426 lockfile/codegen re-sync CHANGED the worktree after the engine verified it — refusing to push a tree the engine did not verify. The regenerated files are left in the worktree (unstaged); approve to retry the deliver phase: the engine re-verifies the changed tree first and this script then delivers it (a second regeneration changes nothing). Nothing was staged, committed or pushed; ${DELIVER_PREFLIGHT_CHANGED_MARKER}: \${CH}"; exit 1; fi`,
    '    echo "deliver: preflight regenerated tracked files on a post-hoc lift (no engine verification to protect): $CH"',
    '  fi',
    'fi',
    // (c1a) TRACKED CHANGES ALWAYS RIDE. `git add -u` stages every modification/deletion to an
    // already-tracked path (the run's product for that class), including the crew#426 preflight's
    // regenerated, already-tracked lockfile/manifest/codegen above.
    'git add -u',
    // (c1b) UNTRACKED PATHS — the crew#434 classifier. `git add -A` swept EVERY non-ignored
    // untracked path into the governed PR, so a repo whose `.gitignore` missed its own test
    // scratch (a `bus.db`, a `socket.path` with a username, `.webm`/`.gif` recordings) leaked ~31
    // files into a run's PR. The fix cannot lean on the target repo's `.gitignore` being right, so
    // each untracked candidate (`git ls-files --others --exclude-standard` — gitignore honored
    // first, NUL-delimited so odd names survive) is classified per-file: it is staged (it is the
    // run's deliberately-produced product) UNLESS it looks like scratch or key material —
    //   • denylisted name/extension: databases (.db/.sqlite*), sockets (.sock), pids (.pid),
    //     dotenv (.env*), recordings (.gif/.webm/.mp4/.mov), key material
    //     (*.pem/*.key/*.p12/*.pfx/id_rsa*/*credentials*);
    //   • a basename containing `socket` (covers `socket.path`, which has no fixed extension);
    //   • a path under an obvious scratch/cache dir (tmp/ .tmp/ scratch/ .cache/ coverage/) or
    //     a `.DS_Store`;
    //   • any otherwise-unrecognised file larger than 1 MiB (a generic net for future scratch).
    // EVERYTHING ELSE RIDES — the floor's job is hygiene, not taste; an allowlist would silently
    // drop a legitimate new asset. This is a GUARD, NOT A SILENT DROP (the issue's own words):
    // every excluded path is printed with its reason, so a clean delivery that skipped files is
    // still fully auditable in the phase output (retained + served on the run wire), never
    // laundered. `git add` here never touches the untracked recovery sentinel: it was removed
    // above, before this pass.
    //
    // F-BM-002 (crew#579): the top-level scratch DIRECTORIES — the engine's own `tmp/` (the
    // repo-checks floor's `tmp/wicked-checks`, the worker's pytest temp, node's compile cache; 35 k
    // files on one benchmark run) and the other four — are excluded AT ENUMERATION with git
    // pathspecs and reported ONCE with a count, never walked file-by-file with a fork per file.
    // The per-file `*/tmp/*` arm below still catches a nested scratch dir.
    'for SD in tmp .tmp scratch .cache coverage; do',
    '  if [ -d "$SD" ]; then N=$(git ls-files --others --exclude-standard -- "$SD" | wc -l | tr -d " "); if [ "${N:-0}" -gt 0 ]; then echo "deliver: EXCLUDED (scratch-dir): $SD/ ($N files)"; fi; fi',
    'done',
    'while IFS= read -r -d "" F; do',
    '  [ -n "$F" ] || continue',
    '  BN=${F##*/}; RN=""',
    // The recovery sentinel is removed above, so this arm is the ONE predicate's first rule, kept
    // here so `deliverExclusionByName` and this classifier stay the same ladder (N2).
    '  [ "$F" = "$S" ] && RN="delivery-sentinel"',
    // Classify on a LOWERCASED basename so DEPLOY.KEY / .ENV / SOCKET.PATH cannot bypass the
    // denylist by case (review, #439).
    '  LBN=$(printf "%s" "$BN" | tr "[:upper:]" "[:lower:]")',
    '  case "$LBN" in',
    '    *.db|*.db-wal|*.db-shm|*.sqlite|*.sqlite2|*.sqlite3|*.sqlite-wal|*.sqlite-shm|*.sock|*.pid|*.env|*.env.*|.envrc|*.gif|*.webm|*.mp4|*.mov|*.pem|*.key|*.p12|*.pfx|id_rsa*|*credentials*) RN="denylisted-name";;',
    '  esac',
    '  case "$LBN" in *socket*) [ -n "$RN" ] || RN="socket-name";; esac',
    '  [ "$BN" = ".DS_Store" ] && [ -z "$RN" ] && RN="ds-store"',
    '  case "/$F" in */tmp/*|*/.tmp/*|*/scratch/*|*/.cache/*|*/coverage/*) [ -n "$RN" ] || RN="scratch-dir";; esac',
    '  if [ -z "$RN" ]; then SZ=$(wc -c < "$F" 2>/dev/null || echo 0); [ "${SZ:-0}" -gt 1048576 ] && RN="oversize-1mib"; fi',
    '  if [ -n "$RN" ]; then echo "deliver: EXCLUDED ($RN): $F"; else git add -- "$F"; fi',
    "done < <(git ls-files --others --exclude-standard -z -- . ':(exclude)tmp' ':(exclude).tmp' ':(exclude)scratch' ':(exclude).cache' ':(exclude)coverage')",
    // Only commit when something is staged — a run that committed incrementally (core#280's
    // liveness contract) leaves a clean tree and must not gain an empty commit here.
    // `--cleanup=whitespace`, NOT git's default for `-F`: an operator/repo `commit.cleanup=strip`
    // would otherwise treat every `## Intent` / `## Run` / `## Phases` heading as a `#` comment and
    // strip it from the commit body (review W3-K1).
    'git diff --cached --quiet || git commit -q --cleanup=whitespace -F "$TD/commit"',
    // (c2) NOTHING TO DELIVER — no staged work AND no commits of its own. Fail LOUDLY before the
    // remote is touched: an empty ref pushed under a run id is worse than a failed phase.
    'if [ -n "$TARGET" ]; then A=$(git rev-list --count "origin/$TARGET..$B"); [ "$A" -ge 1 ] || { echo "deliver: nothing to deliver — the run added no commit on top of PR #$PRNUM"; exit 1; }; else',
    'A=$(git rev-list --count "$D..$B")',
    '[ "$A" -ge 1 ] || { echo "deliver: nothing to deliver — the run produced no committed change ($B is not ahead of $D); nothing was pushed"; exit 1; }',
    'fi',
    // (c3) Rebase onto origin's default branch so the PR opens mergeable — NEW-PR mode only: a
    // revision keeps the PR's own history and pushes its commits on top of the PR head as-is.
    //
    // crew#418 B — the CHANGELOG collision magnet: two runs that both append to CHANGELOG's
    // `[Unreleased]` section conflict on the rebase BY CONSTRUCTION, though their added bullet
    // lines never truly disagree. A conflict whose conflicted paths are ALL `CHANGELOG.md`
    // (matched by basename) is resolved automatically with a UNION merge — `git merge-file
    // --union` keeps BOTH sides' lines, no markers — and the rebase continues. This is scoped to
    // the changelog and touches NOTHING else: a conflict in any other file is left exactly as
    // loud as before (the "never weaken rebase loudness for non-changelog files" rule).
    //
    // crew#418 A — a conflict that is NOT changelog-only (or a changelog union that fails) is a
    // real LIFT collision: abort the rebase (nothing pushed; the abort leaves the worktree on the
    // pre-rebase branch tip, not mid-rebase) and exit carrying DELIVER_LIFT_CONFLICT_MARKER. The
    // run's committed work is safe on its branch, so crew reinterprets THIS refusal as `completed`
    // + `delivery: 'stranded'` (recoverable via POST /runs/:id/deliver) rather than a run failure.
    '_rebasing() { [ -d "$(git rev-parse --git-path rebase-merge 2>/dev/null)" ] || [ -d "$(git rev-parse --git-path rebase-apply 2>/dev/null)" ]; }',
    'if [ -z "$TARGET" ]; then',
    'if ! git rebase "$D" "$B"; then',
    // A rebase that failed WITHOUT leaving in-progress state never started — a preflight error
    // (bad ref, unexpected worktree state), not a conflict. Fail LOUD rather than fall through to
    // the push as if the rebase had succeeded; nothing was pushed.
    '  if ! _rebasing; then echo "deliver: git rebase of $B onto $D failed before it started (preflight error); nothing was pushed"; exit 1; fi',
    '  while _rebasing; do',
    '    CF=$(git diff --name-only --diff-filter=U || true)',
    '    [ -n "$CF" ] || break',
    // Any conflicted path that is not a CHANGELOG.md → a real collision; stop resolving and strand.
    '    if printf "%s\\n" "$CF" | grep -qvE "(^|/)CHANGELOG\\.md$"; then break; fi',
    // Union-merge every conflicted changelog — but ONLY when the two sides differ SOLELY within
    // the `## [Unreleased]` section. A union keeps both sides of every conflict hunk, so a
    // whole-file union of two edits to the SAME released-version line would silently combine
    // them; we refuse that. Guard: strip the [Unreleased] block (from `## [Unreleased]` up to the
    // next `## [` heading) from both stage-2 (ours) and stage-3 (theirs); if the remainder is not
    // byte-identical, the divergence is outside [Unreleased] → a real conflict → break (strand).
    // When they ARE identical outside it, the only conflicting hunks are within [Unreleased], so
    // the whole-file --union affects nothing else. A missing base stage (add/add) unions against
    // an empty base; any git failure breaks out to the loud abort below.
    '    if ! printf "%s\\n" "$CF" | while IFS= read -r F; do',
    '          [ -n "$F" ] || continue;',
    '          TB=$(mktemp); TO=$(mktemp); TT=$(mktemp);',
    '          git show ":1:$F" >"$TB" 2>/dev/null || : >"$TB";',
    '          git show ":2:$F" >"$TO" 2>/dev/null || { rm -f "$TB" "$TO" "$TT"; exit 1; };',
    '          git show ":3:$F" >"$TT" 2>/dev/null || { rm -f "$TB" "$TO" "$TT"; exit 1; };',
    "          _strip='/^## \\[Unreleased\\]/{s=1;next} s&&/^## \\[/{s=0} !s{print}';",
    '          SO=$(awk "$_strip" "$TO"); ST=$(awk "$_strip" "$TT");',
    '          if [ "$SO" != "$ST" ]; then rm -f "$TB" "$TO" "$TT"; exit 1; fi;',
    '          git merge-file -q --union "$TO" "$TB" "$TT" || { rm -f "$TB" "$TO" "$TT"; exit 1; };',
    '          cat "$TO" >"$F"; git add -- "$F"; rm -f "$TB" "$TO" "$TT";',
    '        done; then break; fi',
    '    GIT_EDITOR=true git -c core.editor=true rebase --continue >/dev/null 2>&1 || break;',
    '  done',
    `  if _rebasing; then git rebase --abort >/dev/null 2>&1 || true; echo "${DELIVER_LIFT_CONFLICT_MARKER} — rebase of $B onto $D hit conflicts outside the changelog; resolve on the branch and re-run; nothing was pushed"; exit 1; fi`,
    'fi',
    // Re-derive after the rebase: it drops commits already upstream (patch-id equal), so a branch
    // that WAS ahead can come out of a rebase carrying nothing of its own.
    'A=$(git rev-list --count "$D..$B")',
    '[ "$A" -ge 1 ] || { echo "deliver: nothing to deliver — the run produced no committed change (after rebasing onto $D, $B carries no commit of its own); nothing was pushed"; exit 1; }',
    'fi',
    // (d) Push. Any push failure happens AFTER the work was committed and its branch was proven
    // ahead, whether the remote branch moved, auth returned 403, the transport is down, or a hook
    // rejected it. It is a REFUSAL BY THE REMOTE, not a lift collision (N4): the lift already came
    // out clean. Preserve git's own output, leave the recovery sentinel, and print
    // DELIVER_PUSH_REJECTED_MARKER last — never the LIFT-CONFLICT marker — so the engine takes its
    // deterministic deliver-refusal arm and parks the run at a gate; nothing pushes again until a
    // human approves the retry.
    // A revision pushes the run branch ONTO the PR's head branch (`$B:refs/heads/$TARGET`) — the
    // PR gains exactly the run's commits; a rejection there is the same recoverable strand.
    '_push() { if [ -n "$TARGET" ]; then git push origin "$B:refs/heads/$TARGET"; else git push -u origin "$B"; fi; }',
    'if PUSHOUT=$(_push 2>&1); then echo "$PUSHOUT"; else',
    '  echo "$PUSHOUT"',
    '  case "$PUSHOUT" in',
    `    *non-fast-forward*|*"fetch first"*|*"[rejected]"*|*"Updates were rejected"*) : > "$S"; echo "deliver: the remote refused the push of $B because its branch moved (non-fast-forward); the work is committed on $B and nothing was pushed — approve to retry the deliver phase; ${DELIVER_PUSH_REJECTED_MARKER}"; exit 1;;`,
    `    *) : > "$S"; PUSHERR="\${PUSHOUT:0:96} ... \${PUSHOUT: -128}"; PUSHERR=\${PUSHERR//$'\\n'/ }; echo "deliver: the remote refused the push of $B after commit: $PUSHERR; the work is committed on $B and nothing was pushed — fix the remote condition, then approve to retry the deliver phase; ${DELIVER_PUSH_REJECTED_MARKER}"; exit 1;;`,
    '  esac',
    'fi',
    // (e) Open the PR with gh's OUTPUT and EXIT STATUS captured separately (crew#317). The old
    // `| tail -1` threw away everything gh said but one line and made the phase's verdict a
    // property of a shell option; a gh failure now fails the phase carrying gh's own message.
    // Title and body are the composed text (c1-text) — never `--fill` (crew#524).
    // REVISION (DES-L9): no PR is opened — the one that exists gained the commits. Done is
    // re-derived from the REMOTE: origin/$TARGET must now be exactly $B. The PR's state is read
    // and disclosed (a PR merged or closed in the window is a warning, not a failure — the commits
    // landed, and a refusal here would loop "nothing to deliver" on the retry). The run record then
    // rides `gh pr comment` (the body the PR-create path would have used); a comment failure is
    // printed, not fatal — the commit message carries the same record.
    'if [ -n "$TARGET" ]; then',
    '  git fetch -q origin "$TARGET"',
    '  RT=$(git rev-parse "origin/$TARGET"); LT=$(git rev-parse "$B")',
    '  [ "$RT" = "$LT" ] || { echo "deliver: origin/$TARGET is at ${RT:0:10} after the push, not at $B (${LT:0:10}) — refusing to report a delivery the remote does not show"; exit 1; }',
    '  ST=$(gh pr view "$PRNUM" --json state -q .state 2>/dev/null || true)',
    '  if [ "$ST" = "OPEN" ]; then echo "deliver: pull request #$PRNUM is OPEN and its branch $TARGET is at $B"; else echo "deliver: warning — pull request #$PRNUM reads ${ST:-unknown} (not OPEN) after the push; the commits landed on origin/$TARGET"; fi',
    '  if COUT=$(gh pr comment "$PRNUM" --body-file "$TD/body" 2>&1); then echo "deliver: run record commented on pull request #$PRNUM"; else echo "$COUT"; echo "deliver: could not comment on pull request #$PRNUM — the commits landed; the record is in the commit message"; fi',
    '  URL="$PRURL"',
    'else',
    // (e2) A NON-GITHUB ORIGIN DELIVERS THE BRANCH (F2). `gh pr create` failing used to be
    // `exit 1` with no fallback and no push-only mode, so on a local, SSH, GitLab, ADO or Gitea
    // origin the phase PUSHED THE BRANCH — step (d), above, already happened — and then died on
    // "none of the git remotes configured for this repository point to a known GitHub host".
    // Approving the retry re-ran the identical refusal; rejecting cancelled the run. The run could
    // never reach a terminal state while the one irreversible side effect was already done.
    //
    // gh is the AUTHORITY on whether a remote is a GitHub remote — it resolves the remotes itself
    // and that refusal IS its verdict — so the push-only success path opens on that message and on
    // nothing else. The pattern requires BOTH halves of the diagnostic, in order, rather than one
    // fragment (codex review of this PR, MEDIUM), while skipping the leading "none of the" and the
    // point/points verb so a gh wording tweak cannot silently re-open the F2 hole. Every other gh failure (auth, validation, rate limit, a gh that is not
    // installed) stays exactly as loud as it was, which is what keeps a GitHub Enterprise Server
    // origin — where gh succeeds — on the pull-request path. No forge integration is invented
    // here: the pushed branch IS the delivery, and the phase says so and says where to take it.
    //
    // Done is still RE-DERIVED before the claim: the remote ref must be ahead of the base. And
    // nothing may read a pull request out of this output — there is no URL in it, so `prUrlFrom`
    // answers null and the run's `delivery` never reads `delivered`.
    '  if ! OUT=$(gh pr create --head "$B" --title "$TITLE" --body-file "$TD/body" 2>&1); then',
    '    echo "$OUT"',
    '    case "$OUT" in',
    '      *"git remotes configured for this repository"*"known GitHub host"*)',
    '        P=$(git rev-list --count "$D..origin/$B")',
    '        [ "$P" -ge 1 ] || { echo "deliver: $B is not ahead of $D on the remote after the push — refusing to report a delivery with no commits"; exit 1; }',
    // The PUSH url, with any `user[:password]@` userinfo stripped before it reaches the transcript
    // (codex review of N1: a push URL can carry a deploy token).
    '        R=$(git remote get-url --push origin | sed -E "s#^([A-Za-z][A-Za-z0-9+.-]*://)[^@/]*@#\\1#")',
    '        echo "deliver: pushed $B to origin ($R) with $P commit(s) on top of $D, and no pull request was opened because that remote is not a GitHub host gh can resolve. The branch IS the delivery — open the pull/merge request for $B on your forge; merge stays human.";',
    // N1: the machine line the daemon records the push-only delivery from — LAST, one line.
    `        echo "${DELIVER_PUSHED_NO_PR_MARKER} $B $R";`,
    '        exit 0;;',
    '    esac',
    '    echo "deliver: gh pr create failed for $B — no PR was opened"; exit 1',
    '  fi',
    '  echo "$OUT"',
    // (f) DONE IS RE-DERIVED, NOT ASSERTED — twice, from two independent facts, before the phase
    // is allowed to report a delivery:
    //   1. gh actually produced a PR URL (an exit code alone is a claim, not evidence);
    //   2. the ref ON THE REMOTE is ahead of origin's default branch by at least one commit.
    "  URL=$(printf '%s\\n' \"$OUT\" | grep -Eo 'https://[^[:space:]]+/pull/[0-9]+' | tail -1 || true)",
    '  [ -n "$URL" ] || { echo "deliver: gh pr create exited 0 but produced no PR URL for $B — refusing to report a delivery nothing can be pointed at"; exit 1; }',
    '  P=$(git rev-list --count "$D..origin/$B")',
    '  [ "$P" -ge 1 ] || { echo "deliver: $B is not ahead of $D on the remote after the push — refusing to report a delivery with no commits"; exit 1; }',
    'fi',
    'echo "$URL"',
  ].join('\n');
}

/**
 * The deliver phase definition — the PhaseDef JSON shape core accepts, fully spelled out so the
 * composed def round-trips through `registerWorkflow` (core's serde) and crew's own `WorkflowDef`
 * type without casts. `gate: 'auto'` + `executes_code: false`: the phase is deterministic tooling,
 * not governed agent work — its failure surface is the exit code + output, which core reports as
 * a failed unit.
 *
 * ## Why `verified_evidence: true` AND `validator_pin: EVIDENCE_FLOOR_PIN` (crew#317, core#414)
 *
 * The phase that touches the remote was the one phase nothing re-derived. The engine's phase model
 * DOES let a Tool-executor phase carry a deterministic floor: the flag says the phase's evidence is
 * re-verified, the pin says by what.
 *
 *  - a pin is a CONTENT ADDRESS into core's validator vault, and `attach_pinned_validators` is
 *    fail-closed on one that does not resolve — it BAILS the run at plan time. Authoring and
 *    approving a validator is `wicked-core provision-validator` + `approve-validator`, neither of
 *    which is exposed through the napi surface crew drives, so a pin crew INVENTED would fail
 *    every run on a machine nobody seeded by hand;
 *  - the built-in evidence floor is different: `pre_distribute` seeds it on the plan path so it
 *    ALWAYS resolves — it is the same pin core's own `feature/test`, `bug/verify` and
 *    `migration/verify` carry;
 *  - and since wicked-core#414 (codex review) the engine no longer arms a flagged phase that names
 *    no pin — registration judges the def AS AUTHORED and REFUSES it ("verified_evidence declared
 *    but nothing pinned: deliver-pr"). A `null` pin here would refuse every deliver-composed run.
 *
 * The floor then re-runs against the run's worktree at the gate, INDEPENDENTLY of anything this
 * script printed, and denies the phase when the run left no change. Layer 2 (the agent judge)
 * stays out of it: core hands the Tool path `agent_verdict: None`, so a tool phase's floor is
 * deterministic and costs no LLM call. The PR-URL and branch-ahead assertions stay in the script
 * because no vaulted floor can see the remote.
 */
export function deliverPrPhase(
  dependsOn: string[] = [],
  intent?: string,
  opts: DeliverScriptOptions = {},
): PhaseDef {
  return {
    id: DELIVER_PHASE_ID,
    kind: 'build',
    executor: { type: 'tool', cmd: ['bash', '-lc', deliverPrScript(intent, opts)] },
    // DES-L9: the deliver GATE card text — what the push will do and under which identity, with
    // the pin source named (F9). The engine folds `instructions` onto the unit description after
    // ` ||| ` (core `plan_from_def`), and `advance_or_pause` prints the description on the gate.
    instructions: deliverGateInstructions(opts),
    gate_type: null,
    gate: 'auto',
    executes_code: false,
    verified_evidence: true,
    required_deliverables: [],
    depends_on: dependsOn,
    role: 'neutral',
    skill_ref: null,
    allowed_skills: [],
    validator_pin: EVIDENCE_FLOOR_PIN,
  };
}

/**
 * What the deliver gate card says (DES-L9 §4): the push target — onto the revised PR's branch, or a
 * new PR — and the push identity with its pin source: `GH_ACCOUNT` pinned by an exported `GH_TOKEN`
 * (then `gh api user` IS the token's login and the script refuses on a difference), `GH_ACCOUNT`
 * from the gh keyring (the login can flip between this check and the push — export `GH_TOKEN` to
 * pin it), or unset (pushes as whatever login gh holds). Never the token, never a live probe.
 */
/**
 * How a `git remote get-url origin` value reads for the deliver gate card (F2).
 *
 *  - `'none'`    — no `origin` remote at all (`''`), or nothing could be read (`null`/absent). The
 *                  two are told apart by the caller: `''` means READ AND ABSENT, and only that one
 *                  licenses a claim about it.
 *  - `'local'`   — a filesystem path or `file://` URL: a bare clone, a fixture, a sibling checkout.
 *                  `gh` cannot open a pull request against it and never will.
 *  - `'github'`  — `github.com` (or a subdomain of it).
 *  - `'other'`   — some other host. Deliberately NOT called "not GitHub": a GitHub Enterprise
 *                  Server install is an arbitrary hostname, and gh — which resolves the remote
 *                  itself — is the only authority on whether it can open a pull request there.
 */
export type DeliverOriginKind = 'none' | 'local' | 'github' | 'other';

/** The host of a git remote URL — `https://`/`ssh://` URLs and the scp-like `git@host:owner/repo`
 *  spelling — or `null` when the value names no host (a path). */
export function originRemoteHost(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed === '') return null;
  // Any `scheme://…` is decided HERE, authority or not: `file:///p` has an empty authority and
  // names no host, and so does any other schemed URL written without one.
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(trimmed);
  if (scheme !== null) {
    if (scheme[1]!.toLowerCase() === 'file') return null;
    const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)/.exec(trimmed);
    return authority !== null ? authority[1]!.toLowerCase() : null;
  }
  // A Windows drive is a PATH, excluded by shape rather than by "a host is at least two letters"
  // — which also rejected the single-letter host `h:path` (codex review of this PR, LOW).
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return null;
  // scp-like: `[user@]host:path`. The path may be ABSOLUTE (`git@example.com:/srv/git/repo.git`
  // is valid scp syntax) — an earlier `(?!\/)` guard rejected exactly that and called a real
  // remote a local path (codex review, LOW).
  const scp = /^(?:[^@/\\]+@)?([A-Za-z0-9._-]+):/.exec(trimmed);
  return scp !== null ? scp[1]!.toLowerCase() : null;
}

/** {@link DeliverOriginKind} for an origin URL read at compose time. */
export function classifyDeliverOrigin(url: string | null | undefined): DeliverOriginKind {
  if (url === null || url === undefined || url.trim() === '') return 'none';
  const host = originRemoteHost(url);
  if (host === null) return 'local';
  return host === 'github.com' || host.endsWith('.github.com') ? 'github' : 'other';
}

/**
 * The gate card's first sentence for a NEW-PR delivery — what will ACTUALLY happen (F2).
 *
 * It used to promise "pushes its branch → opens a pull request" unconditionally. On a local, SSH,
 * GitLab, ADO or Gitea origin that was a false promise twice over: the phase pushed the branch and
 * then died on `gh pr create`, so the operator consented to a pull request that could not exist and
 * got an irreversible push plus a run that could not reach a terminal state. The push-only success
 * path in the script fixes the outcome; this fixes the consent.
 *
 * `null`/absent origin ⇒ the generic sentence, unchanged: "could not read it" is not a licence to
 * claim anything about it either way.
 */
export function newPrTargetSentence(originUrl: string | null | undefined): string {
  const kind = classifyDeliverOrigin(originUrl);
  const branch = 'the run branch wicked/<run>';
  if (kind === 'github') {
    return `Pushes ${branch} to origin and opens a pull request; merge stays human.`;
  }
  if (kind === 'local') {
    // NOT a flat "no pull request is opened": `gh pr create` resolves every configured remote, not
    // only `origin`, so a checkout whose origin is a path while some other remote is a GitHub
    // repository can still get one (codex review of this PR, MEDIUM). The push DESTINATION is what
    // this read establishes; the pull request is stated as the condition it actually is.
    return (
      `Pushes ${branch} to origin (${(originUrl ?? '').trim()}) — a local path, so no pull request ` +
      'can be opened against it: unless another remote in this checkout is a GitHub repository gh ' +
      'resolves, the pushed branch IS the delivery.'
    );
  }
  if (kind === 'other') {
    const host = originRemoteHost((originUrl ?? '').trim()) ?? 'that host';
    return (
      `Pushes ${branch} to origin (${host}) and opens a pull request only if gh resolves ${host} ` +
      'as a GitHub host it is logged in to; otherwise no pull request is opened and the pushed ' +
      'branch IS the delivery. Merge stays human.'
    );
  }
  if (originUrl === '') {
    return (
      `Pushes ${branch} to origin — but this repository has no \`origin\` remote, so the push ` +
      'will fail and nothing will be delivered. Add the remote first.'
    );
  }
  return `Pushes ${branch} to origin and opens a pull request; merge stays human.`;
}

export function deliverGateInstructions(opts: DeliverScriptOptions): string {
  const pr = opts.revisesPr ?? null;
  const target =
    pr !== null
      ? `Pushes wicked/<run> onto pull request #${pr.number} (branch ${pr.headRef}); no new PR.`
      : newPrTargetSentence(opts.originUrl);
  // (crew#549) The SETTING wins over the env var, and the card names which one it read, because
  // "pin it now if it must differ" is not an instruction an operator can follow without knowing
  // where the pin lives.
  const configured = (opts.deliverIdentity ?? '').trim();
  const account = configured !== '' ? configured : (opts.ghAccount ?? null);
  const source = configured !== '' ? 'the deliver identity setting' : 'GH_ACCOUNT';
  const who =
    account !== null && account !== ''
      ? opts.ghTokenPinned === true
        ? `Push identity: ${account} (${source}), pinned by GH_TOKEN — the phase refuses if gh's login differs at push time.`
        : `Push identity: ${account} (${source}) against the gh keyring — the login can change between the check and the push; export GH_TOKEN to pin it. The phase refuses if gh's login differs.`
      : 'Push identity: none configured — pushes as whatever login gh holds (set the deliver identity in system settings to pin it).';
  // Whatever is configured, the phase also asks git which credential IT would use for the
  // remote's host and refuses when the two logins disagree — the flip that pushed under an
  // unintended account (F-RC1-010).
  return `${target} ${who} It refuses if gh's login and git's credential for the remote disagree.`;
}

/**
 * Compose a PER-RUN workflow def: `base`'s phases (untouched — the shared def is never mutated)
 * plus the deliver phase appended last, under a run-scoped id. The caller registers the result
 * with the engine for THIS run only; nothing is written to the overlay dir and the composed id
 * never enters the user-workflow registry, so the catalog (`GET /workflows`) stays clean.
 *
 * `intent` is the run's problem statement — the PR title and commit subject are composed from it
 * (`core/deliver-text.ts`); omit it and they name the run id alone. `launch` carries what else is
 * known here (the repo, the daemon's own origin) so the phase's embedded fallback text names the
 * workflow, its phases and the run link, and so the script knows which daemon to ask for the
 * run-derived text at delivery time (crew#524).
 *
 * Throws when `base` already carries a `deliver` phase — appending a second phase with the same
 * id would be ambiguous at best; the caller launches such a def as-is instead (see
 * `CoreAdapter.launchRun`).
 */
export interface DeliverLaunchContext {
  repoRef?: string | null;
  apiOrigin?: string | null;
  /** DES-L9: the open PR this run revises — the deliver phase pushes onto its branch. */
  revisesPr?: RevisedPullRequest | null;
  /** The daemon's `GH_ACCOUNT` (for the gate card); `null` = unset. */
  ghAccount?: string | null;
  /** Whether `GH_TOKEN` is exported in the daemon environment (presence only). */
  ghTokenPinned?: boolean;
  /** (F2) The repo's `git remote get-url origin`, for the gate card's target sentence.
   *  `null`/absent = unreadable; `''` = read, and there is no `origin` remote. */
  originUrl?: string | null;
  /** (crew#549) The `deliverIdentityLogin` system setting — the login the push must run as. */
  deliverIdentity?: string | null;
}

/**
 * The `deliver` PLAN STEP a delivering PRESET launch hands the engine (DES-TEAMING-002 T3,
 * `LaunchOptions.deliverStepJson`): catalog `deliver`, id `deliver`, the same hardened push-and-PR
 * Tool command, gate-card instructions and evidence-floor pin as the composed phase below. The
 * engine appends it to the preset's plan and puts `deliver` in the floor, so the run stays ONE
 * team plan behind its `plan_approval` gate — crew never composes a def over a preset. The step
 * omits `depends_on` (compose gives `deliver` the step before it) and carries no
 * `verified_evidence` (a plan step cannot; DES rev 12 note 4: a recorded difference with no
 * runtime effect). `phases` only feeds the embedded fallback text.
 */
export function deliverPresetStep(
  /** The preset launched, or `null` for a user-composed plan. */
  presetName: string | null,
  phases: PhaseDef[],
  runId: string,
  intent?: string,
  launch: DeliverLaunchContext = {},
): { catalog: 'deliver'; id: string; instructions: string; executor: PhaseDef['executor']; validator_pin: string } {
  const apiOrigin = launch.apiOrigin ?? null;
  const revisesPr = launch.revisesPr ?? null;
  const facts = factsFromWorkflow({
    runId,
    intent,
    workflowId: presetName,
    repoRef: launch.repoRef ?? null,
    phases,
    runUrl: runUrlFor(configuredPublicOrigin(), runId),
    revisesPr: revisesPr === null ? null : { number: revisesPr.number, url: revisesPr.url },
  });
  const phase = deliverPrPhase([], intent, {
    runId,
    facts,
    apiOrigin,
    revisesPr,
    ghAccount: launch.ghAccount ?? null,
    ghTokenPinned: launch.ghTokenPinned === true,
    originUrl: launch.originUrl ?? null,
    deliverIdentity: launch.deliverIdentity ?? null,
  });
  return {
    catalog: 'deliver',
    id: DELIVER_PHASE_ID,
    instructions: phase.instructions ?? '',
    executor: phase.executor,
    validator_pin: EVIDENCE_FLOOR_PIN,
  };
}

export function composeDeliverWorkflow(
  base: WorkflowDef,
  runId: string,
  intent?: string,
  launch: DeliverLaunchContext = {},
): WorkflowDef {
  if (base.phases.some((p) => p.id === DELIVER_PHASE_ID)) {
    throw new Error(
      `workflow '${base.id}' already has a '${DELIVER_PHASE_ID}' phase — launch it without deliver: "pr"`,
    );
  }
  const last = base.phases[base.phases.length - 1];
  // Run ids are UUIDs from the route, but the CLI path accepts caller-supplied ids — keep the
  // composed id inside the same safe charset `registerWorkflow` enforces for user defs.
  const safeRunId = runId.replace(/[^a-zA-Z0-9._-]/g, '_');
  // registerWorkflow enforces id.length <= 128; a caller-supplied CLI session id can be long.
  // Truncate the run-id TAIL, keeping the base+marker prefix intact (Copilot on #303).
  const composedId = `${base.id}-deliver-${safeRunId}`.slice(0, 128);
  const apiOrigin = launch.apiOrigin ?? null;
  const revisesPr = launch.revisesPr ?? null;
  const facts = factsFromWorkflow({
    runId,
    intent,
    workflowId: base.id,
    repoRef: launch.repoRef ?? null,
    phases: base.phases,
    runUrl: runUrlFor(configuredPublicOrigin(), runId),
    revisesPr: revisesPr === null ? null : { number: revisesPr.number, url: revisesPr.url },
  });
  return {
    // No `is_system` on purpose: core's overlay/register schema rejects unknown fields, and the
    // composed def is engine-input, not catalog data.
    id: composedId,
    phases: [
      ...base.phases,
      deliverPrPhase(last !== undefined ? [last.id] : [], intent, {
        runId,
        facts,
        apiOrigin,
        revisesPr,
        ghAccount: launch.ghAccount ?? null,
        ghTokenPinned: launch.ghTokenPinned === true,
        // F2 — the origin the push will actually go to, so the gate card cannot promise a pull
        // request on a remote that can never carry one.
        originUrl: launch.originUrl ?? null,
        deliverIdentity: launch.deliverIdentity ?? null,
      }),
    ],
  };
}
