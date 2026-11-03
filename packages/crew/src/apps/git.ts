/**
 * Git plumbing for app repos (DES-APPS-001 §4, §9.2): crew reads and writes an app's trees from the
 * canonical repo's OBJECTS, never through a worktree, and runs nothing the repo could configure.
 *
 * An app repo is mounted into agent seats (core `container_floor.rs`), so its `.git` may hold config or
 * hooks an agent wrote. Every call here therefore:
 *  - drops the caller's `GIT_*` variables and reads no system or global config;
 *  - overrides every repo-config key that runs a program on the commands used here (`core.hooksPath`,
 *    `core.fsmonitor`; the `reference-transaction` hook runs on `update-ref`), and uses plumbing only
 *    (`cat-file`, `ls-tree`, `hash-object --no-filters`, `mktree`, `commit-tree`, `update-ref`), which runs
 *    no filter, diff driver, pager or editor;
 *  - bounds its output and its time.
 */

import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { devNull } from 'node:os';
import { join } from 'node:path';

/** A full object id. */
export const SHA_RE = /^[0-9a-f]{40}$/;

const OUTPUT_CAP = 16 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const IDENTITY = { name: 'wicked-crew', email: 'apps@wicked-crew.invalid' };

export class AppGitError extends Error {
  constructor(
    message: string,
    readonly code: 'missing' | 'failed' = 'failed',
  ) {
    super(message);
  }
}

/** One entry of a recursive `ls-tree -l`. */
export interface TreeEntry {
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  /** `null` for a tree or a submodule. */
  size: number | null;
  path: string;
}

function gitEnv(gitDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  env['GIT_DIR'] = gitDir;
  env['GIT_CONFIG_NOSYSTEM'] = '1';
  env['GIT_CONFIG_GLOBAL'] = devNull;
  env['GIT_TERMINAL_PROMPT'] = '0';
  env['GIT_AUTHOR_NAME'] = IDENTITY.name;
  env['GIT_AUTHOR_EMAIL'] = IDENTITY.email;
  env['GIT_COMMITTER_NAME'] = IDENTITY.name;
  env['GIT_COMMITTER_EMAIL'] = IDENTITY.email;
  env['LC_ALL'] = 'C';
  return env;
}

/** Repo-config keys that would run a program, pinned off for every call. */
const SAFE_CONFIG = ['-c', `core.hooksPath=${devNull}`, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'gc.auto=0'];

/** Run git in `gitDir` with `args`; stdout as a Buffer. Rejects on a non-zero exit, a timeout or too much output. */
export function runGit(gitDir: string, args: string[], input?: Buffer | string, extraEnv: Record<string, string> = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const env = { ...gitEnv(gitDir), ...extraEnv };
    const child = spawn('git', [...SAFE_CONFIG, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out: Buffer[] = [];
    let size = 0;
    let err = '';
    let failed: Error | null = null;
    const timer = setTimeout(() => {
      failed = new AppGitError(`git ${args[0]} took longer than ${TIMEOUT_MS / 1000}s`);
      child.kill('SIGKILL');
    }, TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => {
      size += d.length;
      if (size > OUTPUT_CAP) {
        failed = new AppGitError(`git ${args[0]} answered more than ${OUTPUT_CAP} bytes`);
        child.kill('SIGKILL');
        return;
      }
      out.push(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      if (err.length < 4000) err += d.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failed !== null) return reject(failed);
      if (code !== 0) return reject(new AppGitError(`git ${args[0]} failed (${code}): ${err.trim().slice(0, 500)}`));
      resolve(Buffer.concat(out));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ?? '');
  });
}

/** One app repo, by its root (the working directory crew registered; `.git` beneath it). */
export class AppGit {
  readonly gitDir: string;

  constructor(readonly root: string) {
    this.gitDir = join(root, '.git');
  }

  private git(args: string[], input?: Buffer | string): Promise<Buffer> {
    return runGit(this.gitDir, args, input);
  }

  /**
   * A new empty repo at `root`: `git init` on branch `main` and one empty commit (a worktree needs a
   * base). The directory must not exist: the create is exclusive, so a taken name is never adopted.
   * Answers the empty commit.
   */
  static async createEmpty(root: string): Promise<{ git: AppGit; commit: string }> {
    await mkdir(join(root, '..'), { recursive: true });
    await mkdir(root); // EEXIST: taken
    try {
      // With GIT_DIR set, `init` makes a non-bare repo whose work tree is `root`.
      await runGit(join(root, '.git'), ['init', '-q', '--initial-branch=main']);
      const git = new AppGit(root);
      const empty = await git.mktree([]);
      const commit = await git.commitTree(empty, null, 'Empty app repository', Date.now());
      await git.setMain(commit);
      return { git, commit };
    } catch (err) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  /** `main`'s commit, or `null` when the ref is missing. */
  async main(): Promise<string | null> {
    try {
      return (await this.git(['rev-parse', '--verify', '-q', 'refs/heads/main'])).toString('utf8').trim() || null;
    } catch {
      return null;
    }
  }

  /** Point `main` at `commit` (crew owns `main` of an app repo; its own record says where it is). */
  async setMain(commit: string): Promise<void> {
    await this.git(['update-ref', '-m', 'wicked-crew apps', 'refs/heads/main', commit]);
  }

  /** A full commit id → its tree, or `null` when the repo holds no such commit. */
  async treeOf(commit: string): Promise<string | null> {
    if (!SHA_RE.test(commit)) return null;
    try {
      const type = (await this.git(['cat-file', '-t', commit])).toString('utf8').trim();
      if (type !== 'commit') return null;
      return (await this.git(['rev-parse', '--verify', '-q', `${commit}^{tree}`])).toString('utf8').trim();
    } catch {
      return null;
    }
  }

  /** Every entry under `treeish`, recursively, trees included. */
  async lsTree(treeish: string): Promise<TreeEntry[]> {
    const raw = (await this.git(['ls-tree', '-r', '-t', '-l', '-z', '--full-tree', treeish])).toString('utf8');
    const out: TreeEntry[] = [];
    for (const rec of raw.split('\0')) {
      if (rec === '') continue;
      const tab = rec.indexOf('\t');
      const [mode, type, sha, size] = rec.slice(0, tab).split(/\s+/) as [string, TreeEntry['type'], string, string];
      out.push({ mode, type, sha, size: size === '-' ? null : Number(size), path: rec.slice(tab + 1) });
    }
    return out;
  }

  async readBlob(sha: string): Promise<Buffer> {
    return this.git(['cat-file', 'blob', sha]);
  }

  async writeBlob(content: Buffer | string): Promise<string> {
    return (await this.git(['hash-object', '-w', '--no-filters', '--stdin'], content)).toString('utf8').trim();
  }

  /** A tree from entries `{mode, type, sha, name}` (one level). */
  async mktree(entries: Array<{ mode: string; type: 'blob' | 'tree'; sha: string; name: string }>): Promise<string> {
    const input = entries.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.name}`).join('\n') + (entries.length > 0 ? '\n' : '');
    return (await this.git(['mktree'], input)).toString('utf8').trim();
  }

  /** A commit of `tree` on `parent`, dated `at` (unix millis); the message rides stdin, never argv. */
  async commitTree(tree: string, parent: string | null, message: string, at: number): Promise<string> {
    const date = `${Math.floor(at / 1000)} +0000`;
    const args = ['commit-tree', tree, ...(parent !== null ? ['-p', parent] : [])];
    const out = await runGit(this.gitDir, args, message, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    return out.toString('utf8').trim();
  }
}
