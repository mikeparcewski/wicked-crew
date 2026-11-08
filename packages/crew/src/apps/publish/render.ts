/**
 * (CONTRACT-CS2 §P2) The publish check's fixture RENDER: crew's conformance Python drives the standalone
 * runtime over a loopback server, showing every page, every filter change and every prepared action's card at
 * two viewports, and records PNGs + a report. It is the QE evidence a publish run's `check` step carries.
 *
 * The harness:
 *  - copies B's `appsRuntime().dir` (`runtime.js`, `runtime.css`, `fixture.html`, `fixture.js`) into a temp dir and writes
 *    `fixture.json` = `{ spec, cards }` beside them (the cards from the pure builder, apps/actions/card.ts);
 *  - runs `scripts/apps-render.py --dir <tmp> --out <tmp>/out`, which serves `<tmp>` on a loopback port with a
 *    strict CSP and drives `window.__wkFixture` (§P4) at 1440x900 and 390x844;
 *  - reads `out/report.json` and the PNGs beside it as the evidence.
 *
 * Any failure — no Python interpreter, no browser, the script's own non-zero exit, a missing or malformed
 * report, a runtime error or a page that did not render — answers `{ ok: false }`: the publish check never
 * passes on a render it could not run. The whole render is capped (3 minutes) and never touches a source.
 */

import { cpSync, lstatSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AppActionCard, AppSpec } from '../../core/types.js';
import { execCapped } from '../../core/exec.js';
import { conformanceRuntimeReady, conformanceRuntimeRoot, conformanceVenvDir, ENGINE_CONFORMANCE_PYTHON_ENV, venvPython } from '../../editors/conformance-runtime.js';

/** How long the whole render may take (DES §9.3: capped at 3 minutes). */
export const RENDER_TIMEOUT_MS = 3 * 60 * 1000;

/** One rendered page at one viewport. */
export interface RenderPage {
  page: string;
  width: number;
  shot: string;
  errors: string[];
}

/** The render script's own report (`out/report.json`). */
export interface RenderReport {
  pages: RenderPage[];
  filters: unknown[];
  actions: unknown[];
  errors: string[];
}

export interface RenderInput {
  /** B's `appsRuntime()`: the standalone runtime dir and JS/CSS contents. */
  runtime: { dir: string; js: string; css: string };
  fixture: { spec: AppSpec; cards: Record<string, AppActionCard> };
  env?: NodeJS.ProcessEnv;
  /** TESTS: override the interpreter and the script path. */
  python?: string;
  scriptPath?: string;
}

export type RenderResult =
  | { ok: true; report: RenderReport; evidence: Array<{ path: string; base64: string }> }
  | { ok: false; reason: string };

/** `scripts/apps-render.py`, resolved from this module (`dist/apps/publish/render.js` → package root → `scripts/`). */
export function appsRenderScript(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'apps-render.py');
}

/**
 * The Python interpreter that runs the render: the engine's conformance interpreter when it is set
 * ({@link ENGINE_CONFORMANCE_PYTHON_ENV}), else crew's own provisioned runtime when it is ready. `null` when
 * neither exists (the host has no headless browser): the caller answers `render_unavailable`.
 */
export function renderPython(env: NodeJS.ProcessEnv = process.env): string | null {
  const named = (env[ENGINE_CONFORMANCE_PYTHON_ENV] ?? '').trim();
  if (named !== '' && existsSync(named)) return named;
  const root = conformanceRuntimeRoot(env);
  if (conformanceRuntimeReady(root, env)) {
    const py = venvPython(conformanceVenvDir(root, env));
    if (existsSync(py)) return py;
  }
  return null;
}

/** Run the fixture render; `{ ok: false }` on any failure (the caller maps it to `render_unavailable`). */
export async function renderFixture(input: RenderInput): Promise<RenderResult> {
  const env = input.env ?? process.env;
  const python = input.python ?? renderPython(env);
  if (python === null) return { ok: false, reason: 'no conformance Python runtime (no headless browser to render the fixture)' };
  const script = input.scriptPath ?? appsRenderScript();
  if (!existsSync(script)) return { ok: false, reason: `the render script is missing (${script})` };
  const dir = input.runtime.dir;
  for (const f of ['runtime.js', 'runtime.css', 'fixture.html', 'fixture.js']) {
    if (!existsSync(join(dir, f)) || !lstatSync(join(dir, f)).isFile()) return { ok: false, reason: `the standalone runtime has no ${f}` };
  }

  const work = mkdtempSync(join(tmpdir(), 'wicked-apps-render-'));
  try {
    // The resolver's js/css are contents, not names. Copy only the fixed fixture asset set.
    for (const name of ['runtime.js', 'runtime.css', 'fixture.html', 'fixture.js']) cpSync(join(dir, name), join(work, name));
    writeFileSync(join(work, 'fixture.json'), JSON.stringify(input.fixture), 'utf8');
    const out = join(work, 'out');
    mkdirSync(out, { recursive: true });

    try {
      await execCapped(python, [script, '--dir', work, '--out', out], { timeout: RENDER_TIMEOUT_MS, env, maxBuffer: 8 * 1024 * 1024 });
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr?.trim();
      return { ok: false, reason: `the render script failed: ${(stderr || (err instanceof Error ? err.message : String(err))).slice(0, 600)}` };
    }

    const reportPath = join(out, 'report.json');
    if (!existsSync(reportPath)) return { ok: false, reason: 'the render produced no report.json' };
    let report: RenderReport;
    try {
      report = JSON.parse(readFileSync(reportPath, 'utf8')) as RenderReport;
    } catch {
      return { ok: false, reason: 'the render report.json is not JSON' };
    }
    if (!Array.isArray(report.pages) || report.pages.length === 0) return { ok: false, reason: 'the render rendered no page' };
    if (!Array.isArray(report.errors) || !Array.isArray(report.filters) || !Array.isArray(report.actions)) return { ok: false, reason: 'the render report is incomplete' };
    if (report.errors.length > 0) return { ok: false, reason: `the render reported errors: ${report.errors.slice(0, 5).join('; ').slice(0, 400)}` };
    for (const p of report.pages) {
      if (typeof p.shot !== 'string' || !/^[a-z0-9._-]+\.png$/.test(p.shot) || !existsSync(join(out, p.shot)) || !lstatSync(join(out, p.shot)).isFile()) return { ok: false, reason: `the render named a shot it did not write (${p.page} at ${p.width})` };
      if (!Array.isArray(p.errors)) return { ok: false, reason: 'a page has no error report' };
      if (p.errors.length > 0) return { ok: false, reason: `the ${p.page} page reported errors at ${p.width}: ${p.errors.slice(0, 3).join('; ').slice(0, 300)}` };
    }

    for (const width of [1440, 390]) {
      for (const page of input.fixture.spec.pages) {
        if (!report.pages.some((p) => p.page === page.id && p.width === width)) return { ok: false, reason: `the render missed page ${page.id} at ${width}` };
      }
      for (const action of input.fixture.spec.actions) {
        if (!report.actions.some((a) => typeof a === 'object' && a !== null && 'id' in a && a.id === action.id && 'width' in a && a.width === width)) return { ok: false, reason: `the render missed action ${action.id} at ${width}` };
      }
    }

    // The evidence: report.json and every file beside it (the PNGs), each base64.
    const evidence: Array<{ path: string; base64: string }> = [];
    for (const name of readdirSync(out).sort()) {
      if (!/^(?:report\.json|[a-z0-9._-]+\.png)$/.test(name) || !lstatSync(join(out, name)).isFile()) return { ok: false, reason: 'the render wrote an unexpected evidence entry' };
      evidence.push({ path: `out/${name}`, base64: readFileSync(join(out, name)).toString('base64') });
    }
    return { ok: true, report, evidence };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
