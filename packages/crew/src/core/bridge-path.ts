/**
 * ACP bridge binary resolution — makes the bridges deployable without any manual step.
 *
 * wicked-core spawns ACP bridge binaries (`claude-agent-acp`, `codex-acp`, `pi-acp`,
 * `agy-acp`) by BARE NAME on PATH. The bridges ship as npm packages (dependencies of
 * this package), so after any normal install their launcher shims land in a
 * `node_modules/.bin` directory — but nothing puts that directory on the daemon's
 * PATH. Requiring users to `npm i -g` the bridge packages (or hand-symlink bins) is
 * exactly the kind of install friction that breaks "clone → npm install → run".
 *
 * FOUR names, and the list is exhaustive on purpose. It used to carry a fifth, for the
 * opencode seat — a bridge that no package declares, that no install produces a shim
 * for, and that `wicked-core/crates/wicked-council/src/registry.rs` never asks for: the
 * opencode seat's `[acp]` block spawns `opencode acp`, the CLI's own NATIVE ACP mode,
 * and so does copilot's (`copilot --acp`). A natively-speaking CLI needs no bridge, so
 * `ensureBridgesOnPath` could not have helped one and nothing was observed broken — but
 * the name existed nowhere except this comment, which is the failure mode the rest of
 * this file exists to prevent: a claim about what is installable that no artifact backs
 * (FINDING-097). Dropped rather than shipped, and the phantom is not respelled here —
 * `bridge-names.test.ts` audits THIS comment for `*-acp` tokens, so writing the dead
 * name to explain it would fail the guard that exists to catch it.
 *
 * `ensureBridgesOnPath()` closes the gap at daemon startup: it walks up from this
 * module looking for a `node_modules/.bin` that contains a bridge shim and prepends
 * it to `process.env.PATH`. Every subprocess the engine spawns inherits the daemon's
 * environment, so the registry's bare binary names resolve in dev checkouts
 * (workspace root `.bin`), global installs, and nested-dependency layouts alike.
 * A user-installed bridge earlier on PATH still wins for spawn resolution only if
 * it appears before ours — we prepend, so the packaged versions take precedence
 * and match the engine version they shipped with.
 *
 * What is prepended is NOT that `.bin` itself (crew#858): `.bin` is crew's whole
 * dependency bin directory, and `@agentclientprotocol/codex-acp` depends on
 * `@openai/codex`, whose launcher lands there as `codex` — prepending it made every
 * bare-name `codex` seat spawn resolve to the vendored CLI instead of the one the
 * operator installed and logs into. The daemon prepends a directory that holds ONLY
 * links to the four bridges (`claude-agent-acp`, `codex-acp`, `pi-acp`, `agy-acp`)
 * and the `wicked-pi` launcher. The precedence above is right for the bridges; a seat
 * CLI that rides along as a transitive dependency never gets it. (`codex-acp` itself
 * is unaffected: it resolves its bundled codex by module path, not PATH.)
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
 * The variable the community `pi-acp` adapter reads for the command it spawns as pi
 * (`getPiCommand(process.env.PI_ACP_PI_COMMAND)`), and the bin this package's
 * `agent-acp-bridges` dependency provides for it: `wicked-pi` turns wicked-core's
 * `WICKED_PI_SKILL_DIRS` (the deliverable portable skill dirs of the published snapshot,
 * F-079 / wicked-core#441) into pi's `--no-skills --skill <dir>…` and runs pi. Without
 * this seam the env contract is inert on the ACP carrier: pi-acp forwards no argv.
 */
export const PI_ACP_COMMAND_ENV = 'PI_ACP_PI_COMMAND';
const PI_LAUNCHER_BIN = 'wicked-pi';

/**
 * The launcher shim in `binDir`, or `null` when this install has none (an older
 * `agent-acp-bridges` on the registry — the seat keeps working, skills do not reach pi
 * over ACP). Windows shims are `<name>.cmd` and pi-acp starts a `.cmd` through a shell.
 */
export function piLauncherIn(binDir: string): string | null {
  const shim = join(binDir, process.platform === 'win32' ? `${PI_LAUNCHER_BIN}.cmd` : PI_LAUNCHER_BIN);
  return existsSync(shim) ? shim : null;
}

/**
 * Point pi-acp at the `wicked-pi` launcher (idempotent; an operator's own
 * `PI_ACP_PI_COMMAND` is respected and never overwritten). Returns the command set — or
 * already in force — else `null`. Call once at daemon startup, after `ensureBridgesOnPath`.
 */
export function ensurePiLauncherCommand(
  start: string = dirname(fileURLToPath(import.meta.url)),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const current = env[PI_ACP_COMMAND_ENV];
  if (current !== undefined && current !== '') return current;
  const binDir = findBridgeBinDir(start);
  if (binDir === null) return null;
  const shim = piLauncherIn(binDir);
  if (shim === null) return null;
  env[PI_ACP_COMMAND_ENV] = shim;
  return shim;
}

/**
 * Every bin the bridges-only PATH directory may carry: the four bridges and the pi
 * launcher. Nothing else from `.bin` — in particular never a seat CLI (crew#858).
 */
export const BRIDGE_ONLY_BINS: readonly string[] = ['claude-agent-acp', 'codex-acp', 'pi-acp', 'agy-acp', PI_LAUNCHER_BIN];

/** Name of the bridges-only directory, a sibling of `.bin` inside `node_modules`. */
const BRIDGES_DIR_NAME = '.wicked-crew-bridges';

/** Point `link` at `target`, replacing a stale link; a link already right is left alone. */
function linkTo(target: string, link: string): void {
  try {
    if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === target) return;
    unlinkSync(link);
  } catch {
    // absent — create below
  }
  try {
    symlinkSync(target, link);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // A concurrent daemon from the same install linked it first: fine ONLY if it agrees —
    // anything else (a file, a link elsewhere) throws so the caller falls back to a fresh dir.
    if (!(lstatSync(link).isSymbolicLink() && readlinkSync(link) === target)) throw err;
  }
}

/** Write a Windows `.cmd` forwarder to `target` (a `.cmd` shim resolves `%~dp0` from its own dir). */
function cmdForwarder(target: string, link: string): void {
  // `%` expands inside a quoted batch string, so a literal one in the path is doubled.
  const body = `@"${target.replace(/%/g, '%%')}" %*\r\n`;
  try {
    if (readFileSync(link, 'utf8') === body) return;
  } catch {
    // absent
  }
  writeFileSync(link, body);
}

/**
 * Populate `dir` with links to the bridge shims found in `binDir` and nothing else.
 * Throws when `dir` cannot be created or written (the caller falls back).
 */
function populateBridgesDir(binDir: string, dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const name of BRIDGE_ONLY_BINS) {
    for (const file of [name, `${name}.cmd`]) {
      const target = join(binDir, file);
      if (!existsSync(target)) continue;
      const link = join(dir, file);
      if (file.endsWith('.cmd')) cmdForwarder(target, link);
      else linkTo(target, link);
    }
  }
}

/**
 * The directory holding ONLY the bridge shims from `binDir` (crew#858), created or
 * refreshed: `<node_modules>/.wicked-crew-bridges` beside `.bin`, or — when the install
 * is read-only — a fresh per-process directory under the OS temp dir.
 */
export function bridgesOnlyDir(binDir: string): string {
  const preferred = join(dirname(binDir), BRIDGES_DIR_NAME);
  try {
    populateBridgesDir(binDir, preferred);
    return preferred;
  } catch {
    const fallback = mkdtempSync(join(tmpdir(), 'wicked-crew-bridges-'));
    populateBridgesDir(binDir, fallback);
    return fallback;
  }
}

/**
 * Prepend a bridges-only directory (links to the bridge shims of the nearest bridge
 * `.bin`) to PATH (idempotent). Returns the prepended directory when bridges were found,
 * else `null`. Call once at daemon startup, before the engine spawns anything.
 */
export function ensureBridgesOnPath(
  start: string = dirname(fileURLToPath(import.meta.url)),
): string | null {
  const found = findBridgeBinDir(start);
  if (found === null) return null;
  const binDir = bridgesOnlyDir(found);
  const current = process.env['PATH'];
  if (current === undefined || current === '') {
    // No trailing delimiter: an empty PATH entry means the CWD on POSIX.
    process.env['PATH'] = binDir;
  } else if (!current.split(delimiter).includes(binDir)) {
    process.env['PATH'] = binDir + delimiter + current;
  }
  return binDir;
}
