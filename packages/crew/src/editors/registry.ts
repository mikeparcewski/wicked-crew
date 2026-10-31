/**
 * The artifact-editor registry (DES-artifact-editor-plugins §5.2, §8.6, §9.1; EP-C1).
 *
 * Two kinds of editor exist:
 *
 *  - **First-party** editors ship INSIDE studio's bundle (§8.6): `<studio dist>/editors/<id>/editor.json`
 *    beside the ONE self-contained `index.html` entry. Crew discovers them at boot, pins each entry's
 *    sha256 and byte size, and serves the entry through the hashed bundle route (`routes.ts`) with
 *    the §8.2 headers. Their ids are `wicked-*` — the reserved first-party namespace every pack is
 *    refused (garden `wicked-pack.schema.json`).
 *  - **Third-party** editors arrive as garden packs (spec 2 `editors[]`), installed by the operator
 *    (`POST /editors {packRoot}`, human-only) once garden's fail-closed `pack check` AND the
 *    install-time conformance run (garden `scripts/editor/conformance.py`, run by crew against its
 *    own conformance host page, §12.1 / EP-C8) both pass (`pack-install.ts`). The registry records
 *    the pack directory and each editor's pinned entry hash; it never writes into the pack. A pack
 *    that also ships skills or blocks is refused: their own "Add these" approval (§3.2) is not built.
 *
 * Persisted state is ONE file, `<state home>/daemon-editors.json`: the enable/disable flags the
 * operator sets in Settings (§6.4, human-only) and the installed packs. It sits under the `daemon-`
 * prefix both crew's state-home registry and the engine's worker fence already classify (crew#756),
 * so no new top-level entry is introduced. The packs themselves live where the installer staged
 * them (garden's default `~/.wicked/editors/<name>/current`, program-owned, outside the state home);
 * a bundle is re-hashed against the recorded pin on every serve, so a copy changed after install is
 * refused, never served.
 */

import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

import type { EditorPermission, EditorView, EditorVisuals } from '../core/types.js';
import { parseSurfaces } from './surfaces.js';
import { declaredDescription, declaredVisuals, resolveVisuals } from './visuals.js';
import { crewStateHome } from '../projects/state-home.js';

/** The persisted flags file, under the registered `daemon-` prefix. */
export const EDITORS_STATE_FILENAME = 'daemon-editors.json';
/** Where first-party manifests live inside the studio bundle. */
export const STUDIO_EDITORS_DIRNAME = 'editors';
/** The most of an installed pack's `wicked-pack.json` the registry reads (a manifest is a few KB). */
export const PACK_MANIFEST_CAP_BYTES = 1024 * 1024;
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
  'mcp.session',
  'artifact.theme',
] as const satisfies ReadonlyArray<EditorPermission>;

/** Editor ids: lowercase dash-words, ≤ 64 (garden's shape); first-party ones start with `wicked-`. */
export const EDITOR_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const FIRST_PARTY_ID = /^wicked-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
/** Anchored SemVer (garden's shape). */
export const EDITOR_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const KIND = /^[a-z][a-z0-9-]{1,40}$/u;

/** Protocol 2's `surfaces` (DES-EDITOR-PLUGIN-CONTRACT-001 §5.2), parsed strictly to the wire shape: any
 *  violation refuses the editor, with the host's own reason. */
const SurfacesField = z.unknown().optional().transform((raw, ctx) => {
  if (raw === undefined) return undefined;
  const parsed = parseSurfaces(raw);
  if (!parsed.ok) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: parsed.reason });
    return z.NEVER;
  }
  return parsed.value;
});

/** §8.2: `surfaces` is required when `protocol` lists 2, and refused when it doesn't. */
function surfacesMatchProtocol(m: { protocol: number[]; surfaces?: unknown }, ctx: z.RefinementCtx): void {
  const speaks2 = m.protocol.includes(2);
  if (speaks2 && m.surfaces === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['surfaces'], message: 'a protocol-2 editor declares its surfaces' });
  if (!speaks2 && m.surfaces !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['surfaces'], message: 'surfaces are a protocol-2 field' });
}

const EditorManifestFields = z.object({
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
  surfaces: SurfacesField,
  /** The Plugins page's one line and look (program DES-LEARN §2). Cosmetic: a malformed value is dropped, never a
   *  reason to refuse the editor. */
  description: z.unknown().optional().transform(declaredDescription),
  visuals: z.unknown().optional().transform(declaredVisuals),
});
export const EditorManifestSchema = EditorManifestFields.superRefine(surfacesMatchProtocol);
export type EditorManifest = z.infer<typeof EditorManifestFields>;

export interface EditorRecord {
  manifest: EditorManifest;
  /** The full 64-hex sha256 of the entry file, pinned when the registry read it. */
  sha256: string;
  bytes: number;
  /** Absolute path of the entry file. Never on the wire. */
  entryPath: string;
  firstParty: boolean;
  /** `studio-bundle`: first-party, shipped in studio's dist. `pack`: a third-party pack the operator installed. */
  source: 'studio-bundle' | 'pack';
  enabled: boolean;
  /** For a pack editor: the pack it came from. Never on the wire. */
  pack?: InstalledPack;
  /** Its declared visuals with each image read into a `data:` URL (`visuals.ts`). */
  visuals?: EditorVisuals;
}

/** One installed pack editor, as `daemon-editors.json` records it. */
export interface InstalledPack {
  /** Absolute path of the pack directory (holding `wicked-pack.json`). */
  root: string;
  /** The pack's `name` (the installer's key). */
  name: string;
  /** The editor's entry path, relative to the pack root. */
  entry: string;
  /** The entry's sha256 when it was installed (and passed the conformance run). */
  sha256: string;
  /** {@link editorEntryDigest} of its manifest entry as admitted: permissions, kinds, version, … */
  manifestSha256: string;
  installedAt: string;
  /** The conformance run that admitted it: when, and which cases ran. */
  conformance: { ok: true; at: string; cases: string[] };
}

/** An install the registry refuses: the id is taken, or the pack did not read back. */
export class EditorInstallConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditorInstallConflict';
  }
}

export function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Read a file holding at most `cap` bytes, never allocating more than `cap + 1` (codex r1 on X3: a
 * file swapped for a huge one is refused before it is read whole). `null` = over the cap.
 */
export function readCapped(path: string, cap: number): Buffer | null {
  const fd = openSync(path, 'r');
  try {
    if (fstatSync(fd).size > cap) return null;
    const buf = Buffer.alloc(cap + 1);
    let n = 0;
    for (;;) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
      if (n > cap) return null;
    }
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/** The digest of a pack editor's admitted manifest entry: a manifest edited after install is a new install. */
export function editorEntryDigest(entry: unknown): string {
  return createHash('sha256').update(JSON.stringify(entry)).digest('hex');
}

/**
 * A path is served from the bundle only if it IS what it looks like: a real directory or a real
 * file, never a link (codex r1 — a link under `editors/` could point outside the bundle and be
 * served as first-party). `null` = fine; else the reason.
 */
export function notRealEntry(path: string, want: 'dir' | 'file'): string | null {
  let meta;
  try {
    meta = lstatSync(path);
  } catch {
    return 'missing';
  }
  if (meta.isSymbolicLink()) return 'a symlink (not followed)';
  if (want === 'dir' && !meta.isDirectory()) return 'not a directory';
  if (want === 'file' && !meta.isFile()) return 'not a file';
  return null;
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
    const dirProblem = notRealEntry(join(dir, name), 'dir');
    if (dirProblem !== null) {
      if (dirProblem !== 'not a directory') log?.(`[editors] ${name}: editor directory is ${dirProblem}; skipped`);
      continue;
    }
    const manifestPath = join(dir, name, 'editor.json');
    if (!existsSync(manifestPath)) continue;
    const manifestProblem = notRealEntry(manifestPath, 'file');
    if (manifestProblem !== null) {
      log?.(`[editors] ${name}: editor.json is ${manifestProblem}; skipped`);
      continue;
    }
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
    const entryProblem = notRealEntry(entryPath, 'file');
    if (entryProblem !== null) {
      log?.(`[editors] ${manifest.id}: entry ${manifest.entry} is ${entryProblem}; skipped`);
      continue;
    }
    const cap = manifest.limits?.bundleBytes ?? HOST_BUNDLE_CAP_BYTES;
    let buf: Buffer | null;
    try {
      buf = readCapped(entryPath, cap);
    } catch (err) {
      log?.(`[editors] ${manifest.id}: entry unreadable (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    if (buf === null) {
      log?.(`[editors] ${manifest.id}: entry is over its ${cap}-byte cap`);
      continue;
    }
    const outside = externalReferences(buf.toString('utf8'));
    if (outside.length > 0) {
      log?.(`[editors] ${manifest.id}: entry loads from outside itself (${outside.slice(0, 3).join(', ')})`);
      continue;
    }
    const visuals = resolveVisuals(join(dir, name), manifest.visuals, (m) => log?.(`[editors] ${manifest.id}: visual ${m}; left out`));
    out.push({ manifest, sha256: sha256Of(buf), bytes: buf.byteLength, entryPath, firstParty: true, source: 'studio-bundle', ...(visuals !== undefined ? { visuals } : {}) });
  }
  return out;
}

/** A pack editor's manifest entry: the shared shape plus its pinned hash and a pack-relative entry. */
/** A pack editor's manifest entry. No `description` / `visuals` yet: garden's pack gate (spec 2) refuses both keys
 *  (PK060), and a pack is another party's directory, so its images would need descriptor-anchored reads; studio-bundle
 *  editors only for now (post-mvp: garden pack schema + anchored reads). */
export const PackEditorSchema = EditorManifestFields.omit({ description: true, visuals: true }).extend({
  entry: z.string().regex(/\.html$/u),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
}).superRefine(surfacesMatchProtocol);

/**
 * Read one pack editor at serve-time quality: the manifest entry for `id` in `<root>/wicked-pack.json`,
 * its entry a real file inside the pack, within its caps, loading nothing from outside, and hashing to
 * `pin`. `null` + a logged reason when any of it fails — an installed editor whose pack changed is
 * skipped until it is installed again, never served half-right.
 */
export function readPackEditor(pack: InstalledPack, id: string, log?: (msg: string) => void): Omit<EditorRecord, 'enabled'> | null {
  const why = (m: string): null => {
    log?.(`[editors] ${id} (pack ${pack.name}): ${m}; skipped — install it again`);
    return null;
  };
  const manifestPath = join(pack.root, 'wicked-pack.json');
  const manifestProblem = notRealEntry(manifestPath, 'file');
  if (manifestProblem !== null) return why(`wicked-pack.json is ${manifestProblem}`);
  let entries: unknown;
  try {
    // Bounded before it is parsed (codex r3): a manifest swapped for a huge one never reaches JSON.parse.
    const raw = readCapped(manifestPath, PACK_MANIFEST_CAP_BYTES);
    if (raw === null) return why(`wicked-pack.json is over ${PACK_MANIFEST_CAP_BYTES} bytes`);
    entries = (JSON.parse(raw.toString('utf8')) as { editors?: unknown }).editors;
  } catch (err) {
    return why(`wicked-pack.json is unreadable (${err instanceof Error ? err.message : String(err)})`);
  }
  const raw = Array.isArray(entries) ? entries.find((e) => typeof e === 'object' && e !== null && (e as { id?: unknown }).id === id) : undefined;
  const parsed = PackEditorSchema.safeParse(raw);
  if (!parsed.success) return why(`its manifest entry is refused (${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')})`);
  const m = parsed.data;
  if (FIRST_PARTY_ID.test(m.id) || m.id === 'wicked') return why('a pack may not declare a wicked-* editor');
  if (editorEntryDigest(m) !== pack.manifestSha256) return why('its manifest entry changed since it was installed');
  if (m.entry !== pack.entry) return why(`its entry moved (${pack.entry} → ${m.entry})`);
  const entryPath = resolve(pack.root, m.entry);
  const rel = relative(resolve(pack.root), entryPath);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return why(`entry ${m.entry} is outside the pack`);
  // Every directory on the way and the file itself are real, never links.
  let at = resolve(pack.root);
  for (const part of rel.split(sep).slice(0, -1)) {
    at = join(at, part);
    const p = notRealEntry(at, 'dir');
    if (p !== null) return why(`entry directory ${part} is ${p}`);
  }
  const entryProblem = notRealEntry(entryPath, 'file');
  if (entryProblem !== null) return why(`entry ${m.entry} is ${entryProblem}`);
  const cap = m.limits?.bundleBytes ?? HOST_BUNDLE_CAP_BYTES;
  let buf: Buffer | null;
  try {
    buf = readCapped(entryPath, cap);
  } catch (err) {
    return why(`entry unreadable (${err instanceof Error ? err.message : String(err)})`);
  }
  if (buf === null) return why(`entry is over its ${cap}-byte cap`);
  const outside = externalReferences(buf.toString('utf8'));
  if (outside.length > 0) return why(`entry loads from outside itself (${outside.slice(0, 3).join(', ')})`);
  const sha = sha256Of(buf);
  if (sha !== m.sha256 || sha !== pack.sha256) return why('its entry no longer matches the hash it was installed with');
  const manifest: EditorManifest = { id: m.id, title: m.title, version: m.version, protocol: m.protocol, kinds: m.kinds, entry: m.entry, sizes: m.sizes, permissions: m.permissions, ...(m.panels !== undefined ? { panels: m.panels } : {}), ...(m.limits !== undefined ? { limits: m.limits } : {}), ...(m.surfaces !== undefined ? { surfaces: m.surfaces } : {}) };
  return { manifest, sha256: sha, bytes: buf.byteLength, entryPath, firstParty: false, source: 'pack', pack };
}

const InstalledPackSchema = z.object({
  root: z.string().min(1),
  name: z.string().regex(EDITOR_ID),
  entry: z.string().regex(/\.html$/u),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  manifestSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  installedAt: z.string(),
  conformance: z.object({ ok: z.literal(true), at: z.string(), cases: z.array(z.string()) }),
});

/** An operator flag by editor id: own properties only (an id like `constructor` is not an inherited key, codex r5). */
function flagOf(flags: Record<string, boolean>, id: string): boolean | undefined {
  return Object.hasOwn(flags, id) && typeof flags[id] === 'boolean' ? flags[id] : undefined;
}

interface PersistedState {
  v: 1;
  enabled: Record<string, boolean>;
  /** Installed pack editors, by editor id. Absent in a file written before installs existed. */
  installed?: Record<string, InstalledPack>;
}

export class EditorRegistry {
  private readonly records = new Map<string, EditorRecord>();
  private readonly stateFile: string;
  private readonly log: (msg: string) => void;

  constructor(opts: { stateHome?: string; studioRoot?: string; log?: (msg: string) => void } = {}) {
    this.stateFile = join(opts.stateHome ?? crewStateHome(), EDITORS_STATE_FILENAME);
    this.log = opts.log ?? (() => undefined);
    const state = this.readState();
    this.persistedFlags = state.enabled;
    if (opts.studioRoot !== undefined) {
      for (const r of discoverStudioEditors(opts.studioRoot, this.log)) {
        this.records.set(r.manifest.id, { ...r, enabled: flagOf(state.enabled, r.manifest.id) ?? true });
      }
    }
    for (const [id, pack] of Object.entries(state.installed ?? {})) {
      this.installed.set(id, pack);
      if (this.records.has(id)) {
        this.log(`[editors] ${id} (pack ${pack.name}): a first-party editor holds the id; skipped`);
        continue;
      }
      const r = readPackEditor(pack, id, this.log);
      if (r !== null) this.records.set(id, { ...r, enabled: flagOf(state.enabled, id) ?? true });
    }
  }

  /** Every installed pack editor as recorded, including one skipped at boot (so an install can replace it). */
  private readonly installed = new Map<string, InstalledPack>();
  /** The flags as read at boot: kept for an installed editor skipped at boot, so a write never drops its "off". */
  private persistedFlags: Record<string, boolean> = {};

  private readState(): PersistedState {
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8')) as Partial<PersistedState>;
      const enabled: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(raw.enabled ?? {})) if (typeof v === 'boolean' && EDITOR_ID.test(k)) enabled[k] = v;
      const installed: Record<string, InstalledPack> = {};
      for (const [k, v] of Object.entries(raw.installed ?? {})) {
        const parsed = InstalledPackSchema.safeParse(v);
        if (EDITOR_ID.test(k) && parsed.success) installed[k] = parsed.data;
        else this.log(`[editors] ${k}: its install record in ${EDITORS_STATE_FILENAME} is malformed; ignored`);
      }
      return { v: 1, enabled, installed };
    } catch {
      return { v: 1, enabled: {} };
    }
  }

  private writeState(): void {
    const enabled: Record<string, boolean> = {};
    for (const r of this.records.values()) if (!r.enabled) enabled[r.manifest.id] = false;
    for (const id of this.installed.keys()) if (!this.records.has(id) && flagOf(this.persistedFlags, id) === false) enabled[id] = false;
    const state: PersistedState = { v: 1, enabled };
    if (this.installed.size > 0) state.installed = Object.fromEntries([...this.installed].sort(([a], [b]) => a.localeCompare(b)));
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
    this.commit(() => this.records.set(id, next));
    return next;
  }

  /**
   * Apply `change` to the in-memory maps and persist; a failed write restores the maps as they were
   * and rethrows, so memory never holds what the file does not (codex r1 on X3).
   */
  private commit(change: () => void): void {
    const records = new Map(this.records);
    const installed = new Map(this.installed);
    const flags = { ...this.persistedFlags };
    change();
    try {
      this.writeState();
    } catch (err) {
      this.records.clear();
      for (const [k, v] of records) this.records.set(k, v);
      this.installed.clear();
      for (const [k, v] of installed) this.installed.set(k, v);
      this.persistedFlags = flags;
      throw err;
    }
  }

  /**
   * Record a pack's editors, already checked and conformance-run by the caller (`pack-install.ts`):
   * each is read back from disk exactly as boot reads it, and only then recorded. All or nothing — a
   * pack editor that does not read back leaves the registry as it was. An editor id another pack
   * holds is refused; the same pack re-installed (an update) replaces its own editors, keeping the
   * operator's on/off choice unless `enabled` says otherwise.
   */
  installPack(packs: Array<{ id: string; pack: InstalledPack }>, enabled: boolean | undefined): { records: EditorRecord[]; updated: boolean } {
    const read: Array<Omit<EditorRecord, 'enabled'>> = [];
    let updated = false;
    for (const { id, pack } of packs) {
      const existing = this.records.get(id);
      if (existing?.firstParty === true) throw new EditorInstallConflict(`${id} is a first-party editor's id`);
      const held = this.installed.get(id);
      if (held !== undefined && held.name !== pack.name) throw new EditorInstallConflict(`${id} is already installed from the pack ${held.name}; remove it first`);
      if (held !== undefined) updated = true;
      const r = readPackEditor(pack, id, this.log);
      if (r === null) throw new EditorInstallConflict(`${id} did not read back from ${pack.root} (see the daemon log)`);
      read.push(r);
    }
    const out: EditorRecord[] = read.map((r) => {
      const id = r.manifest.id;
      // An update keeps the operator's switch: the live record's, else the one persisted for a record
      // skipped at boot (codex r1), else on.
      return { ...r, enabled: enabled ?? this.records.get(id)?.enabled ?? flagOf(this.persistedFlags, id) ?? true };
    });
    this.commit(() => {
      for (const r of out) {
        this.records.set(r.manifest.id, r);
        this.installed.set(r.manifest.id, r.pack!);
      }
    });
    return { records: out, updated };
  }

  /** Remove an installed pack editor (the pack's files are the installer's to delete). `false` when it is not one. */
  removeInstalled(id: string): boolean {
    if (!this.installed.has(id)) return false;
    this.commit(() => {
      this.installed.delete(id);
      // A removed editor's boot-time "off" does not follow a later install of the id (codex r2).
      delete this.persistedFlags[id];
      const r = this.records.get(id);
      if (r !== undefined && !r.firstParty) this.records.delete(id);
    });
    return true;
  }

  /** Whether `id` is an installed pack editor (served or skipped at boot). */
  isInstalled(id: string): boolean {
    return this.installed.has(id);
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
      ...(m.surfaces !== undefined ? { surfaces: structuredClone(m.surfaces) } : {}),
      permissions: m.permissions.map((p) => ({ id: p.id, why: p.why })),
      sha256: r.sha256,
      bytes: r.bytes,
      first_party: r.firstParty,
      enabled: r.enabled,
      source: r.source,
      entry_url: `/api/v1/editors/${encodeURIComponent(m.id)}/${encodeURIComponent(m.version)}/entry`,
      ...(m.description !== undefined ? { description: m.description } : {}),
      ...(r.visuals !== undefined ? { visuals: structuredClone(r.visuals) } : {}),
    };
  }
}
