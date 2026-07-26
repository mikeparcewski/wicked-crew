/**
 * ACP bridge binary resolution — makes the bridges deployable without any manual step.
 *
 * wicked-core spawns ACP bridge binaries (`claude-agent-acp`, `codex-acp`, `pi-acp`,
 * `agy-acp`, `opencode-acp`) by BARE NAME on PATH. The bridges ship as npm packages
 * (dependencies of this package), so after any normal install their launcher shims
 * land in a `node_modules/.bin` directory — but nothing puts that directory on the
 * daemon's PATH. Requiring users to `npm i -g` the bridge packages (or hand-symlink
 * bins) is exactly the kind of install friction that breaks "clone → npm install →
 * run".
 *
 * `ensureBridgesOnPath()` closes the gap at daemon startup: it walks up from this
 * module looking for a `node_modules/.bin` that contains a bridge shim and prepends
 * it to `process.env.PATH`. Every subprocess the engine spawns inherits the daemon's
 * environment, so the registry's bare binary names resolve in dev checkouts
 * (workspace root `.bin`), global installs, and nested-dependency layouts alike.
 * A user-installed bridge earlier on PATH still wins for spawn resolution only if
 * it appears before ours — we prepend, so the packaged versions take precedence
 * and match the engine version they shipped with.
 */

import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One shim that proves a `.bin` dir holds the bridges (any of them will do). */
const PROBE_BINS = ['claude-agent-acp', 'codex-acp'];

/** Windows npm shims are `<name>.cmd`; POSIX shims are extensionless. */
function hasBridgeShim(binDir: string): boolean {
  return PROBE_BINS.some(
    (bin) => existsSync(join(binDir, bin)) || existsSync(join(binDir, `${bin}.cmd`)),
  );
}

/**
 * Find the nearest `node_modules/.bin` (walking up from `start`) that contains a
 * bridge shim. Returns `null` when none is found — e.g. a checkout before
 * `npm install` — in which case PATH is left untouched and the engine's own
 * single-shot fallback still applies.
 */
export function findBridgeBinDir(start: string): string | null {
  let dir = start;
  for (;;) {
    const candidate = join(dir, 'node_modules', '.bin');
    if (hasBridgeShim(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Prepend the bridge `.bin` directory to PATH (idempotent). Returns the directory
 * when one was found, else `null`. Call once at daemon startup, before the engine
 * spawns anything.
 */
export function ensureBridgesOnPath(
  start: string = dirname(fileURLToPath(import.meta.url)),
): string | null {
  const binDir = findBridgeBinDir(start);
  if (binDir === null) return null;
  const current = process.env['PATH'];
  if (current === undefined || current === '') {
    // No trailing delimiter: an empty PATH entry means the CWD on POSIX.
    process.env['PATH'] = binDir;
  } else if (!current.split(delimiter).includes(binDir)) {
    process.env['PATH'] = binDir + delimiter + current;
  }
  return binDir;
}
