/**
 * A pack install (DES-artifact-editor-plugins §3.2, §5.2, §9.2, §12.1; EP-C1 + the install-time
 * conformance run of EP-C8, operator ruling X3).
 *
 * Install is human-only (§6.4) and fail closed at every step, in this order:
 *  1. garden's `pack check --json` on the pack root (schema, every editor's and run plugin's entry inside the
 *     pack, its hash, its size, nothing loaded from outside);
 *  2. a pack that also ships skills or blocks (crew#1703, §3.2 "Add these") needs the person's approval of exactly
 *     its list (409 `pack_needs_approval` / `pack_approval_mismatch` with the list otherwise), and every skill and
 *     block is read and checked (`pack-extras.ts`) before anything runs;
 *  3. the **conformance run**, through the engine's jailed garden harness: its browser can reach
 *     only the engine's own loopback port and writes stay in a private temp directory. Crew provisions
 *     its private Playwright venv first (`conformance-runtime.ts`, B8). A failed case, a browser that
 *     cannot be provisioned or no jailed runner is a 422 with the report — an unverified editor is
 *     never installed. Only crew's run counts (§12.1, review S13); an author's own run is not consulted;
 *  4. the registry's own checks; then the blocks become presets (each keeps the version it replaced); then the
 *     registry reads every editor back from disk at its pinned hash and records it with the pack's skills and
 *     presets (a failed record puts the presets back, and no skill has been written yet); then the skills go into
 *     the daemon skills root in one pass (a failed write puts back the ones replaced and switches off the ones
 *     added); then the skills root is published so workers get them (a blocked publish does the same and says so).
 * Nothing is written into the pack. The registry file is `daemon-editors.json`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { Core } from 'wicked-core-ts';

import type { EditorConformanceSummary, InstallEditorRefusal, InstallEditorResponse, PackCheckResult } from '../core/types.js';
import { execCapped } from '../core/exec.js';
import { EditorInstallConflict, EditorRegistry, PackEditorSchema, PluginManifestSchema, RUN_PLUGIN_CASES, editorEntryDigest, packEditorDigest, type InstalledPack } from './registry.js';
import type { ConformanceProvisioner } from './conformance-runtime.js';
import { approvalDiff, installedSkillsOf, PackExtrasRefusal, packSkillOrigin, planExtras, withdrawPackExtras, writePresets, writeSkills, type ExtrasPlan, type PackApproval, type PackPresetsPort, type PackSkillsPort } from './pack-extras.js';

export type { PackApproval, PackPresetsPort, PackSkillsPort } from './pack-extras.js';

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
    readonly status: 400 | 404 | 409 | 422,
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
 * The engine's jailed conformance harness. An addon without the binding, a host refusal, or an
 * unreadable report is a FAILED run with the reason — never a pass or an unjailed fallback.
 */
export function engineConformance(
  deps: { run?: (requestJson: string) => Promise<string>; provision?: ConformanceProvisioner; env?: NodeJS.ProcessEnv } = {},
): ConformanceRunner {
  const failed = (error: string): EditorConformanceSummary => ({ ok: false, at: new Date().toISOString(), editors: [], error });
  return async (packRoot, editors = [], plugins = []) => {
    const run = deps.run ?? (Core as unknown as { runEditorConformance?: (j: string) => Promise<string> }).runEditorConformance;
    if (typeof run !== 'function') return failed('this engine has no jailed conformance run; update wicked-core-ts');
    let result: string;
    try {
      if (deps.provision !== undefined) {
        const provisioned = await deps.provision();
        if (!provisioned.ok) return failed(provisioned.error);
      }
      const timeoutS = Math.min(900, Math.ceil(conformanceCapMs(editors, conformanceLoadSeconds(deps.env), plugins) / 1000));
      result = await run.call(Core, JSON.stringify({ packRoot, timeoutS }));
    } catch (err) {
      return failed(err instanceof Error ? err.message : String(err));
    }
    try {
      const response = JSON.parse(result) as { record?: { outcome?: string; cause?: string; reason?: string }; report?: unknown } | null;
      const record = response?.record;
      // The engine's refusal (or a run with no rows) says why in its record: cause, then reason.
      const why = (fallback: string): string => `${record?.cause ?? 'no_report'}: ${record?.reason ?? fallback}`;
      if (record?.outcome === 'refused') return failed(why('the engine refused the run'));
      const summary = parseConformanceReport(JSON.stringify(response?.report ?? null));
      if (summary === null) return failed('the conformance run produced no readable report');
      if (summary.editors.length === 0 && (summary.plugins?.length ?? 0) === 0) return failed(why(summary.error ?? 'the report named no editor or plugin'));
      return summary;
    } catch {
      return failed('the conformance run produced no readable report');
    }
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
    if (typeof raw !== 'object' || raw === null || typeof raw.ok !== 'boolean') return null;
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
  /** The manifest's own text, as read (the consent digest covers it). */
  manifestText: string;
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
  let manifestText = '';
  try {
    manifestText = readFileSync(manifestPath, 'utf8');
    manifest = JSON.parse(manifestText) as Record<string, unknown>;
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
  return { pack: { root: packRoot, manifestText, manifest, editors, plugins, blocks, skills }, verdict };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** The approval list a pack with skills or blocks needs (§3.2; crew#1703): the 409 body. Its `error` is what the
 *  person installing reads (garden's installer prints it), so it says what to do, in plain words. */
function approvalList(pack: ParsedPack, verdict: PackCheckResult, code: 'pack_needs_approval' | 'pack_approval_mismatch', why: string, plan: ExtrasPlan): InstallEditorRefusal {
  const m = pack.manifest;
  return {
    code,
    error: why,
    check: verdict,
    digest: plan.digest,
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
      installedSkills: installedSkillsOf(pack.skills),
      // Its run plugins and the topics each asks to hear: the install grants them, so the consent lists them.
      plugins: pack.plugins.map((p) => ({
        id: str(p['id']),
        title: str(p['title']),
        version: str(p['version']),
        observe: Array.isArray(p['observe'])
          ? (p['observe'] as Array<Record<string, unknown>>).map((o) => ({ topic: str(o['topic']), why: str(o['why']) }))
          : [],
      })),
      replaces: plan.replaces,
    },
  };
}

/** The admitted manifest entry's digest, over the same parse and the same digest the registry reads it back with. */
function digestOf(entry: Record<string, unknown>): string {
  const parsed = PackEditorSchema.safeParse(entry);
  if (!parsed.success) throw new PackInstallError(400, `editor ${str(entry['id'])}: manifest entry refused (${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')})`);
  return packEditorDigest(parsed.data);
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
  deps: { check: PackCheckRunner; conformance: ConformanceRunner; registry: EditorRegistry; skills?: PackSkillsPort | null; presets?: PackPresetsPort | null },
  approve?: PackApproval,
): Promise<InstallEditorResponse> {
  const { pack, verdict } = await readCheckedPack(packRootRaw, deps.check);
  const name = str(pack.manifest['name']);
  const blockIds = pack.blocks.map((b) => str(b['id']));
  const extras = pack.blocks.length > 0 || pack.skills.length > 0;
  const ids = [...pack.editors, ...pack.plugins].map((e) => str(e['id']));
  for (const id of ids) {
    if (deps.registry.get(id)?.firstParty === true) throw new PackInstallError(409, `${id} is a first-party editor's id`, verdict);
  }
  // What an earlier install of this same pack added (every persisted record, one skipped at boot included, and what
  // the registry kept after the pack's last editor was removed): an update replaces those in place.
  const earlier = deps.registry.packExtrasOwned(name);
  const owned = {
    skills: new Set(earlier.skills.map((k) => k.key)),
    presets: new Set(earlier.presets),
  };
  // Every skill and block is read and checked before the consent is asked for or anything runs: the consent's digest
  // covers what was read, and a pack that would be refused anyway is refused now.
  let plan: ExtrasPlan = { skills: [], blocks: [], replaces: [], digest: '' };
  if (extras) {
    try {
      plan = await planExtras({ root: pack.root, manifestText: pack.manifestText, manifest: pack.manifest, packName: name, skills: pack.skills, blocks: pack.blocks, skillsPort: deps.skills ?? null, presetsPort: deps.presets ?? null, owned });
    } catch (err) {
      if (err instanceof PackExtrasRefusal) throw new PackInstallError(err.status, err.message, verdict, { code: err.code });
      throw err;
    }
    if (approve === undefined) {
      const why =
        'This pack also brings its own skills or blocks. Nothing was installed: approve them together with the editors’ permissions ' +
        '(install again with `approve` listing exactly these skills and blocks, and this digest to bind them to what was shown).';
      throw new PackInstallError(409, why, verdict, approvalList(pack, verdict, 'pack_needs_approval', why, plan) as unknown as Record<string, unknown>);
    }
  }
  if (approve !== undefined) {
    const diff = approvalDiff(approve, pack.skills, blockIds);
    // The digest binds the approval to the bytes the person was shown (studio's consent sends it). A caller that binds
    // the content itself sends none: garden's installer stages the pack from one read and refuses a change after its
    // own plan (wicked-garden scripts/editor/install.py, `pack_inventory` and `plan_digest`).
    if (extras && approve.digest !== undefined && approve.digest !== plan.digest) diff.push('the pack changed since it was shown (its digest differs)');
    if (diff.length > 0) {
      const why = `The approval is not this pack’s list (${diff.join('; ')}), so nothing was installed.`;
      throw new PackInstallError(409, why, verdict, approvalList(pack, verdict, 'pack_approval_mismatch', why, plan) as unknown as Record<string, unknown>);
    }
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
  // The record names only skills the skills root holds (a new one is named once it is written, below) and the presets
  // this install writes. What an earlier version added and this one no longer ships is withdrawn after the write.
  const packSkills = plan.skills.filter((k) => k.own).map((k) => ({ name: k.name, key: k.key }));
  const packPresets = plan.blocks.map((b) => b.id);
  const droppedSkills = earlier.skills.filter((k) => !plan.skills.some((s) => s.key === k.key));
  const droppedPresets = earlier.presets.filter((id) => !plan.blocks.some((b) => b.id === id));
  const extrasRecord = {
    ...(packSkills.length > 0 ? { skills: packSkills } : {}),
    ...(packPresets.length > 0 ? { presets: packPresets } : {}),
  };
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
      ...extrasRecord,
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
      ...extrasRecord,
    };
    return { id: str(p['id']), pack: record };
  });
  const packs = [...editorPacks, ...pluginPacks];
  // The registry's own checks first (an id another pack holds, an editor that does not read back), so a conflict
  // writes nothing; then the presets, then the record (a failed record puts the presets back), then the skills, which
  // are published for workers last.
  try {
    deps.registry.preflight(packs);
  } catch (err) {
    if (err instanceof EditorInstallConflict) throw new PackInstallError(409, err.message, verdict);
    throw err;
  }
  let presetsWritten: Awaited<ReturnType<typeof writePresets>>;
  try {
    presetsWritten = await writePresets(plan, deps.presets ?? null, name);
  } catch (err) {
    if (err instanceof PackExtrasRefusal) throw new PackInstallError(err.status, err.message, verdict, { code: err.code });
    throw err;
  }
  let installed: ReturnType<EditorRegistry['installPack']>;
  try {
    installed = deps.registry.installPack(packs, enabled, { skills: earlier.skills, presets: [...new Set([...earlier.presets, ...packPresets])] });
  } catch (err) {
    const undone = await presetsWritten.undo();
    // A preset that could not be put back is said, not swallowed: the next install of this pack sees its own stamp
    // on it (`pack:<name>`) and replaces it, so a retry finishes the job.
    const left = undone.length > 0 ? ` (putting the presets back also failed: ${undone.join('; ')}; installing the pack again replaces them)` : '';
    if (err instanceof EditorInstallConflict) throw new PackInstallError(409, `${err.message}${left}`, verdict);
    if (left !== '' && err instanceof Error) err.message = `${err.message}${left}`;
    throw err;
  }
  let skillsError = await writeSkills(plan, deps.skills ?? null, { origin: packSkillOrigin(name) });
  // What an earlier version of the pack added and this one dropped is switched off (skills) or deleted (presets
  // still carrying the pack's stamp), and said.
  const withdrawn = droppedSkills.length > 0 || droppedPresets.length > 0
    ? await withdrawPackExtras({ packName: name, skills: droppedSkills.map((k) => k.key), presets: droppedPresets, skillsPort: deps.skills ?? null, presetsPort: deps.presets ?? null })
    : null;
  // The record now names the skills the root holds; the pack keeps every skill it ever added as its own, so a later
  // version can bring a withdrawn one back.
  const held = deps.skills && plan.skills.length > 0 ? deps.skills.store.manifest().skills : {};
  const current = plan.skills.filter((k) => Object.hasOwn(held, k.key)).map((k) => ({ name: k.name, key: k.key }));
  const ownedSkills = [...earlier.skills, ...current].filter((k, i, a) => a.findIndex((x) => x.key === k.key) === i);
  const ownedPresets = [...new Set([...earlier.presets, ...packPresets])].filter((id) => !(withdrawn?.presets.includes(id) ?? false));
  try {
    deps.registry.setPackExtras(name, { skills: current, presets: packPresets }, { skills: ownedSkills, presets: ownedPresets });
  } catch (err) {
    const why = `the install record could not name the pack’s skills (${err instanceof Error ? err.message : String(err)}); install the pack again`;
    skillsError = skillsError === null ? why : `${skillsError}; ${why}`;
  }
  const records = installed.records.map((r) => deps.registry.get(r.manifest.id) ?? r);
  return {
    ...(current.length > 0 ? { skills: current } : {}),
    ...(packPresets.length > 0 ? { presets: packPresets } : {}),
    ...(skillsError !== null ? { skillsError } : {}),
    ...(withdrawn !== null ? { withdrawn } : {}),
    installed: true,
    updated: installed.updated,
    editors: records.map((r) => EditorRegistry.view(r)),
    ...(installed.removed.length > 0 ? { removed: installed.removed } : {}),
    check: verdict,
    conformance,
  };
}
