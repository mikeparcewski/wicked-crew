// Unit tests: ACP bridge PATH resolution (src/core/bridge-path.ts).
//
// The daemon must find the bridge shims' `node_modules/.bin` by walking up from its
// own module location, and prepend it to PATH exactly once — this is what makes a
// plain `npm install` deployment work with no global installs or hand-made symlinks.

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIDGE_ONLY_BINS, ensureBridgesOnPath, ensurePiLauncherCommand, findBridgeBinDir, PI_ACP_COMMAND_ENV, piLauncherIn } from '../src/core/bridge-path.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** Build `<root>/node_modules/.bin/<shim>` and a nested start dir to walk up from. */
function fixture(shim: string): { root: string; start: string } {
  const root = mkdtempSync(join(tmpdir(), 'bridge-path-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, shim), '#!/bin/sh\n', { mode: 0o755 });
  const start = join(root, 'packages', 'crew', 'dist', 'core');
  mkdirSync(start, { recursive: true });
  return { root, start };
}

describe('findBridgeBinDir', () => {
  it('walks up to the nearest .bin containing a bridge shim (POSIX shim)', () => {
    const { root, start } = fixture('claude-agent-acp');
    expect(findBridgeBinDir(start)).toBe(join(root, 'node_modules', '.bin'));
  });

  it('recognises Windows .cmd shims', () => {
    const { root, start } = fixture('codex-acp.cmd');
    expect(findBridgeBinDir(start)).toBe(join(root, 'node_modules', '.bin'));
  });

  it('returns null when no shim exists anywhere up the tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'bridge-path-none-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const start = join(root, 'a', 'b');
    mkdirSync(start, { recursive: true });
    // A .bin dir WITHOUT bridge shims must not match.
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    expect(findBridgeBinDir(start)).toBeNull();
  });
});

describe('ensureBridgesOnPath', () => {
  it('prepends the .bin dir to PATH exactly once (idempotent)', () => {
    const { root, start } = fixture('claude-agent-acp');
    const binDir = join(root, 'node_modules', '.bin');
    const before = process.env['PATH'];
    cleanups.push(() => {
      if (before === undefined) delete process.env['PATH'];
      else process.env['PATH'] = before;
    });

    const onPath = ensureBridgesOnPath(start);
    expect(onPath).toBe(join(root, 'node_modules', '.wicked-crew-bridges'));
    expect(onPath).not.toBe(binDir);
    expect(process.env['PATH']?.split(delimiter)[0]).toBe(onPath);

    const afterFirst = process.env['PATH'];
    expect(ensureBridgesOnPath(start)).toBe(onPath);
    expect(process.env['PATH']).toBe(afterFirst);
  });

  // crew#858: the vendored `codex` launcher sits in the same `.bin` as `codex-acp`; the PATH entry
  // the daemon adds must resolve the bridge and must NOT resolve the seat CLI.
  it('the PATH entry resolves codex-acp but never the vendored codex beside it (crew#858)', () => {
    const { root, start } = fixture('codex-acp');
    const bin = join(root, 'node_modules', '.bin');
    for (const extra of ['codex', 'claude', 'wicked-pi', 'pi-acp', 'some-other-tool']) {
      writeFileSync(join(bin, extra), '#!/bin/sh\n', { mode: 0o755 });
    }
    const before = process.env['PATH'];
    cleanups.push(() => {
      if (before === undefined) delete process.env['PATH'];
      else process.env['PATH'] = before;
    });
    const onPath = ensureBridgesOnPath(start) as string;
    expect(onPath).not.toBeNull();
    expect(existsSync(join(onPath, 'codex-acp'))).toBe(true);
    expect(existsSync(join(onPath, 'pi-acp'))).toBe(true);
    expect(existsSync(join(onPath, 'wicked-pi'))).toBe(true);
    expect(existsSync(join(onPath, 'codex'))).toBe(false);
    expect(existsSync(join(onPath, 'claude'))).toBe(false);
    for (const entry of readdirSync(onPath)) {
      expect(BRIDGE_ONLY_BINS, `${entry} must not be on the bridge PATH`).toContain(entry.replace(/\.cmd$/i, ''));
    }
    expect(process.env['PATH']?.split(delimiter)).not.toContain(bin);
  });

  it('re-running after the shim was reinstalled keeps the link resolvable and adds nothing else', () => {
    const { root, start } = fixture('codex-acp');
    const before = process.env['PATH'];
    cleanups.push(() => {
      if (before === undefined) delete process.env['PATH'];
      else process.env['PATH'] = before;
    });
    const onPath = ensureBridgesOnPath(start) as string;
    // Re-run after the shim was replaced: the link still resolves (same target path) and nothing else appears.
    rmSync(join(root, 'node_modules', '.bin', 'codex-acp'));
    writeFileSync(join(root, 'node_modules', '.bin', 'codex-acp'), '#!/bin/sh\n', { mode: 0o755 });
    expect(ensureBridgesOnPath(start)).toBe(onPath);
    expect(existsSync(join(onPath, 'codex-acp'))).toBe(true);
    expect(readdirSync(onPath).sort()).toEqual(['codex-acp']);
  });

  it('leaves PATH untouched when nothing is found', () => {
    const root = mkdtempSync(join(tmpdir(), 'bridge-path-none2-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const start = join(root, 'x');
    mkdirSync(start, { recursive: true });
    const before = process.env['PATH'];
    expect(ensureBridgesOnPath(start)).toBeNull();
    expect(process.env['PATH']).toBe(before);
  });
});

// ── The pi launcher seam (F-079) ───────────────────────────────────────────────────────────────
//
// The pi seat's ACP carrier (community pi-acp) spawns whatever `PI_ACP_PI_COMMAND` names as pi;
// the daemon points it at the packaged `wicked-pi` launcher, which turns the engine's
// `WICKED_PI_SKILL_DIRS` into `--no-skills --skill <dir>…`. An operator's own value wins.

const LAUNCHER_SHIM = process.platform === 'win32' ? 'wicked-pi.cmd' : 'wicked-pi';

/** A `.bin` with the bridge probe shim and, optionally, the launcher shim beside it. */
function launcherFixture(withLauncher: boolean): { bin: string; start: string } {
  const { root, start } = fixture('codex-acp');
  const bin = join(root, 'node_modules', '.bin');
  if (withLauncher) writeFileSync(join(bin, LAUNCHER_SHIM), '#!/bin/sh\n', { mode: 0o755 });
  return { bin, start };
}

describe('ensurePiLauncherCommand', () => {
  it('sets PI_ACP_PI_COMMAND to the wicked-pi shim beside the bridges when it is unset', () => {
    const { bin, start } = launcherFixture(true);
    const env: NodeJS.ProcessEnv = {};
    expect(ensurePiLauncherCommand(start, env)).toBe(join(bin, LAUNCHER_SHIM));
    expect(env[PI_ACP_COMMAND_ENV]).toBe(join(bin, LAUNCHER_SHIM));
    expect(piLauncherIn(bin)).toBe(join(bin, LAUNCHER_SHIM));
  });

  it('respects an operator\'s own PI_ACP_PI_COMMAND (never overwritten) and answers it', () => {
    const { start } = launcherFixture(true);
    const env: NodeJS.ProcessEnv = { [PI_ACP_COMMAND_ENV]: '/opt/my-pi-wrapper' };
    expect(ensurePiLauncherCommand(start, env)).toBe('/opt/my-pi-wrapper');
    expect(env[PI_ACP_COMMAND_ENV]).toBe('/opt/my-pi-wrapper');
  });

  it('leaves the environment alone when this install has no launcher shim (an older agent-acp-bridges) or no bridges at all', () => {
    const { start } = launcherFixture(false);
    const env: NodeJS.ProcessEnv = {};
    expect(ensurePiLauncherCommand(start, env)).toBeNull();
    expect(env[PI_ACP_COMMAND_ENV]).toBeUndefined();
    const bare = mkdtempSync(join(tmpdir(), 'bridge-path-none-'));
    cleanups.push(() => rmSync(bare, { recursive: true, force: true }));
    expect(ensurePiLauncherCommand(bare, env)).toBeNull();
    expect(env[PI_ACP_COMMAND_ENV]).toBeUndefined();
  });

  it('the real workspace install carries the launcher shim beside the bridges (the artifact behind the seam)', () => {
    const start = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'core');
    const bin = findBridgeBinDir(start);
    expect(bin, 'run npm install first').not.toBeNull();
    expect(piLauncherIn(bin as string)).not.toBeNull();
  });
});
