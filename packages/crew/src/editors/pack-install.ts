/**
 * A pack install (DES-artifact-editor-plugins §3.2, §5.2, §9.2, §12.1; EP-C1 + the install-time
 * conformance run of EP-C8, operator ruling X3).
 *
 * Install is human-only (§6.4) and fail closed at every step, in this order:
 *  1. garden's `pack check --json` on the pack root (schema, every editor's entry inside the pack, its
 *     hash, its size, nothing loaded from outside);
 *  2. the pack ships editors only: one that also ships skills or blocks is refused with the approval
 *     list (501 `pack_ships_skills_or_blocks`), since their own "Add these" step (§3.2) is not built;
 *  3. the **conformance run**, done by crew itself: garden's `scripts/editor/conformance.py --pack
 *     <root> --host-url <this daemon>` drives studio's conformance host page (served by this daemon)
 *     in headless Chromium against each editor. A failed case, no browser or no runner is a 422 with
 *     the report — an unverified editor is never installed. Only crew's run counts (§12.1, review S13);
 *     an author's own run is not consulted;
 *  4. the registry reads every editor back from disk at its pinned hash and records it.
 * Nothing is written into the pack. The registry file is `daemon-editors.json`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type { EditorConformanceSummary, InstallEditorRefusal, InstallEditorResponse, PackCheckResult } from '../core/types.js';
import { execCapped } from '../core/exec.js';
import { EditorInstallConflict, EditorRegistry, type InstalledPack } from './registry.js';

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

/** The install-time conformance run: the pack root in, garden's report out. */
export type ConformanceRunner = (packRoot: string) => Promise<EditorConformanceSummary>;

/** The cases a conformance run must report passing for every editor (garden's runner: 0-6 and 8-12). */
export const CONFORMANCE_CASES = ['0-manifest', '1-handshake', '2-sizes', '3-no-network', '4-permissions', '5-typing', '6-forwarding', '8-strict-input', '9-liveness', '10-keyboard', '11-theme', '12-hash-pinned'] as const;

/**
 * Garden's conformance runner as a child: `python3 <garden>/scripts/editor/conformance.py --pack <root>
 * --host-url <this daemon> --json`. A missing garden or runner, no daemon URL, no browser, or an
 * unreadable report is a FAILED run with the reason — never a pass.
 */
export function gardenConformance(gardenRoot: string | null, hostUrl: () => string | null): ConformanceRunner {
  const failed = (error: string): EditorConformanceSummary => ({ ok: false, at: new Date().toISOString(), editors: [], error });
  return async (packRoot) => {
    if (gardenRoot === null) return failed('no wicked-garden plugin found to run the editor conformance cases');
    const script = join(gardenRoot, 'scripts', 'editor', 'conformance.py');
    if (!existsSync(script)) return failed('this wicked-garden has no scripts/editor/conformance.py (needs the release with the editor-scaffold skill)');
    const host = hostUrl();
    if (host === null) return failed('this daemon does not know its own URL to serve the conformance host page');
    const args = [script, '--pack', packRoot, '--host-url', host, '--json'];
    let stdout = '';
    for (const bin of ['python3', 'python']) {
      try {
        stdout = (await execCapped(bin, args, { timeout: 240_000, windowsHide: true })).stdout;
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
    try {
      const raw = JSON.parse(stdout) as { ok?: unknown; error?: unknown; editors?: unknown };
      const editors = Array.isArray(raw.editors)
        ? raw.editors.flatMap((e) => {
            if (typeof e !== 'object' || e === null) return [];
            const r = e as { id?: unknown; ok?: unknown; cases?: unknown; gaps?: unknown };
            const cases: Record<string, { ok: boolean }> = {};
            if (typeof r.cases === 'object' && r.cases !== null) {
              for (const [k, v] of Object.entries(r.cases)) cases[k] = { ok: typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === true };
            }
            const gaps = Array.isArray(r.gaps) ? r.gaps.filter((g): g is string => typeof g === 'string') : [];
            return [{ id: String(r.id), ok: r.ok === true, cases, gaps }];
          })
        : [];
      return {
        ok: raw.ok === true,
        at: new Date().toISOString(),
        editors,
        ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
      };
    } catch {
      return failed('the conformance run printed no readable report');
    }
  };
}

interface ParsedPack {
  root: string;
  manifest: Record<string, unknown>;
  editors: Array<Record<string, unknown>>;
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
  if (manifest['spec'] !== 2 || editors.length === 0) {
    throw new PackInstallError(400, 'the pack declares no editors (spec 2 `editors[]`); there is nothing to install here');
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
  return { pack: { root: packRoot, manifest, editors, blocks, skills }, verdict };
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
  const ids = pack.editors.map((e) => str(e['id']));
  for (const id of ids) {
    if (deps.registry.get(id)?.firstParty === true) throw new PackInstallError(409, `${id} is a first-party editor's id`, verdict);
  }
  const conformance = await deps.conformance(pack.root);
  const missing = (r: EditorConformanceSummary['editors'][number] | undefined): string[] =>
    CONFORMANCE_CASES.filter((c) => r?.cases[c]?.ok !== true);
  const failures = ids.map((id) => ({ id, missing: missing(conformance.editors.find((e) => e.id === id)) })).filter((f) => f.missing.length > 0);
  if (!conformance.ok || failures.length > 0) {
    const unavailable = conformance.editors.length === 0;
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
  const packs = pack.editors.map((e) => {
    const entry = str(e['entry']);
    const record: InstalledPack = {
      root: pack.root,
      name,
      entry,
      sha256: str(e['sha256']),
      installedAt: now,
      conformance: { ok: true, at: conformance.at, cases: [...CONFORMANCE_CASES] },
    };
    return { id: str(e['id']), pack: record };
  });
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
