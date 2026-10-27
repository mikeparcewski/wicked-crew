// B8 (PRODUCT-WORKS J6): a daemon host with no Python Playwright met `422 conformance_unavailable` on
// its first editor-plugin install. Crew now provisions its own conformance browser runtime (a private
// venv with a pinned Playwright and its Chromium, made once) and runs the cases again under it.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONFORMANCE_PLAYWRIGHT_ENV,
  CONFORMANCE_PLAYWRIGHT_VERSION,
  CONFORMANCE_RUNTIME_DIR_ENV,
  PROVISIONED_MARKER,
  conformanceProvisioner,
  conformanceRuntimeRoot,
  needsBrowserRuntime,
  venvPython,
} from '../src/editors/conformance-runtime.js';
import { gardenConformance } from '../src/editors/pack-install.js';
import { removeScratch } from './setup/scratch.js';

/** garden's exit-3 report when the Python playwright package is missing (scripts/editor/conformance.py). */
const NO_BROWSER = JSON.stringify({
  ok: false,
  pack: '/pack',
  error: 'no headless browser: the Python playwright package is not installed (pip install playwright && playwright install chromium); refusing to report conformance without the run',
});
const PASSED = JSON.stringify({ ok: true, editors: [{ id: 'e', version: '1.0.0', sha256: 'ab', ok: true, cases: { '0-manifest': { ok: true } }, gaps: [] }] });

function exit(code: number, stdout: string): Error {
  return Object.assign(new Error(`Command failed: exit ${code}`), { code, stdout, stderr: '' });
}

let dir: string;
let garden: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conformance-runtime-'));
  garden = join(dir, 'garden');
  mkdirSync(join(garden, 'scripts', 'editor'), { recursive: true });
  writeFileSync(join(garden, 'scripts', 'editor', 'conformance.py'), '# stub\n');
});
afterEach(() => removeScratch(dir));

describe('gardenConformance on a host with no browser runtime', () => {
  it('provisions crew\'s runtime and runs the cases again under its python', async () => {
    const bins: string[] = [];
    let provisions = 0;
    const run = gardenConformance(garden, () => 'http://127.0.0.1:1', {
      exec: (async (bin: string) => {
        bins.push(bin);
        if (bin === '/rt/venv/bin/python') return { stdout: PASSED, stderr: '' };
        throw exit(3, NO_BROWSER);
      }) as never,
      provision: async () => {
        provisions += 1;
        return { ok: true, python: '/rt/venv/bin/python' };
      },
    });
    const report = await run('/pack', []);
    expect(provisions).toBe(1);
    expect(bins).toEqual(['python3', '/rt/venv/bin/python']);
    expect(report.ok).toBe(true);
    expect(report.editors.map((e) => e.id)).toEqual(['e']);
  });

  it('says what crew tried and the one command that fixes it when it cannot provision (still fail closed)', async () => {
    const run = gardenConformance(garden, () => 'http://127.0.0.1:1', {
      exec: (async () => { throw exit(3, NO_BROWSER); }) as never,
      provision: async () => ({ ok: false, error: 'crew could not provision the conformance browser: installing playwright==1.64.0 failed: no index. On this host, run: pip install playwright==1.64.0 && python -m playwright install chromium' }),
    });
    const report = await run('/pack', []);
    expect(report.ok).toBe(false);
    expect(report.editors).toEqual([]);
    expect(report.error).toContain('no headless browser');
    expect(report.error).toContain('crew could not provision the conformance browser');
    expect(report.error).toContain('python -m playwright install chromium');
  });

  it('never provisions for a run that reached the cases (a failed case is the editor\'s), or another refusal', async () => {
    let provisions = 0;
    const provision = async () => {
      provisions += 1;
      return { ok: true as const, python: '/rt/venv/bin/python' };
    };
    const failedCase = JSON.stringify({ ok: false, editors: [{ id: 'e', version: '1', sha256: 'ab', ok: false, cases: { '1-handshake': { ok: false } }, gaps: [] }] });
    const caseRun = gardenConformance(garden, () => 'http://127.0.0.1:1', { exec: (async () => { throw exit(1, failedCase); }) as never, provision });
    expect((await caseRun('/pack', [])).editors).toHaveLength(1);
    const noHost = gardenConformance(garden, () => 'http://127.0.0.1:1', { exec: (async () => { throw exit(2, JSON.stringify({ ok: false, error: 'no host: pass --host-url' })); }) as never, provision });
    expect((await noHost('/pack', [])).error).toMatch(/no host/);
    expect(provisions).toBe(0);
  });

  it('recognises both of garden\'s no-browser reports', () => {
    expect(needsBrowserRuntime('no headless browser: the Python playwright package is not installed')).toBe(true);
    expect(needsBrowserRuntime('no headless browser: chromium did not start (Executable doesn\'t exist)')).toBe(true);
    expect(needsBrowserRuntime('the editor failed')).toBe(false);
    expect(needsBrowserRuntime(undefined)).toBe(false);
  });
});

describe('conformanceProvisioner', () => {
  it('makes a venv, installs the pinned playwright and its chromium, and shares one provisioning', async () => {
    const calls: string[][] = [];
    const root = join(dir, 'rt');
    const provision = conformanceProvisioner(() => root, {
      platform: 'linux',
      env: {},
      exec: (async (bin: string, args: string[]) => {
        calls.push([bin, ...args]);
        return { stdout: '', stderr: '' };
      }) as never,
    });
    const [a, b] = await Promise.all([provision(), provision()]);
    const venv = join(root, `venv-playwright-${CONFORMANCE_PLAYWRIGHT_VERSION}`);
    expect(a).toEqual({ ok: true, python: venvPython(venv, 'linux') });
    expect(b).toEqual(a);
    expect(calls).toEqual([
      ['python3', '-m', 'venv', venv],
      [venvPython(venv, 'linux'), '-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', `playwright==${CONFORMANCE_PLAYWRIGHT_VERSION}`],
      [venvPython(venv, 'linux'), '-m', 'playwright', 'install', 'chromium'],
    ]);
  });

  it('reuses a finished venv with no index or browser call, and rebuilds a half-made one', async () => {
    const root = join(dir, 'rt2');
    const pinned = join(root, 'venv-playwright-1.65.0');
    mkdirSync(join(pinned, 'bin'), { recursive: true });
    writeFileSync(venvPython(pinned, 'linux'), '');
    const calls: string[][] = [];
    const exec = (async (bin: string, args: string[]) => {
      calls.push([bin, ...args]);
      // A real `venv` would create the interpreter again.
      if (args[1] === 'venv') {
        mkdirSync(join(pinned, 'bin'), { recursive: true });
        writeFileSync(venvPython(pinned, 'linux'), '');
      }
      return { stdout: '', stderr: '' };
    }) as never;
    const provision = conformanceProvisioner(() => root, { platform: 'linux', env: { [CONFORMANCE_PLAYWRIGHT_ENV]: '1.65.0' }, exec });
    // No marker (a venv a killed provisioning left): rebuilt from nothing, with the pin override.
    expect(await provision()).toEqual({ ok: true, python: venvPython(pinned, 'linux') });
    expect(calls.map((c) => c.slice(0, 3))).toEqual([
      ['python3', '-m', 'venv'],
      [venvPython(pinned, 'linux'), '-m', 'pip'],
      [venvPython(pinned, 'linux'), '-m', 'playwright'],
    ]);
    expect(calls[1]).toContain('playwright==1.65.0');
    expect(existsSync(join(pinned, PROVISIONED_MARKER))).toBe(true);
    // Marked: the next installs spawn nothing (no package index, no mutation of a venv in use).
    calls.length = 0;
    expect((await provision()).ok).toBe(true);
    expect((await provision()).ok).toBe(true);
    expect(calls).toEqual([]);
  });

  it('falls back to `python` only when `python3` is missing, and keeps a real python3 failure as the answer', async () => {
    const tried: string[] = [];
    const fallback = conformanceProvisioner(() => join(dir, 'rt3'), {
      platform: 'linux',
      env: {},
      exec: (async (bin: string) => {
        tried.push(bin);
        if (bin === 'python3') throw Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' });
        return { stdout: '', stderr: '' };
      }) as never,
    });
    expect((await fallback()).ok).toBe(true);
    expect(tried.slice(0, 2)).toEqual(['python3', 'python']);

    const seen: string[] = [];
    const root = join(dir, 'rt3b');
    const noVenv = conformanceProvisioner(() => root, {
      platform: 'linux',
      env: {},
      exec: (async (bin: string) => {
        seen.push(bin);
        if (bin === 'python3') throw Object.assign(new Error('Command failed: python3 -m venv'), { code: 1, stderr: 'The virtual environment was not created successfully because ensurepip is not available.' });
        throw Object.assign(new Error('spawn python ENOENT'), { code: 'ENOENT' });
      }) as never,
    });
    const r = await noVenv();
    expect(seen).toEqual(['python3']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('creating a virtualenv with python3 failed');
      expect(r.error).toContain('ensurepip is not available');
      expect(r.error).not.toContain('ENOENT');
    }
    expect(existsSync(join(root, `venv-playwright-${CONFORMANCE_PLAYWRIGHT_VERSION}`))).toBe(false);
  });

  it('keeps the runtime in the OS cache directory, never the state home (an unregistered state-home entry refuses launches)', () => {
    expect(conformanceRuntimeRoot({}, 'darwin', '/h')).toBe(join('/h', 'Library', 'Caches', 'wicked-crew', 'editor-conformance'));
    expect(conformanceRuntimeRoot({}, 'linux', '/h')).toBe(join('/h', '.cache', 'wicked-crew', 'editor-conformance'));
    expect(conformanceRuntimeRoot({ XDG_CACHE_HOME: '/xdg' }, 'linux', '/h')).toBe(join('/xdg', 'wicked-crew', 'editor-conformance'));
    expect(conformanceRuntimeRoot({ LOCALAPPDATA: 'C:\\L' }, 'win32', '/h')).toBe(join('C:\\L', 'wicked-crew', 'editor-conformance'));
    expect(conformanceRuntimeRoot({ [CONFORMANCE_RUNTIME_DIR_ENV]: '/opt/rt' }, 'linux', '/h')).toBe('/opt/rt');
  });

  it('names the failed step and the fix, and tries again on the next install', async () => {
    let fail = true;
    const provision = conformanceProvisioner(() => join(dir, 'rt4'), {
      platform: 'linux',
      env: {},
      exec: (async (_bin: string, args: string[]) => {
        if (fail && args.includes('pip')) throw Object.assign(new Error('Command failed'), { stderr: 'ERROR: Could not find a version that satisfies the requirement' });
        return { stdout: '', stderr: '' };
      }) as never,
    });
    const first = await provision();
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.error).toContain(`installing playwright==${CONFORMANCE_PLAYWRIGHT_VERSION} failed`);
      expect(first.error).toContain('Could not find a version');
      expect(first.error).toContain(`pip install playwright==${CONFORMANCE_PLAYWRIGHT_VERSION} && python -m playwright install chromium`);
    }
    expect(existsSync(join(dir, 'rt4', `venv-playwright-${CONFORMANCE_PLAYWRIGHT_VERSION}`))).toBe(false);
    fail = false;
    expect((await provision()).ok).toBe(true);
  });
});
