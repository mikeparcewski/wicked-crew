/**
 * The artifact-editor registry (DES-artifact-editor-plugins §5.2, §8.6, §9.1; EP-C1).
 *
 * Two kinds of editor exist in the design; one exists today:
 *
 *  - **First-party** editors ship INSIDE studio's bundle (§8.6): `<studio dist>/editors/<id>/editor.json`
 *    beside the ONE self-contained `index.html` entry. Crew discovers them at boot, pins each entry's
 *    sha256 and byte size, and serves the entry through the hashed bundle route (`routes.ts`) with
 *    the §8.2 headers. Their ids are `wicked-*` — the reserved first-party namespace every pack is
 *    refused (garden `wicked-pack.schema.json`).
 *  - **Third-party** editors arrive as garden packs (spec 2 `editors[]`). Their install is REFUSED
 *    until the install-time conformance run ships (EP-C8, LATER): `pack-install.ts` still runs
 *    garden's fail-closed `pack check` and lists what the operator would be asked to approve, then
 *    answers 501. Nothing of a pack is ever written by this registry.
 *
 * Persisted state is ONE file, `<state home>/daemon-editors.json` — the enable/disable flags the
 * operator sets in Settings → Editors (§6.4, human-only). It sits under the `daemon-` prefix both
 * crew's state-home registry and the engine's worker fence already classify (crew#756), so no new
 * top-level entry is introduced; a pack install (EP-C8) will need a registered `editors/` subtree in
 * both repos first.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import type { EditorPermission, EditorView } from '../core/types.js';
import { crewStateHome } from '../projects/state-home.js';

/** The persisted flags file, under the registered `daemon-` prefix. */
export const EDITORS_STATE_FILENAME = 'daemon-editors.json';
/** Where first-party manifests live inside the studio bundle. */
export const STUDIO_EDITORS_DIRNAME = 'editors';
/** The host's bundle cap (§8.5); a pack's `limits.bundleBytes` may only be lower. */
export const HOST_BUNDLE_CAP_BYTES = 5 * 1024 * 1024;

export const EDITOR_PERMISSIONS = [
  'artifact.read',
  'artifact.write',
  'selection.chip',
  'composer.draft',
  'checks.read',
  'checks.contribute',
  'sources.read',
  'media.read',
  'artifact.export',
  'ui.fullscreen',
  'network.media',
] as const satisfies ReadonlyArray<EditorPermission>;

/** Editor ids: lowercase dash-words, ≤ 64 (garden's shape); first-party ones start with `wicked-`. */
export const EDITOR_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const FIRST_PARTY_ID = /^wicked-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
/** Anchored SemVer (garden's shape). */
export const EDITOR_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const KIND = /^[a-z][a-z0-9-]{1,40}$/u;

export const EditorManifestSchema = z.object({
  id: z.string().max(64).regex(EDITOR_ID),
  title: z.string().min(1).regex(/\S/u),
  version: z.string().regex(EDITOR_VERSION),
  protocol: z.array(z.number().int().min(1)).min(1),
  kinds: z.array(z.string().regex(KIND)).min(1),
  entry: z.string().regex(/\.html$/u).default('index.html'),
  sizes: z.array(z.enum(['inline', 'pane', 'full'])).refine((s) => s.includes('inline'), { message: "'inline' is required" }),
  panels: z.array(z.enum(['checks'])).optional(),
  permissions: z.array(z.object({ id: z.enum(EDITOR_PERMISSIONS), why: z.string().min(1) })),
  limits: z.object({ bundleBytes: z.number().int().min(1).max(HOST_BUNDLE_CAP_BYTES) }).optional(),
});
export type EditorManifest = z.infer<typeof EditorManifestSchema>;

export interface EditorRecord {
  manifest: EditorManifest;
  /** The full 64-hex sha256 of the entry file, pinned when the registry read it. */
  sha256: string;
  bytes: number;
  /** Absolute path of the entry file. Never on the wire. */
  entryPath: string;
  firstParty: boolean;
  source: 'studio-bundle';
  enabled: boolean;
}

export function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** The entry must be ONE self-contained file: nothing loaded from outside it (§5.2; the CSP would block it anyway). */
export function externalReferences(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<(script|link|iframe)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["']/giu)) {
    const tag = m[1]!.toLowerCase();
    const url = m[2]!.trim();
    if (tag === 'link' && !/\brel\s*=\s*["']?stylesheet/iu.test(m[0]!)) continue;
    if (/^(?:https?:)?\/\//iu.test(url) || /^[a-z][a-z0-9+.-]*:/iu.test(url) && !/^(?:data|blob|about):/iu.test(url)) {
      out.push(`${tag} ${url}`);
    }
  }
  return out;
}

/**
 * Read the first-party editors a studio bundle ships. A malformed manifest, a missing or oversized
 * entry, an entry with outside references, or a non-`wicked-*` id is skipped with a reason — never
 * served half-right.
 */
export function discoverStudioEditors(
  studioRoot: string,
  log?: (msg: string) => void,
): Array<Omit<EditorRecord, 'enabled'>> {
  const dir = join(studioRoot, STUDIO_EDITORS_DIRNAME);
  if (!existsSync(dir)) return [];
  const out: Array<Omit<EditorRecord, 'enabled'>> = [];
  for (const name of readdirSync(dir).sort()) {
    const manifestPath = join(dir, name, 'editor.json');
    if (!existsSync(manifestPath)) continue;
    let manifest: EditorManifest;
    try {
      const parsed = EditorManifestSchema.safeParse(JSON.parse(readFileSync(manifestPath, 'utf8')));
      if (!parsed.success) {
        log?.(`[editors] ${name}: manifest refused (${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')})`);
        continue;
      }
      manifest = parsed.data;
    } catch (err) {
      log?.(`[editors] ${name}: manifest unreadable (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    if (manifest.id !== name || !FIRST_PARTY_ID.test(manifest.id)) {
      log?.(`[editors] ${name}: a studio-bundle editor must be named wicked-* and live in a directory of its id (got ${manifest.id})`);
      continue;
    }
    if (manifest.entry.includes('/') || manifest.entry.includes('\\') || manifest.entry.startsWith('.')) {
      log?.(`[editors] ${manifest.id}: entry must be a file beside the manifest (got ${manifest.entry})`);
      continue;
    }
    const entryPath = join(dir, name, manifest.entry);
    let buf: Buffer;
    try {
      if (!statSync(entryPath).isFile()) throw new Error('not a file');
      buf = readFileSync(entryPath);
    } catch (err) {
      log?.(`[editors] ${manifest.id}: entry unreadable (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    const cap = manifest.limits?.bundleBytes ?? HOST_BUNDLE_CAP_BYTES;
    if (buf.byteLength > cap) {
      log?.(`[editors] ${manifest.id}: entry is ${buf.byteLength} bytes, over its ${cap}-byte cap`);
      continue;
    }
    const outside = externalReferences(buf.toString('utf8'));
    if (outside.length > 0) {
      log?.(`[editors] ${manifest.id}: entry loads from outside itself (${outside.slice(0, 3).join(', ')})`);
      continue;
    }
    out.push({ manifest, sha256: sha256Of(buf), bytes: buf.byteLength, entryPath, firstParty: true, source: 'studio-bundle' });
  }
  return out;
}

interface PersistedState {
  v: 1;
  enabled: Record<string, boolean>;
}

export class EditorRegistry {
  private readonly records = new Map<string, EditorRecord>();
  private readonly stateFile: string;
  private readonly log: (msg: string) => void;

  constructor(opts: { stateHome?: string; studioRoot?: string; log?: (msg: string) => void } = {}) {
    this.stateFile = join(opts.stateHome ?? crewStateHome(), EDITORS_STATE_FILENAME);
    this.log = opts.log ?? (() => undefined);
    const state = this.readState();
    if (opts.studioRoot !== undefined) {
      for (const r of discoverStudioEditors(opts.studioRoot, this.log)) {
        this.records.set(r.manifest.id, { ...r, enabled: state.enabled[r.manifest.id] ?? true });
      }
    }
  }

  private readState(): PersistedState {
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8')) as Partial<PersistedState>;
      const enabled: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(raw.enabled ?? {})) if (typeof v === 'boolean' && EDITOR_ID.test(k)) enabled[k] = v;
      return { v: 1, enabled };
    } catch {
      return { v: 1, enabled: {} };
    }
  }

  private writeState(): void {
    const enabled: Record<string, boolean> = {};
    for (const r of this.records.values()) if (!r.enabled) enabled[r.manifest.id] = false;
    const state: PersistedState = { v: 1, enabled };
    mkdirSync(join(this.stateFile, '..'), { recursive: true });
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.stateFile);
  }

  /** Where the flags live (diagnostics / tests). */
  get stateFilePath(): string {
    return this.stateFile;
  }

  list(): EditorRecord[] {
    return [...this.records.values()].sort((a, b) => Number(b.firstParty) - Number(a.firstParty) || a.manifest.id.localeCompare(b.manifest.id));
  }

  get(id: string): EditorRecord | null {
    return this.records.get(id) ?? null;
  }

  /** Enable or disable (§6.4: the operator's click). Returns the record, or `null` for an unknown id. */
  setEnabled(id: string, enabled: boolean): EditorRecord | null {
    const r = this.records.get(id);
    if (r === undefined) return null;
    const next = { ...r, enabled };
    this.records.set(id, next);
    this.writeState();
    return next;
  }

  /** The wire view: no paths, the hashed entry URL instead. */
  static view(r: EditorRecord): EditorView {
    const m = r.manifest;
    return {
      id: m.id,
      title: m.title,
      version: m.version,
      protocol: [...m.protocol],
      kinds: [...m.kinds],
      sizes: [...m.sizes],
      ...(m.panels !== undefined ? { panels: [...m.panels] } : {}),
      permissions: m.permissions.map((p) => ({ id: p.id, why: p.why })),
      sha256: r.sha256,
      bytes: r.bytes,
      first_party: r.firstParty,
      enabled: r.enabled,
      source: r.source,
      entry_url: `/api/v1/editors/${encodeURIComponent(m.id)}/${encodeURIComponent(m.version)}/entry`,
    };
  }
}
