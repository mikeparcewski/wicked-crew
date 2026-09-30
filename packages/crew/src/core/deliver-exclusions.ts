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

/** The scratch/cache directory names the push never carries, at any depth. */
const SCRATCH_DIRS = ['tmp', '.tmp', 'scratch', '.cache', 'coverage'];

/** Past this, an otherwise-unrecognised file is scratch by size alone (the generic net). */
export const OVERSIZE_BYTES = 1048576;

/**
 * Why the deliver push would exclude this path on its NAME alone — the arms that need no `stat`:
 * the denylist, the `socket` basename, `.DS_Store`, and a scratch directory at any depth. `null`
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
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  // The script classifies on a LOWERCASED basename so DEPLOY.KEY / .ENV / SOCKET.PATH cannot
  // bypass the denylist by case (crew#439).
  const lower = base.toLowerCase();
  if (DENYLISTED.some((re) => re.test(lower))) return 'denylisted-name';
  if (lower.includes('socket')) return 'socket-name';
  // `.DS_Store` is matched on the ORIGINAL basename, as the shell does.
  if (base === '.DS_Store') return 'ds-store';
  const segments = relPath.split('/');
  // Every segment BUT the last is a directory of the path (`/$F` against `*/tmp/*` in the shell).
  if (segments.slice(0, -1).some((s) => SCRATCH_DIRS.includes(s))) return 'scratch-dir';
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
export function deliverExclusionReason(relPath: string, sizeBytes: number | null): string | null {
  const byName = deliverExclusionByName(relPath);
  if (byName !== null) return byName;
  if (sizeBytes !== null && sizeBytes > OVERSIZE_BYTES) return 'oversize-1mib';
  return null;
}
