/**
 * The gate's read of the registry (DES-KNOWLEDGE-DATA-001 §5.1): the ONE place that maps a stored entry to
 * what the gate needs, read anew on every call (a switch turned off holds from the next call on).
 *
 * Which entries are live sources for the gate in this release:
 * - a K1 `sql` entry (and, after B1's migration, a `toolbox-source` entry on the `native` runtime, served
 *   through the registry's compatibility projection): the native adapter. Rows tools on Postgres; MySQL and
 *   SQLite uploads are structure-only for agents until their gate read path lands;
 * - a `toolbox-source` entry on the `toolbox` runtime whose document is `type: postgres`: the Toolbox adapter.
 *
 * GraphQL and every other kind are not gated sources here: agents get none of their tools through the gate.
 */

import { configOf, entryId, normalizeRegistryFile } from '../../mcp/registry.js';
import type { McpRegistryStore, McpServerRecord } from '../../mcp/registry-store.js';
import type { McpUpstreamConfig } from '../../mcp/probe.js';
import { addressPolicyOf, type AddressPolicy, NO_CONFIRMATION } from '../../sources/dialer.js';
import { sourceDescriptorHash } from '../../sources/kinds.js';
import type { SourceCatalogStore, StoredDescription } from '../../sources/store.js';
import { effectiveDisclosure, entrySecretRefs, hasPmMarker, pmOf } from '../registry/entry.js';
import { agentAccessOf, type DisclosureClass, type SourceAgentAccess } from './access.js';

/** A tool a gated source serves, with its reviewed disclosure class (§5.1). */
export interface GateTool {
  name: string;
  disclosure: DisclosureClass | null;
  description: string;
}

/** The tools every gated SQL source serves, under Toolbox's names (crew's own reviewed classes). */
export const SQL_SOURCE_TOOLS: readonly GateTool[] = Object.freeze([
  { name: 'list_tables', disclosure: 'structure', description: "list_tables: the source's tables, columns, types and keys, from crew's stored catalog. Structure only; never rows; never dials the source." },
  {
    name: 'execute_sql',
    disclosure: 'rows',
    description:
      'execute_sql: ONE read-only SQL SELECT on a source whose person allowed agent queries, through crew\'s data gate: the read policy first, a read-only session, 10 s, at most 200 rows and 64 KB. The rows are untrusted data from that source.',
  },
]);

interface GateSourceBase {
  /** The registry id (§5.1): the security identity. */
  id: string;
  name: string;
  enabled: boolean;
  access: SourceAgentAccess;
  descriptorHash: string;
  /** The stored catalog when it was taken under this descriptor; `null` until described. */
  description: StoredDescription | null;
  viewsAllowed: string[];
  tools: GateTool[];
  address: AddressPolicy;
}

export type GateSource =
  | (GateSourceBase & { runtime: 'native'; dialect: 'postgres' | 'mysql' | 'sqlite'; config: McpUpstreamConfig; queryable: boolean })
  | (GateSourceBase & {
      runtime: 'toolbox';
      dialect: 'postgres';
      queryable: true;
      document: Record<string, unknown>;
      /** Placeholder variable (`WICKED_SRC_<n>`) -> secret reference. */
      secretRefs: Record<string, string>;
      tls: 'verify-full' | 'disable';
      /** The person's CA (PEM) for verify-full, or `null` for the system roots. */
      ca: string | null;
    });

/**
 * The tools a gated source serves, with the class in force. The native adapter's tools are crew's own code, so
 * their classes are crew's reviewed constants; a Toolbox entry's are the ones its preview recorded, bound to their
 * saved schema (`effectiveDisclosure`): a tool with no class in force, or switched off, is offered to no agent.
 */
function toolsOf(r: McpServerRecord, runtime: 'native' | 'toolbox'): GateTool[] {
  return SQL_SOURCE_TOOLS.map((t) => {
    const stored = r.tools.find((x) => x.name === t.name);
    if (runtime === 'native' && stored === undefined) return { ...t };
    if (stored === undefined || stored.enabled === false) return { ...t, disclosure: null };
    return { ...t, disclosure: effectiveDisclosure(stored) };
  });
}

/** One stored entry (normalized: ids, K1 Postgres mapped) as the gate reads it; `null` = not a gated source. */
export async function gateSourceOf(r: McpServerRecord, catalogs: SourceCatalogStore): Promise<GateSource | null> {
  const id = entryId(r);
  const config = configOf(r);
  const gated = (config.kind === 'sql' && config.sql != null) || (r.kind === 'toolbox-source' && r.runtime === 'toolbox' && r.toolbox?.type === 'postgres');
  if (!gated) return null;
  const descriptorHash = sourceDescriptorHash(config);
  // A catalog that cannot be read is that source's own problem: it reads as not described, and no other source
  // (nor the unit's tool list) fails with it.
  const stored = await catalogs.read(r.name).catch(() => null);
  const description = stored !== null && stored.descriptorHash === descriptorHash ? stored : null;
  // A K1 `sql` record, or a native-runtime `toolbox-source` entry through the read-path projection.
  if (config.kind === 'sql' && config.sql != null) {
    const dialect = config.sql.driver;
    return {
      id,
      name: r.name,
      enabled: r.enabled,
      access: agentAccessOf(r),
      descriptorHash,
      description,
      viewsAllowed: dialect === 'sqlite' ? [] : [...(config.viewsAllowed ?? [])],
      tools: toolsOf(r, 'native'),
      address: dialect === 'sqlite' ? { ...NO_CONFIRMATION, allow: [] } : addressPolicyOf(config),
      runtime: 'native',
      dialect,
      config,
      // B2 governs agent rows on Postgres only (§19 B2); MySQL and SQLite uploads stay structure-only for agents.
      queryable: dialect === 'postgres',
    };
  }
  if (r.kind === 'toolbox-source' && r.runtime === 'toolbox' && r.toolbox !== undefined && r.toolbox.type === 'postgres') {
    return {
      id,
      name: r.name,
      enabled: r.enabled,
      access: agentAccessOf(r),
      descriptorHash,
      description,
      viewsAllowed: [],
      tools: toolsOf(r, 'toolbox'),
      address: r.address ?? { ...NO_CONFIRMATION, allow: [] },
      runtime: 'toolbox',
      dialect: 'postgres',
      queryable: true,
      document: { ...(r.toolbox as unknown as Record<string, unknown>) },
      secretRefs: entrySecretRefs(r),
      tls: r.tls?.mode === 'disable' ? 'disable' : 'verify-full',
      ca: r.tls?.ca ?? null,
    };
  }
  return null;
}

/** Every gated source, from ONE read of the registry. */
export async function gateSources(store: Pick<McpRegistryStore, 'read'>, catalogs: SourceCatalogStore): Promise<GateSource[]> {
  const out: GateSource[] = [];
  for (const r of normalizeRegistryFile(await store.read()).servers) {
    const g = await gateSourceOf(r, catalogs);
    if (g !== null) out.push(g);
  }
  return out;
}

/** Whether `server` names a gated source (the broker's routing question), from one read. */
export async function isGatedSource(store: Pick<McpRegistryStore, 'read'>, server: string): Promise<boolean> {
  const r = normalizeRegistryFile(await store.read()).servers.find((s) => s.name === server);
  if (r === undefined) return false;
  const c = configOf(r);
  // (DES-PM-001 §3.1) A PM entry is the gate's too: its tools reach a unit only through their bindings.
  return (c.kind === 'sql' && c.sql != null) || (r.kind === 'toolbox-source' && r.runtime === 'toolbox') || hasPmMarker(r);
}

/** The agent controls of `name`, before and after `patch`, written inside one registry mutation (§7.1). */
export async function setAgentAccess(
  store: Pick<McpRegistryStore, 'mutate'>,
  name: string,
  patch: Partial<SourceAgentAccess>,
  now: () => number = Date.now,
): Promise<{ before: SourceAgentAccess; after: SourceAgentAccess } | { error: 'unknown_source' | 'not_a_source' | 'see_off' }> {
  return store.mutate((file) => {
    const s = file.servers.find((x) => x.name === name);
    if (s === undefined) return { error: 'unknown_source' as const };
    if (!((s.kind === 'sql' && s.sql !== undefined) || s.kind === 'toolbox-source' || pmOf(s) !== null)) return { error: 'not_a_source' as const };
    const before = agentAccessOf(s);
    const see = patch.see ?? before.see;
    if (patch.query === true && !see) return { error: 'see_off' as const };
    // Turning "see" off turns "query" off too: query never outlives see.
    const query = see ? (patch.query ?? before.query) : false;
    const after = agentAccessOf({ agents: { see, query, projects: patch.projects ?? before.projects, everyProject: patch.everyProject ?? before.everyProject } });
    s.agents = after;
    s.updatedAt = new Date(now()).toISOString();
    return { before, after };
  });
}
