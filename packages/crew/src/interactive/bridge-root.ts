/**
 * Which wicked-interactive document root a crew project speaks to (DES-MERGE-001 §7.1/§7.2).
 *
 * §7.1 closed the identity question: a crew Project is THE entity, and an interactive
 * "instance" (a docs directory) maps onto it through ONE nullable setting, `interactiveRoot`.
 * Null means "the shared default root" — it is a default, never a constraint (§7.2): two
 * projects that leave it null share one bridge, a project that sets it gets its own.
 *
 * The resolved string is also the BRIDGE POOL KEY, which is why every spelling of the same
 * directory has to collapse to one value here rather than in the pool. `~/decks`, `decks`
 * (relative), and `/Users/me/decks/` are the same instance; keying on the raw setting would
 * start a second `wicked-interactive serve` on a second port for each spelling — exactly the
 * "why is it on 5 ports" confusion ADR-0025 exists to prevent.
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** The setting carrier — a `Project` record or a crew-side settings row both satisfy this. */
export interface InteractiveRootSetting {
  /** Absolute or `~`-relative docs root; null/absent ⇒ the shared default. */
  interactiveRoot?: string | null | undefined;
}

/** Env override for the SHARED DEFAULT only (never for an explicit per-project setting).
 *  Exists so a test harness or an e2e run can point "the default root" at a scratch dir. */
export const ROOT_ENV = 'WICKED_INTERACTIVE_ROOT';

/**
 * What `wicked-interactive serve` uses with no `--root`: the canonical shared root
 * `~/wicked-interactive/docs` (ADR-0025 amended, `bin/wicked-interactive.js:181`). Kept
 * byte-identical to interactive's own default on purpose — that is what lets an operator's
 * already-running default bridge be ADOPTED by the pool instead of duplicated.
 */
export function defaultInteractiveRoot(home: string = homedir()): string {
  return resolve(home, 'wicked-interactive', 'docs');
}

/** Expand a leading `~` and absolutize, so every spelling of one directory keys the same. */
function canonicalize(value: string, home: string): string {
  const expanded =
    value === '~' ? home : value.startsWith('~/') || value.startsWith('~\\') ? resolve(home, value.slice(2)) : value;
  return resolve(expanded);
}

/**
 * The resolved, canonical docs root for a project — and therefore its bridge pool key.
 * Precedence: the project's own `interactiveRoot` › `WICKED_INTERACTIVE_ROOT` › the shared
 * default. A blank/whitespace setting is treated as null, not as "the cwd".
 */
export function resolveInteractiveRoot(
  setting: InteractiveRootSetting | null | undefined,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const own = setting?.interactiveRoot;
  if (typeof own === 'string' && own.trim() !== '') return canonicalize(own.trim(), home);
  const shared = env[ROOT_ENV];
  if (typeof shared === 'string' && shared.trim() !== '') return canonicalize(shared.trim(), home);
  return defaultInteractiveRoot(home);
}
