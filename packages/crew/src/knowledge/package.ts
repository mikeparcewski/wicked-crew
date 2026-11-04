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

export interface KnowledgePackage {
  package: typeof KNOWLEDGE_PACKAGE;
  projectId: string | null;
  sources: PackageSource[];
}

/** What the package reads: the gate's view of the registry (one read, the switches as stored now). */
export interface KnowledgePackageDeps {
  sources: () => Promise<GateSource[]>;
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
 */
export async function knowledgePackageFor(ctx: { projectId: string | null }, deps: KnowledgePackageDeps): Promise<KnowledgePackage> {
  const sources: PackageSource[] = [];
  for (const s of [...(await deps.sources())].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!agentMay(s.access, s, ctx.projectId, 'see')) continue;
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
  return { package: KNOWLEDGE_PACKAGE, projectId: ctx.projectId, sources };
}

/**
 * The package as one JSON value of at most `maxBytes` UTF-8 BYTES, envelope included. Sources are listed in order
 * while they fit; one whose structure does not fit is listed without it and with a note; what cannot be named at
 * all is counted (`sourcesNotListed`).
 */
export function packageJson(pkg: KnowledgePackage, maxBytes: number = KNOWLEDGE_PACKAGE_MAX_BYTES): string {
  const listed: PackageSource[] = [];
  const render = (): string => JSON.stringify({ package: pkg.package, projectId: pkg.projectId, sources: listed, sourcesNotListed: pkg.sources.length - listed.length });
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
export function visibleDeps(sources: readonly GateSource[], projectId: string | null, repos: readonly string[]): string[] {
  const out = new Set<string>();
  for (const s of sources) if (s.description !== null && agentMay(s.access, s, projectId, 'see')) out.add(sourceDep(s.id));
  for (const r of repos) if (typeof r === 'string' && r.trim() !== '') out.add(repoDep(r));
  return [...out].sort();
}
