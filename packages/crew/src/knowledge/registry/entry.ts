/**
 * The one registry's entry (DES-KNOWLEDGE-DATA-001 §5.1): what an entry carries beyond the MCP tools registry's
 * record, and the helpers every reader shares.
 *
 * - `id`: the entry's immutable identity. Estate's source documents, `deps`, grants and records key on it, never on
 *   the name, so a name that is removed and registered again never inherits the old entry's structure.
 * - A database source (`kind: 'toolbox-source'`) stores Toolbox's own source document, its `runtime` (`native`:
 *   crew's K1 adapter; `toolbox`: the Toolbox process), its TLS choice and its descriptor version.
 * - `agents`: who among the agents may use the source (see, query, projects). Set by a human operator only.
 * - A tool's `disclosure`: what its answer discloses (`none`, `structure`, `rows`), reviewed at preview and bound
 *   to the tool's saved schema hash. A tool with no class in force is unavailable to agents (the gate's rule).
 */

import { createHash } from 'node:crypto';

import { SECRET_PLACEHOLDER, type ToolboxSourceDocument } from './policy.js';

export type { ToolboxSourceDocument } from './policy.js';

/** `native`: crew's own adapter (K1's driver, dialer and read policy). `toolbox`: one Toolbox process per source. */
export type SourceRuntime = 'native' | 'toolbox';

/** A database source's TLS choice; crew writes the driver's TLS settings from it. `ca` is a PEM, or `null`. */
export interface SourceTls {
  mode: 'verify-full' | 'disable';
  ca: string | null;
}

/**
 * `1`: an entry mapped from a K1 `sql` record. Its descriptor hash is K1's function over the equivalent fields,
 * so accepted app versions, their locks, action grants and Allow writes stay valid with no re-lock.
 * `2`: written by a save; the hash covers the canonical execution descriptor (§5.4).
 */
export type DescriptorVersion = 1 | 2;

/** The database-source part of an entry (`kind: 'toolbox-source'`), as stored. */
export interface ToolboxSourceEntry {
  toolbox: ToolboxSourceDocument;
  runtime: SourceRuntime;
  tls: SourceTls;
  descriptorVersion: DescriptorVersion;
  /** The deployment policy the document was checked under (`postgres/1@toolbox-v1.15.0`). */
  policyVersion: string;
}

/** What a tool's answer discloses. `rows` needs "query"; `structure` needs "see"; `none` discloses neither. */
export type ToolDisclosureClass = 'none' | 'structure' | 'rows';

/** A tool's reviewed disclosure class, bound to the schema hash it was reviewed against. */
export interface ToolDisclosure {
  class: ToolDisclosureClass;
  schemaHash: string;
}

export const DISCLOSURE_CLASSES: readonly ToolDisclosureClass[] = ['none', 'structure', 'rows'];

/** A source's agent switches as the registry stores them. */
export interface SourceAgentAccess {
  /** "Agents can see this structure": on by default. */
  see: boolean;
  /** "Agents can query this source": off by default; needs `see`; reset by a descriptor change and by a restore. */
  query: boolean;
  /** The project ids whose runs and chats may use it: sorted, unique. None by default. */
  projects: string[];
  /** Every project: an explicit choice. */
  everyProject: boolean;
}

export const AGENT_ACCESS_DEFAULT: Readonly<SourceAgentAccess> = Object.freeze({ see: true, query: false, projects: [], everyProject: false });

/** A project id as crew spells them (`proj_…`, `default`). */
export const AGENT_PROJECT_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** The switches a stored record holds, with the defaults filled in. Query never outlives see. */
export function agentAccessOf(rec: { agents?: Partial<SourceAgentAccess> | null }): SourceAgentAccess {
  const a = rec.agents ?? {};
  const see = typeof a.see === 'boolean' ? a.see : AGENT_ACCESS_DEFAULT.see;
  const query = see && a.query === true;
  const projects = Array.isArray(a.projects) ? [...new Set(a.projects.filter((p) => typeof p === 'string' && AGENT_PROJECT_RE.test(p)))].sort() : [];
  return { see, query, projects, everyProject: a.everyProject === true };
}

/** The disclosure class in force for a tool: its reviewed class while the saved schema is the one reviewed, else `null`. */
export function effectiveDisclosure(t: { disclosure?: ToolDisclosure | null; schemaHash: string | null }): ToolDisclosureClass | null {
  const d = t.disclosure ?? null;
  if (d === null || t.schemaHash === null || d.schemaHash !== t.schemaHash) return null;
  return DISCLOSURE_CLASSES.includes(d.class) ? d.class : null;
}

/**
 * The class crew proposes at preview for a tool it knows: only the tools of crew's own Toolbox configuration on a
 * `toolbox-source` entry, never by the name another server gives its tool (a server could call anything
 * `list_tables`).
 */
export function proposedDisclosure(kind: string, tool: string): ToolDisclosureClass | null {
  if (kind !== 'toolbox-source') return null;
  if (tool === 'list_tables') return 'structure';
  if (tool === 'execute_sql') return 'rows';
  return null;
}

/** The placeholder → secret reference map a spawn resolves (`{WICKED_SRC_1: auth.ref}`); empty with no secret. */
export function entrySecretRefs(rec: { auth: { ref: string } | null }): Record<string, string> {
  return rec.auth === null ? {} : { [SECRET_PLACEHOLDER]: rec.auth.ref };
}

/**
 * The id of a record saved before ids existed: a uuid derived from its name and when it was first registered, so
 * every read agrees before the next write persists it, and a name registered again (a new `registeredAt`) is a new id.
 */
export function legacyEntryId(name: string, registeredAt: string): string {
  const h = createHash('sha256').update(`wicked-registry-entry\0${name}\0${registeredAt}`).digest('hex');
  // RFC 9562 layout, version 8 (custom), variant 10.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// ── Project-management entries (DES-PM-001 rev 4, PM-1) ──────────────────────────────────────────────

/** A project-management system. PM-1 registers `github` and `jira`; `gitlab` and `ado` are wave PM-2. */
export type PmSystem = 'github' | 'jira' | 'gitlab' | 'ado';
/** The systems a registration may name in this release. */
export const PM_SYSTEMS_REGISTERED: readonly PmSystem[] = ['github', 'jira'];

/** Marks an `mcp-http` / `mcp-stdio` entry as a PM system's own MCP server (DES-PM-001 §3), set at registration. */
export interface PmMarker {
  system: PmSystem;
}

/** What a tracker link points at: a studio project or a registered repo (§3). */
export type TrackerLinkTarget = { kind: 'project'; id: string } | { kind: 'repo'; id: string };

/** One link of a tracker, as the registry keeps it (only the tracker-links routes write it). */
export interface StoredTrackerLink {
  /** `tl_` + hash16(tracker id, kind, id). */
  id: string;
  target: TrackerLinkTarget;
  linkedAt: string;
  linkedBy: string;
}

/** One tracker of a PM entry: one project inside one tenant (§3), with its links. A tracker with no link is removed. */
export interface StoredTracker {
  /** `trk_` + hash16(source id, tenant, key). */
  id: string;
  /** Jira: the site's cloudId; GitHub: the host. */
  tenant: string;
  /** The tenant as a person reads it (a Jira site's name); `null` when not known. */
  tenantLabel: string | null;
  /** Jira: the site's host (`acme.atlassian.net`), from the vendor at link time: an issue's own address must name it. */
  siteHost?: string | null;
  /** Jira: the project key; GitHub: `owner/repo`. */
  key: string;
  /** The vendor's label, cut to {@link TRACKER_LABEL_MAX} characters. Vendor text. */
  label: string;
  links: StoredTrackerLink[];
  /**
   * (DES-PM-001 §3.4, §4) Value-free structure read at link time: issue types, and workflow states with their mapping
   * to todo/doing/done. Names only (vendor text); never an issue. Absent = not read.
   */
  structure?: TrackerStructure;
}

export interface TrackerStructure {
  issueTypes: string[];
  states: Array<{ name: string; category: 'todo' | 'doing' | 'done' | null }>;
  /** The fields of the project's first issue type: identifier, name, value type. Never a value or a default. */
  fields?: Array<{ id: string; name: string; type: string | null }>;
}

/** A tracker whose last link was removed, kept until estate acknowledges its empty generation (§3.4). */
export interface RetiredTracker {
  id: string;
  since: string;
}

/** A PM tool's resource binding as stored: crew's binding policy for the tool, bound to the reviewed schema (§3). */
export interface ToolBinding {
  policy: string;
  schemaHash: string;
}

export const TRACKER_LABEL_MAX = 120;

const hash16 = (...parts: string[]): string => createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);

/** A tracker's id: derived from (source id, tenant, key), so two sites that both have `PROJ` are two trackers. */
export function trackerIdOf(sourceId: string, tenant: string, key: string): string {
  return `trk_${hash16('wicked-tracker', sourceId, tenant, key)}`;
}

/** A link's id: derived from (tracker id, kind, id), so linking twice is one link. */
export function trackerLinkIdOf(trackerId: string, target: TrackerLinkTarget): string {
  return `tl_${hash16('wicked-tracker-link', trackerId, target.kind, target.id)}`;
}

/** A tracker label as stored and shown: one line, at most {@link TRACKER_LABEL_MAX} characters. */
export function trackerLabel(raw: unknown, fallback: string): string {
  const flat = (typeof raw === 'string' ? raw : '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const t = flat === '' ? fallback : flat;
  return t.length <= TRACKER_LABEL_MAX ? t : `${t.slice(0, TRACKER_LABEL_MAX - 1)}…`;
}

/**
 * Whether a stored record carries a PM marker AT ALL, readable or not. The plain path (raw tool lists, Apps, the
 * broker's upstream call) refuses every such record, so a marker this release cannot read fails closed.
 */
export function hasPmMarker(rec: { kind: string; pm?: unknown }): boolean {
  return (rec.kind === 'mcp-http' || rec.kind === 'mcp-stdio') && rec.pm !== undefined && rec.pm !== null;
}

/** The PM marker a stored record holds, or `null` (not a PM entry, or one this release cannot read). */
export function pmOf(rec: { kind: string; pm?: Partial<PmMarker> | null }): PmMarker | null {
  if (rec.kind !== 'mcp-http' && rec.kind !== 'mcp-stdio') return null;
  const s = rec.pm?.system;
  return s === 'github' || s === 'jira' ? { system: s } : null;
}

/** The trackers a stored record holds, well-formed ones only. */
export function trackersOf(rec: { trackers?: unknown }): StoredTracker[] {
  if (!Array.isArray(rec.trackers)) return [];
  const out: StoredTracker[] = [];
  for (const t of rec.trackers as unknown[]) {
    if (typeof t !== 'object' || t === null) continue;
    const r = t as Record<string, unknown>;
    if (typeof r['id'] !== 'string' || typeof r['tenant'] !== 'string' || typeof r['key'] !== 'string' || !Array.isArray(r['links'])) continue;
    const links: StoredTrackerLink[] = [];
    for (const l of r['links'] as unknown[]) {
      if (typeof l !== 'object' || l === null) continue;
      const x = l as Record<string, unknown>;
      const tg = x['target'] as Record<string, unknown> | undefined;
      if (typeof x['id'] !== 'string' || tg === undefined || (tg['kind'] !== 'project' && tg['kind'] !== 'repo') || typeof tg['id'] !== 'string') continue;
      links.push({ id: x['id'], target: { kind: tg['kind'], id: tg['id'] } as TrackerLinkTarget, linkedAt: String(x['linkedAt'] ?? ''), linkedBy: String(x['linkedBy'] ?? '') });
    }
    const st = r['structure'] as Partial<TrackerStructure> | undefined;
    const structure: TrackerStructure | undefined =
      typeof st === 'object' && st !== null
        ? {
            issueTypes: Array.isArray(st.issueTypes) ? st.issueTypes.filter((x): x is string => typeof x === 'string').map((x) => trackerLabel(x, '?')).slice(0, 50) : [],
            states: Array.isArray(st.states) ? st.states.filter((x) => typeof x?.name === 'string').map((x) => ({ name: trackerLabel(x.name, '?'), category: x.category === 'todo' || x.category === 'doing' || x.category === 'done' ? x.category : null })).slice(0, 50) : [],
            fields: Array.isArray(st.fields) ? st.fields.filter((x) => typeof x?.id === 'string' && typeof x?.name === 'string').map((x) => ({ id: trackerLabel(x.id, '?'), name: trackerLabel(x.name, '?'), type: typeof x.type === 'string' ? trackerLabel(x.type, '?') : null })).slice(0, 50) : [],
          }
        : undefined;
    out.push({ id: r['id'], tenant: r['tenant'], tenantLabel: typeof r['tenantLabel'] === 'string' ? r['tenantLabel'] : null, siteHost: typeof r['siteHost'] === 'string' ? r['siteHost'] : null, key: r['key'], label: trackerLabel(r['label'], r['key']), links, ...(structure !== undefined ? { structure } : {}) });
  }
  return out;
}
