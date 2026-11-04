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
 * The generation is the description's `describedAt` (ms) times 16 plus {@link PROJECTION_FORMAT}: monotonic per
 * source with no counter of crew's own, and a new projection format re-projects an unchanged catalog.
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

/** One relation's document, its columns cut (and counted) until estate's record bound holds. */
function relationDoc(source: string, r: Relation): ReplaceSourceArgs['docs'][number] {
  let columns = [...r.columns];
  const make = (): ReplaceSourceArgs['docs'][number] => {
    const notListed = (r.columnsNotListed ?? 0) + (r.columns.length - columns.length);
    const entry: Record<string, unknown> = {
      relation: r.table,
      kind: r.kind,
      columns,
      ...(notListed > 0 ? { columnsNotListed: notListed } : {}),
      primaryKey: r.primaryKey,
      foreignKeys: r.foreignKeys,
    };
    const listed = columns.length > 0 ? columns.map(columnText).join('; ') : 'none listed';
    const more = notListed > 0 ? ` (${notListed} more not listed)` : '';
    const sections = [{ key: 'columns', text: `${r.table}: a ${r.kind} in data source ${source}. Columns: ${listed}${more}.` }];
    const fks = r.foreignKeys.map((f) => `(${f.columns.join(', ')}) references ${f.references.schema === null ? '' : `${f.references.schema}.`}${f.references.table} (${f.references.columns.join(', ')})`);
    if (r.primaryKey.length > 0 || fks.length > 0) {
      sections.push({ key: 'keys', text: `${r.table}: ${r.primaryKey.length > 0 ? `primary key (${r.primaryKey.join(', ')})` : 'no primary key'}${fks.length > 0 ? `; foreign keys: ${fks.join('; ')}` : ''}.` });
    }
    return { key: r.table, title: `${source} · ${r.table}`, entry, sections };
  };
  // Estate prefixes a section's text with the doc key when it does not start with it; ours always does.
  let doc = make();
  while (columns.length > 0 && (bytes(doc) > DOC_RECORD_MAX_BYTES || doc.sections.some((s) => bytes(s.text) > SECTION_TEXT_MAX_BYTES))) {
    columns = columns.slice(0, Math.max(0, Math.floor(columns.length * 0.8)));
    doc = make();
  }
  return doc;
}

/**
 * The complete generation for one described source (module doc), or `null` when it has no stored structure under
 * its current descriptor. Pure.
 */
export function sourceGeneration(s: Pick<GateSource, 'id' | 'name' | 'dialect' | 'description' | 'viewsAllowed'>): ReplaceSourceArgs | null {
  if (s.description === null) return null;
  const catalog = s.description.catalog as SqlCatalog;
  const st = agentStructure(catalog, s.viewsAllowed);
  const describedMs = Date.parse(catalog.describedAt);
  const ms = Number.isFinite(describedMs) && describedMs > 0 ? describedMs : Date.now();
  return {
    sourceId: s.id,
    generation: ms * 16 + PROJECTION_FORMAT,
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
}

/** The one writer of source structure into estate (module doc). */
export class SourceProjector {
  private readonly call: EstateCall;
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly deps: SourceProjectorDeps) {
    this.call = deps.call ?? ((tool, args) => callEstateTool(tool, args));
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
    const gen = sourceGeneration(s);
    if (gen === null) return false;
    await this.call('knowledge.replace_source', gen as unknown as Record<string, unknown>);
    return true;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
