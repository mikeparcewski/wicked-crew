/**
 * A pack install (DES-artifact-editor-plugins §3.2, §5.2, §9.2, §12.1; EP-C1 + the install-time
 * conformance run of EP-C8, operator ruling X3).
 *
 * Install is human-only (§6.4) and fail closed at every step, in this order:
 *  1. garden's `pack check --json` on the pack root (schema, every editor's and run plugin's entry inside the
 *     pack, its hash, its size, nothing loaded from outside);
 *  2. the pack ships editors and/or run plugins only (CS7 C4): one that also ships skills or blocks is refused
 *     with the approval list (501 `pack_ships_skills_or_blocks`), since their own "Add these" step (§3.2) is
 *     not built;
 *  3. the **conformance run**, done by crew itself: garden's `scripts/editor/conformance.py --pack
 *     <root> --host-url <this daemon>` drives studio's conformance host page (served by this daemon)
 *     in headless Chromium against each editor. A host with no browser runtime gets crew's own
 *     (`conformance-runtime.ts`: a private venv with Playwright, made once, B8). A failed case, a
 *     browser that cannot be provisioned or no runner is a 422 with the report — an unverified
 *     editor is never installed. Only crew's run counts (§12.1, review S13);
 *     an author's own run is not consulted;
 *  4. the registry reads every editor back from disk at its pinned hash and records it.
 * Nothing is written into the pack. The registry file is `daemon-editors.json`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type { EditorConformanceSummary, InstallEditorRefusal, InstallEditorResponse, PackCheckResult } from '../core/types.js';
import { execCapped } from '../core/exec.js';
import { EditorInstallConflict, EditorRegistry, PackEditorSchema, PluginManifestSchema, RUN_PLUGIN_CASES, editorEntryDigest, type InstalledPack } from './registry.js';
import { absoluteCacheEnv, needsBrowserRuntime, type ConformanceProvisioner } from './conformance-runtime.js';

export type PackCheckRunner = (packRoot: string) => Promise<PackCheckResult>;

/** The verdict shape garden's `scripts/pack/check.py --json` prints. */
function parseCheckOutput(stdout: string): PackCheckResult | null {
  try {
    const raw = JSON.parse(stdout) as Partial<PackCheckResult>;
    if (typeof raw !== 'object' || raw === null || typeof raw.ok !== 'boolean') return null;
    const findings = (list: unknown): PackCheckResult['errors'] =>
      Array.isArray(list)
        ? list.flatMap((f) => (typeof f === 'object' && f !== null ? [f as PackCheckResult['errors'][number]] : []))
        : [];
    return { ok: raw.ok, errors: findings(raw.errors), warnings: findings(raw.warnings) };
  } catch {
    return null;
  }
}

/**
 * Garden's gate, run as a child: `python3 <garden>/scripts/pack/check.py <pack> --json --garden-root <garden>`
 * (`python` when `python3` is not on PATH). A missing garden or an unparseable verdict is a FAILED
 * check with the reason — never a pass.
 */
export function gardenPackCheck(gardenRoot: string | null): PackCheckRunner {
  return async (packRoot) => {
    if (gardenRoot === null) {
      return { ok: false, errors: [{ level: 'error', code: 'garden-missing', message: 'no wicked-garden plugin found to run `pack check`' }], warnings: [] };
    }
    const script = join(gardenRoot, 'scripts', 'pack', 'check.py');
    if (!existsSync(script)) {
      return { ok: false, errors: [{ level: 'error', code: 'garden-too-old', message: `this wicked-garden has no scripts/pack/check.py (needs >= 12.40.0)` }], warnings: [] };
    }
    const args = [script, packRoot, '--json', '--garden-root', gardenRoot];
    let stdout = '';
    for (const bin of ['python3', 'python']) {
      try {
        const out = await execCapped(bin, args, { timeout: 60_000, windowsHide: true });
        stdout = out.stdout;
        break;
      } catch (err) {
        const e = err as NodeJS.ErrnoException & { stdout?: string; code?: string | number };
        if (e.code === 'ENOENT') continue; // no such interpreter: try the next spelling
        // A failing check exits 1 with the JSON verdict on stdout.
        if (typeof e.stdout === 'string' && e.stdout.trim() !== '') {
          stdout = e.stdout;
          break;
        }
        return { ok: false, errors: [{ level: 'error', code: 'check-failed', message: `pack check did not run: ${e.message}` }], warnings: [] };
      }
    }
    const parsed = parseCheckOutput(stdout);
    if (parsed === null) {
      return { ok: false, errors: [{ level: 'error', code: 'check-unreadable', message: stdout === '' ? 'no python interpreter found (python3 / python)' : 'pack check printed no readable verdict' }], warnings: [] };
    }
    return parsed;
  };
}

export class PackInstallError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422 | 501,
    message: string,
    readonly check?: PackCheckResult,
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PackInstallError';
  }
}

/** The install-time conformance run: the pack root in, garden's report out; `editors` and `plugins` (the
 *  manifest's entries) size the run's overall cap. */
export type ConformanceRunner = (packRoot: string, editors?: readonly Record<string, unknown>[], plugins?: readonly Record<string, unknown>[]) => Promise<EditorConformanceSummary>;

/** garden's bound on each load of the conformance host page (scripts/editor/conformance.py `--timeout`):
 *  this env var, read by garden's runner itself in the daemon's environment, else 120 s. */
export const CONFORMANCE_TIMEOUT_ENV = 'WG_EDITOR_CONFORMANCE_TIMEOUT';
export const DEFAULT_CONFORMANCE_LOAD_S = 120;

/**
 * The per-load bound the runner will use, read the way garden's `load_timeout` reads it: Python's
 * `float()` of the env value (surrounding spaces and digit-group underscores allowed, `1_000` = 1000),
 * valid only within 5-1800 s. A value garden refuses fails its run at once, so the default stands.
 */
export function conformanceLoadSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env[CONFORMANCE_TIMEOUT_ENV] ?? '').trim();
  if (raw === '' || !/^[+-]?(\d(_?\d)*(\.(\d(_?\d)*)?)?|\.\d(_?\d)*)([eE][+-]?\d(_?\d)*)?$/.test(raw)) return DEFAULT_CONFORMANCE_LOAD_S;
  const v = Number(raw.replace(/_/g, ''));
  return Number.isFinite(v) && v >= 5 && v <= 1800 ? v : DEFAULT_CONFORMANCE_LOAD_S;
}

/** One editor's fixed waits in garden's run: the host-contract cases (~30 s) and the behaviour cases 7 and 18 (25 s). */
export const CONFORMANCE_FIXED_WAITS_S = 30 + 25;

/** One editor's manifest surfaces, as far as the run's length depends on them. */
function surfaceCounts(entry: Record<string, unknown>): { actions: number; tabs: number; pluginTabs: number } {
  const surfaces = entry['surfaces'];
  const o = typeof surfaces === 'object' && surfaces !== null ? (surfaces as Record<string, unknown>) : {};
  const card = typeof o['card'] === 'object' && o['card'] !== null ? (o['card'] as Record<string, unknown>) : {};
  const options = typeof o['options'] === 'object' && o['options'] !== null ? (o['options'] as Record<string, unknown>) : {};
  const actions = Array.isArray(card['actions']) ? card['actions'].length : 0;
  const tabs = Array.isArray(options['tabs']) ? options['tabs'] : [];
  const pluginTabs = tabs.filter((t) => typeof t === 'object' && t !== null && (t as Record<string, unknown>)['render'] === 'plugin').length;
  return { actions, tabs: tabs.length, pluginTabs };
}

/**
 * The overall cap on one conformance run, derived from garden's per-load bound so the two never
 * disagree. Per editor (garden scripts/editor/conformance.py):
 *  - host-page loads, each allowed the whole bound: 2 (the cases, then the hash-pinned reload); for an
 *    editor that speaks protocol 2, 1 more for the card (full screen reuses it) and 1 per plugin-rendered
 *    options tab (at least 1 when it declares options);
 *  - the cases' fixed waits (~30 s), plus the behaviour cases' own deadlines (25 s: case 18 reads within 3 s, re-reads
 *    within 3 s, shows the change within 3 s and settles up to 4 s; case 7's save readies within 2 s, lands within
 *    5 s and is watched 1.5 s more; with polling margin), plus each sequential answer the host allows up to 2 s:
 *    every card action, every options tab, and the two full-screen mode changes;
 * plus 60 s for the browser start. One protocol-2 editor with no surfaces, at the default 120 s:
 * 60 + (55 + 2 x 2) + 3 x 120 = 479 s. A fixed 240 s cap killed a correct install at 249 s.
 *
 * A run plugin (CS7 C4) counts as 3 host-page loads (the cases, the replay remount, the hash-pinned reload) plus
 * 20 s of fixed waits (r1's 3 s handshake, r3/r4's live/replay windows).
 */
export const RUN_PLUGIN_FIXED_WAITS_S = 20;
export const RUN_PLUGIN_LOADS = 3;
export function conformanceCapMs(editors: readonly Record<string, unknown>[], loadS: number, plugins: readonly Record<string, unknown>[] = []): number {
  const list = editors.length > 0 || plugins.length > 0 ? editors : [{}];
  let seconds = 60;
  for (const e of list) {
    const speaks2 = requiredCases(e).length > CONFORMANCE_CASES.length;
    const c = surfaceCounts(e);
    const loads = 2 + (speaks2 ? 1 + (c.tabs > 0 ? Math.max(1, c.pluginTabs) : 0) : 0);
    const answers = speaks2 ? c.actions + c.tabs + 2 : 0;
    seconds += CONFORMANCE_FIXED_WAITS_S + 2 * answers + loads * loadS;
  }
  seconds += plugins.length * (RUN_PLUGIN_FIXED_WAITS_S + RUN_PLUGIN_LOADS * loadS);
  return Math.round(seconds * 1000);
}

/** The cases a conformance run must report passing for every editor (garden's runner: 0-12 and 18; wicked-core's
 *  editor_conformance `CASES` is the same list). 7 and 18 are behaviour (G9b): `7-edit`, an editor that asks
 *  `artifact.write` saves an edit through its own UI (its `data-wicked-save` control lands one version; a viewer
 *  passes), and `18-shows`, it asks `artifact.read`, shows the content it is handed and reads again when another
 *  version lands. A garden runner before them reports neither, so every install is refused (fail closed) until
 *  garden carries them. */
export const CONFORMANCE_CASES = ['0-manifest', '1-handshake', '2-sizes', '3-no-network', '4-permissions', '5-typing', '6-forwarding', '7-edit', '8-strict-input', '9-liveness', '10-keyboard', '11-theme', '12-hash-pinned', '18-shows'] as const;
/** The protocol-2 cases an editor whose `protocol` lists 2 must also pass (DES-EDITOR-PLUGIN-CONTRACT-001 §8.3):
 *  its surfaces, card, options and full screen. A garden runner before them reports none, so such an editor is
 *  refused (fail closed). Case 17 (protocol-1 compatibility) restates cases 1-12, so it is not required. */
export const CONFORMANCE_CASES_V2 = ['13-surfaces', '14-card', '15-options', '16-full'] as const;

/** The cases one editor's install requires, by the protocols its manifest entry lists. */
export function requiredCases(entry: Record<string, unknown>): string[] {
  const protocol = entry['protocol'];
  const speaks2 = Array.isArray(protocol) && protocol.includes(2);
  return [...CONFORMANCE_CASES, ...(speaks2 ? CONFORMANCE_CASES_V2 : [])];
}

/**
 * Garden's conformance runner as a child: `python3 <garden>/scripts/editor/conformance.py --pack <root>
 * --host-url <this daemon> --json`. A missing garden or runner, no daemon URL, no browser, or an
 * unreadable report is a FAILED run with the reason — never a pass.
 */
export function gardenConformance(
  gardenRoot: string | null,
  hostUrl: () => string | null,
  deps: { env?: NodeJS.ProcessEnv; exec?: typeof execCapped; provision?: ConformanceProvisioner } = {},
): ConformanceRunner {
  const failed = (error: string): EditorConformanceSummary => ({ ok: false, at: new Date().toISOString(), editors: [], error });
  const exec = deps.exec ?? execCapped;
  return async (packRoot, editors = [], plugins = []) => {
    if (gardenRoot === null) return failed('no wicked-garden plugin found to run the editor conformance cases');
    const script = join(gardenRoot, 'scripts', 'editor', 'conformance.py');
    if (!existsSync(script)) return failed('this wicked-garden has no scripts/editor/conformance.py (needs the release with the editor-scaffold skill)');
    const host = hostUrl();
    if (host === null) return failed('this daemon does not know its own URL to serve the conformance host page');
    const args = [script, '--pack', packRoot, '--host-url', host, '--json'];
    // garden's runner gets the very bound the cap was sized from (any spelling of the env var it would
    // read differently, e.g. non-ASCII digits, cannot make the two disagree — codex r2).
    const loadS = conformanceLoadSeconds(deps.env);
    // The same browser-cache resolution the provisioner installed under (absolute cache variables only).
    const childEnv: NodeJS.ProcessEnv = { ...absoluteCacheEnv(deps.env ?? process.env), [CONFORMANCE_TIMEOUT_ENV]: String(loadS) };
    const runWith = async (bins: readonly string[]): Promise<EditorConformanceSummary> => {
      let stdout = '';
      for (const bin of bins) {
        try {
          stdout = (await exec(bin, args, { timeout: conformanceCapMs(editors, loadS, plugins), windowsHide: true, env: childEnv })).stdout;
          break;
        } catch (err) {
          const e = err as NodeJS.ErrnoException & { stdout?: string };
          if (e.code === 'ENOENT') continue;
          // A failing run exits 1 (a case failed) or 3 (no browser) with the JSON report on stdout.
          if (typeof e.stdout === 'string' && e.stdout.trim() !== '') {
            stdout = e.stdout;
            break;
          }
          return failed(`the conformance run did not finish: ${e.message}`);
        }
      }
      if (stdout === '') return failed('no python interpreter found (python3 / python)');
      return parseConformanceReport(stdout) ?? failed('the conformance run printed no readable report');
    };
    const first = await runWith(['python3', 'python']);
    // B8: no browser runtime on this host. Crew provisions its own (a private venv with Playwright and
    // its Chromium) and runs the cases again under it; a host where it cannot says what to run.
    if (first.editors.length > 0 || (first.plugins?.length ?? 0) > 0 || deps.provision === undefined || !needsBrowserRuntime(first.error)) return first;
    const provisioned = await deps.provision();
    if (!provisioned.ok) return failed(`${first.error ?? 'no headless browser'} — ${provisioned.error}`);
    return runWith([provisioned.python]);
  };
}

/** One `editors[]` / `plugins[]` row of garden's `--json` report. */
type ConformanceRow = EditorConformanceSummary['editors'][number];
function parseRows(list: unknown): ConformanceRow[] {
  return Array.isArray(list)
    ? list.flatMap((e) => {
        if (typeof e !== 'object' || e === null) return [];
        const r = e as { id?: unknown; version?: unknown; sha256?: unknown; ok?: unknown; cases?: unknown; gaps?: unknown };
        const cases: Record<string, { ok: boolean }> = {};
        if (typeof r.cases === 'object' && r.cases !== null) {
          for (const [k, v] of Object.entries(r.cases)) cases[k] = { ok: typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === true };
        }
        const gaps = Array.isArray(r.gaps) ? r.gaps.filter((g): g is string => typeof g === 'string') : [];
        return [{ id: String(r.id), version: typeof r.version === 'string' ? r.version : '', sha256: typeof r.sha256 === 'string' ? r.sha256 : '', ok: r.ok === true, cases, gaps }];
      })
    : [];
}

/** garden's `--json` report, or `null` when it is not one. Its top-level `plugins` array (CS7 C5) carries the
 *  run plugins' rows, the same shape as `editors`. */
function parseConformanceReport(stdout: string): EditorConformanceSummary | null {
  try {
    const raw = JSON.parse(stdout) as { ok?: unknown; error?: unknown; editors?: unknown; plugins?: unknown };
    const plugins = parseRows(raw.plugins);
    return {
      ok: raw.ok === true,
      at: new Date().toISOString(),
      editors: parseRows(raw.editors),
      ...(plugins.length > 0 ? { plugins } : {}),
      ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
    };
  } catch {
    return null;
  }
}

interface ParsedPack {
  root: string;
  manifest: Record<string, unknown>;
  editors: Array<Record<string, unknown>>;
  plugins: Array<Record<string, unknown>>;
  blocks: Array<Record<string, unknown>>;
  skills: string[];
}

async function readCheckedPack(packRootRaw: string, check: PackCheckRunner): Promise<{ pack: ParsedPack; verdict: PackCheckResult }> {
  if (typeof packRootRaw !== 'string' || packRootRaw.trim() === '' || !isAbsolute(packRootRaw)) {
    throw new PackInstallError(400, '`packRoot` must be an absolute path to a directory holding wicked-pack.json');
  }
  const packRoot = resolve(packRootRaw);
  let isDir = false;
  try {
    isDir = statSync(packRoot).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new PackInstallError(404, `no directory at ${packRoot}`);
  const manifestPath = join(packRoot, 'wicked-pack.json');
  if (!existsSync(manifestPath)) throw new PackInstallError(400, `${packRoot} holds no wicked-pack.json`);
  // Garden's gate first (fail closed): a refused manifest never gets as far as a listing.
  const verdict = await check(packRoot);
  if (!verdict.ok) {
    throw new PackInstallError(422, `wicked-garden pack check refused the pack (${verdict.errors.length} error${verdict.errors.length === 1 ? '' : 's'})`, verdict);
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new PackInstallError(400, `wicked-pack.json is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const editors = Array.isArray(manifest['editors']) ? (manifest['editors'] as Array<Record<string, unknown>>) : [];
  const plugins = Array.isArray(manifest['plugins']) ? (manifest['plugins'] as Array<Record<string, unknown>>) : [];
  if (manifest['spec'] !== 2 || (editors.length === 0 && plugins.length === 0)) {
    throw new PackInstallError(400, 'the pack declares no editors and no run plugins (spec 2 `editors[]` / `plugins[]`); there is nothing to install here');
  }
  const blocks = Array.isArray(manifest['blocks']) ? (manifest['blocks'] as Array<Record<string, unknown>>) : [];
  const skillsDir = typeof manifest['skills_dir'] === 'string' ? manifest['skills_dir'] : 'skills';
  let skills: string[] = [];
  try {
    const dir = join(packRoot, skillsDir);
    if (statSync(dir).isDirectory()) skills = readdirSync(dir).filter((n) => !n.startsWith('.')).sort();
  } catch {
    skills = [];
  }
  return { pack: { root: packRoot, manifest, editors, plugins, blocks, skills }, verdict };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** The approval list a pack with skills or blocks would need (§3.2): the 501 body. */
function approvalList(pack: ParsedPack, verdict: PackCheckResult): InstallEditorRefusal {
  const m = pack.manifest;
  return {
    code: 'pack_ships_skills_or_blocks',
    error:
      'this pack also ships skills or blocks, and their own approval step (DES-artifact-editor-plugins §3.2 ' +
      '"Add these") is not built yet, so it cannot be installed. An editor-only pack can be. ' +
      'This is what the install would ask you to approve.',
    check: verdict,
    pack: {
      name: str(m['name']),
      vendor: str(m['vendor']),
      version: str(m['version']),
      editors: pack.editors.map((e) => ({
        id: str(e['id']),
        title: str(e['title']),
        version: str(e['version']),
        kinds: strs(e['kinds']),
        permissions: Array.isArray(e['permissions'])
          ? (e['permissions'] as Array<Record<string, unknown>>).map((p) => ({ id: str(p['id']), why: str(p['why']) }))
          : [],
      })),
      blocks: pack.blocks.map((b) => ({ id: str(b['id']), label: str(b['label']), produces_kind: str(b['produces_kind']), skills: strs(b['skills']) })),
      skills: pack.skills,
    },
  };
}

/** The admitted manifest entry's digest, over the same parse the registry reads it back with. */
function digestOf(entry: Record<string, unknown>): string {
  const parsed = PackEditorSchema.safeParse(entry);
  if (!parsed.success) throw new PackInstallError(400, `editor ${str(entry['id'])}: manifest entry refused (${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')})`);
  return editorEntryDigest(parsed.data);
}

/** A run plugin's admitted manifest entry digest (CS7), over the same parse {@link readPackPlugin} reads it with. */
function digestOfPlugin(entry: Record<string, unknown>): string {
  const parsed = PluginManifestSchema.safeParse(entry);
  if (!parsed.success) throw new PackInstallError(400, `plugin ${str(entry['id'])}: manifest entry refused (${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')})`);
  return editorEntryDigest(parsed.data);
}

/** `POST /editors {packRoot, enabled?}`: the gate, the conformance run, then the registry. */
export async function installPack(
  packRootRaw: string,
  enabled: boolean | undefined,
  deps: { check: PackCheckRunner; conformance: ConformanceRunner; registry: EditorRegistry },
): Promise<InstallEditorResponse> {
  const { pack, verdict } = await readCheckedPack(packRootRaw, deps.check);
  if (pack.blocks.length > 0 || pack.skills.length > 0) {
    throw new PackInstallError(501, 'the pack ships skills or blocks', verdict, approvalList(pack, verdict) as unknown as Record<string, unknown>);
  }
  const name = str(pack.manifest['name']);
  const ids = [...pack.editors, ...pack.plugins].map((e) => str(e['id']));
  for (const id of ids) {
    if (deps.registry.get(id)?.firstParty === true) throw new PackInstallError(409, `${id} is a first-party editor's id`, verdict);
  }
  const conformance = await deps.conformance(pack.root, pack.editors, pack.plugins);
  // The report counts only for the bytes being installed (codex r1): the run's own version and entry
  // hash must be the manifest's, which the registry then re-reads at that same hash. A run plugin (CS7 C5) is
  // matched the same way against the report's `plugins[]` array, on the run-plugin cases.
  const missing = (e: Record<string, unknown>, rows: readonly EditorConformanceSummary['editors'][number][], cases: readonly string[]): string[] => {
    const r = rows.find((x) => x.id === str(e['id']));
    if (r === undefined) return ['not in the report'];
    if (r.sha256 !== str(e['sha256']) || r.version !== str(e['version'])) return [`ran against ${r.version || '?'}#${(r.sha256 || '?').slice(0, 12)}, not this entry`];
    return cases.filter((c) => r.cases[c]?.ok !== true);
  };
  const failures = [
    ...pack.editors.map((e) => ({ id: str(e['id']), missing: missing(e, conformance.editors, requiredCases(e)) })),
    ...pack.plugins.map((p) => ({ id: str(p['id']), missing: missing(p, conformance.plugins ?? [], RUN_PLUGIN_CASES) })),
  ].filter((f) => f.missing.length > 0);
  if (!conformance.ok || failures.length > 0) {
    const unavailable = conformance.editors.length === 0 && (conformance.plugins?.length ?? 0) === 0;
    throw new PackInstallError(
      422,
      unavailable
        ? `the conformance run could not run, so nothing was installed: ${conformance.error ?? 'no report'}`
        : `the editor failed its conformance run (${failures.map((f) => `${f.id}: ${f.missing.join(', ')}`).join('; ')}); nothing was installed`,
      verdict,
      { code: unavailable ? 'conformance_unavailable' : 'editor_not_conformant', conformance },
    );
  }
  const now = new Date().toISOString();
  const editorPacks = pack.editors.map((e) => {
    const record: InstalledPack = {
      kind: 'editor',
      root: pack.root,
      name,
      entry: str(e['entry']),
      sha256: str(e['sha256']),
      manifestSha256: digestOf(e),
      installedAt: now,
      conformance: { ok: true, at: conformance.at, cases: requiredCases(e) },
    };
    return { id: str(e['id']), pack: record };
  });
  const pluginPacks = pack.plugins.map((p) => {
    const record: InstalledPack = {
      kind: 'plugin',
      root: pack.root,
      name,
      entry: str(p['entry']),
      sha256: str(p['sha256']),
      manifestSha256: digestOfPlugin(p),
      installedAt: now,
      conformance: { ok: true, at: conformance.at, cases: [...RUN_PLUGIN_CASES] },
    };
    return { id: str(p['id']), pack: record };
  });
  const packs = [...editorPacks, ...pluginPacks];
  let installed: ReturnType<EditorRegistry['installPack']>;
  try {
    installed = deps.registry.installPack(packs, enabled);
  } catch (err) {
    if (err instanceof EditorInstallConflict) throw new PackInstallError(409, err.message, verdict);
    throw err;
  }
  return {
    installed: true,
    updated: installed.updated,
    editors: installed.records.map((r) => EditorRegistry.view(r)),
    check: verdict,
    conformance,
  };
}
