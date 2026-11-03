/**
 * Git plumbing for app repos (DES-APPS-001 §4, §9.2): crew reads and writes an app's trees from the
 * canonical repo's OBJECTS, never through a worktree, and runs nothing the repo could configure.
 *
 * An app repo, `.git` included, is mounted read-write into agent seats (core `container_floor.rs`), so an
 * agent may have written its config, hooks, refs, replace refs, alternates and even its object files.
 * Every call here therefore:
 *  - drops the caller's `GIT_*` variables and reads no system or global config;
 *  - pins off every repo-config route to running a program on the commands used here: hooks (the
 *    `reference-transaction` hook runs on `update-ref`), fsmonitor, maintenance and gc, commit signing,
 *    every transport (`protocol.allow=never`), and lazy fetching from a promisor remote
 *    (`GIT_NO_LAZY_FETCH`); and uses plumbing only, which runs no filter, diff driver, pager or editor;
 *  - pins the administrative directories for its READS (`GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`), so a
 *    `commondir` file an agent wrote cannot point crew at another repository;
 *  - WRITES WITHOUT GIT (codex r3 on the store): crew writes its loose objects and its refs itself, a temp
 *    file renamed into a directory it has just checked is a real directory inside the repo. No git config,
 *    ref backend, reflog, hook or object setting of the agent's repo is ever on crew's write path;
 *  - requires a git whose lazy-fetch switch is honoured (2.45.1 and later), and refuses every transport by
 *    name as well as by default (a repo's `protocol.<name>.allow` cannot widen it);
 *  - ignores replace refs (`GIT_NO_REPLACE_OBJECTS`);
 *  - VERIFIES every object it reads: the bytes crew parses are hashed (`<type> <size>\0<bytes>`) and must
 *    be the object id asked for, so an edited object file, an alternate or a replacement can make a read
 *    fail but never make crew act on bytes other than the ones the id names;
 *  - bounds its output and its time.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import { childEnvWithBootEstateDb } from '../core/governance-store.js';

/** A full object id (SHA-1 repositories only). */
export const SHA_RE = /^[0-9a-f]{40}$/;

const OUTPUT_CAP = 16 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const IDENTITY = { name: 'wicked-crew', email: 'apps@wicked-crew.invalid' };

export class AppGitError extends Error {
  constructor(
    message: string,
    readonly code: 'missing' | 'failed' | 'too_large' | 'corrupt' = 'failed',
  ) {
    super(message);
  }
}

/** One entry of a tree crew read (one level). */
export interface TreeEntry {
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  name: string;
}

function gitEnv(gitDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  env['GIT_DIR'] = gitDir;
  env['GIT_COMMON_DIR'] = gitDir;
  env['GIT_OBJECT_DIRECTORY'] = join(gitDir, 'objects');
  env['GIT_CONFIG_NOSYSTEM'] = '1';
  env['GIT_CONFIG_GLOBAL'] = devNull;
  env['GIT_TERMINAL_PROMPT'] = '0';
  env['GIT_NO_LAZY_FETCH'] = '1';
  env['GIT_NO_REPLACE_OBJECTS'] = '1';
  env['GIT_OPTIONAL_LOCKS'] = '0';
  env['GIT_AUTHOR_NAME'] = IDENTITY.name;
  env['GIT_AUTHOR_EMAIL'] = IDENTITY.email;
  env['GIT_COMMITTER_NAME'] = IDENTITY.name;
  env['GIT_COMMITTER_EMAIL'] = IDENTITY.email;
  env['LC_ALL'] = 'C';
  return env;
}

/** Repo-config keys that would run a program (or reach a remote), pinned off for every call. */
const SAFE_CONFIG = [
  '-c', `core.hooksPath=${devNull}`,
  '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false',
  '-c', 'gc.auto=0',
  '-c', 'maintenance.auto=false',
  '-c', 'commit.gpgSign=false',
  '-c', 'protocol.allow=never',
  ...['file', 'git', 'ssh', 'http', 'https', 'ext', 'fd'].flatMap((p) => ['-c', `protocol.${p}.allow=never`]),
  '-c', 'core.alternateRefsCommand=',
  '-c', 'core.logAllRefUpdates=false',
];

/** The oldest git whose `GIT_NO_LAZY_FETCH` crew relies on (the lazy-fetch fix shipped in 2.45.1). */
export const MIN_GIT: readonly [number, number, number] = [2, 45, 1];

let gitOk: Promise<string | null> | null = null;

/** `git --version` output → `null` when it is at least {@link MIN_GIT}, else why not. */
export function gitVersionProblem(out: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
  if (m === null) return `cannot read the git version from "${out.trim()}"`;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  const old = v[0]! < MIN_GIT[0] || (v[0] === MIN_GIT[0] && (v[1]! < MIN_GIT[1] || (v[1] === MIN_GIT[1] && v[2]! < MIN_GIT[2])));
  return old ? `Apps needs git ${MIN_GIT.join('.')} or later (this host has ${v.join('.')})` : null;
}

/** `null` when the installed git is new enough; else why Apps cannot use it. Probed once. */
export function gitProblem(): Promise<string | null> {
  gitOk ??= (async () => {
    try {
      return gitVersionProblem((await runGit(devNull, ['--version'])).toString('utf8'));
    } catch (err) {
      return `git did not run: ${err instanceof Error ? err.message : String(err)}`;
    }
  })();
  return gitOk;
}

/** Run git in `gitDir`; stdout as a Buffer. Rejects on a non-zero exit, a timeout, or more than `cap` bytes. */
export function runGit(gitDir: string, args: string[], input?: Buffer | string, extraEnv: Record<string, string> = {}, cap = OUTPUT_CAP): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // The daemon's exported governance store (it may hold a credential) never reaches git (crew#495).
    const child = spawn('git', [...SAFE_CONFIG, ...args], { env: childEnvWithBootEstateDb({ ...gitEnv(gitDir), ...extraEnv }), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out: Buffer[] = [];
    let size = 0;
    let err = '';
    let failed: Error | null = null;
    const timer = setTimeout(() => {
      failed = new AppGitError(`git ${args[0]} took longer than ${TIMEOUT_MS / 1000}s`);
      child.kill('SIGKILL');
    }, TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => {
      if (failed !== null) return;
      size += d.length;
      if (size > cap) {
        failed = new AppGitError(`git ${args[0]} answered more than ${cap} bytes`, 'too_large');
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
      if (code !== 0) return reject(new AppGitError(`git ${args[0]} failed (${code}): ${err.trim().slice(0, 500)}`, 'missing'));
      resolve(Buffer.concat(out));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ?? '');
  });
}

/** The object id of `bytes` as a git object of `type`. */
export function objectId(type: 'blob' | 'tree' | 'commit', bytes: Buffer): string {
  return createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
}

/** Parse a raw tree object: `<mode> <name>\0<20-byte id>` repeated. */
function parseTree(raw: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < raw.length) {
    const sp = raw.indexOf(0x20, i);
    const nul = raw.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > raw.length) throw new AppGitError('a tree object does not parse', 'corrupt');
    const mode = raw.subarray(i, sp).toString('latin1');
    const name = raw.subarray(sp + 1, nul).toString('utf8');
    const sha = raw.subarray(nul + 1, nul + 21).toString('hex');
    const type = mode === '40000' ? 'tree' : mode === '160000' ? 'commit' : 'blob';
    out.push({ mode: mode === '40000' ? '040000' : mode, type, sha, name });
    i = nul + 21;
  }
  return out;
}

/** One app repo, by its root (the working directory crew registered; `.git` beneath it). */
export class AppGit {
  readonly gitDir: string;

  constructor(readonly root: string) {
    this.gitDir = join(root, '.git');
  }

  private git(args: string[], input?: Buffer | string, cap?: number): Promise<Buffer> {
    return runGit(this.gitDir, args, input, {}, cap);
  }

  /**
   * A new empty repo at `root`: `git init` on branch `main` (in a directory crew has just made, so nothing
   * of an agent's is there yet) and one empty commit (a worktree needs a base). The create is exclusive, so
   * a taken name is never adopted. Answers the empty commit.
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

  /**
   * Each of `dirs` (in order, each inside the one before) is made if missing and must be a real directory
   * (never a link) whose real path is inside the repo; `.git` must not name another common directory.
   */
  private async ensureDirs(dirs: string[], opts: { create: boolean } = { create: true }): Promise<void> {
    const realRoot = await realpath(this.root);
    const inside = (p: string): boolean => p === realRoot || p.startsWith(`${realRoot}/`) || p.startsWith(`${realRoot}\\`);
    for (const d of dirs) {
      if (opts.create) {
        try {
          await mkdir(d);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        }
      }
      const st = await lstat(d);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new AppGitError(`${d} is not a plain directory inside the app repo`, 'corrupt');
      if (!inside(await realpath(d))) throw new AppGitError(`${d} resolves outside the app repo`, 'corrupt');
    }
    try {
      await lstat(join(this.gitDir, 'commondir'));
      throw new AppGitError(`${this.gitDir} holds a commondir file; crew writes only into the repo's own .git`, 'corrupt');
    } catch (err) {
      if (err instanceof AppGitError) throw err;
    }
  }

  /**
   * Write `data` as `dir/name`: a temp file in `dir`, renamed over whatever is there (a link at `name` is
   * replaced, never followed). Nothing is ever done THROUGH the existing entry (codex r4: no chmod of it).
   * Where the platform refuses to rename over an existing read-only file (Windows), an existing OBJECT that
   * is a regular file is kept (`keepExisting`): it is content-addressed, and every read verifies it.
   */
  private async place(dir: string, name: string, data: Buffer | string, mode: number, keepExisting = false): Promise<void> {
    const tmp = join(dir, `.tmp-crew-${randomBytes(6).toString('hex')}`);
    await writeFile(tmp, data, { flag: 'wx', mode });
    try {
      await rename(tmp, join(dir, name));
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      const code = (err as NodeJS.ErrnoException).code;
      if (keepExisting && (code === 'EPERM' || code === 'EACCES' || code === 'EEXIST')) {
        const st = await lstat(join(dir, name)).catch(() => null);
        if (st !== null && st.isFile() && !st.isSymbolicLink()) return;
      }
      throw err;
    }
  }

  /** Write a loose object (crew's own bytes, deflated) and answer its id. */
  async writeObject(type: 'blob' | 'tree' | 'commit', content: Buffer): Promise<string> {
    const sha = objectId(type, content);
    const objects = join(this.gitDir, 'objects');
    const fan = join(objects, sha.slice(0, 2));
    await this.ensureDirs([this.gitDir, objects, fan]);
    await this.place(fan, sha.slice(2), deflateSync(Buffer.concat([Buffer.from(`${type} ${content.length}\0`), content])), 0o444, true);
    return sha;
  }

  /** Point the loose ref `refs/<path…>` at `sha` (a direct ref; whatever was there, link or file, is replaced). */
  async writeRef(path: string[], sha: string): Promise<void> {
    if (!SHA_RE.test(sha)) throw new AppGitError(`${sha} is not an object id`, 'missing');
    const dirs = [this.gitDir, join(this.gitDir, 'refs')];
    for (const part of path.slice(0, -1)) dirs.push(join(dirs[dirs.length - 1]!, part));
    await this.ensureDirs(dirs);
    await this.place(dirs[dirs.length - 1]!, path[path.length - 1]!, `${sha}\n`, 0o644);
  }

  /**
   * Remove the loose ref `refs/<path…>`. Every directory from `.git` down to the ref's own must be a real
   * directory inside the repo (codex r4: a link higher up must not take the unlink elsewhere); nothing is
   * created; anything unsafe or missing leaves the ref where it is. Best effort.
   */
  async dropRef(path: string[]): Promise<void> {
    const dirs = [this.gitDir, join(this.gitDir, 'refs')];
    for (const part of path.slice(0, -1)) dirs.push(join(dirs[dirs.length - 1]!, part));
    try {
      await this.ensureDirs(dirs, { create: false });
      const file = join(dirs[dirs.length - 1]!, path[path.length - 1]!);
      const st = await lstat(file);
      if (st.isFile() || st.isSymbolicLink()) await unlink(file); // unlinking a link removes the link only
    } catch {
      /* unsafe or already gone: left as it is */
    }
  }

  /** `main`'s commit as a direct ref, or `null` when it is missing or not a plain ref to a commit id. */
  async main(): Promise<string | null> {
    try {
      const out = (await this.git(['for-each-ref', '--format=%(objectname) %(symref)', 'refs/heads/main'])).toString('utf8').trim();
      const [id, symref] = out.split(' ');
      return id !== undefined && SHA_RE.test(id) && (symref === undefined || symref === '') ? id : null;
    } catch {
      return null;
    }
  }

  /** Point `main` at `commit` as a DIRECT ref (a symbolic `main` is replaced, never followed). */
  async setMain(commit: string): Promise<void> {
    await this.writeRef(['heads', 'main'], commit);
  }

  /** The object `sha` of `type`, its bytes verified against the id (at most `cap` bytes). */
  async readObject(type: 'blob' | 'tree' | 'commit', sha: string, cap = OUTPUT_CAP): Promise<Buffer> {
    if (!SHA_RE.test(sha)) throw new AppGitError(`${sha} is not an object id`, 'missing');
    const bytes = await this.git(['cat-file', type, sha], undefined, cap);
    if (objectId(type, bytes) !== sha) throw new AppGitError(`object ${sha} does not hash to its id (the repo's object store was changed)`, 'corrupt');
    return bytes;
  }

  /** A commit id → its tree, read from the verified commit; `null` when the repo holds no such commit. */
  async treeOf(commit: string): Promise<string | null> {
    if (!SHA_RE.test(commit)) return null;
    let raw: Buffer;
    try {
      raw = await this.readObject('commit', commit, 1024 * 1024);
    } catch (err) {
      if (err instanceof AppGitError && err.code === 'corrupt') throw err;
      return null;
    }
    const m = /^tree ([0-9a-f]{40})\n/.exec(raw.toString('latin1'));
    return m === null ? null : m[1]!;
  }

  /** A tree's entries (one level), verified. */
  async readTree(sha: string): Promise<TreeEntry[]> {
    return parseTree(await this.readObject('tree', sha, 4 * 1024 * 1024));
  }

  /** A blob, verified; `AppGitError('too_large')` past `cap` bytes. */
  async readBlob(sha: string, cap = OUTPUT_CAP): Promise<Buffer> {
    return this.readObject('blob', sha, cap);
  }

  async writeBlob(content: Buffer | string): Promise<string> {
    return this.writeObject('blob', Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
  }

  /** A tree from entries `{mode, type, sha, name}` (one level), in git's order (a tree sorts as `name/`). */
  async mktree(entries: Array<{ mode: string; type: 'blob' | 'tree'; sha: string; name: string }>): Promise<string> {
    const key = (e: { type: string; name: string }): string => (e.type === 'tree' ? `${e.name}/` : e.name);
    const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(key(a)), Buffer.from(key(b))));
    const raw = Buffer.concat(sorted.map((e) => Buffer.concat([Buffer.from(`${e.type === 'tree' ? '40000' : e.mode} ${e.name}\0`), Buffer.from(e.sha, 'hex')])));
    return this.writeObject('tree', raw);
  }

  /** A commit of `tree` on `parent`, dated `at` (unix millis), authored by crew. */
  async commitTree(tree: string, parent: string | null, message: string, at: number): Promise<string> {
    const sig = `${IDENTITY.name} <${IDENTITY.email}> ${Math.floor(at / 1000)} +0000`;
    const body = `tree ${tree}\n${parent !== null ? `parent ${parent}\n` : ''}author ${sig}\ncommitter ${sig}\n\n${message.endsWith('\n') ? message : `${message}\n`}`;
    return this.writeObject('commit', Buffer.from(body, 'utf8'));
  }
}
