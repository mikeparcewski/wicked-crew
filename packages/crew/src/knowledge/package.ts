/**
 * The knowledge package (DES-KNOWLEDGE-DATA-001 §8.1, §9.3): what an agent is handed about the live sources its
 * project may use, built ONE way for a chat seat, a governed unit and the apps builder.
 *
 * `knowledgePackageFor({projectId})` reads the registry once (the gate's own read, `DataGate.sources()`) and keeps
 * a source only when THE predicate (`agentMay`, §7.1) lets the project see it. Per source it carries:
 *
 * - its name, registry id and kind, and whether agents may query it (`query`, the same predicate);
 * - the subjects a unit calls through the broker: `mcp:<source>/list_tables` always, `execute_sql` only when
 *   query is on (the gate refuses it otherwise, whatever the package says);
 * - its STRUCTURE from crew's stored catalog (the gate's `agentStructure`: relations a read may name, columns,
 *   types, keys, declared enum literals), never a row, never a row estimate, a credential, a host, a login, a
 *   database name, a URL or a path. A source not described yet carries a note instead.
 *
 * It is authorized by the project alone (prelaunch, §9.3: no unit is bound yet); live reads come later through
 * the broker under the unit's own token and the same predicate. {@link packageJson} renders it as one JSON value
 * bounded on its FINAL UTF-8 bytes at {@link KNOWLEDGE_PACKAGE_MAX_BYTES}.
 *
 * {@link visibleDeps} is the same predicate's set in estate's spelling (`source:<id>`, `repo:<id>`): the estate
 * relay hands it to `knowledge.recall` as `visible` and re-checks every item against it before release.
 */

import type { SqlCatalog } from '../sources/catalog/types.js';
import { agentMay } from './gate/access.js';
import { agentStructure } from './gate/gate.js';
import type { GateSource } from './gate/sources.js';
import type { TrackerSetEntry } from './trackers/set.js';

/** The whole package's JSON, at most, in UTF-8 bytes (Ask's projection bound, DES-APPS-001 §5.4). */
export const KNOWLEDGE_PACKAGE_MAX_BYTES = 48 * 1024;

/** The package's wire name. */
export const KNOWLEDGE_PACKAGE = 'wicked.knowledge/v1';

/** One relation as a package carries it: structure only. */
export interface PackageRelation {
  /** `schema.name` as a read names it; `schema` and `name` are the identifiers themselves (a part may hold a dot). */
  table: string;
  schema: string | null;
  name: string;
  kind: string;
  columns: Array<{ name: string; type: string; nullable: boolean; enum?: string[] }>;
  columnsNotListed?: number;
  primaryKey: string[];
  foreignKeys: Array<{ columns: string[]; references: { schema: string | null; table: string; columns: string[] } }>;
}

/** One live source the project may see. */
export interface PackageSource {
  name: string;
  /** The registry's immutable id (estate's `source:<id>`). */
  id: string;
  /** The dialect: `postgres`, `mysql`, `sqlite`. */
  kind: string;
  /** Whether agents may read rows from it (the person's "Agents can query this source", for this project). */
  query: boolean;
  /** The broker subjects a unit may call for it now. */
  tools: string[];
  /** Absent when the source is not described yet (`note` says so). */
  structure?: { relations: PackageRelation[]; notListed: number };
  note?: string;
}

/**
 * (DES-PM-001 §3.2) One tracker of the unit's tracker set: its PM source, its key, the vendor's label (untrusted text,
 * inside the package's data fence) and how it is linked (to the project, or through a named repo).
 */
export interface PackageTracker {
  source: string;
  system: string;
  key: string;
  label: string;
  via: Array<{ kind: 'project' } | { kind: 'repo'; id: string }>;
}

export interface KnowledgePackage {
  package: typeof KNOWLEDGE_PACKAGE;
  projectId: string | null;
  sources: PackageSource[];
  /** (DES-PM-001 §3.2) The tracker set: present when the unit has one. */
  trackers?: PackageTracker[];
}

/** What the package reads: the gate's view of the registry (one read, the switches as stored now). */
export interface KnowledgePackageDeps {
  sources: () => Promise<GateSource[]>;
  /** (DES-PM-001 §3.2) The unit's tracker set T(u), read now; absent = no trackers in the package. */
  trackers?: (scope: { projectId: string | null; repoId: string | null }) => Promise<TrackerSetEntry[]>;
}

/** The structure of a described source, as the package carries it: the agent's projection with no row estimate. */
function structureOf(s: GateSource): NonNullable<PackageSource['structure']> {
  const st = agentStructure((s.description as NonNullable<GateSource['description']>).catalog as SqlCatalog, s.viewsAllowed);
  return {
    relations: st.relations.map((r) => ({
      table: r.table,
      schema: r.schema,
      name: r.name,
      kind: r.kind,
      columns: r.columns,
      ...(r.columnsNotListed !== undefined ? { columnsNotListed: r.columnsNotListed } : {}),
      primaryKey: r.primaryKey,
      foreignKeys: r.foreignKeys,
    })),
    notListed: st.notListed,
  };
}

/**
 * The package for a project's agents (module doc). `projectId: null` (a chat or run in no project) reaches only
 * sources set to every project, as the gate decides for a unit in no project.
 *
 * (CS10, DES-CATALOG-002 §2.d piece 4 ·4) `ctx.pick`, when an array, is the run's source pick: only sources whose
 * name is in it are disclosed — AND only trackers whose PM source name is in it (otherwise an excluded source's
 * name, keys, labels and links would still leak through `trackers`). `null` or absent discloses whatever the
 * switches allow, as before. Today the callers are chats and Apps turns (no run), so none passes a pick yet; the
 * parameter keeps the rule where the next run caller lands.
 */
export async function knowledgePackageFor(
  ctx: { projectId: string | null; repoId?: string | null; pick?: readonly string[] | null },
  deps: KnowledgePackageDeps,
): Promise<KnowledgePackage> {
  const pick = ctx.pick === undefined || ctx.pick === null ? null : new Set(ctx.pick);
  const sources: PackageSource[] = [];
  for (const s of [...(await deps.sources())].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!agentMay(s.access, s, ctx.projectId, 'see')) continue;
    if (pick !== null && !pick.has(s.name)) continue;
    const query = agentMay(s.access, s, ctx.projectId, 'query');
    const tools = s.tools
      .filter((t) => (t.disclosure === 'structure' || t.disclosure === 'none' ? true : t.disclosure === 'rows' ? query : false))
      .map((t) => `mcp:${s.name}/${t.name}`);
    const base = { name: s.name, id: s.id, kind: s.dialect, query, tools };
    if (s.description === null) {
      sources.push({ ...base, note: 'not described yet: a person tests its connection on the Data sources page first, so it cannot be queried or built on yet' });
      continue;
    }
    try {
      sources.push({ ...base, structure: structureOf(s) });
    } catch {
      sources.push({ ...base, note: 'its structure could not be read' });
    }
  }
  const set = deps.trackers === undefined ? [] : await deps.trackers({ projectId: ctx.projectId, repoId: ctx.repoId ?? null }).catch(() => []);
  // (CS10, DES-CATALOG-002 §2.d piece 4 ·4) A pick narrows the trackers too, by their PM source NAME: a tracker
  // whose source the pick excludes is not disclosed (its source name, key, label and links would otherwise leak
  // past an empty or partial pick, through `trackers`, even though `sources` was already filtered). `null`/absent
  // pick discloses them all, as before. Filtered BEFORE the count and byte bounds so bounds apply to the disclosed.
  const visibleSet = pick === null ? set : set.filter((t) => pick.has(t.source));
  // Bounded so the trackers alone always fit the package: 50 trackers, each with at most 8 ways it is linked.
  const trackers: PackageTracker[] = visibleSet.slice(0, 50).map((t) => ({ source: t.source, system: t.system, key: t.key, label: t.label, via: t.via.slice(0, 8).map((v) => ({ ...v })) }));
  // And by their serialized bytes (repo ids can be long): at most 16 KiB, the rest left out from the end.
  while (trackers.length > 0 && Buffer.byteLength(JSON.stringify(trackers), 'utf8') > 16 * 1024) trackers.pop();
  return { package: KNOWLEDGE_PACKAGE, projectId: ctx.projectId, sources, ...(trackers.length > 0 ? { trackers } : {}) };
}

/**
 * The package as one JSON value of at most `maxBytes` UTF-8 BYTES, envelope included. Sources are listed in order
 * while they fit; one whose structure does not fit is listed without it and with a note; what cannot be named at
 * all is counted (`sourcesNotListed`).
 */
export function packageJson(pkg: KnowledgePackage, maxBytes: number = KNOWLEDGE_PACKAGE_MAX_BYTES): string {
  const listed: PackageSource[] = [];
  // (DES-PM-001) The tracker set rides first: it is small (keys and labels), and it says what the issues tools reach.
  const trackers = pkg.trackers !== undefined && pkg.trackers.length > 0 ? { trackers: pkg.trackers.slice(0, 50) } : {};
  const empty = JSON.stringify({ package: pkg.package, projectId: pkg.projectId, ...trackers, sources: [], sourcesNotListed: pkg.sources.length });
  if (Buffer.byteLength(empty, 'utf8') > maxBytes) throw new Error(`a knowledge package needs at least ${Buffer.byteLength(empty, 'utf8')} bytes (bound ${maxBytes})`);
  const render = (): string => JSON.stringify({ package: pkg.package, projectId: pkg.projectId, ...trackers, sources: listed, sourcesNotListed: pkg.sources.length - listed.length });
  // Each candidate is checked with the count the final rendering would carry if nothing more were listed; listing
  // more only lowers that count, so the final rendering fits whenever the last check did.
  const fits = (): boolean => Buffer.byteLength(render(), 'utf8') <= maxBytes;
  for (const s of pkg.sources) {
    listed.push(s);
    if (fits()) continue;
    const bare: PackageSource = { ...s, note: 'its structure is left out: the package is full (mcp:<source>/list_tables has it)' };
    delete bare.structure;
    listed[listed.length - 1] = bare;
    if (!fits()) listed.pop();
  }
  return render();
}

/**
 * What a projection of `s` stood on: its descriptor AND the views a person allowed (the descriptor leaves them out,
 * yet they decide which views estate holds). The projector acknowledges this key; the visible set requires it.
 */
export function projectionKey(s: Pick<GateSource, 'descriptorHash' | 'viewsAllowed'>): string {
  return `${s.descriptorHash}\u0000${JSON.stringify([...new Set(s.viewsAllowed)].sort())}`;
}

/** Estate's spelling of a repo dep. */
export const repoDep = (repoId: string): string => `repo:${repoId}`;
/** Estate's spelling of a source dep (the registry id, never the name). */
export const sourceDep = (sourceId: string): string => `source:${sourceId}`;

/**
 * The deps a project's agents may see (§4.3): every source the predicate lets the project see AND that holds a
 * description under its current descriptor (what estate has of a source described under another descriptor, a
 * restored registry generation's for instance, stays hidden until it is described again), and the repos named
 * (the run's own, its project's). Sorted and unique.
 */
export function visibleDeps(
  sources: readonly GateSource[],
  projectId: string | null,
  repos: readonly string[],
  /** The {@link projectionKey} estate holds per source id (the projector's acknowledgements); absent = trust the stored description. */
  projected?: (sourceId: string) => string | null,
  /** (DES-PM-001 §3.4) The unit's trackers (T(u)) whose projection estate has taken: each is `source:<tracker id>`, and the project joins as `project:<id>`. */
  trackers: readonly string[] = [],
): string[] {
  const out = new Set<string>();
  for (const t of trackers) if (typeof t === 'string' && t !== '') out.add(sourceDep(t));
  if (trackers.length > 0 && projectId !== null) out.add(`project:${projectId}`);
  for (const s of sources) {
    if (s.description === null || !agentMay(s.access, s, projectId, 'see')) continue;
    // What estate holds must be this descriptor's: a projection still pending, or one that failed after a
    // descriptor change, leaves the earlier descriptor's structure in estate, and it is never released.
    if (projected !== undefined && projected(s.id) !== projectionKey(s)) continue;
    out.add(sourceDep(s.id));
  }
  for (const r of repos) if (typeof r === 'string' && r.trim() !== '') out.add(repoDep(r));
  return [...out].sort();
}
