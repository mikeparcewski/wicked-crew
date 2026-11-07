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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, resolve, win32 } from 'node:path';

import { execCapped } from '../core/exec.js';

/** The Playwright release crew provisions (the one garden's runner is exercised with on the rig). */
export const CONFORMANCE_PLAYWRIGHT_VERSION = '1.64.0';
/** Overrides {@link CONFORMANCE_PLAYWRIGHT_VERSION} (a pin, e.g. `1.65.0`). */
export const CONFORMANCE_PLAYWRIGHT_ENV = 'WICKED_CONFORMANCE_PLAYWRIGHT';

/** Overrides {@link conformanceRuntimeRoot}: where the runtime is kept. */
export const CONFORMANCE_RUNTIME_DIR_ENV = 'WICKED_CONFORMANCE_RUNTIME_DIR';
/** Written into a venv only once every provisioning step succeeded. */
export const PROVISIONED_MARKER = '.wicked-provisioned';
/** (PLAN G12) Beside the marker: the path of the Chromium that venv's Playwright installed, one line. */
export const CHROMIUM_PATH_FILE = '.wicked-chromium';

/** The workflows whose documents crew's draft floor prints to measure their pages (PLAN G12). */
export const DRAFT_RENDER_WORKFLOWS: ReadonlySet<string> = new Set(['interactive-draft', 'interactive-chat']);

/**
 * (PLAN G12) The Chromium crew provisioned for this host, as the draft floor's renderer (`WICKED_CHROME`), or `null`
 * when the runtime is not made yet (or its browser is gone). Read from the file the provisioner writes; never spawns.
 */
export function managedChromium(root: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  if (!conformanceRuntimeReady(root, env, platform)) return null;
  try {
    const path = readFileSync(join(conformanceVenvDir(root, env), CHROMIUM_PATH_FILE), 'utf8').trim();
    return path !== '' && existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

/** Asks the venv's Playwright where its Chromium is (printed on one line). */
const CHROMIUM_PATH_PY =
  'from playwright.sync_api import sync_playwright as s\np = s().start()\nprint(p.chromium.executable_path)\np.stop()';

/** The OS cache directory's `wicked-crew/editor-conformance`, or the override. */
export function conformanceRuntimeRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  const override = (env[CONFORMANCE_RUNTIME_DIR_ENV] ?? '').trim();
  // Absolute, always: the engine runs only an absolute interpreter path (a relative one would refuse forever).
  if (override !== '') return resolve(override);
  // An empty or relative cache variable is unset (the engine runs only an absolute interpreter path).
  const isAbs = platform === 'win32' ? win32.isAbsolute : posix.isAbsolute;
  const absolute = (v: string | undefined): string | undefined => (v !== undefined && isAbs(v) ? v : undefined);
  const cache = platform === 'darwin'
    ? join(home, 'Library', 'Caches')
    : platform === 'win32'
      ? (absolute(env['LOCALAPPDATA']) ?? join(home, 'AppData', 'Local'))
      : (absolute(env['XDG_CACHE_HOME']) ?? join(home, '.cache'));
  const root = join(cache, 'wicked-crew', 'editor-conformance');
  return isAbs(root) ? root : resolve(root);
}

/** The Playwright pin crew provisions: {@link CONFORMANCE_PLAYWRIGHT_ENV} when it is a version, else the default. */
export function conformancePin(env: NodeJS.ProcessEnv = process.env): string {
  const v = (env[CONFORMANCE_PLAYWRIGHT_ENV] ?? '').trim();
  return /^\d+\.\d+\.\d+$/.test(v) ? v : CONFORMANCE_PLAYWRIGHT_VERSION;
}

/**
 * `env` without a relative browser-cache variable (`XDG_CACHE_HOME`, `PLAYWRIGHT_BROWSERS_PATH`): Playwright would
 * install Chromium relative to the daemon's working directory, while the engine runs the cases from its own temp
 * dir (and passes only absolute path variables), so the two would never meet.
 */
export function absoluteCacheEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const isAbs = platform === 'win32' ? win32.isAbsolute : posix.isAbsolute;
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of ['XDG_CACHE_HOME', 'PLAYWRIGHT_BROWSERS_PATH']) {
    const v = out[k];
    if (v !== undefined && !isAbs(v)) delete out[k];
  }
  return out;
}

/** The pinned venv's directory under the runtime root (the one {@link conformanceProvisioner} makes). */
export function conformanceVenvDir(root: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(root, `venv-playwright-${conformancePin(env)}`);
}

/**
 * (DES-EDITOR-CONFORMANCE-HOST, e2e F18) The daemon variable naming the interpreter of crew's conformance runtime,
 * read by the engine when it runs an editor-plugin run's `conformance` step on the host
 * (wicked-core `editor_conformance::PYTHON_ENV`).
 */
export const ENGINE_CONFORMANCE_PYTHON_ENV = 'WICKED_EDITOR_CONFORMANCE_PYTHON';
/** The daemon variable naming the studio dist that step serves its host page from (`editor_conformance::STUDIO_DIST_ENV`). */
export const ENGINE_CONFORMANCE_STUDIO_ENV = 'WICKED_EDITOR_CONFORMANCE_STUDIO_DIST';

/**
 * At boot: tell the in-process engine where crew's conformance runtime is (its pinned venv's interpreter; the path is
 * fixed, so it is named even before the venv is made, and the engine's step refuses with a retry until it exists)
 * and which studio dist to serve the host page from (crew's own bundle, when it holds `index.html`). An operator's
 * own setting of either wins. The engine reads the daemon's environment at each dispatch, as it does
 * `WICKED_CREW_BIN`. Returns what it set.
 */
export function exportEngineConformanceEnv(
  studioRoot: string | null,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { python?: string; studio?: string } {
  // What crew itself exported into this environment before (a server booted earlier in the same process):
  // crew's own values are refreshed on every boot; only a value crew did not write is the operator's.
  const mine = crewExports.get(env) ?? {};
  const operators = (key: string, crew: string | undefined): boolean => {
    const v = (env[key] ?? '').trim();
    return v !== '' && v !== crew;
  };
  const out: { python?: string; studio?: string } = {};
  if (!operators(ENGINE_CONFORMANCE_PYTHON_ENV, mine.python)) {
    out.python = venvPython(conformanceVenvDir(conformanceRuntimeRoot(env, platform), env), platform);
    env[ENGINE_CONFORMANCE_PYTHON_ENV] = out.python;
  }
  if (!operators(ENGINE_CONFORMANCE_STUDIO_ENV, mine.studio)) {
    if (studioRoot !== null && existsSync(join(studioRoot, 'index.html'))) {
      out.studio = studioRoot;
      env[ENGINE_CONFORMANCE_STUDIO_ENV] = studioRoot;
    } else if (mine.studio !== undefined) {
      // A headless boot after one that served a studio: the old dist is not this server's.
      delete env[ENGINE_CONFORMANCE_STUDIO_ENV];
    }
  }
  crewExports.set(env, { ...mine, ...out });
  return out;
}

/** The values crew exported into each environment object (by identity), so a later boot can tell them from an operator's. */
const crewExports = new WeakMap<NodeJS.ProcessEnv, { python?: string; studio?: string }>();

/** Whether crew's managed runtime at `root` is fully made (the provisioner's marker beside its interpreter). */
export function conformanceRuntimeReady(root: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  const venv = conformanceVenvDir(root, env);
  return existsSync(join(venv, PROVISIONED_MARKER)) && existsSync(venvPython(venv, platform));
}

/**
 * (DES-EDITOR-CONFORMANCE-HOST) When an editor-plugin run is launched (the adapter's launch notice, every launch
 * path), make crew's conformance runtime in the background
 * (deduped; a made one is reused at once), so the engine's `conformance` step finds it after the build. Nothing is
 * installed when an operator named their own interpreter. A failure is logged with crew's fix line; the step then
 * refuses and its gate offers a retry.
 */
export function provisionOnEditorPluginLaunch(
  notice: { kind: string; status: string; workflow?: string },
  provision: ConformanceProvisioner,
  log: (m: string) => void,
  env: NodeJS.ProcessEnv = process.env,
  managed: string | undefined = undefined,
): boolean {
  // One notice per hand-off: `handed` (the `accepted` that follows it is the same launch).
  if (notice.kind !== 'run' || notice.status !== 'handed' || notice.workflow !== 'editor-plugin') return false;
  // An operator's own interpreter: crew provisions nothing (only crew's managed path is crew's to make).
  if (managed !== undefined && (env[ENGINE_CONFORMANCE_PYTHON_ENV] ?? '') !== managed) return false;
  // No studio dist to serve the host page from (a headless daemon): the step can never pass here, so nothing
  // is downloaded for it.
  if ((env[ENGINE_CONFORMANCE_STUDIO_ENV] ?? '').trim() === '') return false;
  void provision().then(
    (r) => {
      if (!r.ok) log(`[editors] an editor-plugin run started, but ${r.error}`);
    },
    (err: unknown) => log(`[editors] provisioning the conformance runtime failed: ${err instanceof Error ? err.message : String(err)}`),
  );
  return true;
}

/**
 * (PLAN G12) When a document draft or a refine is launched, make the same runtime in the background, so crew's draft
 * floor can PRINT the document and measure its pages ({@link managedChromium}) instead of estimating them. Nothing is
 * installed when an operator named their own interpreter or their own `WICKED_CHROME`. A failure is logged; the floor
 * then estimates the count and says it is unmeasured, as before.
 */
export function provisionOnDraftLaunch(
  notice: { kind: string; status: string; workflow?: string },
  provision: ConformanceProvisioner,
  log: (m: string) => void,
  env: NodeJS.ProcessEnv = process.env,
  managed: string | undefined = undefined,
): boolean {
  if (notice.kind !== 'run' || notice.status !== 'handed' || notice.workflow === undefined || !DRAFT_RENDER_WORKFLOWS.has(notice.workflow)) return false;
  if (managed !== undefined && (env[ENGINE_CONFORMANCE_PYTHON_ENV] ?? '') !== managed) return false;
  if ((env['WICKED_CHROME'] ?? '').trim() !== '') return false;
  void provision().then(
    (r) => {
      if (!r.ok) log(`[interactive] a document run started, but its page count stays unmeasured: ${r.error}`);
    },
    (err: unknown) => log(`[interactive] provisioning the document renderer failed: ${err instanceof Error ? err.message : String(err)}`),
  );
  return true;
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
  // (PLAN G12) The Chromium path is asked for until it is recorded: a reused runtime with the path spawns nothing, and
  // a failed query is asked again at most every 10 minutes (codex r1/r2).
  const askedChromium = new Map<string, number>();
  const CHROMIUM_RETRY_MS = 10 * 60_000;
  const pin = (): string => conformancePin(env);
  const run = async (): Promise<Provisioned> => {
    const dir = root();
    const venv = conformanceVenvDir(dir, env);
    const python = venvPython(venv, platform);
    const marker = join(venv, PROVISIONED_MARKER);
    const chromiumFile = join(venv, CHROMIUM_PATH_FILE);
    // (PLAN G12) Where Playwright put its Chromium, for the draft floor's renderer. Best-effort: without it the floor
    // estimates the page count, as before.
    const recordChromium = async (): Promise<void> => {
      const last = askedChromium.get(venv);
      if (last !== undefined && Date.now() - last < CHROMIUM_RETRY_MS) return;
      askedChromium.set(venv, Date.now());
      try {
        const out = await exec(python, ['-c', CHROMIUM_PATH_PY], { timeout: VENV_TIMEOUT_MS, windowsHide: true, env: absoluteCacheEnv(env, platform) });
        const path = out.stdout.trim().split('\n').pop()?.trim() ?? '';
        if (path !== '' && existsSync(path)) writeFileSync(chromiumFile, `${path}\n`);
      } catch {
        /* the floor estimates instead */
      }
    };
    // A venv every step finished in is reused as is: no package index, no browser download.
    if (existsSync(marker) && existsSync(python)) {
      if (!existsSync(chromiumFile)) await recordChromium();
      return { ok: true, python };
    }
    const fix = `pip install playwright==${pin()} && python -m playwright install chromium`;
    const refuse = (what: string): Provisioned => {
      // A half-made venv is never reused: the next install starts from nothing.
      rmSync(venv, { recursive: true, force: true });
      return { ok: false, error: `crew could not provision the conformance browser: ${what}. On this host, run: ${fix}` };
    };
    const step = async (what: string, file: string, args: string[], timeout: number): Promise<{ missing: boolean; error: string } | null> => {
      try {
        await exec(file, args, { timeout, windowsHide: true, env: absoluteCacheEnv(env, platform) });
        return null;
      } catch (err) {
        return { missing: (err as NodeJS.ErrnoException).code === 'ENOENT', error: `${what} failed: ${message(err)}` };
      }
    };
    rmSync(venv, { recursive: true, force: true });
    askedChromium.delete(venv);
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
    await recordChromium();
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

/**
 * (DES-EDITOR-CONFORMANCE-HOST) The launch listener crew registers: a new editor-plugin launch starts the
 * runtime ({@link provisionOnEditorPluginLaunch}); a resume or a gate answer on a run (its notice names no
 * workflow) does too when the runtime is not made yet and the run is an editor-plugin run, so the conformance
 * step's retry after a failed or interrupted provisioning is not a refusal forever.
 */
export function editorPluginLaunchListener(deps: {
  provision: ConformanceProvisioner;
  log: (m: string) => void;
  managed: string;
  ready: () => boolean;
  workflowOf: (runId: string) => Promise<string | undefined>;
  env?: NodeJS.ProcessEnv;
}): (notice: { kind: string; id: string; status: string; workflow?: string }) => void {
  const env = deps.env ?? process.env;
  return (notice) => {
    if (notice.workflow !== undefined) {
      provisionOnEditorPluginLaunch(notice, deps.provision, deps.log, env, deps.managed);
      provisionOnDraftLaunch(notice, deps.provision, deps.log, env, deps.managed);
      return;
    }
    if (notice.kind !== 'run' || notice.status !== 'handed' || deps.ready()) return;
    void deps.workflowOf(notice.id).then(
      (workflow) => {
        if (workflow !== undefined) provisionOnEditorPluginLaunch({ ...notice, workflow }, deps.provision, deps.log, env, deps.managed);
      },
      () => undefined,
    );
  };
}
