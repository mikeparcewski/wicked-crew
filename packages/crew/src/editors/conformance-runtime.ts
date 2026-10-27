/**
 * B8 (PRODUCT-WORKS J6): the browser runtime crew's install-time editor conformance run needs.
 *
 * Garden's runner (`scripts/editor/conformance.py`) drives headless Chromium through the PYTHON
 * Playwright package. Nothing installs that package: a fresh daemon host met
 * `422 conformance_unavailable` ("no headless browser") on the first editor-plugin install, and the
 * operator had to `pip install playwright` by hand. The conformance run is crew's own gate (only
 * crew's run counts, DES-artifact-editor-plugins §12.1), so crew provisions its runtime: a private
 * virtualenv with a pinned Playwright, and Playwright's Chromium (a no-op when the shared browser
 * cache already holds it). It is made once, on the first install that needs it, and reused;
 * nothing is installed into the operator's own Python.
 *
 * It lives in the OS cache directory ({@link conformanceRuntimeRoot}), NOT the state home: every
 * top-level state-home entry must be registered with the engine's launch fence, and an
 * unregistered one refuses every governed launch. A cache is also what it is: deleting it costs
 * one re-provisioning.
 *
 * A host where that cannot be done (no Python with `venv`, no package index) still refuses the
 * install, fail closed, but says what crew tried, what failed and the one command that fixes it.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { execCapped } from '../core/exec.js';

/** The Playwright release crew provisions (the one garden's runner is exercised with on the rig). */
export const CONFORMANCE_PLAYWRIGHT_VERSION = '1.64.0';
/** Overrides {@link CONFORMANCE_PLAYWRIGHT_VERSION} (a pin, e.g. `1.65.0`). */
export const CONFORMANCE_PLAYWRIGHT_ENV = 'WICKED_CONFORMANCE_PLAYWRIGHT';

/** Overrides {@link conformanceRuntimeRoot}: where the runtime is kept. */
export const CONFORMANCE_RUNTIME_DIR_ENV = 'WICKED_CONFORMANCE_RUNTIME_DIR';
/** Written into a venv only once every provisioning step succeeded. */
export const PROVISIONED_MARKER = '.wicked-provisioned';

/** The OS cache directory's `wicked-crew/editor-conformance`, or the override. */
export function conformanceRuntimeRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  const override = (env[CONFORMANCE_RUNTIME_DIR_ENV] ?? '').trim();
  if (override !== '') return override;
  const cache = platform === 'darwin'
    ? join(home, 'Library', 'Caches')
    : platform === 'win32'
      ? (env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'))
      : (env['XDG_CACHE_HOME'] ?? join(home, '.cache'));
  return join(cache, 'wicked-crew', 'editor-conformance');
}

/** Bounds on each provisioning step. */
const VENV_TIMEOUT_MS = 120_000;
const PIP_TIMEOUT_MS = 300_000;
const BROWSER_TIMEOUT_MS = 600_000;

export type Provisioned = { ok: true; python: string } | { ok: false; error: string };
export type ConformanceProvisioner = () => Promise<Provisioned>;

/** The venv's interpreter, by platform. */
export function venvPython(venv: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python');
}

/** Whether a garden conformance report says the browser runtime is what is missing. */
export function needsBrowserRuntime(error: string | undefined): boolean {
  return typeof error === 'string' && /no headless browser/i.test(error);
}

function message(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown };
  const tail = typeof e.stderr === 'string' && e.stderr.trim() !== '' ? e.stderr.trim().split('\n').slice(-3).join(' | ') : '';
  const head = err instanceof Error ? err.message.split('\n')[0]! : String(err);
  return tail === '' ? head : `${head} (${tail})`;
}

export interface ProvisionDeps {
  exec?: typeof execCapped;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/**
 * The provisioner over `<root>` (crew passes {@link conformanceRuntimeRoot}). Concurrent callers
 * share one provisioning; a finished one is marked and reused; a failed one leaves nothing behind
 * and is retried by the next install.
 */
export function conformanceProvisioner(root: () => string, deps: ProvisionDeps = {}): ConformanceProvisioner {
  const exec = deps.exec ?? execCapped;
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  let inFlight: Promise<Provisioned> | null = null;
  const pin = (): string => {
    const v = (env[CONFORMANCE_PLAYWRIGHT_ENV] ?? '').trim();
    return /^\d+\.\d+\.\d+$/.test(v) ? v : CONFORMANCE_PLAYWRIGHT_VERSION;
  };
  const run = async (): Promise<Provisioned> => {
    const dir = root();
    const venv = join(dir, `venv-playwright-${pin()}`);
    const python = venvPython(venv, platform);
    const marker = join(venv, PROVISIONED_MARKER);
    // A venv every step finished in is reused as is: no package index, no browser download.
    if (existsSync(marker) && existsSync(python)) return { ok: true, python };
    const fix = `pip install playwright==${pin()} && python -m playwright install chromium`;
    const refuse = (what: string): Provisioned => {
      // A half-made venv is never reused: the next install starts from nothing.
      rmSync(venv, { recursive: true, force: true });
      return { ok: false, error: `crew could not provision the conformance browser: ${what}. On this host, run: ${fix}` };
    };
    const step = async (what: string, file: string, args: string[], timeout: number): Promise<{ missing: boolean; error: string } | null> => {
      try {
        await exec(file, args, { timeout, windowsHide: true, env });
        return null;
      } catch (err) {
        return { missing: (err as NodeJS.ErrnoException).code === 'ENOENT', error: `${what} failed: ${message(err)}` };
      }
    };
    rmSync(venv, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    let made: { missing: boolean; error: string } | null = { missing: true, error: 'no python interpreter found (python3 / python)' };
    for (const bin of platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']) {
      const r = await step(`creating a virtualenv with ${bin}`, bin, ['-m', 'venv', venv], VENV_TIMEOUT_MS);
      if (r === null) {
        made = null;
        break;
      }
      // Only a missing interpreter moves on to the next spelling; a real failure is the answer.
      if (!r.missing) {
        made = r;
        break;
      }
      if (made.missing) made = r;
    }
    if (made !== null) return refuse(made.missing ? 'no python interpreter found (python3 / python)' : made.error);
    const pip = await step(`installing playwright==${pin()}`, python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', `playwright==${pin()}`], PIP_TIMEOUT_MS);
    if (pip !== null) return refuse(pip.error);
    const browser = await step('installing Playwright\'s chromium', python, ['-m', 'playwright', 'install', 'chromium'], BROWSER_TIMEOUT_MS);
    if (browser !== null) return refuse(browser.error);
    mkdirSync(venv, { recursive: true });
    writeFileSync(marker, `playwright==${pin()}\n`);
    return { ok: true, python };
  };
  return () => {
    if (inFlight === null) {
      inFlight = run().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
}
