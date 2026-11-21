// B8 (PRODUCT-WORKS J6): a daemon host with no Python Playwright met `422 conformance_unavailable` on
// its first editor-plugin install. Crew now provisions its own conformance browser runtime (a private
// venv with a pinned Playwright and its Chromium, made once) before the engine runs its jailed harness.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as childExec from '../src/core/exec.js';

import {
  CONFORMANCE_PLAYWRIGHT_ENV,
  CONFORMANCE_PLAYWRIGHT_VERSION,
  CONFORMANCE_RUNTIME_DIR_ENV,
  PROVISIONED_MARKER,
  ENGINE_CONFORMANCE_PYTHON_ENV,
  ENGINE_CONFORMANCE_STUDIO_ENV,
  absoluteCacheEnv,
  conformanceProvisioner,
  conformanceRuntimeRoot,
  conformanceVenvDir,
  editorPluginLaunchListener,
  exportEngineConformanceEnv,
  exportManagedChrome,
  CHROMIUM_PATH_FILE,
  managedChromium,
  provisionOnDraftLaunch,
  provisionOnEditorPluginLaunch,
  venvPython,
} from '../src/editors/conformance-runtime.js';
import { CONFORMANCE_CASES, engineConformance } from '../src/editors/pack-install.js';
import { removeScratch } from './setup/scratch.js';

const engine = vi.hoisted(() => ({ runEditorConformance: undefined as ((request: string) => Promise<string>) | undefined }));
vi.mock('wicked-core-ts', () => ({ Core: engine }));

const PASSED = {
  ok: true,
  editors: [{ id: 'e', version: '1.0.0', sha256: 'ab', protocol: [1], negotiated: 1, ok: true, cases: Object.fromEntries(CONFORMANCE_CASES.map((c) => [c, { ok: true }])) }],
  plugins: [],
};
const passedRun = () => JSON.stringify({ record: { outcome: 'pass', attempt: 1 }, report: PASSED });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conformance-runtime-'));
  engine.runEditorConformance = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  removeScratch(dir);
});

describe('engineConformance', () => {
  it('maps a pass report and its editor cases', async () => {
    const summary = await engineConformance({ run: async () => passedRun() })('/pack');
    expect(summary).toMatchObject({ ok: true, editors: [{ id: 'e', cases: PASSED.editors[0]!.cases, gaps: [] }] });
    expect(summary.at).toEqual(expect.any(String));
  });

  it('keeps the rows and failing cases of a failed report', async () => {
    const report = { ...PASSED, ok: false, editors: [{ ...PASSED.editors[0]!, ok: false, cases: { '1-handshake': { ok: false, error: 'timed out' } } }] };
    const summary = await engineConformance({ run: async () => JSON.stringify({ record: { outcome: 'fail', attempt: 1 }, report }) })('/pack');
    expect(summary).toMatchObject({ ok: false, editors: [{ id: 'e', ok: false, cases: { '1-handshake': { ok: false } } }] });
  });

  it('fails closed for a refused record, even if it contains report rows', async () => {
    const run = vi.fn(async () => JSON.stringify({ record: { outcome: 'refused', cause: 'unjailed_host', reason: 'no jail available', attempt: 1 }, report: PASSED }));
    expect(await engineConformance({ run })('/pack')).toMatchObject({ ok: false, editors: [], error: 'unjailed_host: no jail available' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each(['pass', 'fail'])('fails closed for outcome %s with no editor or plugin rows', async (outcome) => {
    const run = async () => JSON.stringify({ record: { outcome, cause: 'no_studio', reason: 'studio is missing', attempt: 1 }, report: { ok: true, editors: [], plugins: [] } });
    expect(await engineConformance({ run })('/pack')).toMatchObject({ ok: false, editors: [], error: 'no_studio: studio is missing' });
  });

  it('fails without a binding and spawns no child process', async () => {
    const exec = vi.spyOn(childExec, 'execCapped');
    const provision = vi.fn();
    expect(await engineConformance({ provision })('/pack')).toMatchObject({
      ok: false, editors: [], error: 'this engine has no jailed conformance run; update wicked-core-ts',
    });
    expect(exec).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });

  it('uses the optional Core static by default', async () => {
    engine.runEditorConformance = vi.fn(async function (this: unknown) {
      expect(this).toBe(engine);
      return passedRun();
    });
    expect((await engineConformance({})('/pack')).ok).toBe(true);
    expect(engine.runEditorConformance).toHaveBeenCalledTimes(1);
  });

  it('awaits provisioning once before one run', async () => {
    const order: string[] = [];
    const provision = vi.fn(async () => {
      order.push('provision');
      await Promise.resolve();
      order.push('ready');
      return { ok: true as const, python: '/rt/venv/bin/python' };
    });
    const run = vi.fn(async () => { order.push('run'); return passedRun(); });
    expect((await engineConformance({ provision, run })('/pack')).ok).toBe(true);
    expect(order).toEqual(['provision', 'ready', 'run']);
    expect(provision).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('returns a provisioning failure without running the harness', async () => {
    const run = vi.fn();
    const provision = vi.fn(async () => ({ ok: false as const, error: 'crew could not provision the conformance browser: no index' }));
    expect(await engineConformance({ provision, run })('/pack')).toMatchObject({ ok: false, editors: [], error: 'crew could not provision the conformance browser: no index' });
    expect(provision).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([null, 'not a report', 42, {}])('fails for an unreadable report: %j', async (report) => {
    const run = async () => JSON.stringify({ record: { outcome: 'fail', attempt: 1 }, report });
    expect(await engineConformance({ run })('/pack')).toMatchObject({ ok: false, editors: [], error: 'the conformance run produced no readable report' });
  });

  it('fails for malformed binding JSON', async () => {
    expect(await engineConformance({ run: async () => 'not JSON' })('/pack')).toMatchObject({ ok: false, editors: [], error: 'the conformance run produced no readable report' });
  });

  it('returns a rejected binding promise as a failed summary', async () => {
    const run = vi.fn(async () => { throw new Error('engine request rejected'); });
    expect(await engineConformance({ run })('/pack')).toMatchObject({ ok: false, editors: [], error: 'engine request rejected' });
    expect(run).toHaveBeenCalledTimes(1);
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
      // PLAN G12: where its headless shell is, for the draft renderer; a cache without one gets the shell alone, and
      // is asked again.
      [venvPython(venv, 'linux'), '-c', expect.stringContaining('chromium_headless_shell-')],
      [venvPython(venv, 'linux'), '-m', 'playwright', 'install', '--only-shell', 'chromium'],
      [venvPython(venv, 'linux'), '-c', expect.stringContaining('chromium_headless_shell-')],
    ]);
  });

  it('PLAN G12: a failed Chromium query is asked again after 10 minutes, and never once the path is recorded (codex r3)', async () => {
    const root = join(dir, 'rt-retry');
    const venv = join(root, `venv-playwright-${CONFORMANCE_PLAYWRIGHT_VERSION}`);
    const chromium = join(dir, 'chrome-retry');
    writeFileSync(chromium, '');
    let clock = 1_000_000;
    let answer = '';
    const queries: number[] = [];
    const provision = conformanceProvisioner(() => root, {
      platform: 'linux',
      env: {},
      now: () => clock,
      exec: (async (_bin: string, args: string[]) => {
        if (args[1] === 'venv') {
          mkdirSync(join(venv, 'bin'), { recursive: true });
          writeFileSync(venvPython(venv, 'linux'), '');
        }
        if (args[0] === '-c') queries.push(clock);
        return { stdout: args[0] === '-c' ? answer : '', stderr: '' };
      }) as never,
    });
    await provision(); // made; the query answers nothing, before and after the shell install
    expect(queries).toHaveLength(2);
    clock += 9 * 60_000;
    await provision();
    expect(queries).toHaveLength(2);
    clock += 60_000;
    answer = `${chromium}\n`;
    await provision();
    expect(queries).toHaveLength(3);
    expect(managedChromium(root, {}, 'linux')).toBe(chromium);
    clock += 60 * 60_000;
    await provision();
    expect(queries).toHaveLength(3);
  });

  it('PLAN G12: records the provisioned Chromium for the draft floor, and starts making it when a document run is launched', async () => {
    const root = join(dir, 'rt-chrome');
    const venv = join(root, `venv-playwright-${CONFORMANCE_PLAYWRIGHT_VERSION}`);
    const chromium = join(dir, 'chrome-linux', 'chrome');
    mkdirSync(join(dir, 'chrome-linux'), { recursive: true });
    writeFileSync(chromium, '');
    const provision = conformanceProvisioner(() => root, {
      platform: 'linux',
      env: {},
      exec: (async (bin: string, args: string[]) => {
        if (args[1] === 'venv') {
          mkdirSync(join(venv, 'bin'), { recursive: true });
          writeFileSync(venvPython(venv, 'linux'), '');
        }
        return { stdout: args[0] === '-c' ? `${chromium}\n` : '', stderr: '' };
      }) as never,
    });
    expect(managedChromium(root, {}, 'linux')).toBeNull();
    expect((await provision()).ok).toBe(true);
    expect(managedChromium(root, {}, 'linux')).toBe(chromium);

    let starts = 0;
    const counted = async () => {
      starts += 1;
      return { ok: true as const, python: '/x' };
    };
    const managed = '/rt/venv/bin/python';
    const env: NodeJS.ProcessEnv = { [ENGINE_CONFORMANCE_PYTHON_ENV]: managed };
    expect(provisionOnDraftLaunch({ kind: 'run', status: 'handed', workflow: 'feature' }, counted, () => {}, env, managed)).toBe(false);
    // An operator's own renderer: nothing is downloaded for the floor.
    expect(provisionOnDraftLaunch({ kind: 'run', status: 'handed', workflow: 'interactive-draft' }, counted, () => {}, { ...env, WICKED_CHROME: '/opt/chrome' }, managed)).toBe(false);
    // No studio dist needed: a document floor prints the document, it serves no host page.
    expect(provisionOnDraftLaunch({ kind: 'run', status: 'handed', workflow: 'interactive-draft' }, counted, () => {}, env, managed)).toBe(true);
    expect(provisionOnDraftLaunch({ kind: 'run', status: 'handed', workflow: 'interactive-chat' }, counted, () => {}, env, managed)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(starts).toBe(2);
  });

  it('reuses a finished venv with no index or browser call, and rebuilds a half-made one', async () => {
    const root = join(dir, 'rt2');
    const pinned = join(root, 'venv-playwright-1.65.0');
    mkdirSync(join(pinned, 'bin'), { recursive: true });
    writeFileSync(venvPython(pinned, 'linux'), '');
    const calls: string[][] = [];
    const chromium = join(root, 'chrome');
    const exec = (async (bin: string, args: string[]) => {
      calls.push([bin, ...args]);
      // A real `venv` would create the interpreter again.
      if (args[1] === 'venv') {
        mkdirSync(join(pinned, 'bin'), { recursive: true });
        writeFileSync(venvPython(pinned, 'linux'), '');
        writeFileSync(chromium, '');
      }
      // The Chromium query answers a real path: recorded once, never asked again on reuse.
      return { stdout: args[0] === '-c' ? `${chromium}\n` : '', stderr: '' };
    }) as never;
    const provision = conformanceProvisioner(() => root, { platform: 'linux', env: { [CONFORMANCE_PLAYWRIGHT_ENV]: '1.65.0' }, exec });
    // No marker (a venv a killed provisioning left): rebuilt from nothing, with the pin override.
    expect(await provision()).toEqual({ ok: true, python: venvPython(pinned, 'linux') });
    expect(calls.map((c) => c.slice(0, 3))).toEqual([
      ['python3', '-m', 'venv'],
      [venvPython(pinned, 'linux'), '-m', 'pip'],
      [venvPython(pinned, 'linux'), '-m', 'playwright'],
      // PLAN G12: once, where its headless shell is (for the draft renderer).
      [venvPython(pinned, 'linux'), '-c', expect.stringContaining('chromium.executable_path')],
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

// (DES-EDITOR-CONFORMANCE-HOST, e2e F18) The engine runs an editor-plugin run's conformance cases on this host, from
// crew's runtime and studio dist, which crew names in the daemon's environment at boot.
describe('the engine\'s conformance step inputs', () => {
  it('names crew\'s pinned venv interpreter (the one the provisioner makes) and its studio dist; an operator\'s own setting wins', async () => {
    const studio = join(dir, 'studio');
    mkdirSync(studio, { recursive: true });
    writeFileSync(join(studio, 'index.html'), '<!doctype html>');
    const env: NodeJS.ProcessEnv = { [CONFORMANCE_RUNTIME_DIR_ENV]: join(dir, 'rt') };
    const set = exportEngineConformanceEnv(studio, env, 'darwin');
    const python = venvPython(conformanceVenvDir(join(dir, 'rt'), env), 'darwin');
    expect(set).toEqual({ python, studio });
    expect(env[ENGINE_CONFORMANCE_PYTHON_ENV]).toBe(python);
    expect(env[ENGINE_CONFORMANCE_STUDIO_ENV]).toBe(studio);
    expect(python).toBe(join(dir, 'rt', `venv-playwright-${CONFORMANCE_PLAYWRIGHT_VERSION}`, 'bin', 'python'));
    // The path the provisioner reports for the same root is the one named at boot.
    const made = await conformanceProvisioner(() => join(dir, 'rt'), {
      env,
      platform: 'darwin',
      exec: (async (_bin: string, args: string[]) => {
        if (args[0] === '-m' && args[1] === 'venv') mkdirSync(join(String(args[2]), 'bin'), { recursive: true });
        if (args[0] === '-m' && args[1] === 'venv') writeFileSync(join(String(args[2]), 'bin', 'python'), '');
        return { stdout: '', stderr: '' };
      }) as never,
    })();
    expect(made).toEqual({ ok: true, python });
    const own: NodeJS.ProcessEnv = { [ENGINE_CONFORMANCE_PYTHON_ENV]: '/opt/py', [ENGINE_CONFORMANCE_STUDIO_ENV]: '/opt/dist' };
    expect(exportEngineConformanceEnv(studio, own, 'darwin')).toEqual({});
    expect(own[ENGINE_CONFORMANCE_PYTHON_ENV]).toBe('/opt/py');
    // A bundle with no index.html (a headless daemon) names no dist: the engine's step then refuses with a retry.
    const headless: NodeJS.ProcessEnv = {};
    expect(exportEngineConformanceEnv(join(dir, 'nothing'), headless, 'darwin').studio).toBeUndefined();
    expect(headless[ENGINE_CONFORMANCE_STUDIO_ENV]).toBeUndefined();
  });

  it('refreshes its own exports on a later boot (never mistaking them for an operator\'s), and follows the pin and the platform', () => {
    const a = join(dir, 'studio-a');
    const b = join(dir, 'studio-b');
    for (const d of [a, b]) {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'index.html'), '<!doctype html>');
    }
    const env: NodeJS.ProcessEnv = { [CONFORMANCE_RUNTIME_DIR_ENV]: join(dir, 'rt') };
    exportEngineConformanceEnv(a, env, 'darwin');
    exportEngineConformanceEnv(b, env, 'darwin');
    expect(env[ENGINE_CONFORMANCE_STUDIO_ENV]).toBe(b);
    exportEngineConformanceEnv(null, env, 'darwin'); // a headless boot after them
    expect(env[ENGINE_CONFORMANCE_STUDIO_ENV]).toBeUndefined();
    env[CONFORMANCE_PLAYWRIGHT_ENV] = '1.70.1';
    exportEngineConformanceEnv(null, env, 'win32');
    expect(env[ENGINE_CONFORMANCE_PYTHON_ENV]).toBe(join(dir, 'rt', 'venv-playwright-1.70.1', 'Scripts', 'python.exe'));
    // A relative runtime override, or an empty or relative cache variable, never yields a relative interpreter
    // (the engine runs only an absolute one).
    for (const e of [{ [CONFORMANCE_RUNTIME_DIR_ENV]: 'rel-rt' }, { XDG_CACHE_HOME: '' }, { XDG_CACHE_HOME: 'rel-cache' }] as NodeJS.ProcessEnv[]) {
      exportEngineConformanceEnv(null, e, 'linux');
      expect(e[ENGINE_CONFORMANCE_PYTHON_ENV]!.startsWith('/'), JSON.stringify(e)).toBe(true);
    }
  });

  it('starts making the runtime when an editor-plugin run is launched, never for another run or an operator\'s own interpreter', async () => {
    let calls = 0;
    const logs: string[] = [];
    const provision = async () => {
      calls += 1;
      return { ok: false as const, error: 'crew could not provision the conformance browser: no index' };
    };
    const managed = '/rt/venv/bin/python';
    const env: NodeJS.ProcessEnv = { [ENGINE_CONFORMANCE_PYTHON_ENV]: managed, [ENGINE_CONFORMANCE_STUDIO_ENV]: '/studio' };
    const fire = (n: { kind: string; status: string; workflow?: string }, e = env) =>
      provisionOnEditorPluginLaunch(n, provision, (m) => logs.push(m), e, managed);
    expect(fire({ kind: 'run', status: 'handed', workflow: 'feature' })).toBe(false);
    expect(fire({ kind: 'campaign', status: 'handed', workflow: 'editor-plugin' })).toBe(false);
    expect(fire({ kind: 'run', status: 'rejected', workflow: 'editor-plugin' })).toBe(false);
    expect(fire({ kind: 'run', status: 'handed', workflow: 'editor-plugin' }, { [ENGINE_CONFORMANCE_PYTHON_ENV]: '/opt/py', [ENGINE_CONFORMANCE_STUDIO_ENV]: '/studio' })).toBe(false);
    // A headless daemon (no studio dist): the step can never pass there, so nothing is downloaded.
    expect(fire({ kind: 'run', status: 'handed', workflow: 'editor-plugin' }, { [ENGINE_CONFORMANCE_PYTHON_ENV]: managed })).toBe(false);
    // `accepted` follows `handed` for the same launch: one hand-off, one start.
    expect(fire({ kind: 'run', status: 'accepted', workflow: 'editor-plugin' })).toBe(false);
    expect(calls).toBe(0);
    expect(fire({ kind: 'run', status: 'handed', workflow: 'editor-plugin' })).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(1);
    expect(logs.join('\n')).toContain('crew could not provision the conformance browser');
  });

  it('provisions with absolute browser-cache variables only (the engine runs the cases from another directory)', async () => {
    expect(absoluteCacheEnv({ XDG_CACHE_HOME: 'rel', PLAYWRIGHT_BROWSERS_PATH: 'pw', HOME: '/h' }, 'linux')).toEqual({ HOME: '/h' });
    expect(absoluteCacheEnv({ XDG_CACHE_HOME: '/abs' }, 'linux')).toEqual({ XDG_CACHE_HOME: '/abs' });
    const seen: NodeJS.ProcessEnv[] = [];
    await conformanceProvisioner(() => join(dir, 'rt2'), {
      env: { XDG_CACHE_HOME: 'rel-cache' },
      platform: 'linux',
      exec: (async (_bin: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
        seen.push(opts.env);
        if (args[1] === 'venv') {
          mkdirSync(join(String(args[2]), 'bin'), { recursive: true });
          writeFileSync(join(String(args[2]), 'bin', 'python'), '');
        }
        return { stdout: '', stderr: '' };
      }) as never,
    })();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((e) => e['XDG_CACHE_HOME'] === undefined)).toBe(true);
  });

  it('a resume or gate answer on an editor-plugin run starts the runtime when it is not made yet (the retry path)', async () => {
    let calls = 0;
    const provision = async () => {
      calls += 1;
      return { ok: true as const, python: '/rt/venv/bin/python' };
    };
    const env: NodeJS.ProcessEnv = { [ENGINE_CONFORMANCE_PYTHON_ENV]: '/rt/venv/bin/python', [ENGINE_CONFORMANCE_STUDIO_ENV]: '/studio' };
    let ready = false;
    const looked: string[] = [];
    const listen = editorPluginLaunchListener({
      provision,
      log: () => undefined,
      managed: '/rt/venv/bin/python',
      ready: () => ready,
      workflowOf: async (id) => {
        looked.push(id);
        return id === 'ep-run' ? 'editor-plugin' : 'feature';
      },
      env,
    });
    listen({ kind: 'run', id: 'ep-run', status: 'handed' });
    listen({ kind: 'run', id: 'other', status: 'handed' });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(1);
    expect(looked).toEqual(['ep-run', 'other']);
    ready = true; // made: a resume reads nothing
    listen({ kind: 'run', id: 'ep-run', status: 'handed' });
    await new Promise((r) => setTimeout(r, 0));
    expect(looked).toHaveLength(2);
  });
});

describe('PLAN G12 (crew half): the managed headless shell as the daemon\'s WICKED_CHROME', () => {
  /** A made runtime under `root` whose recorded renderer is `shell` (a real file). */
  function made(root: string, shell: string | null): void {
    const venv = conformanceVenvDir(root, {});
    mkdirSync(join(venv, 'bin'), { recursive: true });
    writeFileSync(venvPython(venv, 'linux'), '');
    writeFileSync(join(venv, PROVISIONED_MARKER), 'playwright\n');
    if (shell !== null) {
      mkdirSync(join(shell, '..'), { recursive: true });
      writeFileSync(shell, '');
      writeFileSync(join(venv, CHROMIUM_PATH_FILE), `${shell}\n`);
    }
  }

  it('records the headless shell, never the full Chrome an earlier crew recorded', () => {
    const root = join(dir, 'g12-file');
    made(root, null);
    const venv = conformanceVenvDir(root, {});
    const full = join(dir, 'chromium-1248', 'chrome-mac-arm64', 'Google Chrome for Testing');
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, '');
    // What an earlier crew wrote: the full browser, which cannot print in the engine's no-network jail.
    writeFileSync(join(venv, '.wicked-chromium'), `${full}\n`);
    expect(CHROMIUM_PATH_FILE).not.toBe('.wicked-chromium');
    expect(managedChromium(root, {}, 'linux')).toBeNull();
  });

  it('exports crew\'s shell, refreshes and withdraws only crew\'s own value, and never touches an operator\'s', () => {
    const root = join(dir, 'g12-export');
    const shell = join(dir, 'chromium_headless_shell-1248', 'chrome-headless-shell-linux64', 'chrome-headless-shell');
    made(root, shell);
    const env: NodeJS.ProcessEnv = {};
    expect(exportManagedChrome(root, env, 'linux')).toBe(shell);
    expect(env['WICKED_CHROME']).toBe(shell);
    // Its browser is gone: crew's own value is withdrawn.
    writeFileSync(join(conformanceVenvDir(root, {}), CHROMIUM_PATH_FILE), '/nowhere/chrome-headless-shell\n');
    expect(exportManagedChrome(root, env, 'linux')).toBeUndefined();
    expect(env['WICKED_CHROME']).toBeUndefined();
    // An operator's own renderer stays as it is.
    const own: NodeJS.ProcessEnv = { WICKED_CHROME: '/opt/my-chrome' };
    made(root, shell);
    expect(exportManagedChrome(root, own, 'linux')).toBeUndefined();
    expect(own['WICKED_CHROME']).toBe('/opt/my-chrome');
  });

  it('a draft launch still provisions when WICKED_CHROME is crew\'s own export, not the operator\'s', async () => {
    const root = join(dir, 'g12-launch');
    const shell = join(dir, 'g12-shell', 'chrome-headless-shell');
    made(root, shell);
    const managed = '/rt/venv/bin/python';
    const env: NodeJS.ProcessEnv = { [ENGINE_CONFORMANCE_PYTHON_ENV]: managed };
    exportManagedChrome(root, env, 'linux');
    expect(env['WICKED_CHROME']).toBe(shell);
    let starts = 0;
    const counted = async () => {
      starts += 1;
      return { ok: true as const, python: '/x' };
    };
    expect(provisionOnDraftLaunch({ kind: 'run', status: 'handed', workflow: 'interactive-draft' }, counted, () => {}, env, managed)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(starts).toBe(1);
  });

  it('review r1 (pi): a made runtime whose recorded shell is gone asks again, and records the new one', async () => {
    const root = join(dir, 'g12-stale');
    made(root, join(dir, 'g12-stale-old', 'chrome-headless-shell'));
    const venv = conformanceVenvDir(root, {});
    writeFileSync(join(venv, CHROMIUM_PATH_FILE), `${join(dir, 'pruned', 'chrome-headless-shell')}\n`);
    const fresh = join(dir, 'g12-stale-new', 'chrome-headless-shell');
    mkdirSync(join(fresh, '..'), { recursive: true });
    writeFileSync(fresh, '');
    const env: NodeJS.ProcessEnv = {};
    const provision = conformanceProvisioner(() => root, {
      platform: 'linux',
      env,
      exec: (async (_bin: string, args: string[]) => ({ stdout: args[0] === '-c' ? `${fresh}\n` : '', stderr: '' })) as never,
    });
    expect((await provision()).ok).toBe(true);
    expect(managedChromium(root, {}, 'linux')).toBe(fresh);
    expect(env['WICKED_CHROME']).toBe(fresh);
  });

  it('the provisioner exports the shell it recorded into the daemon environment it was given', async () => {
    const root = join(dir, 'g12-prov');
    const venv = conformanceVenvDir(root, {});
    const shell = join(dir, 'g12-prov-shell', 'chrome-headless-shell');
    mkdirSync(join(shell, '..'), { recursive: true });
    writeFileSync(shell, '');
    const env: NodeJS.ProcessEnv = {};
    const provision = conformanceProvisioner(() => root, {
      platform: 'linux',
      env,
      exec: (async (_bin: string, args: string[]) => {
        if (args[1] === 'venv') {
          mkdirSync(join(venv, 'bin'), { recursive: true });
          writeFileSync(venvPython(venv, 'linux'), '');
        }
        return { stdout: args[0] === '-c' ? `${shell}\n` : '', stderr: '' };
      }) as never,
    });
    expect((await provision()).ok).toBe(true);
    expect(env['WICKED_CHROME']).toBe(shell);
  });
});
