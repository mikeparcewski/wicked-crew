/**
 * A pack install, as far as it goes before EP-C8 (DES-artifact-editor-plugins §5.2, §9.2; EP-C1).
 *
 * Install is human-only (§6.4) and runs garden's fail-closed gate FIRST: `pack check --json` on the
 * pack root (schema, every editor's entry inside the pack, its hash, its size, nothing loaded from
 * outside). Then crew reads the spec-2 manifest and lists what the operator would be asked to
 * approve — the editors, the blocks and the pack's skills (§3.2 "Add these") — and REFUSES with 501
 * `third_party_editors_not_available`: an unverified editor must pass the install-time conformance
 * run (cases 1-12 against the bundle, headless Chrome) before it may be installed, and that run is
 * EP-C8. Nothing is written. The refusal carries the check verdict and the approval list, so the
 * operator sees exactly what will be asked once installs open.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type { InstallEditorRefusal, PackCheckResult } from '../core/types.js';
import { execCapped } from '../core/exec.js';

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
    readonly status: 400 | 404 | 422,
    message: string,
    readonly check?: PackCheckResult,
  ) {
    super(message);
    this.name = 'PackInstallError';
  }
}

/** What `POST /editors` reads of a pack before refusing: the approval list (§3.2). */
export async function previewPackInstall(packRootRaw: string, check: PackCheckRunner): Promise<InstallEditorRefusal> {
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
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return {
    code: 'third_party_editors_not_available',
    error:
      'third-party editors cannot be installed yet: the install-time conformance run (DES-artifact-editor-plugins EP-C8) ' +
      'has not shipped, and an unverified editor is never installed. The pack passed wicked-garden `pack check`; ' +
      'this is what the install would ask you to approve.',
    check: verdict,
    pack: {
      name: str(manifest['name']),
      vendor: str(manifest['vendor']),
      version: str(manifest['version']),
      editors: editors.map((e) => ({
        id: str(e['id']),
        title: str(e['title']),
        version: str(e['version']),
        kinds: strs(e['kinds']),
        permissions: Array.isArray(e['permissions'])
          ? (e['permissions'] as Array<Record<string, unknown>>).map((p) => ({ id: str(p['id']), why: str(p['why']) }))
          : [],
      })),
      blocks: blocks.map((b) => ({ id: str(b['id']), label: str(b['label']), produces_kind: str(b['produces_kind']), skills: strs(b['skills']) })),
      skills,
    },
  };
}
