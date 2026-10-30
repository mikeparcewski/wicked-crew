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
// `--all` (crew#1221) runs the WHOLE suite (`vitest run`) the same way: `.wicked/checks.json` declares
// `"test": ["node", "scripts/test-related.mjs", "--all"]`, the check a power run at high rigor or above
// hands off on. Plain `vitest run` built no `dist/` and applied no cross-repo filter, so on the floor's
// lone checkout the dist-CLI and cross-repo suites failed on base and head alike, the base was always
// red and every such floor escalated `base_red_unseparated`. `--all` gives the full suite the clean
// build and the cross-repo filter (with its one disclosed line) described below.
// It leaves nothing else out, and it does not retry itself: the engine retries the check (see `planAll`).
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
//     engine's outer bound by retrying. That re-run is taken only when EVERY failure the first pass
//     reported is a deadline failure, the named files equal vitest's `Test Files  N failed` count and the
//     summary reports no unhandled `Errors` (crew#1223, `namedRetryRefusal`); otherwise the first pass's
//     exit is recorded as-is with a `WICKED-RETRY` line naming the rule.
//     When the output names no file at all (a worker died before it reported), the whole command is re-run once, but ONLY if the first attempt left at least
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
//
// ## crew#1173 — build `dist/` before the tests run
//
// The dist-CLI suites (`cli-status-version`, `cli-port-resolution`, `mcp-server`,
// `governance-replay-cli`, `cli-service`) spawn `packages/crew/dist/cli/index.js` as a child
// process. CI builds before `test`; the floor runs this script on a fresh checkout, installs with
// `--ignore-scripts` and has no build key in `checks.json`, so `dist/` never existed there and those
// suites failed on every crew floor, base and head alike. So before vitest runs, this script empties
// `dist/` (keeping the `dist/studio` bundle, which is not crew's compiler output) and runs crew's own
// `npm run build` (`tsc -p tsconfig.json`, about 15 s), every time rather than only when `dist/` is
// missing: a worktree whose `dist/` was built before the change was edited would otherwise test the
// old code, and tsc never removes the output of a deleted source. `dist/` is gitignored, so the
// worktree guard does not see it. If the build fails, the failure is printed, the tests still run
// for their evidence, and the check fails whatever they report: tsc emits even on a type error, so
// passing tests after a failed build prove nothing about the build. Nothing is skipped.
//
// ## crew#1173 — the cross-repo tests run where the sibling checkout exists, and only there
//
// A handful of tests read the sibling `wicked-core` checkout (`tests/support/core-checkout.ts`):
// core's constants are derived from core's own sources rather than transcribed. The floor's checkout
// is a lone clone under the system temp dir with no sibling, so those tests failed on every crew
// floor, base and head alike, and the base could not be separated from the change. The operator's
// ruling: they run in CI, which checks crew and core out as siblings, and the floor leaves them out
// and says so. They carry the vitest tag `cross-repo` (declared in `vitest.config.ts`); when this
// script finds no checkout ({@link coreCheckoutDir}, the same candidates the support module tries)
// it passes `--tags-filter=!cross-repo` to vitest, on the first run and on the retry, and prints ONE
// line naming how many it left out, in which files, and why. With a checkout it passes nothing, and
// everywhere else (a developer's `npm test`, CI) nothing changes: a missing checkout still fails
// those tests loudly, as the support module's policy says.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { cpus, freemem, loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CREW = 'packages/crew';

/** The host-telemetry marker — greppable in a verdict's `stdoutTail`. */
export const HOST_MARKER = 'WICKED-HOST';
/** The retry-disclosure marker: what was re-run and why, or why nothing was. */
export const RETRY_MARKER = 'WICKED-RETRY';
/** crew's own build (`packages/crew` `build` = `tsc -p tsconfig.json`), run before the tests (crew#1173). */
export const BUILD_ARGV = ['npm', 'run', 'build'];

/** The vitest tag on every test that reads the sibling wicked-core checkout (crew#1173). */
export const CROSS_REPO_TAG = 'cross-repo';
/** What vitest is handed when there is no checkout: every test except the cross-repo ones. */
export const CROSS_REPO_FILTER = [`--tags-filter=!${CROSS_REPO_TAG}`];
/** What `tests/support/core-checkout.ts` requires of a directory before it counts as core's checkout. */
const CORE_ARTIFACTS = [join('crates', 'wicked-core-ts', 'package.json')];

/**
 * The sibling wicked-core checkout the cross-repo tests would use, or `null`. The same rule as
 * `resolveCoreDir()` in `tests/support/core-checkout.ts` (the parity is pinned by
 * `tests/test-related-cross-repo.test.ts`): an explicit `WICKED_CORE_DIR` is the only candidate,
 * otherwise `<repo>/../wicked-core` then `<repo>/../../wicked-core`, and a directory qualifies only
 * when it carries the artifacts. A RELATIVE override is read from `packages/crew`, where vitest (and so
 * the support module) runs, not from this script's cwd: read from here it could name nothing while
 * the tests find a checkout, and the filter would drop guards that could have run (review of #1183).
 */
export function coreCheckoutDir({ override = process.env['WICKED_CORE_DIR'], repoRoot = ROOT } = {}) {
  const candidates =
    override !== undefined && override.length > 0
      ? [resolve(repoRoot, CREW, override)]
      : [resolve(repoRoot, '..', 'wicked-core'), resolve(repoRoot, '..', '..', 'wicked-core')];
  for (const dir of candidates) {
    if (existsSync(dir) && CORE_ARTIFACTS.every((rel) => existsSync(join(dir, rel)))) return dir;
  }
  return null;
}

/**
 * The tests tagged {@link CROSS_REPO_TAG}, counted off the source: `{ count, files }`, files relative
 * to `packages/crew`. Each tagged `it` is one test; the tag goes on tests, not on suites, so this
 * count is the number vitest leaves out (pinned by `tests/test-related-cross-repo.test.ts`).
 */
export function crossRepoTests(crewDir = resolve(ROOT, CREW)) {
  const tag = new RegExp(`tags:\\s*\\[\\s*['"]${CROSS_REPO_TAG}['"]\\s*\\]`, 'g');
  const files = [];
  let count = 0;
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name !== 'node_modules') walk(p);
      } else if (/\.test\.[cm]?[jt]sx?$/.test(name)) {
        const n = (readFileSync(p, 'utf8').match(tag) ?? []).length;
        if (n > 0) {
          count += n;
          files.push(p.slice(crewDir.length + 1).replace(/\\/g, '/'));
        }
      }
    }
  };
  const tests = join(crewDir, 'tests');
  if (existsSync(tests)) walk(tests);
  return { count, files };
}

/** The one line the floor's evidence carries when the cross-repo tests are left out. */
export function crossRepoLine({ count, files }) {
  return (
    `test-related: left out ${count} cross-repo test(s) (vitest tag \`${CROSS_REPO_TAG}\`, in ${files.join(', ')}): ` +
    'no sibling wicked-core checkout; CI runs them (crew#1173).'
  );
}

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

/** A test file vitest can be handed as a filter: relative to packages/crew, test-shaped, no flag shape. */
const TEST_FILE = /^(?!-)(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\s{}]+\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * wicked-core#1198: the plan for `--tests <files>`, the engine's FAILING-SET re-run. `.wicked/checks.json`
 * declares `rerun.test_targeted = {"command": ["node", "scripts/test-related.mjs", "--tests", "{files}"], ...}`:
 * when this check fails, the floor's base comparison (and, for a check that does not retry on its own, its
 * retry) runs only the test files that failed, named as vitest named them (relative to packages/crew). They run
 * the way the targeted command runs them: the same clean build first, the same cross-repo filter, the same
 * one deadline retry. Only the selection differs: `vitest run <files>` instead of `vitest related`.
 * `--passWithNoTests`: on the run base, a file the change added does not exist, and the base cannot fail it.
 * Anything that is not a test file is refused, not skipped: an empty or malformed list must not pass.
 */
export function planTests(files) {
  const list = files.map((f) => String(f).replace(/\\/g, '/'));
  const bad = list.filter((f) => !TEST_FILE.test(f));
  if (list.length === 0) return { refuse: 'no test file named — `--tests` needs the files to run' };
  if (bad.length > 0) return { refuse: `not a test file under ${CREW}: ${bad.join(', ')}` };
  return { argv: ['npx', 'vitest', 'run', '--passWithNoTests', ...list], cwd: CREW };
}

/**
 * crew#1221: the plan for `--all`, the floor's FULL `test` check: every test in the suite (`vitest run`, no
 * selection), after the same clean build and with the same cross-repo filter as the targeted command.
 *
 * It does NOT retry itself (`retry: false`): its exit is recorded as-is and the ENGINE retries the check
 * (`rerun.test` is not `self_retry`). The engine's retry is the stronger one: a failing-set retry that passes
 * never stands on its own, the whole identical retry decides (wicked-core#1198). This script's deadline retry
 * re-runs the named files alone, so a file that failed an assertion beside a timed-out one, or an unhandled
 * error vitest names no file for, could clear on it (review of #1222).
 * It takes no file list: one given is refused rather than ignored.
 */
export function planAll(files = []) {
  if (files.length > 0) return { refuse: `\`--all\` runs the whole suite and takes no files (got ${files.join(', ')})` };
  return { argv: ['npx', 'vitest', 'run'], cwd: CREW, retry: false };
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
 * Strip ANSI styling before ANY parsing of vitest's output.
 *
 * The output this script parses is COLOURED wherever it actually runs: vitest colours when `CI=true`
 * (the repo-checks floor sets it — see the `RepoChecksEvaluatedEvent` doc: `CI=1` is one of the few
 * variables that reach a check), when `FORCE_COLOR` is set, and by default on Windows, where
 * picocolors turns colour on. A real `FAIL` line then reads
 *
 *   \x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m tests/foo.test.ts\x1b[2m > \x1b[22mname
 *
 * — captured verbatim from `CI=true FORCE_COLOR=1 npx vitest run` and committed as
 * `packages/crew/tests/fixtures/vitest-colored-failure-output.txt`. `\s` does not match `\x1b`, so
 * `^\s*FAIL` never matched a line in production, and `\S+` would have swallowed the trailing style
 * code even if it had. The first cut's unit fixtures were hand-written plain text, so they passed
 * while the real input could not (review of #656, defect 1).
 *
 * Normalising here rather than at the call site means a caller cannot forget: both classifiers are
 * self-protecting, and the cost is one `replace` over at most 512 KiB, once per attempt.
 */
export function stripAnsi(output) {
  // CSI sequences (colour, cursor) and the OSC-8 hyperlinks some reporters emit.
  return String(output ?? '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/**
 * WHY this output earns a re-run, or `null` when it does not. The whole tolerance hangs off this
 * predicate, so it only ever answers for a deadline (see {@link RETRYABLE_FAILURES}).
 */
export function retryableFailureReason(output) {
  const text = stripAnsi(output);
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
  // Hoisted, like `retryableFailureReason` above: inside the loop this was one `replace` over the
  // whole captured tail PER MATCH — and the normaliser's own doc promises one per call.
  const text = stripAnsi(output);
  const re = /^\s*FAIL\s+(\S+)/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const p = m[1].replace(/\\/g, '/');
    if (!/\.(test|spec)\.[cm]?[jt]sx?$/.test(p)) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * crew#1223: the checks that decide whether a failure set is PURELY deadline failures, so that re-running
 * only the named files can stand for the whole run. Returns the rule that refuses the named-files retry, or
 * `null` when every rule holds:
 *  • every failure the first pass reported (each ` FAIL  <file> > <test>` block, cut at the next header, the
 *    next `⎯⎯⎯` separator or the summary) carries a deadline marker itself — one assertion failure beside a
 *    timeout is not cleared because both pass alone;
 *  • the named files reconcile with vitest's own summary (`Test Files  N failed` equals the files named) — a
 *    header lost past the 512 KiB capture would otherwise leave a failing file unre-run;
 *  • the summary reports no unhandled errors (`Errors  N error`) — vitest attributes those to no file, so a
 *    re-run of the named files cannot clear them.
 * The engine's own rule (wicked-core#1198) is that a passing failing-set retry never stands for a failure it
 * did not name; this keeps the self-retry inside that.
 */
export function namedRetryRefusal(output, failed) {
  const text = stripAnsi(output);
  const lines = text.split('\n');
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    if (/^\s*FAIL\s+\S/.test(line)) {
      cur = [line];
      blocks.push(cur);
    } else if (cur !== null && (/^\s*⎯/.test(line) || /^\s*(Test Files|Tests|Errors)\s{2,}/.test(line))) {
      cur = null;
    } else if (cur !== null) {
      cur.push(line);
    }
  }
  const notDeadline = blocks.filter((b) => retryableFailureReason(b.join('\n')) === null);
  if (notDeadline.length > 0) {
    return `${notDeadline.length} failure(s) are not deadline failures (${notDeadline[0][0].trim()}), and the re-run alone could clear them`;
  }
  const summary = /^\s*Test Files\s+(\d+) failed/m.exec(text);
  if (summary === null) {
    return "the output carries no `Test Files  N failed` summary to reconcile the named files with";
  }
  if (Number(summary[1]) !== failed.length) {
    return `vitest's summary counts ${summary[1]} failed file(s) but ${failed.length} are named (a FAIL header may be lost)`;
  }
  const errs = /^\s*Errors\s+(\d+) errors?/m.exec(text);
  if (errs !== null) {
    return `vitest's summary reports ${errs[1]} unhandled error(s), which belong to no file the re-run names`;
  }
  return null;
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

/**
 * Run a command, streaming each stream through to ITS OWN destination — stdout to stdout, stderr to
 * stderr — while capturing both (the last 512 KiB, interleaved) for the classifier. The split
 * matters: the floor records `stdoutTail` and `stderrTail` separately on the verdict, and folding
 * stderr into stdout would empty one of the two pieces of evidence an operator reads.
 */
function spawnCapturing(argv, cwd, out, err) {
  return new Promise((done) => {
    const [cmd, ...rest] = argv;
    const child = spawn(process.platform === 'win32' ? `${cmd}.cmd` : cmd, rest, {
      cwd: resolve(ROOT, cwd),
      shell: process.platform === 'win32',
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    const CAP = 512 * 1024;
    let buf = '';
    const take = (sink) => (chunk) => {
      const s = chunk.toString();
      sink(s);
      buf += s;
      if (buf.length > CAP) buf = buf.slice(-CAP);
    };
    child.stdout?.on('data', take(out));
    child.stderr?.on('data', take(err));
    child.on('error', (err) => done({ status: 1, output: buf, spawnError: err.message }));
    child.on('close', (code) => done({ status: code ?? 1, output: buf, spawnError: null }));
  });
}

/**
 * Empty crew's `dist/` before the build (crew#1173), keeping `dist/studio`: that is the studio bundle
 * `build:with-studio` copies in, not crew's compiler output, so it cannot be stale crew code and a
 * local checkout should not lose it. A missing `dist/` is fine (the floor's fresh checkout).
 */
export function cleanDist(distDir) {
  if (!existsSync(distDir)) return;
  for (const name of readdirSync(distDir)) {
    if (name === 'studio') continue;
    rmSync(join(distDir, name), { recursive: true, force: true });
  }
}

/**
 * Run the targeted suite and return the exit code the check should report.
 *
 * `io.run` is the seam the tests drive: `(argv, cwd) => Promise<{ status, output, spawnError }>`.
 * `io.build` has the same shape and runs {@link BUILD_ARGV} once, before vitest; `io.cleanDist` empties
 * `dist/` first ({@link cleanDist}). Both are crew#1173.
 */
export async function runTargeted(files, io = {}) {
  const spawnStreaming = (argv, cwd) =>
    spawnCapturing(
      argv,
      cwd,
      (s) => process.stdout.write(s),
      (s) => process.stderr.write(s),
    );
  const run = io.run ?? spawnStreaming;
  const build = io.build ?? spawnStreaming;
  const clean = io.cleanDist ?? (() => cleanDist(resolve(ROOT, CREW, 'dist')));
  const out = io.out ?? ((line) => process.stdout.write(`${line}\n`));
  // wicked-core#1172: the line that starts a re-run goes to BOTH streams. vitest prints its failures on stderr,
  // so the floor splits each stream at its own copy: what a stream prints after it is the final pass, and a
  // failure only the first pass named is flaky (passed on retry), not this change's.
  const err = io.err ?? ((line) => process.stderr.write(`${line}\n`));
  const startRetry = (line) => {
    out(line);
    err(line);
  };
  const host = io.host ?? hostSnapshot;
  const now = io.now ?? Date.now;
  const budgetS = io.budgetS ?? checksTimeoutS();
  const coreDir = io.coreDir ?? coreCheckoutDir;
  const tagged = io.crossRepoTests ?? crossRepoTests;

  const p = (io.plan ?? plan)(files);
  if (p.refuse) {
    out(`test-related: ${p.refuse}`);
    out(formatHostLine(host(), 'post'));
    return 2;
  }
  if (p.skip) {
    // The skip line stays FIRST (its prefix is the pinned contract of this path), the host line last.
    out(`test-related: ${p.skip}`);
    out(formatHostLine(host(), 'post'));
    return 0;
  }

  out(formatHostLine(host(), 'pre'));
  // crew#1173: no sibling wicked-core checkout → leave the cross-repo tests out, and say so once.
  const filter = coreDir() === null ? CROSS_REPO_FILTER : [];
  if (filter.length > 0) out(crossRepoLine(tagged()));
  // crew#1173: the dist-CLI suites spawn dist/cli/index.js, and the floor's checkout has no dist/.
  // Emptied first: tsc overwrites what it emits but never removes the output of a deleted source.
  out(`test-related: ${BUILD_ARGV.join(' ')} (cwd ${p.cwd}) — a clean dist/ first, for the dist-CLI suites`);
  let built;
  try {
    clean();
    built = await build(BUILD_ARGV, p.cwd);
  } catch (err) {
    built = { status: 1, output: '', spawnError: `could not clear dist/: ${err instanceof Error ? err.message : String(err)}` };
  }
  const buildFailed = built.spawnError != null || built.status !== 0;
  if (buildFailed) {
    out(
      `test-related: the build FAILED (${built.spawnError ?? `exit ${built.status}`}) — running the tests anyway ` +
        'for their evidence; the check fails whatever they report.',
    );
  }
  // The vitest attempt (and its one retry) decides the tests' code; the build's verdict is applied
  // after it, so a failed build never reads as a pass, and the host line stays the LAST line.
  const attempt = async () => {
    const argv = [...p.argv, ...filter];
    out(`test-related: ${argv.join(' ')} (cwd ${p.cwd})`);
    const startedMs = now();
    const first = await run(argv, p.cwd);
    if (first.spawnError != null) {
      out(`test-related: could not run vitest: ${first.spawnError}`);
      return 1;
    }
    if (first.status === 0) {
      return 0;
    }
    if (p.retry === false) {
      out(`${RETRY_MARKER} none — the full suite does not retry itself; the engine's floor retries this check (crew#1221).`);
      return first.status;
    }

    const why = retryableFailureReason(first.output);
    if (why === null) {
      out(
        `${RETRY_MARKER} none — the failure carries no deadline marker, so it is this change's failure and is ` +
          'recorded as-is (crew#649: the retry must never launder a real failure).',
      );
      return first.status;
    }

    const failed = failedTestFiles(first.output);
    const elapsedS = (now() - startedMs) / 1000;
    let retryArgv = null;
    if (failed.length > 0) {
      const refusal = namedRetryRefusal(first.output, failed);
      if (refusal !== null) {
        out(
          `${RETRY_MARKER} none — ${why}, but ${refusal}; the named-files re-run cannot stand for the whole run, ` +
            'so the first pass is recorded as-is (crew#1223).',
        );
        return first.status;
      }
      retryArgv = ['npx', 'vitest', 'run', '--no-file-parallelism', ...filter, ...failed];
      startRetry(
        `${RETRY_MARKER} ${why} — re-running the ${failed.length} named file(s) ONCE, serially, before recording ` +
          `any failure: ${failed.join(', ')}`,
      );
    } else if (elapsedS < budgetS / 2) {
      retryArgv = [...argv, '--no-file-parallelism'];
      startRetry(
        `${RETRY_MARKER} ${why}, and the output named no test file (a worker died before it reported) — re-running ` +
          `the whole targeted command ONCE, serially (${elapsedS.toFixed(0)}s of the ${budgetS}s budget used).`,
      );
    } else {
      out(
        `${RETRY_MARKER} none — ${why}, but the output named no test file and ` +
          `${elapsedS.toFixed(0)}s of the ${budgetS}s budget is already spent; re-running the whole command could ` +
          'blow the check bound. Recorded as a failure, INCONCLUSIVE: this verdict may track host load, not the diff (crew#649).',
      );
      return first.status;
    }

    const second = await run(retryArgv, p.cwd);
    if (second.spawnError != null) {
      out(`test-related: could not run the re-run: ${second.spawnError}`);
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
    return second.status;
  };
  const tests = await attempt();
  const code = buildFailed && tests === 0 ? (built.status !== 0 ? built.status : 1) : tests;
  if (buildFailed && tests === 0) {
    out(`test-related: the tests passed, but the build failed — recorded as exit ${code} (crew#1173).`);
  }
  out(formatHostLine(host(), 'post'));
  return code;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let args = process.argv.slice(2);
  const dryRun = args[0] === '--dry-run';
  if (dryRun) args = args.slice(1);
  // wicked-core#1198: `--tests <files>` runs the named test files (the floor's failing-set re-run).
  const testsMode = args[0] === '--tests';
  // crew#1221: `--all` runs the whole suite (the floor's full `test` check).
  const allMode = args[0] === '--all';
  const files = testsMode || allMode ? args.slice(1) : args;
  const planOf = testsMode ? planTests : allMode ? planAll : plan;
  // `process.exitCode`, NEVER `process.exit()` (review of #656, defect 2). When stdout/stderr are
  // PIPED — which is exactly how the repo-checks floor runs this — node's streams are asynchronous,
  // and `process.exit()` terminates without draining them: under the pipe backpressure this check
  // exists to survive, the tail can be cut. The last thing this script writes is the `WICKED-HOST`
  // telemetry, placed last precisely so it survives the floor's 4 KiB `stdoutTail` truncation —
  // exiting hard could drop the one line the fix added. Setting the code lets node leave once the
  // buffers drain; nothing after this statement keeps the event loop alive.
  if (dryRun) {
    // Pure: the plan as JSON and nothing else — the mapper test parses this stdout.
    process.stdout.write(`${JSON.stringify(planOf(files))}\n`);
    process.exitCode = 0;
  } else {
    process.exitCode = await runTargeted(files, { plan: planOf });
  }
}
