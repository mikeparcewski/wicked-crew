import type { SessionView } from '../core/types.js';
import { isSafeRefName, type GhExec } from '../core/deliver.js';
import { seatKey } from '../interactive/review-events.js';

export const REVIEW_CHANGE_WORKFLOW = 'review-change';
export const REVIEW_PROVENANCE_WINDOW_DAYS = 90;

export type ReviewTarget =
  | { kind: 'pr'; number: number }
  | { kind: 'branch'; name: string }
  | { kind: 'commit'; sha: string };

/** Prefer explicit PR references over branches and commits, so incidental hashes cannot retarget a review. */
export function parseReviewTarget(words: string): ReviewTarget | null {
  const pr = /https?:\/\/[^\s<>]+?\/(?:pull|pullrequest)\/(\d+)\b|(?:#|\bPR\s+|\bpull\s+request\s+)(\d+)\b/i.exec(words);
  if (pr !== null) {
    const number = Number(pr[1] ?? pr[2]);
    // A PR-shaped token with an impossible number names no target: never re-read its digits as a commit.
    return Number.isSafeInteger(number) && number > 0 ? { kind: 'pr', number } : null;
  }
  const branch = /\bbranch\s+([^\s`'"<>]+)|\b(wicked\/[A-Za-z0-9._/-]+)/i.exec(words);
  if (branch !== null) {
    const name = branch[1] ?? branch[2]!;
    if (isSafeRefName(name)) return { kind: 'branch', name };
  }
  const commit = /\b[0-9a-f]{7,40}\b/i.exec(words);
  return commit === null ? null : { kind: 'commit', sha: commit[0].toLowerCase() };
}

export type ReviewProvenance = 'built_here' | 'outside' | 'unknown';

export interface ReviewChangeDeps {
  repoRef: string;
  /** The registered clone, so all lookups concern the launch's repository. */
  repoRoot: string;
  views: () => Promise<SessionView[]>;
  deliveredUrl: (runId: string) => string | undefined;
  pushed: (runId: string) => { branch: string; remote: string } | undefined;
  deliveredCommit: (runId: string) => string | undefined;
  revisesPr: (runId: string) => { number: number; headRef: string; url: string } | undefined;
  gh: GhExec;
  git: (args: string[], cwd: string) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  now?: () => number;
}

export type ReviewExclusion =
  | {
      ok: true;
      target: ReviewTarget | null;
      provenance: ReviewProvenance;
      /** Contributors, or all recent repository runs when provenance could not be read. */
      runs: string[];
      /** Sorted, unique CLI keys; excludes both critics and judges at the launch seam. */
      excludeSeats: string[];
      headSha: string | null;
      /** Only a same-repository origin branch is suitable as the review run's base. */
      baseRef?: string;
      label: string;
      briefLines: string[];
    }
  | { ok: false; code: 'review_authors_unknown'; error: string };

type Unit = SessionView['units'][number];
const field = (value: object, key: string): unknown => (value as Record<string, unknown>)[key];

/** Mirror core/reassign-refusal.ts's isReadStep/workAuthors: read steps only author recorded changes. */
function isReadStep(unit: Unit): boolean {
  if (unit.stage !== 'recon' || unit.role !== 'neutral' || field(unit, 'executes_code') === true) return false;
  if (field(unit, 'owner') === 'team') return true;
  const mutation = field(unit, 'worktree_mutation') as { restored?: unknown } | null | undefined;
  return field(unit, 'worktree_guarded') === true && (mutation == null || mutation.restored === true);
}

/** Mirror the engine's work-authors rule, retaining reassigned seats rather than just the last writer. */
export function runAuthorSeats(view: SessionView | undefined): string[] | null {
  if (view === undefined || !Array.isArray(view.units)) return null;
  const seats = new Set<string>();
  let hasWork = false;
  for (const unit of view.units) {
    if (unit.tool_cmd != null || (unit.stage !== 'build' && unit.stage !== 'recon')) continue;
    const raw = field(unit, 'authored_by');
    const authored = Array.isArray(raw) ? raw : [];
    const readStep = isReadStep(unit);
    if (readStep && authored.length === 0) continue;
    hasWork = true;
    for (const seat of [...(readStep ? [] : [unit.assigned_cli]), ...authored]) {
      if (typeof seat === 'string' && seat.trim() !== '' && seatKey(seat).trim() !== '') seats.add(seatKey(seat));
    }
  }
  return hasWork && seats.size === 0 ? null : [...seats].sort();
}

/** Delivery links may name a PR tab, fragment or a repository with a .git suffix. */
function prUrl(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const match = /^(.*?)\/(pull|pullrequest)\/(\d+)(?:[/?#]|$)/i.exec(url.pathname);
    if (match === null) return null;
    return `${url.host.toLowerCase()}${match[1]!.replace(/\.git$/i, '')}/${match[2]!.toLowerCase()}/${Number(match[3])}`;
  } catch {
    return null;
  }
}

function runBranch(view: SessionView): string {
  const branch = field(view.session, 'run_branch');
  return typeof branch === 'string' && branch !== '' ? branch : `wicked/${view.session.id}`;
}

/** Engine views may lack the daemon's created_at; undated runs must remain in the exclusion window. */
function inWindow(view: SessionView, cutoff: number): boolean {
  for (const key of ['created_at', 'started_at']) {
    const raw = field(view.session, key);
    const time = typeof raw === 'number' ? raw * 1000
      : typeof raw === 'string' && raw.trim() !== '' ? Date.parse(raw) : NaN;
    if (Number.isFinite(time)) return time >= cutoff;
  }
  return true;
}

/** Resolve provenance before selecting seats: lookup errors widen the author set, never imply outside work. */
export async function reviewChangeExclusion(words: string, deps: ReviewChangeDeps): Promise<ReviewExclusion> {
  const target = parseReviewTarget(words);
  let views: SessionView[];
  try {
    views = (await deps.views()).filter((view) => view.session.repo_ref === deps.repoRef);
  } catch {
    return { ok: false, code: 'review_authors_unknown', error: 'Crew cannot read the runs in this repository, so it will not pick a reviewer blindly.' };
  }
  const byId = new Map(views.map((view) => [view.session.id, view]));
  const candidates = new Set<string>();
  let headSha: string | null = null;
  let baseRef: string | undefined;
  let why: string | undefined;
  let headBranch: string | undefined;
  let url: string | null = null;
  const git = (args: string[]) => deps.git(args, deps.repoRoot);
  try {
    if (target === null) {
      throw new Error('the request names no pull request, branch or commit');
    } else if (target.kind === 'pr') {
      const out = await deps.gh(['pr', 'view', String(target.number), '--json', 'headRefName,headRefOid,url,state,isCrossRepository'], { cwd: deps.repoRoot, timeoutMs: 5000 });
      if (out.code !== 0) throw new Error(`could not read PR #${target.number}`);
      const pr = JSON.parse(out.stdout) as Record<string, unknown> | null;
      if (pr === null || typeof pr['headRefName'] !== 'string' || !isSafeRefName(pr['headRefName']) ||
          typeof pr['headRefOid'] !== 'string' || !/^[0-9a-f]{40}$/i.test(pr['headRefOid']) ||
          typeof pr['url'] !== 'string' || prUrl(pr['url']) === null || typeof pr['state'] !== 'string' ||
          typeof pr['isCrossRepository'] !== 'boolean') throw new Error('the PR lookup returned incomplete metadata');
      headBranch = pr['headRefName'];
      headSha = pr['headRefOid'];
      url = prUrl(pr['url']);
      if (pr['state'] === 'OPEN' && !pr['isCrossRepository']) baseRef = headBranch;
    } else if (target.kind === 'branch') {
      if ((await git(['fetch', 'origin', target.name])).code !== 0) throw new Error('could not fetch the review branch');
      const out = await git(['rev-parse', '--verify', '-q', `origin/${target.name}^{commit}`]);
      if (out.code !== 0 || !/^[0-9a-f]{40}$/i.test(out.stdout.trim())) throw new Error('could not resolve the review branch');
      headSha = out.stdout.trim();
      headBranch = target.name;
      baseRef = target.name;
    } else {
      if ((await git(['fetch', 'origin'])).code !== 0 || (await git(['cat-file', '-e', `${target.sha}^{commit}`])).code !== 0) {
        throw new Error('could not resolve the review commit');
      }
      headSha = target.sha;
      const out = await git(['for-each-ref', '--contains', target.sha, '--format=%(refname)', 'refs/heads/wicked/', 'refs/remotes/origin/wicked/']);
      if (out.code !== 0) throw new Error('could not read branches containing the review commit');
      for (const ref of out.stdout.trim().split('\n')) {
        const match = /^refs\/(?:heads|remotes\/origin)\/wicked\/(.+)$/.exec(ref);
        if (match !== null) candidates.add(match[1]!);
      }
    }
    if (headBranch?.startsWith('wicked/')) candidates.add(headBranch.slice('wicked/'.length));
    for (const view of views) {
      const id = view.session.id;
      const revision = deps.revisesPr(id);
      if (headBranch !== undefined && (runBranch(view) === headBranch || deps.pushed(id)?.branch === headBranch)) candidates.add(id);
      if (target.kind === 'pr' && ((url !== null && prUrl(deps.deliveredUrl(id)) === url) ||
          (revision !== undefined && ((url !== null && prUrl(revision.url) === url) || revision.number === target.number)))) candidates.add(id);
      if (target.kind === 'branch' && revision?.headRef === target.name) candidates.add(id);
      if (target.kind === 'commit' && deps.deliveredCommit(id) === target.sha) candidates.add(id);
    }
  } catch (error) {
    why = error instanceof Error ? error.message : 'the change lookup failed';
  }

  let runs: string[];
  let provenance: ReviewProvenance;
  if (why !== undefined) {
    provenance = 'unknown';
    const cutoff = (deps.now?.() ?? Date.now()) - REVIEW_PROVENANCE_WINDOW_DAYS * 86_400_000;
    runs = views.filter((view) => inWindow(view, cutoff)).map((view) => view.session.id);
  } else {
    runs = [];
    for (const id of candidates) {
      // Only a proven non-ancestor can remove an author; missing objects and failed git keep them.
      let code: number | null = null;
      try {
        const commit = deps.deliveredCommit(id);
        if (commit !== undefined && headSha !== null) code = (await git(['merge-base', '--is-ancestor', commit, headSha])).code;
      } catch { /* An unreadable membership proof still contributes. */ }
      if (code !== 1) runs.push(id);
    }
    provenance = runs.length > 0 ? 'built_here' : 'outside';
  }
  runs = [...new Set(runs)].sort();
  const seats = new Set<string>();
  for (const id of runs) {
    const authors = runAuthorSeats(byId.get(id));
    if (authors === null) return {
      ok: false, code: 'review_authors_unknown',
      error: `Run ${id} contributed to this change and crew cannot read who wrote it, so it will not pick a reviewer blindly.`,
    };
    for (const author of authors) seats.add(author);
  }
  const excludeSeats = [...seats].sort();
  const label = provenance === 'built_here'
    ? `built by runs ${runs.join(', ')} (authors excluded: ${excludeSeats.join(', ')})`
    : provenance === 'outside' ? 'built outside this studio'
      : `provenance unknown: ${why}; only seats that touched no run in this repository in the last ${REVIEW_PROVENANCE_WINDOW_DAYS} days review`;
  const named = target === null ? 'unspecified' : target.kind === 'pr' ? `PR #${target.number}` : target.kind === 'branch' ? `branch ${target.name}` : `commit ${target.sha}`;
  return {
    ok: true, target, provenance, runs, excludeSeats, headSha,
    ...(baseRef === undefined ? {} : { baseRef }), label,
    briefLines: [`Review target: ${named}`, `Head SHA: ${headSha ?? 'unknown'}`, label, 'Post nothing to the pull request.'],
  };
}
