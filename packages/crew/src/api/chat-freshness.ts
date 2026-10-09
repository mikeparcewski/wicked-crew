/**
 * crew#899: a chat reads the REGISTERED checkout, and nothing refreshed it — runs base on the
 * fetched `origin/<default>`, so a run saw current code while an Ask about the same repo searched a
 * tree 174 commits behind and timed out. When a chat opens, each repository in its scope is brought
 * to its upstream the way `git pull --ff-only` would, and only when that is safe: the root is the
 * checkout's own top level, the branch tracks an upstream, the working tree has no tracked changes
 * and the branch has no commits of its own. Anything else is left exactly as it is and DISCLOSED in
 * the scope statement (how far behind, and why it was not refreshed), so an answer is never
 * silently stale.
 */

import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { devNull } from 'node:os';
import { resolve } from 'node:path';

import type { ChatCheckoutFreshness } from '../core/types.js';

/** What opening a chat found (and did) for one repository's checkout. */
export type CheckoutFreshness =
  | ChatCheckoutFreshness
  /** Not a git checkout we can judge (no upstream, not the top level, git missing): nothing said. */
  | { state: 'unknown' };

export type FreshenCheckout = (root: string) => Promise<CheckoutFreshness>;

/** A fetch per repository, bounded: a chat open must not hang on a slow remote. */
export const CHAT_FETCH_TIMEOUT_MS = 20_000;

type Git = (root: string, args: string[], timeoutMs?: number) => Promise<string>;

const realGit: Git = (root, args, timeoutMs = 30_000) =>
  new Promise((ok, fail) => {
    execFile(
      'git',
      // No hooks (codex on crew#902): a fetch or fast-forward run on the operator's behalf must not
      // execute the checkout's post-merge / reference-transaction hooks.
      ['-C', root, '-c', `core.hooksPath=${devNull}`, ...args],
      // Never prompt for credentials: a fetch that needs them fails, and the chat says so.
      { windowsHide: true, timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout) => (err ? fail(err) : ok(String(stdout).trim())),
    );
  });

function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

/** Bring one clean checkout to its upstream, or say why not. Never throws. */
export async function freshenCheckout(root: string, git: Git = realGit): Promise<CheckoutFreshness> {
  let upstream: string;
  try {
    // Only the checkout's own top level: a registered root nested inside another repository must
    // not fetch or move the outer one.
    if (!sameDir(await git(root, ['rev-parse', '--show-toplevel']), root)) return { state: 'unknown' };
    upstream = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  } catch {
    return { state: 'unknown' }; // not a repository, detached HEAD, or no upstream
  }
  // The remote by name from git itself: a remote whose name holds a `/` (`team/origin`) must not
  // be cut from the upstream's display name (codex on crew#902).
  let remote: string;
  try {
    remote = await git(root, ['for-each-ref', '--format=%(upstream:remotename)', await git(root, ['symbolic-ref', '-q', 'HEAD'])]);
  } catch {
    return { state: 'unknown' };
  }
  if (remote === '' || remote === '.') return { state: 'unknown' }; // a local-branch upstream: nothing to fetch
  let fetchFailed = false;
  try {
    await git(root, ['fetch', '--quiet', remote], CHAT_FETCH_TIMEOUT_MS);
  } catch {
    fetchFailed = true;
  }
  let ahead: number;
  let behind: number;
  try {
    const [a, b] = (await git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])).split(/\s+/u);
    ahead = Number(a);
    behind = Number(b);
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return { state: 'unknown' };
  } catch {
    return { state: 'unknown' };
  }
  if (behind === 0) {
    return fetchFailed
      ? { state: 'stale', upstream, behind: 0, reason: `could not fetch ${remote}, so it may be behind` }
      : { state: 'current', upstream };
  }
  if (fetchFailed) return { state: 'stale', upstream, behind, reason: `could not fetch ${remote}` };
  if (ahead > 0) return { state: 'stale', upstream, behind, reason: `the branch has ${ahead} commit(s) of its own` };
  try {
    if ((await git(root, ['status', '--porcelain', '--untracked-files=no'])) !== '') {
      return { state: 'stale', upstream, behind, reason: 'the working tree has uncommitted changes' };
    }
    await git(root, ['merge', '--ff-only', '--quiet', '@{upstream}']);
  } catch (err) {
    return { state: 'stale', upstream, behind, reason: `fast-forward refused (${err instanceof Error ? err.message.split('\n')[0] : String(err)})` };
  }
  return { state: 'refreshed', upstream, commits: behind };
}

/** The scope-statement clause for a repository's freshness; `''` when there is nothing to say. */
export function freshnessClause(f: CheckoutFreshness | undefined): string {
  if (f === undefined) return '';
  switch (f.state) {
    case 'refreshed':
      return ` (fast-forwarded ${f.commits} commit(s) to \`${f.upstream}\` when this chat opened)`;
    case 'stale':
      return f.behind > 0
        ? ` (STALE: ${f.behind} commit(s) behind \`${f.upstream}\`, not refreshed: ${f.reason}. Recent changes may be missing; say so when it matters)`
        : ` (${f.reason}; say so when it matters)`;
    default:
      return '';
  }
}
