// Run liveness from the daemon's own process tree (crew#629 / crew#581).
//
// The stall watchdog's only proof of life used to be a relay frame. A wrapped-carrier seat that
// runs `vitest run` or `cargo test` in its own shell emits no frame while the child works, so a
// busy unit read as silent and was killed and re-dispatched at 30 minutes (run c4acc184: three
// full suite runs = "30 min silence").
//
// The engine runs in this process (napi), so every worker it spawns, and every test runner or
// build those workers start, is a DESCENDANT of this daemon. A run's processes are the ones whose
// working directory sits inside a directory the engine named for the run: its worktree
// (`<repo>/wicked-worktrees/<run id>`), or a checks floor's guarded checkout of the run's tree,
// which the engine keeps OUTSIDE the worktree (wicked-core `repo_checks::checkout_guarded_tree`:
// `$TMPDIR/wicked-core-floor/<label>-<pid>-<nonce>`, the label `<run id>-<ord>-a<attempt>` for a
// unit's floor and `<run id>-<ord>-deliver` for the deliver re-verify). Both are read EXACTLY: the
// worktree segment equals the run id, and a floor checkout's owner is parsed off the fixed suffix,
// so one run's processes never count for another whose id is a prefix of it. Before the floor
// checkout was read, a deliver step's re-verify (an hour of vitest or cargo) read as silence: the
// watchdog raised `workerStalled` at 15 min and a needs-you at 30 on rig runs 85ddad0d and d3a380b0.
//
// One reading per sweep: `ps` for the tree and CPU times, then the cwd of each descendant
// (`lsof` on macOS, `/proc/<pid>/cwd` on Linux). Windows has no reading: the watchdog keeps the
// frame-only clock there.

import { execFile } from 'node:child_process';
import { readlink } from 'node:fs/promises';
import { childEnvWithBootEstateDb } from '../core/governance-store.js';

/** One process row: its parent, cumulative CPU seconds, and command name. */
export interface ProcRow {
  pid: number;
  ppid: number;
  cpuSec: number;
  comm: string;
}

/** The two OS reads the sampler needs, injectable for tests. */
export interface ProcessProbe {
  /** Every process on the host (or at least this daemon's subtree). */
  table: () => Promise<ProcRow[]>;
  /** The working directory of each pid that has a readable one. */
  cwds: (pids: number[]) => Promise<Map<number, string>>;
}

/** CPU share of one core, over the time since the previous sample, that reads as busy. An idle
 *  node CLI waiting on a model sits well under 1 %; a test runner or compiler burns 50-100 %+. */
export const BUSY_CPU_SHARE = 0.05;

/**
 * Parses `ps -o time=` (`[[dd-]hh:]mm:ss[.cc]`, macOS and procps alike) to seconds; NaN when
 * the field is not a CPU time.
 */
export function parseCpuTime(raw: string): number {
  const s = raw.trim();
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(s);
  if (m === null) return Number.NaN;
  const [, dd, hh, mm, ss] = m;
  return (Number(dd ?? 0) * 24 + Number(hh ?? 0)) * 3600 + Number(mm) * 60 + Number(ss);
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 8_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: childEnvWithBootEstateDb() }, (_err, stdout) => {
      // lsof exits 1 when one of the pids has already gone; its stdout for the rest still counts.
      resolve(typeof stdout === 'string' ? stdout : '');
    });
  });
}

/** The host probe: `ps` everywhere POSIX, cwd via lsof (macOS) or /proc (Linux). */
export const hostProcessProbe: ProcessProbe = {
  table: async () => {
    const out = await run('ps', ['-A', '-o', 'pid=,ppid=,time=,comm=']);
    const rows: ProcRow[] = [];
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (m === null) continue;
      const cpuSec = parseCpuTime(m[3] ?? '');
      if (!Number.isFinite(cpuSec)) continue;
      rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cpuSec, comm: (m[4] ?? '').trim() });
    }
    return rows;
  },
  cwds: async (pids) => {
    const out = new Map<number, string>();
    if (pids.length === 0) return out;
    if (process.platform === 'linux') {
      await Promise.all(
        pids.map(async (pid) => {
          try {
            out.set(pid, await readlink(`/proc/${pid}/cwd`));
          } catch {
            // gone, or not ours to read
          }
        }),
      );
      return out;
    }
    const text = await run('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn', '-w']);
    let pid: number | undefined;
    for (const line of text.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('n') && pid !== undefined) out.set(pid, line.slice(1));
    }
    return out;
  },
};

/** The directory the engine makes its guarded floor checkouts in (`std::env::temp_dir()/…`). */
export const FLOOR_CHECKOUT_PARENT = 'wicked-core-floor';
/** A floor checkout's name: `<run label>-<ord>-a<attempt>-<pid>-<nonce>` or `<run label>-<ord>-deliver-<pid>-<nonce>`. */
const FLOOR_CHECKOUT_NAME = /^(.+)-\d+-(?:a\d+|deliver)-\d+-\d+$/;

/** The run id as the engine spells it in a checkout label (every char but ASCII alnum and `-` → `_`). */
function floorLabelOf(runId: string): string {
  return [...runId].map((c) => (/^[A-Za-z0-9-]$/.test(c) ? c : '_')).join('');
}

/**
 * The run `cwd` belongs to: a path segment that IS a run id (`…/wicked-worktrees/<id>/…`), or a
 * guarded floor checkout (`…/wicked-core-floor/<id>-<ord>-a<n>-<pid>-<nonce>/…`) whose parsed
 * owner is a run id. Never a prefix or substring: `<id>-tests` is another run.
 */
export function runOfCwd(cwd: string, runIds: readonly string[]): string | undefined {
  const segments = cwd.split('/');
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] as string;
    const exact = runIds.find((id) => id === seg);
    if (exact !== undefined) return exact;
    if (i > 0 && segments[i - 1] === FLOOR_CHECKOUT_PARENT) {
      const owner = FLOOR_CHECKOUT_NAME.exec(seg)?.[1];
      const id = owner === undefined ? undefined : runIds.find((r) => floorLabelOf(r) === owner);
      if (id !== undefined) return id;
    }
  }
  return undefined;
}

/**
 * Samples which runs have busy processes. Stateful: CPU is compared with the previous sample of
 * the same pid, so the first sample of a process is a baseline and never reads as busy.
 */
export class RunLivenessSampler {
  private prev = new Map<number, { cpuSec: number; at: number }>();

  constructor(
    private readonly probe: ProcessProbe = hostProcessProbe,
    private readonly rootPid: number = process.pid,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * For each of `runIds` whose processes burned at least {@link BUSY_CPU_SHARE} of a core since the
   * previous sample: the run id → a short description of the busiest process (`vitest pid 812`).
   */
  async busy(runIds: readonly string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (runIds.length === 0 || process.platform === 'win32') return result;
    const rows = await this.probe.table();
    const children = new Map<number, ProcRow[]>();
    for (const r of rows) {
      const list = children.get(r.ppid);
      if (list === undefined) children.set(r.ppid, [r]);
      else list.push(r);
    }
    const descendants: ProcRow[] = [];
    const queue = [this.rootPid];
    const seen = new Set<number>(queue);
    while (queue.length > 0) {
      for (const c of children.get(queue.shift() as number) ?? []) {
        if (seen.has(c.pid)) continue;
        seen.add(c.pid);
        descendants.push(c);
        queue.push(c.pid);
      }
    }
    const cwds = await this.probe.cwds(descendants.map((d) => d.pid));
    const at = this.now();
    const next = new Map<number, { cpuSec: number; at: number }>();
    const perRun = new Map<string, { burned: number; window: number; top?: ProcRow; topBurn: number }>();
    for (const d of descendants) {
      next.set(d.pid, { cpuSec: d.cpuSec, at });
      const cwd = cwds.get(d.pid);
      if (cwd === undefined) continue;
      const runId = runOfCwd(cwd, runIds);
      if (runId === undefined) continue;
      const before = this.prev.get(d.pid);
      if (before === undefined) continue; // baseline
      const burned = Math.max(0, d.cpuSec - before.cpuSec);
      const acc = perRun.get(runId) ?? { burned: 0, window: 0, topBurn: 0 };
      acc.burned += burned;
      acc.window = Math.max(acc.window, (at - before.at) / 1000);
      if (burned > acc.topBurn) {
        acc.top = d;
        acc.topBurn = burned;
      }
      perRun.set(runId, acc);
    }
    this.prev = next;
    for (const [runId, acc] of perRun) {
      if (acc.window > 0 && acc.burned / acc.window >= BUSY_CPU_SHARE && acc.top !== undefined) {
        const name = acc.top.comm.split('/').pop() ?? acc.top.comm;
        result.set(runId, `${name} pid ${acc.top.pid} (${acc.burned.toFixed(1)} s CPU in ${Math.round(acc.window)} s)`);
      }
    }
    return result;
  }
}
