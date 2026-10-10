/**
 * crew#720 (operator ruling 2026-10-10): EVERY delivery — GitHub, Azure DevOps or local-only —
 * leaves a zip of the run's final codebase, whatever the outcome: delivered, push refused,
 * credentials missing, wrong account, lift conflict, or a run that failed after building.
 *
 * WHAT IS IN IT: the tree delivery would ship. HEAD, plus the worktree's changes to tracked files,
 * plus the untracked files the deliver phase's own classifier lets ride (`deliverExclusionReason`:
 * no `.env*` / key material / databases / scratch or tool-output dirs / oversize files) — gitignored
 * files never. It is snapshotted through a SCRATCH index (the worktree's own index is never
 * touched) and written with `git archive --format=zip <tree>`: tracked content only, no `.git`.
 * Tracked files ship as tracked, exactly as delivery treats them, and `git archive` honours the
 * repository's `export-ignore` / `export-subst` attributes. When the run's worktree is gone (the
 * engine reaps a cancelled run's, and a committed run's clean one) the `wicked/<run>` branch in
 * the registered repository is archived instead.
 *
 * WHERE: `<state home>/artifacts/runs/<sha256(run id)[0:32]>/codebase.zip` + `codebase.json` (the
 * record, the run id included). The record is durable on its own — {@link CodebaseArchiveStore.get}
 * reads it back after a restart — and served as `AgentSession.codebase_archive`; the bytes are
 * `GET /api/v1/runs/:id/artifacts/codebase.zip`. Re-archiving a run whose tree has not changed
 * rewrites nothing.
 *
 * Best-effort by construction: an archive that cannot be made is logged, never a run failure.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, type ReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_PREFIX } from './api-prefix.js';
import { DELIVER_PUSH_REJECTED_MARKER, deliverRunBranch } from '../core/deliver.js';
import { SCRATCH_DIRS, TOOL_ARTIFACT_DIRS, deliverExclusionByName, deliverExclusionReason } from '../core/deliver-exclusions.js';
import { childEnvWithBootEstateDb } from '../core/governance-store.js';
import { crewStateHome } from '../projects/state-home.js';

/** api-types `CodebaseArchive` (crew#720). */
export interface CodebaseArchive {
  /** `GET` this (daemon-relative) for the zip. */
  url: string;
  /** Hex sha256 of the zip's bytes. */
  sha256: string;
  bytes: number;
  /** The git tree the zip was written from. */
  tree: string;
  /** The commit the tree was taken on (the worktree's HEAD, or the run branch's tip). */
  commit: string | null;
  /** Unix millis. */
  created_at: number;
  /** What took it: the deliver phase (or a post-hoc deliver), or the run's end. */
  trigger: 'deliver' | 'run_end';
  /** Where the tree came from: the live worktree, or the retained run branch. */
  source: 'worktree' | 'branch';
}

/** Where the run's tree can be read: its worktree, and the registered repository (for the branch). */
export interface ArchiveSources {
  workdir?: string | null;
  repoRoot?: string | null;
}

const GIT_TIMEOUT_MS = 60_000;
const ZIP_NAME = 'codebase.zip';
const META_NAME = 'codebase.json';

/** `<run>\0<ord>` — the key a deliver unit's dispatch and its output capture share. */
export function archiveKey(runId: string, ord: number): string {
  return `${runId}\0${ord}`;
}

/**
 * The {@link archiveKey} of a `toolExecutorDispatched` frame that runs crew's deliver script —
 * recognised by its own refusal marker in the command (the structural mark `deliverUnitOf` reads,
 * crew#720 S3) — else `null`. The daemon archives on that unit's `unitOutputCaptured` only, so no
 * other unit's capture costs an engine read.
 */
export function deliverDispatchKey(event: { type?: unknown; session?: unknown; ord?: unknown; cmd?: unknown }): string | null {
  if (event.type !== 'toolExecutorDispatched' || typeof event.session !== 'string' || typeof event.ord !== 'number') return null;
  if (!Array.isArray(event.cmd) || !event.cmd.some((a) => typeof a === 'string' && a.includes(DELIVER_PUSH_REJECTED_MARKER))) return null;
  return archiveKey(event.session, event.ord);
}

/** The daemon-relative URL the zip is served at. */
export function codebaseArchiveUrl(runId: string): string {
  return `${API_PREFIX}/runs/${encodeURIComponent(runId)}/artifacts/${ZIP_NAME}`;
}

/**
 * The environment the archiver's git runs with: an ALLOWLIST, never the daemon's own. A repository
 * can name a clean filter (`.gitattributes` + its config) that `git add` runs; whatever it is, it
 * must not find the daemon's forge credentials (`GH_TOKEN`, `AZURE_DEVOPS_EXT_PAT`, `CREW_ADO_*`)
 * in its environment (codex r1 on this PR).
 */
const GIT_ENV_ALLOW = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TZ', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'WINDIR'];
export function archiverGitEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  for (const k of GIT_ENV_ALLOW) {
    const v = env[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** git with the hooks and fsmonitor off, never prompting, on {@link archiverGitEnv}. */
function git(cwd: string, args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', windowsHide: true, env: childEnvWithBootEstateDb({ ...archiverGitEnv(), ...extraEnv }) },
      (err, stdout, stderr) => (err !== null ? reject(new Error(`git ${args[0]}: ${String(stderr || err.message).trim()}`)) : resolve(String(stdout))),
    );
  });
}

function sha256Of(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * The tree delivery would ship from `workdir` (see the module doc), or throw. `scratch` is a
 * private temp dir for the scratch index and the pathspec file.
 */
export async function worktreeShipTree(workdir: string, scratch: string): Promise<{ tree: string; commit: string | null }> {
  const index = join(scratch, 'index');
  const env = { GIT_INDEX_FILE: index };
  const commit = (await git(workdir, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).catch(() => '')).trim() || null;
  // Seeded from a COPY of the worktree's own index — the index the deliver phase stages into — so
  // "tracked" means what delivery means: a path the run `git rm --cached` is untracked (and meets the
  // classifier), a path it force-added is tracked (codex r1). The real index is never written.
  const realIndex = (await git(workdir, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).catch(() => '')).trim();
  if (realIndex !== '' && existsSync(realIndex)) copyFileSync(realIndex, index);
  else if (commit !== null) await git(workdir, ['read-tree', commit], env);
  else await git(workdir, ['read-tree', '--empty'], env);
  // Tracked changes ride (modifications and deletions to tracked paths).
  await git(workdir, ['add', '-u', '--', '.'], env);
  // Untracked paths — gitignore honoured, the scratch and tool-output dirs dropped at enumeration —
  // then the deliver classifier, per file.
  const excludes = [...SCRATCH_DIRS, ...TOOL_ARTIFACT_DIRS].map((d) => `:(exclude)${d}`);
  const listed = await git(workdir, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ...excludes], env);
  const keep: string[] = [];
  for (const rel of listed.split('\0')) {
    if (rel === '' || deliverExclusionByName(rel) !== null) continue;
    const abs = join(workdir, rel);
    let size: number | null = null;
    try {
      const st = lstatSync(abs);
      if (!st.isFile() && !st.isSymbolicLink()) continue;
      size = st.size;
    } catch {
      continue; // raced away
    }
    const why = deliverExclusionReason(rel, size, () => {
      try {
        return readFileSync(abs, 'utf8');
      } catch {
        return null;
      }
    });
    if (why === null) keep.push(rel);
  }
  if (keep.length > 0) {
    const list = join(scratch, 'paths');
    writeFileSync(list, keep.map((p) => `:(literal)${p}`).join('\0'));
    await git(workdir, ['add', `--pathspec-from-file=${list}`, '--pathspec-file-nul'], env);
  }
  const tree = (await git(workdir, ['write-tree'], env)).trim();
  return { tree, commit };
}

interface StoredArchive {
  rec: CodebaseArchive;
  /** The zip's file name inside the run's directory (content-addressed: `<sha256>.zip`). */
  file: string;
}

export class CodebaseArchiveStore {
  private readonly memo = new Map<string, StoredArchive | null>();
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    readonly root: string = join(crewStateHome(), 'artifacts', 'runs'),
    private readonly log: (msg: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  private dirOf(runId: string): string {
    return join(this.root, createHash('sha256').update(runId).digest('hex').slice(0, 32));
  }

  private stored(runId: string): StoredArchive | null {
    if (!this.memo.has(runId)) {
      let found: StoredArchive | null = null;
      try {
        const raw = JSON.parse(readFileSync(join(this.dirOf(runId), META_NAME), 'utf8')) as CodebaseArchive & { runId?: unknown; file?: unknown };
        if (raw.runId === runId && typeof raw.sha256 === 'string' && typeof raw.tree === 'string' && typeof raw.file === 'string' && /^[0-9a-f]{64}\.zip$/.test(raw.file)) {
          const { runId: _r, file, ...rec } = raw;
          void _r;
          found = { rec, file };
        }
      } catch {
        found = null;
      }
      this.memo.set(runId, found);
    }
    return this.memo.get(runId) ?? null;
  }

  /** The run's archive record, or `undefined` — read from disk once, then memoized. */
  get(runId: string): CodebaseArchive | undefined {
    return this.stored(runId)?.rec;
  }

  /** The current zip's path, or `null`. */
  zipFile(runId: string): string | null {
    const s = this.stored(runId);
    if (s === null) return null;
    const p = join(this.dirOf(runId), s.file);
    return existsSync(p) ? p : null;
  }

  /**
   * The record and a stream of EXACTLY its bytes, or `null`. The file is opened synchronously with
   * the record in hand, and every zip is content-addressed, so a newer archive landing meanwhile can
   * never put its bytes under this record's sha256 / length (codex r1).
   */
  open(runId: string): { rec: CodebaseArchive; stream: ReadStream } | null {
    const s = this.stored(runId);
    if (s === null) return null;
    let fd: number;
    try {
      fd = openSync(join(this.dirOf(runId), s.file), 'r');
    } catch {
      return null;
    }
    return { rec: s.rec, stream: createReadStream('', { fd }) };
  }

  /**
   * Archive the run's final tree (serialized per run). Answers the record — the existing one when
   * the tree is unchanged — or `null` when no tree could be read (logged).
   */
  archive(runId: string, sources: ArchiveSources, trigger: CodebaseArchive['trigger']): Promise<CodebaseArchive | null> {
    const prev = this.chains.get(runId) ?? Promise.resolve();
    const job = prev.catch(() => undefined).then(() => this.archiveNow(runId, sources, trigger));
    this.chains.set(runId, job);
    void job.finally(() => {
      if (this.chains.get(runId) === job) this.chains.delete(runId);
    });
    return job;
  }

  private async archiveNow(runId: string, sources: ArchiveSources, trigger: CodebaseArchive['trigger']): Promise<CodebaseArchive | null> {
    const scratch = mkdtempSync(join(tmpdir(), 'crew-codebase-'));
    try {
      let picked: { cwd: string; tree: string; commit: string | null; source: CodebaseArchive['source'] } | null = null;
      const wd = sources.workdir ?? null;
      if (wd !== null && wd !== '' && existsSync(wd)) {
        try {
          const t = await worktreeShipTree(wd, scratch);
          picked = { cwd: wd, ...t, source: 'worktree' };
        } catch (err) {
          this.log(`[runs] codebase archive: the worktree of ${runId} could not be read (${err instanceof Error ? err.message : String(err)}); trying the run branch`);
        }
      }
      const branch = deliverRunBranch(runId);
      const root = sources.repoRoot ?? null;
      if (picked === null && branch !== null && root !== null && root !== '' && existsSync(root)) {
        const commit = (await git(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`]).catch(() => '')).trim();
        if (commit !== '') {
          const tree = (await git(root, ['rev-parse', `${commit}^{tree}`])).trim();
          picked = { cwd: root, tree, commit, source: 'branch' };
        }
      }
      if (picked === null) {
        this.log(`[runs] codebase archive: no worktree and no run branch for ${runId} — nothing to archive`);
        return null;
      }
      const existing = this.stored(runId);
      const dir = this.dirOf(runId);
      if (existing !== null && existing.rec.tree === picked.tree && existsSync(join(dir, existing.file))) return existing.rec;
      const tmpZip = join(scratch, ZIP_NAME);
      await git(picked.cwd, ['archive', '--format=zip', '-o', tmpZip, picked.tree]);
      const sha256 = await sha256Of(tmpZip);
      const bytes = statSync(tmpZip).size;
      const file = `${sha256}.zip`;
      mkdirSync(dir, { recursive: true });
      // Same filesystem is not guaranteed (tmpdir vs state home): stage beside the target, then rename.
      const staged = join(dir, `${file}.partial`);
      copyFileSync(tmpZip, staged);
      renameSync(staged, join(dir, file));
      const rec: CodebaseArchive = {
        url: codebaseArchiveUrl(runId),
        sha256,
        bytes,
        tree: picked.tree,
        commit: picked.commit,
        created_at: this.now(),
        trigger,
        source: picked.source,
      };
      const metaTmp = join(dir, `${META_NAME}.partial`);
      writeFileSync(metaTmp, JSON.stringify({ runId, file, ...rec }, null, 2));
      renameSync(metaTmp, join(dir, META_NAME));
      this.memo.set(runId, { rec, file });
      // The previous zip goes once the record no longer names it (an open download keeps its fd).
      if (existing !== null && existing.file !== file) {
        try {
          unlinkSync(join(dir, existing.file));
        } catch {
          // already gone
        }
      }
      this.log(`[runs] codebase archive: ${runId} ${trigger} ${picked.source} tree ${picked.tree.slice(0, 12)} → ${bytes} bytes sha256 ${sha256.slice(0, 12)}`);
      return rec;
    } catch (err) {
      this.log(`[runs] codebase archive failed for ${runId}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
