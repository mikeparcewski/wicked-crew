#!/usr/bin/env node
// The engine's change-scoped test command for this repo (core#482 ship half — FIX-IT-ALL L10-8).
//
// `.wicked/checks.json` declares `"test_targeted": ["node", "scripts/test-related.mjs", "{files}"]`:
// the repo-checks floor splices one argv entry per touched file, spelled RELATIVE TO THE WORKTREE
// ROOT (`git diff --name-only` + `ls-files --others` at the root — `packages/crew/src/x.ts`), and runs
// it from the root at the creator's and the verifier's floor (`full: false`; the FULL suite stays
// CI's PR gate — it blew the 1200 s verify bound under host load, F-RC2-050). vitest resolves
// `related` paths against ITS root, so the one-liner cannot work from the root: `--root packages/crew`
// + root-relative files doubles the prefix, and without `--root` crew's config (hermetic setup files)
// is not loaded. This script is the one deterministic place for that translation:
//
//   1. keep the files under `packages/crew/`, re-spell them relative to `packages/crew`;
//   2. none left (docs, root files, another workspace) → print why and exit 0 — nothing to run;
//   3. else `npx vitest related --run --passWithNoTests <files>` with `cwd: packages/crew`, and exit
//      with vitest's status (`--passWithNoTests`: a crew source file with no related test is not a
//      failure of the change).
//
// `--dry-run` prints the plan as JSON instead of running it (what the unit test asserts).
//
// ## crew#649 — the verdict must not track ambient host load
//
// When the diff touches a hub module (`src/api/routes.ts`), `vitest related` expands to ~147 files /
// ~1,800 tests and runs 11–17 minutes. On a busy host (this box runs corporate endpoint agents at up
// to 198 % CPU with swap near-full) vitest's workers miss the birpc deadline and die with
// `[vitest-worker]: Timeout calling "onTaskUpdate"`. Every test in that worker's file is then
// recorded as FAILED. The repo-checks floor diffs the head failure set against the base's and calls
// whatever is unique to head a `[regression]` — so the verdict tracked the load, not the diff: six
// of seven attempts on one byte-stable diff denied it, the one attempt at load 23 passed, the named
// failures never repeated, and nine of them re-ran individually at exit 0 in the same worktree.
//
// Two things close that here — TOLERANCE, not scheduling (the check still runs the same tests, with
// the same workers, in the same order):
//
//   • RETRY ONCE, only for a DEADLINE failure (`RETRYABLE_FAILURES`: the worker-IPC death above, and
//     the `Test/Hook timed out in Nms` shape the same contention produces one level in — observed on
//     this host at load 45 on an unmodified tree). A non-zero exit whose output carries no deadline
//     marker is a real failure and is recorded immediately — the retry must never launder an
//     assertion failure. When a deadline marker IS present, the test FILES
//     vitest named are re-run ONCE, serially (`--no-file-parallelism`): a failure that does not
//     reproduce on its own is not evidence. They pass ⇒ exit 0 (every failure observed was re-run
//     and cleared; the rest of the suite already passed). One still fails ⇒ exit 1, as before.
//     The re-run is bounded — it is the named files, not the suite — so the check cannot blow the
//     engine's outer bound by retrying. When the output names no file at all (a worker died before
//     it reported), the whole command is re-run once, but ONLY if the first attempt left at least
//     half the declared `timeout_s` budget unspent.
//
//   • RECORD THE HOST. `WICKED-HOST` lines are printed before the run and again as the LAST thing
//     the check prints, so they survive the floor's 4 KiB `stdoutTail` truncation and a verdict
//     produced at load 130 with swap exhausted is distinguishable in the ledger from the same
//     verdict at load 10. Nothing separated them before.
//
// Not fixed here: vitest's worker→main birpc deadline itself is hard-coded (`DEFAULT_TIMEOUT = 6e4`
// in birpc, no vitest config or env knob in v3.2 — checked in `node_modules/vitest/dist/chunks`), so
// the deadline cannot be raised from this side. The retry is the tolerance that closes it; the
// in-suite `testTimeout`/`hookTimeout` are raised on the same grounds in `vitest.config.ts`.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cpus, freemem, loadavg } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CREW = 'packages/crew';

/** The host-telemetry marker — greppable in a verdict's `stdoutTail`. */
export const HOST_MARKER = 'WICKED-HOST';
/** The retry-disclosure marker: what was re-run and why, or why nothing was. */
export const RETRY_MARKER = 'WICKED-RETRY';

/**
 * The failure shapes that earn ONE re-run — all of them DEADLINES, none of them a verdict about the
 * code. An `AssertionError`, a type error, a thrown exception, a non-zero exit with no deadline in
 * sight: recorded as-is, immediately, with no second run.
 *
 *  • `[vitest-worker]: Timeout calling "…"` — the worker missed vitest's birpc deadline and died;
 *    every test in its file is then reported failed (the shape #649 recorded seven times).
 *  • `Test timed out in Nms` / `Hook timed out in Nms` — the same contention one level in. Observed
 *    on this host at load 45 on an UNMODIFIED tree: `evals-internal-corpus` (one of the tests #649
 *    names as re-running at exit 0) timed out twice in a run whose diff was empty.
 *
 * Widening the set is safe because the re-run — not the marker — is the judge: a test that really
 * hangs hangs again on its own, serially, and still fails. The marker only decides whether asking
 * twice is warranted.
 */
export const RETRYABLE_FAILURES = [
  { re: /\[vitest-worker\]: Timeout calling "/, why: 'a vitest worker missed its IPC deadline and died (`[vitest-worker]: Timeout calling …`)' },
  { re: /(Test|Hook) timed out in \d+ms/, why: 'a test or hook blew its in-suite deadline (`Test/Hook timed out in …ms`)' },
];

/** Worktree-root-relative paths → the ones under packages/crew, spelled relative to it. */
export function crewRelative(files) {
  const out = [];
  for (const f of files) {
    const norm = String(f).replace(/\\/g, '/').replace(/^\.\//, '');
    if (norm.startsWith(`${CREW}/`)) out.push(norm.slice(CREW.length + 1));
  }
  return out;
}

/** The plan: `{ skip: reason }` when nothing under packages/crew changed, else `{ argv, cwd }`. */
export function plan(files) {
  const related = crewRelative(files);
  if (related.length === 0) return { skip: 'no crew files touched — no related tests to run (docs / root / other-workspace change)' };
  return {
    argv: ['npx', 'vitest', 'related', '--run', '--passWithNoTests', ...related],
    cwd: CREW,
  };
}

/**
 * Free/used swap in MiB, or `null` where it cannot be read. macOS keeps it in
 * `sysctl vm.swapusage`, Linux in `/proc/meminfo`; every other platform (Windows) answers `null` and
 * the telemetry line says `unknown` rather than inventing a number. Never throws: telemetry must not
 * be able to fail a check.
 */
export function swapMb() {
  try {
    if (process.platform === 'darwin') {
      const r = spawnSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8', timeout: 5000 });
      const text = typeof r.stdout === 'string' ? r.stdout : '';
      const free = /free\s*=\s*([\d.]+)M/.exec(text);
      const used = /used\s*=\s*([\d.]+)M/.exec(text);
      if (free === null && used === null) return null;
      return {
        freeMb: free !== null ? Number(free[1]) : null,
        usedMb: used !== null ? Number(used[1]) : null,
      };
    }
    if (process.platform === 'linux') {
      const text = readFileSync('/proc/meminfo', 'utf8');
      const free = /SwapFree:\s*(\d+) kB/.exec(text);
      const total = /SwapTotal:\s*(\d+) kB/.exec(text);
      if (free === null || total === null) return null;
      const freeMb = Number(free[1]) / 1024;
      const totalMb = Number(total[1]) / 1024;
      return { freeMb, usedMb: totalMb - freeMb };
    }
  } catch {
    return null;
  }
  return null;
}

/** The host conditions this check ran under. Every field is best-effort; `null` means "unknown". */
export function hostSnapshot(deps = {}) {
  const avg = (deps.loadavg ?? loadavg)();
  const cpuCount = (deps.cpuCount ?? (() => cpus().length))();
  const swap = (deps.swap ?? swapMb)();
  const load1 = Array.isArray(avg) && typeof avg[0] === 'number' ? avg[0] : null;
  return {
    load1,
    load5: Array.isArray(avg) && typeof avg[1] === 'number' ? avg[1] : null,
    cpus: typeof cpuCount === 'number' && cpuCount > 0 ? cpuCount : null,
    loadPerCpu: load1 !== null && typeof cpuCount === 'number' && cpuCount > 0 ? load1 / cpuCount : null,
    freeMemMb: (deps.freemem ?? freemem)() / (1024 * 1024),
    swapFreeMb: swap !== null && swap !== undefined ? swap.freeMb : null,
    swapUsedMb: swap !== null && swap !== undefined ? swap.usedMb : null,
  };
}

/** One number for the telemetry line: 2 decimals, or `unknown`. */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : 'unknown';
}

/**
 * The telemetry line. `label` is `pre` (before the run) or `post` (the LAST line the check prints,
 * so it survives the floor's 4 KiB tail truncation).
 */
export function formatHostLine(snap, label) {
  return (
    `${HOST_MARKER} label=${label} load1=${num(snap.load1)} load5=${num(snap.load5)} ` +
    `cpus=${snap.cpus ?? 'unknown'} loadPerCpu=${num(snap.loadPerCpu)} ` +
    `freeMemMb=${num(snap.freeMemMb)} swapFreeMb=${num(snap.swapFreeMb)} swapUsedMb=${num(snap.swapUsedMb)}`
  );
}

/**
 * WHY this output earns a re-run, or `null` when it does not. The whole tolerance hangs off this
 * predicate, so it only ever answers for a deadline (see {@link RETRYABLE_FAILURES}).
 */
export function retryableFailureReason(output) {
  const text = String(output ?? '');
  for (const { re, why } of RETRYABLE_FAILURES) {
    if (re.test(text)) return why;
  }
  return null;
}

/**
 * The test FILES vitest reported as failing, deduplicated, in first-seen order — read off the
 * reporter's own ` FAIL  <path> > <name>` lines (verbose and default reporters both print them).
 * Only test-shaped paths are taken: a `FAIL` line naming something else is not a file this script
 * can hand back to vitest as a filter.
 */
export function failedTestFiles(output) {
  const out = [];
  const re = /^\s*FAIL\s+(\S+)/gm;
  let m;
  while ((m = re.exec(String(output ?? ''))) !== null) {
    const p = m[1].replace(/\\/g, '/');
    if (!/\.(test|spec)\.[cm]?[jt]sx?$/.test(p)) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** The declared outer bound for this check (`.wicked/checks.json`), seconds; 1800 when unreadable. */
export function checksTimeoutS(root = ROOT) {
  try {
    const j = JSON.parse(readFileSync(resolve(root, '.wicked', 'checks.json'), 'utf8'));
    return typeof j.timeout_s === 'number' && j.timeout_s > 0 ? j.timeout_s : 1800;
  } catch {
    return 1800;
  }
}

/** Run a command, streaming its output through AND capturing it (the last 512 KiB) for the classifier. */
function spawnCapturing(argv, cwd, out) {
  return new Promise((done) => {
    const [cmd, ...rest] = argv;
    const child = spawn(process.platform === 'win32' ? `${cmd}.cmd` : cmd, rest, {
      cwd: resolve(ROOT, cwd),
      shell: process.platform === 'win32',
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    const CAP = 512 * 1024;
    let buf = '';
    const take = (chunk) => {
      const s = chunk.toString();
      out(s);
      buf += s;
      if (buf.length > CAP) buf = buf.slice(-CAP);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.on('error', (err) => done({ status: 1, output: buf, spawnError: err.message }));
    child.on('close', (code) => done({ status: code ?? 1, output: buf, spawnError: null }));
  });
}

/**
 * Run the targeted suite and return the exit code the check should report.
 *
 * `io.run` is the seam the tests drive: `(argv, cwd) => Promise<{ status, output, spawnError }>`.
 */
export async function runTargeted(files, io = {}) {
  const run = io.run ?? ((argv, cwd) => spawnCapturing(argv, cwd, (s) => process.stdout.write(s)));
  const out = io.out ?? ((line) => process.stdout.write(`${line}\n`));
  const host = io.host ?? hostSnapshot;
  const now = io.now ?? Date.now;
  const budgetS = io.budgetS ?? checksTimeoutS();

  const p = plan(files);
  if (p.skip) {
    // The skip line stays FIRST (its prefix is the pinned contract of this path), the host line last.
    out(`test-related: ${p.skip}`);
    out(formatHostLine(host(), 'post'));
    return 0;
  }

  out(formatHostLine(host(), 'pre'));
  out(`test-related: ${p.argv.join(' ')} (cwd ${p.cwd})`);
  const startedMs = now();
  const first = await run(p.argv, p.cwd);
  if (first.spawnError != null) {
    out(`test-related: could not run vitest: ${first.spawnError}`);
    out(formatHostLine(host(), 'post'));
    return 1;
  }
  if (first.status === 0) {
    out(formatHostLine(host(), 'post'));
    return 0;
  }

  const why = retryableFailureReason(first.output);
  if (why === null) {
    out(
      `${RETRY_MARKER} none — the failure carries no deadline marker, so it is this change's failure and is ` +
        'recorded as-is (crew#649: the retry must never launder a real failure).',
    );
    out(formatHostLine(host(), 'post'));
    return first.status;
  }

  const failed = failedTestFiles(first.output);
  const elapsedS = (now() - startedMs) / 1000;
  let retryArgv = null;
  if (failed.length > 0) {
    retryArgv = ['npx', 'vitest', 'run', '--no-file-parallelism', ...failed];
    out(
      `${RETRY_MARKER} ${why} — re-running the ${failed.length} named file(s) ONCE, serially, before recording ` +
        `any failure: ${failed.join(', ')}`,
    );
  } else if (elapsedS < budgetS / 2) {
    retryArgv = [...p.argv, '--no-file-parallelism'];
    out(
      `${RETRY_MARKER} ${why}, and the output named no test file (a worker died before it reported) — re-running ` +
        `the whole targeted command ONCE, serially (${elapsedS.toFixed(0)}s of the ${budgetS}s budget used).`,
    );
  } else {
    out(
      `${RETRY_MARKER} none — ${why}, but the output named no test file and ` +
        `${elapsedS.toFixed(0)}s of the ${budgetS}s budget is already spent; re-running the whole command could ` +
        'blow the check bound. Recorded as a failure, INCONCLUSIVE: this verdict may track host load, not the diff (crew#649).',
    );
    out(formatHostLine(host(), 'post'));
    return first.status;
  }

  const second = await run(retryArgv, p.cwd);
  if (second.spawnError != null) {
    out(`test-related: could not run the re-run: ${second.spawnError}`);
    out(formatHostLine(host(), 'post'));
    return first.status;
  }
  if (second.status === 0) {
    out(
      `${RETRY_MARKER} the re-run passed — every failure the first attempt reported was re-run on its own and ` +
        'cleared, so it was contention, not this change (crew#649). Reporting exit 0.',
    );
  } else {
    out(`${RETRY_MARKER} the re-run FAILED too — a reproducing failure is this change's, recorded as exit ${second.status}.`);
  }
  out(formatHostLine(host(), 'post'));
  return second.status;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const dryRun = args[0] === '--dry-run';
  const files = dryRun ? args.slice(1) : args;
  if (dryRun) {
    // Pure: the plan as JSON and nothing else — the mapper test parses this stdout.
    process.stdout.write(`${JSON.stringify(plan(files))}\n`);
    process.exit(0);
  }
  process.exit(await runTargeted(files));
}
