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
