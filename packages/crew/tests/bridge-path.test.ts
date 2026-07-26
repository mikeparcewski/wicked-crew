// Unit tests: ACP bridge PATH resolution (src/core/bridge-path.ts).
//
// The daemon must find the bridge shims' `node_modules/.bin` by walking up from its
// own module location, and prepend it to PATH exactly once — this is what makes a
// plain `npm install` deployment work with no global installs or hand-made symlinks.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { ensureBridgesOnPath, findBridgeBinDir } from '../src/core/bridge-path.js';

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
      process.env['PATH'] = before;
    });

    expect(ensureBridgesOnPath(start)).toBe(binDir);
    expect(process.env['PATH']?.split(delimiter)[0]).toBe(binDir);

    const afterFirst = process.env['PATH'];
    expect(ensureBridgesOnPath(start)).toBe(binDir);
    expect(process.env['PATH']).toBe(afterFirst);
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
