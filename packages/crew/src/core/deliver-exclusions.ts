/**
 * WHAT THE DELIVER PUSH LEAVES BEHIND — the crew#434 classifier, as one reusable predicate.
 *
 * The rules themselves are not new: they have run inside `deliverPrScript`'s generated bash since
 * crew#434 (an untracked candidate is staged UNLESS it looks like scratch or key material, and
 * every exclusion is printed with its reason). What is new is that they are now readable from
 * TypeScript, because a second consumer needs the SAME answer.
 *
 * ## Why (F3, ship-proof C7)
 *
 * The deliver gate's consent diffstat is computed from `GET /runs/:id/diff`, whose untracked pass
 * appended every non-ignored untracked path as an all-addition hunk. The push does not carry every
 * non-ignored untracked path. On a run whose creator left a `tmp/` behind, the gate read
 * **"109 files changed, +258, -2"** and the commit pushed **4 files, +47, -2** — 27x over, on the
 * one gate with an irreversible external side effect. The script printed
 * `deliver: EXCLUDED (scratch-dir): tmp/ (105 files)`, so the exclusion applied to the push and
 * not to the number the operator approved.
 *
 * The number on a consent surface has to be the number that ships, so the diff the gate reads now
 * runs this classifier over its untracked candidates.
 *
 * ## Drift
 *
 * There are necessarily TWO implementations — this one runs in the daemon, the other is generated
 * bash running in the run worktree — and only one of them decides what is actually pushed. The
 * shell is therefore the source of truth and this module tracks it; they are pinned together by
 * `tests/deliver-gate-diffstat.test.ts`, which runs the REAL script over a fixture tree and
 * requires the committed set to equal the set this function keeps.
 *
 * It is a GUARD, NOT A SILENT DROP: the script still prints every excluded path with its reason
 * into the phase output (retained and served on the run wire), and this module only changes which
 * files a *preview* of the push counts.
 */

/**
 * The deliver script's untracked RECOVERY SENTINEL (crew#432): a failed push leaves this empty file
 * at the worktree root so the engine's terminal reap never removes a worktree whose work was
 * committed but not delivered, and the next attempt removes it before staging. It is never part of
 * the push, so it is never part of the consent diffstat either (N2, ship re-proof): the retry gate
 * read "5 files changed" for a commit of 4 because this predicate did not know the name. The
 * script's `S=` line is generated FROM this constant, so the name cannot drift between the two.
 */
export const DELIVER_STRANDED_SENTINEL = '.wicked-crew-delivery-stranded';

/** Basename globs that mean "scratch or key material, never a run's product" (crew#434). */
const DENYLISTED = [
  /\.db$/, /\.db-wal$/, /\.db-shm$/,
  /\.sqlite$/, /\.sqlite2$/, /\.sqlite3$/, /\.sqlite-wal$/, /\.sqlite-shm$/,
  /\.sock$/, /\.pid$/,
  /\.env$/, /\.env\./, /^\.envrc$/,
  /\.gif$/, /\.webm$/, /\.mp4$/, /\.mov$/,
  /\.pem$/, /\.key$/, /\.p12$/, /\.pfx$/,
  /^id_rsa/, /credentials/,
];

/**
 * crew#901: an env TEMPLATE (`.env.example`, `.env.sample`, `.env.template`, and `<x>.env.example`
 * and the like) is a product a README points at ("see `.env.example`"; MCPS-1004 requires one), not
 * key material — when it holds no value. It rides only when every line is blank, a comment, or a
 * `NAME=` assignment whose value is empty (`""`, `''`) or an angle-bracket placeholder
 * (`<your token>`); one real value and it is excluded as `env-template-with-values`. The shell runs
 * the same test with {@link ENV_TEMPLATE_SAFE_LINE_ERE}.
 */
const ENV_TEMPLATE = /\.env\.(example|sample|template)$/;

/** One line a value-free env template may hold (POSIX ERE, shared with the deliver script). */
export const ENV_TEMPLATE_SAFE_LINE_ERE =
  "^[[:space:]]*(#.*)?$|^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=[[:space:]]*(\"\"|''|<[^>]*>)?[[:space:]]*$";
const ENV_TEMPLATE_SAFE_LINE = new RegExp(
  // POSIX `[[:space:]]` is space, tab, CR, LF, VT and FF: a CRLF template must read the same here
  // as in the shell's grep.
  ENV_TEMPLATE_SAFE_LINE_ERE.replaceAll('[[:space:]]', '[ \\t\\r\\n\\v\\f]'),
  's', // and POSIX `.` matches CR too (JS `.` does not without dotAll)
);

/** Whether a basename names an env template (lowercased, as the ladder compares). */
export function isEnvTemplateName(lowerBase: string): boolean {
  return ENV_TEMPLATE.test(lowerBase);
}

/** Whether an env template's text holds no value (every line {@link ENV_TEMPLATE_SAFE_LINE}). */
export function envTemplateIsValueFree(text: string): boolean {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop(); // a trailing newline is not a line
  return lines.every((l) => ENV_TEMPLATE_SAFE_LINE.test(l));
}

/** The scratch/cache directory names the push never carries, at any depth. */
export const SCRATCH_DIRS = ['tmp', '.tmp', 'scratch', '.cache', 'coverage'];

/**
 * The directories a TEST RUNNER or build tool writes its own output into (crew#861): a vitest
 * JSON reporter's `.vitest/json/output.json` (2.3 MB, left untracked at a studio worktree root by a
 * creator's read-only re-verify) would have ridden a governed PR had the lift not conflicted first.
 * These names are never a run's product at any depth; like {@link SCRATCH_DIRS} they are excluded at
 * enumeration by the script and reported once with a count.
 */
export const TOOL_ARTIFACT_DIRS = ['.vitest', 'playwright-report', 'test-results', 'node_modules', '.nyc_output', '__pycache__', '.pytest_cache'];

/** Basename globs that are a tool's own log/report output, never a run's product (crew#861). */
const TOOL_ARTIFACT_NAMES = [/\.log$/];

/** The heading under which the deliver script lists what it left behind, in the PR body and the
 *  commit message (crew#861) — the "says what it skipped" half of the guard. */
export const DELIVER_NOT_SHIPPED_HEADING = '## Not shipped';

/** Past this, an otherwise-unrecognised file is scratch by size alone (the generic net). */
export const OVERSIZE_BYTES = 1048576;

/**
 * Why the deliver push would exclude this path on its NAME alone — the arms that need no `stat`:
 * the denylist, the `socket` basename, `.DS_Store`, a scratch or tool-artifact directory at any depth,
 * and a tool's `*.log` (crew#434, crew#861). `null`
 * means "no name rule fires"; the caller still owes the size rule ({@link deliverExclusionReason}).
 *
 * Split out so a caller can classify 100 000 untracked paths without 100 000 synchronous `stat`
 * calls on the daemon's event loop (codex review of the F3 PR, MEDIUM): only a path that survives
 * every name rule is ever stat'd, and under a scratch directory none of them are.
 *
 * `relPath` is repo-relative with `/` separators — git's own spelling, which
 * `git status --porcelain -z` and `git ls-files -z` emit on every platform.
 *
 * The order of the arms is the script's order, and it matters: a `tmp/x.db` reports
 * `denylisted-name`, exactly as the shell's `[ -n "$RN" ] ||` guards do.
 */
export function deliverExclusionByName(relPath: string): string | null {
  // The script's own recovery sentinel, at the worktree root only — the shell's first arm.
  if (relPath === DELIVER_STRANDED_SENTINEL) return 'delivery-sentinel';
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  // The script classifies on a LOWERCASED basename so DEPLOY.KEY / .ENV / SOCKET.PATH cannot
  // bypass the denylist by case (crew#439).
  const lower = base.toLowerCase();
  // crew#901: an env template is judged by its CONTENT ({@link deliverExclusionReason}); no NAME
  // rule fires for it, so the name-only pre-filter never drops one.
  if (!isEnvTemplateName(lower) && DENYLISTED.some((re) => re.test(lower))) return 'denylisted-name';
  if (lower.includes('socket')) return 'socket-name';
  // `.DS_Store` is matched on the ORIGINAL basename, as the shell does.
  if (base === '.DS_Store') return 'ds-store';
  const segments = relPath.split('/');
  // Every segment BUT the last is a directory of the path (`/$F` against `*/tmp/*` in the shell).
  const dirs = segments.slice(0, -1);
  if (dirs.some((s) => SCRATCH_DIRS.includes(s))) return 'scratch-dir';
  // crew#861: under a test-runner / build-tool output directory (`.vitest/`, `playwright-report/`, …).
  if (dirs.some((s) => TOOL_ARTIFACT_DIRS.includes(s))) return 'tool-artifact-dir';
  // crew#861: a tool's own log output (`*.log`) — LAST of the name rules (a log under `tmp/` reads
  // as the scratch dir it sits in), in the same order as the shell.
  if (TOOL_ARTIFACT_NAMES.some((re) => re.test(lower))) return 'tool-artifact-name';
  return null;
}

/**
 * Why the deliver push would EXCLUDE this untracked path, or `null` when it rides — the whole
 * ladder, name rules first and then the size rule.
 *
 * `sizeBytes` is the file's size, or `null` when it could not be stat'd; an unknown size is never
 * treated as oversize (the shell's `wc -c < "$F" 2>/dev/null || echo 0` degrades the same way).
 * A caller that wants to avoid the `stat` for a path a name rule already rejects calls
 * {@link deliverExclusionByName} first.
 */
export function deliverExclusionReason(
  relPath: string,
  sizeBytes: number | null,
  /** crew#901: the file's text, for an env template; absent or `null` (unreadable) = excluded. */
  readText?: () => string | null,
): string | null {
  const byName = deliverExclusionByName(relPath);
  if (byName !== null) return byName;
  if (isEnvTemplateName(relPath.slice(relPath.lastIndexOf('/') + 1).toLowerCase())) {
    const text = readText?.() ?? null;
    if (text === null || !envTemplateIsValueFree(text)) return 'env-template-with-values';
  }
  if (sizeBytes !== null && sizeBytes > OVERSIZE_BYTES) return 'oversize-1mib';
  return null;
}

/**
 * WHAT THE PUSH REMOVES FROM COMMITTED WORK (wicked-core#1573) — one narrow class, never the ladder above.
 *
 * A Claude Code seat committed its own background-task output,
 * `tmp/claude-<uid>/<a slug of the worktree's absolute path>/<session>/tasks/<id>.output`, and a later
 * commit deleted it. The ladder above runs over UNTRACKED files only, and the deliver script pushes
 * the run's own commits, so the slug (a home-derived name) would have sat in the public PR's history.
 *
 * The crew#434 ladder is the wrong rule for committed work: a run that deliberately commits
 * `tmp/parser.rs` or `src/credentials.ts` must ship them (secrets are GitGuardian's and the gate's).
 * So the deliver script's history scrub (block c3b) removes, from every commit it pushes, only a path
 * this predicate names:
 *  - `seat-temp`: under a Claude Code per-uid temp directory (a `claude-<digits>` directory segment);
 *  - `home-derived`: a segment that is a slug of an absolute host path (`-Users-…`, `-home-…`,
 *    `-root-…`, `-private-…`, `-var-…`, `-tmp-…`, `C--Users-…`), or one that starts with the slug of
 *    THIS host's home, or this host's home path mirrored as directories (`…/home/alice/…`).
 * It is name-only (no content, no size), and a path the base already holds as a file, symlink or
 * submodule at exactly that spelling is never removed. The script's `_seatscratch` is generated
 * from the same two expressions, and `worktreeDiff` (`api/run-files.ts`) leaves the same committed
 * paths out of the aggregate diff, so for committed files the gate's count is the push's (up to that
 * diff's exclude-pathspec byte cap).
 *
 * `home` is the home directory of the process that runs the push (the script reads `$HOME`).
 */
export const SEAT_TEMP_DIR_ERE = '(^|/)claude-[0-9]+/';
/** A path segment that is a slug of an absolute host path (POSIX ERE, shared with the deliver script). */
export const HOME_SLUG_SEGMENT_ERE = '(^|/)(-(Users|home|root|private|var|tmp)-[^/]|[A-Za-z]--Users-[^/])';
const SEAT_TEMP_DIR = new RegExp(SEAT_TEMP_DIR_ERE);
const HOME_SLUG_SEGMENT = new RegExp(HOME_SLUG_SEGMENT_ERE);

/** Why the deliver push removes this COMMITTED path from the run's commits, or `null` when it ships. */
export function committedScrubReason(relPath: string, home: string): 'seat-temp' | 'home-derived' | null {
  if (SEAT_TEMP_DIR.test(relPath)) return 'seat-temp';
  if (HOME_SLUG_SEGMENT.test(relPath)) return 'home-derived';
  // This host's own home, when it has at least two segments (a bare `/root` would match `src/root/`).
  const h = home.replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^\/[^/]+\/./.test(h)) {
    const p = `/${relPath}`;
    if (p.includes(`/${h.replaceAll('/', '-')}`) || p.includes(`${h}/`)) return 'home-derived';
  }
  return null;
}
