/**
 * The learn schedule's tick (DES-learn-workflow §5.3). Once a minute:
 *
 *  1. RECONCILE — a schedule's last run that reached a terminal status records its outcome.
 *  2. INDEX — a topic whose MERGED knowledge changed (`git rev-parse HEAD:.wicked/knowledge/<slug>`
 *     moved) is re-indexed into the estate knowledge store by garden's `scripts/learn/index.py`,
 *     spawned OUTSIDE any run (its env carries no run markers, so the estate opens writable), one
 *     spawn per sweep. Indexing reads the registered checkout, never an open pull request.
 *  3. LAUNCH — at most ONE due schedule launches the `learn` workflow, and only while no schedule's
 *     run is still open and no run on the daemon is executing (one governed run at a time). The
 *     launch delivers a pull request behind the engine's human deliver gate; nothing auto-merges.
 *     A refused launch backs off exponentially (capped at a day); missed intervals coalesce.
 *
 * Never throws; a slow sweep never stacks (`sweeping`).
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { SessionStatus } from 'wicked-crew-api-types';
import type { CoreAdapter } from '../core/adapter.js';
import type { Actor, CoreEvent } from '../core/types.js';
import type { AuditLog } from '../api/audit.js';
import { recordRunLaunched, type RunTimingIndex } from '../api/run-timing-index.js';
import { HOURS, type LearnSchedule, type LearnScheduleStore } from './schedule-store.js';

export const LEARN_WORKFLOW = 'learn';
export const LEARN_SCHEDULE_ACTOR: Actor = { id: 'learn-schedule', kind: 'system', trust: 'operator' };
export const DEFAULT_LEARN_SWEEP_MS = 60_000;
/** How long a launched run the daemon no longer lists keeps the schedule's slot (48 h). */
export const STALE_LAUNCH_MS = 48 * HOURS;
const TERMINAL: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['completed', 'failed', 'cancelled']);
/** The env a governed unit carries; the index spawn drops every one so estate opens writable. */
export const RUN_MARKER_ENV = ['WICKED_RUN_ID', 'WICKED_GATE_SCOPE', 'WICKED_WRITE_ROOTS', 'WICKED_GOVERNED', 'WICKED_ESTATE_READONLY'];

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Exec = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<ExecResult>;

export const defaultExec: Exec = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export interface LearnSchedulerDeps {
  store: LearnScheduleStore;
  adapter: Pick<CoreAdapter, 'listRepos' | 'sessionsDetail' | 'seatsForWorkflow' | 'launchRun'>;
  audit: AuditLog;
  runTimingIndex: RunTimingIndex;
  fileRun: (runId: string, projectId: string) => void;
  broadcast: (frame: CoreEvent) => void;
  log: (msg: string) => void;
  now?: () => Date;
  exec?: Exec;
  env?: NodeJS.ProcessEnv;
}

/** The garden launcher: `$WICKED_GARDEN_ROOT/scripts/wicked-garden` when set, else `wicked-garden` on PATH. */
export function gardenLauncher(env: NodeJS.ProcessEnv): string {
  const root = env['WICKED_GARDEN_ROOT'];
  return root !== undefined && root !== '' ? `${root.replace(/\/+$/, '')}/scripts/wicked-garden` : 'wicked-garden';
}

/** `env` without the governed-run markers. */
export function unmarkedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of RUN_MARKER_ENV) delete out[k];
  return out;
}

export function refreshProblem(row: LearnSchedule): string {
  return (
    `Refresh learn topic "${row.topic}" (.wicked/knowledge/${row.slug}/): re-research what changed since the ` +
    `topic's refreshed_at and propose only changes (confirm, supersede, contradict, retire) per the ` +
    `wicked-garden-learn skill's refresh rules.`
  );
}

export class LearnScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(private readonly deps: LearnSchedulerDeps) {}

  start(intervalMs = DEFAULT_LEARN_SWEEP_MS): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.sweep(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** One sweep. Never throws. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const rows = this.deps.store.list();
      if (rows.length === 0) return;
      const views = await this.deps.adapter.sessionsDetail();
      const status = new Map<string, SessionStatus>(views.map((v) => [v.session.id, v.session.status]));
      this.reconcile(rows, status);
      await this.indexOne(this.deps.store.list());
      await this.launchOne(this.deps.store.list(), status);
    } catch (err) {
      this.deps.log(`[learn-schedule] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.sweeping = false;
    }
  }

  private reconcile(rows: LearnSchedule[], status: Map<string, SessionStatus>): void {
    for (const row of rows) {
      if (row.lastRunId === null || row.lastOutcome !== 'launched') continue;
      const s = status.get(row.lastRunId);
      if (s !== undefined && TERMINAL.has(s)) {
        this.deps.store.update(row.id, { lastOutcome: s as 'completed' | 'failed' | 'cancelled' }, this.now());
      }
    }
  }

  private async indexOne(rows: LearnSchedule[]): Promise<void> {
    const exec = this.deps.exec ?? defaultExec;
    const env = this.deps.env ?? process.env;
    const repos = await this.deps.adapter.listRepos();
    for (const row of rows) {
      if (!row.enabled) continue;
      const repo = repos.find((r) => r.id === row.repoRef);
      if (repo === undefined || !repo.root_path) continue;
      const tree = await exec('git', ['-C', repo.root_path, 'rev-parse', `HEAD:.wicked/knowledge/${row.slug}`], { timeoutMs: 5_000 });
      const sha = tree.code === 0 ? tree.stdout.trim() : '';
      if (sha === '' || sha === row.indexedTree) continue;
      const res = await exec(
        gardenLauncher(env),
        ['run', 'scripts/learn/index.py', '--repo', repo.root_path, '--name', repo.name, '--slug', row.slug],
        { cwd: repo.root_path, env: unmarkedEnv(env), timeoutMs: 120_000 },
      );
      if (res.code === 0) {
        this.deps.store.update(row.id, { indexedTree: sha }, this.now());
        this.deps.log(`[learn-schedule] indexed ${row.id} at tree ${sha.slice(0, 12)}`);
      } else {
        this.deps.log(`[learn-schedule] index of ${row.id} failed (exit ${res.code}): ${(res.stderr || res.stdout).slice(0, 300)}`);
      }
      return; // one index spawn per sweep
    }
  }

  private async launchOne(rows: LearnSchedule[], status: Map<string, SessionStatus>): Promise<void> {
    const now = this.now();
    // A launched run the list does not show (yet) counts as OPEN — never launch a second refresh
    // on a guess — unless it was launched over STALE_LAUNCH_MS ago (archived or lost: stop waiting).
    const open = rows.some((r) => {
      if (r.lastRunId === null || r.lastOutcome !== 'launched') return false;
      const s = status.get(r.lastRunId);
      if (s !== undefined) return !TERMINAL.has(s);
      return r.lastRunAt !== null && now.getTime() - Date.parse(r.lastRunAt) < STALE_LAUNCH_MS;
    });
    if (open) return;
    if ([...status.values()].some((s) => s === 'executing')) return;
    const due = rows
      .filter((r) => r.enabled && Date.parse(r.nextDueAt) <= now.getTime())
      .sort((a, b) => a.nextDueAt.localeCompare(b.nextDueAt))[0];
    if (due === undefined) return;
    try {
      const runId = await this.deps.adapter.launchRun({
        problem: refreshProblem(due),
        sessionId: randomUUID(),
        clisJson: JSON.stringify(await this.deps.adapter.seatsForWorkflow(LEARN_WORKFLOW)),
        workflow: LEARN_WORKFLOW,
        repoRef: due.repoRef,
        deliver: 'pr',
        ...(due.projectId !== undefined ? { projectId: due.projectId } : {}),
      });
      recordRunLaunched(this.deps.audit, this.deps.runTimingIndex, LEARN_SCHEDULE_ACTOR, runId, {
        workflow: LEARN_WORKFLOW,
        repoRef: due.repoRef,
        deliver: 'pr',
        learnSchedule: due.id,
        ...(due.projectId !== undefined ? { projectId: due.projectId } : {}),
      });
      if (due.projectId !== undefined) this.deps.fileRun(runId, due.projectId);
      this.deps.store.update(
        due.id,
        {
          lastRunId: runId,
          lastRunAt: now.toISOString(),
          lastOutcome: 'launched',
          failures: 0,
          lastError: null,
          nextDueAt: new Date(now.getTime() + due.everyHours * HOURS).toISOString(),
        },
        now,
      );
      this.deps.broadcast({ type: 'learnRefreshLaunched', session: runId, schedule: due.id } as unknown as CoreEvent);
      this.deps.log(`[learn-schedule] ${due.id} due → learn ${runId}`);
    } catch (err) {
      const failures = due.failures + 1;
      const message = err instanceof Error ? err.message : String(err);
      this.deps.store.update(
        due.id,
        {
          failures,
          lastOutcome: 'refused',
          lastError: message.slice(0, 500),
          nextDueAt: new Date(now.getTime() + Math.min(2 ** failures, 24) * HOURS).toISOString(),
        },
        now,
      );
      this.deps.log(`[learn-schedule] ${due.id} launch refused (${failures}): ${message}`);
    }
  }
}
