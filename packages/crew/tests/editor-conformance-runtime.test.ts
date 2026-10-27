// B8 (PRODUCT-WORKS J6): a daemon host with no Python Playwright met `422 conformance_unavailable` on
// its first editor-plugin install. Crew now provisions its own conformance browser runtime (a private
// venv with a pinned Playwright and its Chromium, made once) and runs the cases again under it.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONFORMANCE_PLAYWRIGHT_ENV,
  CONFORMANCE_PLAYWRIGHT_VERSION,
  conformanceProvisioner,
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

  it('reuses an existing venv, honours a pin override, and falls back to `python` when `python3` is missing', async () => {
    const root = join(dir, 'rt2');
    const pinned = join(root, 'venv-playwright-1.65.0');
    mkdirSync(join(pinned, 'bin'), { recursive: true });
    writeFileSync(venvPython(pinned, 'linux'), '');
    const calls: string[][] = [];
    const exec = (async (bin: string, args: string[]) => {
      calls.push([bin, ...args]);
      return { stdout: '', stderr: '' };
    }) as never;
    expect(await conformanceProvisioner(() => root, { platform: 'linux', env: { [CONFORMANCE_PLAYWRIGHT_ENV]: '1.65.0' }, exec })()).toEqual({ ok: true, python: venvPython(pinned, 'linux') });
    expect(calls.map((c) => c[0])).toEqual([venvPython(pinned, 'linux'), venvPython(pinned, 'linux')]);
    expect(calls[0]).toContain('playwright==1.65.0');

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
    fail = false;
    expect((await provision()).ok).toBe(true);
  });
});
