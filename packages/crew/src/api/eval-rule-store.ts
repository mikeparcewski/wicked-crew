/**
 * How a recorded eval run's `rule_store` reads on the wire (crew#1934).
 *
 * Studio decides "was this run judged against THIS daemon's rules?" by comparing a run's `rule_store`
 * (GET /testing/evals[/:id]) with the `core.db` path GET /diagnostics lists. Diagnostics shows paths
 * home-masked (`~/…`, the ui-text backstop), while the run route records the absolute `--db`; compared
 * as plain strings, every run on a daemon whose store lives under the home directory read as "another
 * rule store", and Steering dropped its per-rule eval marks.
 *
 * The rule here: COMPARE canonical paths, MASK only for display. The daemon compares the run's store
 * with its own, both sides canonical (`~` expanded, resolved, symlinks followed); a run on this
 * daemon's store then renders exactly as diagnostics renders `core.db`, and any other store renders
 * through the same home scrub. Studio's string equality relays this answer, and history rows recorded
 * before the fix (absolute, or under another spelling of the same file) read correctly too.
 *
 * Theoretical, no actor: a DIFFERENT store whose masked spelling equals this daemon's (another user's
 * home at the same relative path) would still read equal to studio's string compare.
 */

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { scrubHomePaths } from './ui-text.js';

/** One store path in canonical form: `~` expanded, absolute, symlinks followed (the file's parent when
 *  the file itself is gone, so a deleted store still compares by its real directory). */
export function canonicalStorePath(path: string, home: string = homedir()): string {
  const expanded = path === '~' ? home : /^~[\\/]/.test(path) ? join(home, path.slice(2)) : path;
  const abs = resolve(expanded);
  try {
    return realpathSync.native(abs);
  } catch {
    try {
      return join(realpathSync.native(dirname(abs)), basename(abs));
    } catch {
      return abs;
    }
  }
}

/** The usable `--db` of this daemon, or null (a stub route set, an in-memory store). */
function daemonDb(dbPath: unknown): string | null {
  return typeof dbPath === 'string' && dbPath !== '' && dbPath !== ':memory:' ? dbPath : null;
}

/**
 * A reader for recorded runs' `rule_store`, bound to this daemon's `--db`: same store (canonically)
 * → the exact string diagnostics shows for `core.db`; any other store → its own path, home-masked.
 * Canonical forms are memoised per distinct stored string, so a long history costs one realpath per
 * store, not per row.
 */
export function ruleStoreReader(dbPath: unknown, home: string = homedir()): (stored: unknown) => unknown {
  const db = daemonDb(dbPath);
  const own = db === null ? null : canonicalStorePath(db, home);
  // Diagnostics lists core.db as `join(stateHomeOfDb(db), name)` = `resolve(db)`, then the backstop scrubs it.
  const ownDisplay = db === null ? null : scrubHomePaths(resolve(db), home);
  const seen = new Map<string, string>();
  return (stored) => {
    if (typeof stored !== 'string' || stored === '') return stored;
    let shown = seen.get(stored);
    if (shown === undefined) {
      shown = own !== null && ownDisplay !== null && canonicalStorePath(stored, home) === own ? ownDisplay : scrubHomePaths(stored, home);
      seen.set(stored, shown);
    }
    return shown;
  };
}
