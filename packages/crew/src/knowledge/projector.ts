/**
 * Describe → estate (DES-KNOWLEDGE-DATA-001 §4.1): every time crew stores a source's catalog, the same STRUCTURE is
 * projected into estate's knowledge plane as ONE complete generation (`knowledge.replace_source`), so recall finds
 * `support.tickets` beside the code and the documents, and the combined view can link it.
 *
 * Value-free by construction ({@link sourceGeneration}): it is built from the gate's own agent projection of the
 * stored catalog (`agentStructure`: the relations a read may name, their columns, types, nullability, keys and the
 * enum literals the schema declares). It never holds a row, a row estimate, a default, a comment, a credential, a
 * host, a login, a database name or a path. The documents are keyed by the registry entry's immutable id (never
 * its name), one per relation, and estate gates every one of them by that id (`deps`), so only a unit whose
 * project may see the source ever recalls them (the relay's `visible` set).
 *
 * The generation is the time of the projection (ms) times 16 plus {@link PROJECTION_FORMAT}, above the last one
 * this process sent for the source ({@link SourceProjector}): monotonic per source in the order its catalogs were
 * stored, with no counter of crew's own on disk. The boot backfill projects every described source again.
 *
 * Fire and forget: a describe never fails because estate is missing, older than the knowledge plane, or refused
 * the generation; that is logged and the next describe projects again. Jobs run one at a time per source, in
 * order, after the registry mutation that wrote the catalog has landed.
 */

import { callEstateTool } from '../core/estate-mcp-client.js';
import { normalizeRegistryFile } from '../mcp/registry.js';
import type { McpRegistryStore } from '../mcp/registry-store.js';
import type { SqlCatalog } from '../sources/catalog/types.js';
import type { SourceCatalogStore } from '../sources/store.js';
import { agentStructure } from './gate/gate.js';
import { gateSourceOf, type GateSource } from './gate/sources.js';

/** Bumped when the documents' shape changes, so an unchanged catalog is projected again in the new shape. */
export const PROJECTION_FORMAT = 1;
/** Estate refuses a document record over 18,000 bytes; crew keeps under this, cutting columns honestly. */
export const DOC_RECORD_MAX_BYTES = 17_000;
/** Estate's per-section text bound. */
export const SECTION_TEXT_MAX_BYTES = 16 * 1024;

export interface ReplaceSourceArgs {
  sourceId: string;
  generation: number;
  label: string;
  catalog: Record<string, unknown>;
  docs: Array<{ key: string; title: string; entry: Record<string, unknown>; sections: Array<{ key: string; text: string }> }>;
}

type Relation = ReturnType<typeof agentStructure>['relations'][number];
type Column = Relation['columns'][number];

const bytes = (v: unknown): number => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v), 'utf8');

function columnText(c: Column): string {
  const enumPart = c.enum !== undefined && c.enum.length > 0 ? ` (one of: ${c.enum.join(', ')})` : '';
  return `${c.name} ${c.type}${c.nullable ? '' : ' not null'}${enumPart}`;
}

/** A relation's identifier as SQL spells it, quoted only when a part could make the dotted form ambiguous. */
export function relationKey(schema: string | null, name: string): string {
  const part = (x: string): string => (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(x) ? x : `"${x.replace(/"/g, '""')}"`);
  return schema === null ? part(name) : `${part(schema)}.${part(name)}`;
}

/**
 * One relation's document, bounded by estate's record bound: columns are cut (and counted) first, then foreign
 * keys; a relation that still does not fit is named with its kind and a note, so one wide table never costs the
 * source its whole generation.
 */
function relationDoc(source: string, r: Relation): ReplaceSourceArgs['docs'][number] {
  const key = relationKey(r.schema, r.name);
  let columns = [...r.columns];
  let fkeys = [...r.foreignKeys];
  const make = (): ReplaceSourceArgs['docs'][number] => {
    const notListed = (r.columnsNotListed ?? 0) + (r.columns.length - columns.length);
    const fkNotListed = r.foreignKeys.length - fkeys.length;
    const entry: Record<string, unknown> = {
      relation: r.table,
      schema: r.schema,
      name: r.name,
      kind: r.kind,
      columns,
      ...(notListed > 0 ? { columnsNotListed: notListed } : {}),
      primaryKey: r.primaryKey,
      foreignKeys: fkeys,
      ...(fkNotListed > 0 ? { foreignKeysNotListed: fkNotListed } : {}),
    };
    const listed = columns.length > 0 ? columns.map(columnText).join('; ') : 'none listed';
    const more = notListed > 0 ? ` (${notListed} more not listed)` : '';
    const sections = [{ key: 'columns', text: `${key}: a ${r.kind} in data source ${source}. Columns: ${listed}${more}.` }];
    const fks = fkeys.map((f) => `(${f.columns.join(', ')}) references ${relationKey(f.references.schema, f.references.table)} (${f.references.columns.join(', ')})`);
    if (fkNotListed > 0) fks.push(`${fkNotListed} more not listed`);
    if (r.primaryKey.length > 0 || fks.length > 0) {
      sections.push({ key: 'keys', text: `${key}: ${r.primaryKey.length > 0 ? `primary key (${r.primaryKey.join(', ')})` : 'no primary key'}${fks.length > 0 ? `; foreign keys: ${fks.join('; ')}` : ''}.` });
    }
    return { key, title: `${source} · ${r.table}`, entry, sections };
  };
  const over = (d: ReturnType<typeof make>): boolean => bytes(d) > DOC_RECORD_MAX_BYTES || d.sections.some((x) => bytes(x.text) > SECTION_TEXT_MAX_BYTES);
  // Estate prefixes a section's text with the doc key when it does not start with it; ours always does.
  let doc = make();
  while (over(doc) && columns.length > 0) {
    columns = columns.slice(0, Math.floor(columns.length * 0.8));
    doc = make();
  }
  while (over(doc) && fkeys.length > 0) {
    fkeys = fkeys.slice(0, Math.floor(fkeys.length * 0.8));
    doc = make();
  }
  if (!over(doc)) return doc;
  return {
    key,
    title: `${source} · ${r.table}`.slice(0, 500),
    entry: { relation: r.table, schema: r.schema, name: r.name, kind: r.kind, tooLarge: true },
    sections: [{ key: 'columns', text: `${key}: a ${r.kind} in data source ${source}; its structure is too large to list here (mcp:${source}/list_tables has it).` }],
  };
}

/**
 * The complete generation for one described source (module doc), or `null` when it has no stored structure under
 * its current descriptor. Pure: `generation` is the caller's.
 */
export function sourceGeneration(s: Pick<GateSource, 'id' | 'name' | 'dialect' | 'description' | 'viewsAllowed'>, generation: number): ReplaceSourceArgs | null {
  if (s.description === null) return null;
  const catalog = s.description.catalog as SqlCatalog;
  const st = agentStructure(catalog, s.viewsAllowed);
  return {
    sourceId: s.id,
    generation,
    label: s.name,
    catalog: { source: s.name, kind: s.dialect, relations: st.relations.length, notListed: st.notListed, describedAt: catalog.describedAt ?? null, format: PROJECTION_FORMAT },
    docs: st.relations.map((r) => relationDoc(s.name, r)),
  };
}

export type EstateCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

export interface SourceProjectorDeps {
  /** The registry (read after the mutation that wrote a catalog has landed). */
  store: Pick<McpRegistryStore, 'read' | 'settled'>;
  catalogs: SourceCatalogStore;
  /** Estate, in write mode (the operator client's spawn). */
  call?: EstateCall;
  log?: (message: string) => void;
  /** TESTS ONLY: the clock generations are taken from. */
  now?: () => number;
}

/** The one writer of source structure into estate (module doc). */
export class SourceProjector {
  private readonly call: EstateCall;
  private readonly now: () => number;
  private readonly chains = new Map<string, Promise<void>>();
  /** The last generation sent per source id (this process): the next is always higher. */
  private readonly sent = new Map<string, number>();

  constructor(private readonly deps: SourceProjectorDeps) {
    this.call = deps.call ?? ((tool, args) => callEstateTool(tool, args));
    this.now = deps.now ?? Date.now;
  }

  /**
   * The generation of a projection made now: the time it is made (ms) times 16 plus {@link PROJECTION_FORMAT}, and
   * above the last one sent for that source. Projections of a source run one at a time in the order its catalogs
   * were stored, each reading the catalog stored NOW, so the latest catalog always carries the highest generation
   * (a description's own `describedAt` does not: a held preview is described before it is saved).
   */
  private nextGeneration(sourceId: string): number {
    const g = Math.max(this.now() * 16 + PROJECTION_FORMAT, (this.sent.get(sourceId) ?? 0) + 16);
    this.sent.set(sourceId, g);
    return g;
  }

  /** A catalog for `name` was stored: project it once the write has landed. Never throws. */
  written(name: string): void {
    const prior = this.chains.get(name) ?? Promise.resolve();
    const next: Promise<void> = prior
      .then(async () => {
        await this.project(name);
      })
      .catch((err: unknown) => {
        this.deps.log?.(`[knowledge] ${name}'s structure was not projected into estate: ${message(err)}`);
      });
    this.chains.set(name, next);
    void next.then(() => {
      if (this.chains.get(name) === next) this.chains.delete(name);
    });
  }

  /** Every described source, once (a daemon's first boot on this release projects what was described before it). */
  async backfill(): Promise<void> {
    let names: string[];
    try {
      names = normalizeRegistryFile(await this.deps.store.read()).servers.map((s) => s.name);
    } catch (err) {
      this.deps.log?.(`[knowledge] the registry could not be read to project source structure: ${message(err)}`);
      return;
    }
    for (const n of names) this.written(n);
    await this.idle();
  }

  /** Every queued projection has finished (tests; the boot backfill). */
  async idle(): Promise<void> {
    while (this.chains.size > 0) await Promise.all([...this.chains.values()]);
  }

  /** Project `name` now: `true` when estate took a generation. */
  async project(name: string): Promise<boolean> {
    await this.deps.store.settled();
    const r = normalizeRegistryFile(await this.deps.store.read()).servers.find((x) => x.name === name);
    if (r === undefined) return false;
    const s = await gateSourceOf(r, this.deps.catalogs);
    if (s === null) return false;
    if (s.description === null) return false;
    const gen = sourceGeneration(s, this.nextGeneration(s.id));
    if (gen === null) return false;
    await this.call('knowledge.replace_source', gen as unknown as Record<string, unknown>);
    return true;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
