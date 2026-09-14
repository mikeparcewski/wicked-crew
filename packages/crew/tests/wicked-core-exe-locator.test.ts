// core#405 (F-009, F-SMOKE-006) — FIX-IT-ALL L10-9 crew half (row 2.8): the gate-hook binary the
// daemon hands the engine as WICKED_CORE_EXE comes FIRST from the `wicked-core-ts` platform package
// of THIS install (core-ts ≥ 0.7.26 bundles it beside the `.node`, stamped `wickedCoreVersion`), and
// only then from the operator's home-dir installs — the stale-copy class a `.local/bin` symlink to an
// old build produced. `WICKED_CORE_EXE` set by the operator still wins (the adapter fills it only
// when unset — unchanged here).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { WICKED_CORE_EXE_NAME, bundledWickedCoreExe, wickedCoreTsPlatformPackage } from '../src/core/adapter.js';
import { removeScratch } from './setup/scratch.js';

const scratches: string[] = [];
afterEach(() => {
  for (const d of scratches.splice(0)) removeScratch(d);
});

describe('wickedCoreTsPlatformPackage — the five names napi-release.yml publishes', () => {
  it('maps platform/arch to the published package name, undefined otherwise', () => {
    expect(wickedCoreTsPlatformPackage('darwin', 'arm64')).toBe('wicked-core-ts-darwin-arm64');
    expect(wickedCoreTsPlatformPackage('darwin', 'x64')).toBe('wicked-core-ts-darwin-x64');
    expect(wickedCoreTsPlatformPackage('linux', 'x64')).toBe('wicked-core-ts-linux-x64-gnu');
    expect(wickedCoreTsPlatformPackage('linux', 'arm64')).toBe('wicked-core-ts-linux-arm64-gnu');
    expect(wickedCoreTsPlatformPackage('win32', 'x64')).toBe('wicked-core-ts-win32-x64-msvc');
    expect(wickedCoreTsPlatformPackage('freebsd', 'x64')).toBeUndefined();
    expect(wickedCoreTsPlatformPackage('win32', 'arm64')).toBeUndefined();
  });
});

describe('bundledWickedCoreExe — the binary inside the platform package, or nothing', () => {
  function fakeInstall(withBinary: boolean): { nm: string; pkgDir: string } {
    const root = mkdtempSync(join(tmpdir(), 'crew-core-exe-'));
    scratches.push(root);
    const nm = join(root, 'node_modules');
    const pkgDir = join(nm, 'wicked-core-ts-linux-x64-gnu');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'wicked-core-ts-linux-x64-gnu', version: '0.7.26', wickedCoreVersion: '0.4.0' }), 'utf8');
    if (withBinary) writeFileSync(join(pkgDir, WICKED_CORE_EXE_NAME), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    return { nm, pkgDir };
  }

  it('resolves through the package.json when the exports map allows it', () => {
    const { nm, pkgDir } = fakeInstall(true);
    const found = bundledWickedCoreExe(WICKED_CORE_EXE_NAME, 'wicked-core-ts-linux-x64-gnu', {
      resolve: (id) => join(nm, id),
      paths: () => [],
    });
    expect(found).toBe(join(pkgDir, WICKED_CORE_EXE_NAME));
  });

  it('falls back to the resolver candidate dirs when package.json is not exported', () => {
    const { nm, pkgDir } = fakeInstall(true);
    const found = bundledWickedCoreExe(WICKED_CORE_EXE_NAME, 'wicked-core-ts-linux-x64-gnu', {
      resolve: () => {
        throw new Error('ERR_PACKAGE_PATH_NOT_EXPORTED');
      },
      paths: () => ['/nowhere/node_modules', nm],
    });
    expect(found).toBe(join(pkgDir, WICKED_CORE_EXE_NAME));
  });

  it('a pre-0.7.26 platform package (no binary) and a missing package both yield undefined — the home-dir ladder takes over', () => {
    const { nm } = fakeInstall(false);
    expect(bundledWickedCoreExe(WICKED_CORE_EXE_NAME, 'wicked-core-ts-linux-x64-gnu', { resolve: (id) => join(nm, id), paths: () => [nm] })).toBeUndefined();
    expect(bundledWickedCoreExe(WICKED_CORE_EXE_NAME, 'wicked-core-ts-linux-x64-gnu', { resolve: () => { throw new Error('MODULE_NOT_FOUND'); }, paths: () => null })).toBeUndefined();
    expect(bundledWickedCoreExe(WICKED_CORE_EXE_NAME, undefined, { resolve: () => 'x', paths: () => [] })).toBeUndefined();
  });
});
