/**
 * Each registered repo's `git_url` (studio#1012, crew#1744): the address the engine recorded, else (it records none
 * for its own clones) the checkout's `origin`, read through `git remote get-url origin`, held a minute per checkout and
 * read at most eight at a time across every list, so a list never runs a `git` per repository per request. Shown
 * through `shownGitUrl` (credentials and query removed, an address it can't vouch for dropped); none = no field.
 *
 * ONE instance per daemon serves every reader of `git_url` (`GET /repos`, the review's "open an issue" link, the repo
 * search document), so they share the reads and the cache.
 */

import { execCapped } from '../core/exec.js';
import type { RepoEntry } from '../core/types.js';
import { shownGitUrl } from './proposal-onboard.js';

/** The checkout's `origin` address as git prints it, or null (no checkout, no origin, git failed). */
export async function originOf(rootPath: string): Promise<string | null> {
  try {
    const out = await execCapped('git', ['-C', rootPath, 'remote', 'get-url', 'origin'], { timeout: 5_000 });
    return out.stdout.trim() || null;
  } catch {
    return null;
  }
}

const HOLD_MS = 60_000;
const MAX_READS = 8;

export class RepoOrigins {
  private readonly cache = new Map<string, { at: number; url: Promise<string | null> }>();
  private reads = 0;
  private readonly queue: Array<() => void> = [];

  private async limited(rootPath: string): Promise<string | null> {
    if (this.reads < MAX_READS) this.reads += 1;
    else await new Promise<void>((go) => this.queue.push(go));
    try {
      return await originOf(rootPath);
    } finally {
      // The slot passes straight to the next waiter, so no new read can take it in between.
      const next = this.queue.shift();
      if (next !== undefined) next();
      else this.reads -= 1;
    }
  }

  private origin(rootPath: string): Promise<string | null> {
    const now = Date.now();
    const hit = this.cache.get(rootPath);
    if (hit !== undefined && now - hit.at < HOLD_MS) return hit.url;
    const url = this.limited(rootPath);
    this.cache.set(rootPath, { at: now, url });
    return url;
  }

  /** One repo with the `git_url` it is shown with (none = no field). */
  async withGitUrl(r: RepoEntry): Promise<RepoEntry> {
    const { git_url: recorded, ...rest } = r;
    const raw = typeof recorded === 'string' && recorded.trim() !== '' ? recorded : await this.origin(r.root_path);
    const shown = raw === null ? null : shownGitUrl(raw);
    return shown === null ? rest : { ...rest, git_url: shown };
  }

  /** The registered repos, each with its `git_url`. A checkout no longer registered leaves the cache. */
  async list(listRepos: () => Promise<RepoEntry[]>): Promise<RepoEntry[]> {
    const listed = await listRepos();
    const roots = new Set(listed.map((r) => r.root_path));
    for (const root of this.cache.keys()) if (!roots.has(root)) this.cache.delete(root);
    return Promise.all(listed.map((r) => this.withGitUrl(r)));
  }
}
