/**
 * Describe → estate (DES-KNOWLEDGE-DATA-001 §4.1): every time crew stores a source's catalog, the same STRUCTURE is
 * projected into estate's knowledge plane as ONE complete generation (`knowledge.replace_source`), so recall finds
 * `support.tickets` beside the code and the documents, and the combined view can link it.
 *
 * Value-free by construction ({@link sourceGeneration}): it is built from the stored catalog through the gate's
 * readable filter ({@link projectableRelations}: EVERY relation a read may name, with its columns, types,
 * nullability, keys and the enum literals the schema declares; no prompt budget, since estate tombstones what a
 * generation omits). It never holds a row, a row estimate, a default, a comment, a credential, a host, a login, a
 * database name or a path. The documents are keyed by the registry entry's immutable id (never its name), one per
 * relation, and estate gates every one of them by that id (`deps`), so only a unit whose project may see the
 * source ever recalls them (the relay's `visible` set, which also waits for estate to accept the projection of the
 * source's current descriptor: {@link SourceProjector.projectedDescriptor}).
 *
 * The generation is the time of the projection (ms) times 16 plus {@link PROJECTION_FORMAT}, above the last one
 * this process sent for the source ({@link SourceProjector}): monotonic per source in the order its catalogs were
 * stored, with no counter of crew's own on disk. The boot backfill projects every described source again.
 *
 * Fire and forget: a describe never fails because estate is missing, older than the knowledge plane, or refused
 * the generation; that is logged and the next describe projects again. Jobs run one at a time per source, in
 * order, after the registry mutation that wrote the catalog has landed.
 */

import { createHash } from 'node:crypto';

import { callEstateTool } from '../core/estate-mcp-client.js';
import { Semaphore } from '../mcp/estate-relay.js';
import { normalizeRegistryFile } from '../mcp/registry.js';
import type { McpRegistryStore } from '../mcp/registry-store.js';
import { ASK_ENUM_MAX, ASK_NAME_MAX } from '../sources/ask.js';
import type { SqlCatalog } from '../sources/catalog/types.js';
import type { SourceCatalogStore } from '../sources/store.js';
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

/** Estate's per-generation bounds (estate#389 `source.rs`): a source over them is refused whole, never cut. */
export const GENERATION_MAX_DOCS = 5_000;
export const GENERATION_MAX_BYTES = 32 * 1024 * 1024;
/** Estate refuses a key or title over 512 bytes; crew keeps under this. */
const NAME_MAX_BYTES = 500;
/** At most this many estate writes run at once (a boot backfill over many sources). */
export const PROJECTION_CONCURRENCY = 2;

/** One relation as the projection holds it: structure only, no row estimate (the field does not exist here). */
interface Column {
  name: string;
  type: string;
  nullable: boolean;
  enum?: string[];
}
interface Relation {
  schema: string | null;
  name: string;
  /** `schema.name` as a read names it. */
  table: string;
  kind: string;
  columns: Column[];
  columnsNotListed?: number;
  primaryKey: string[];
  foreignKeys: Array<{ columns: string[]; references: { schema: string | null; table: string; columns: string[] } }>;
}

const bytes = (v: unknown): number => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v), 'utf8');

/** `text` cut to at most `max` UTF-8 bytes, on a character boundary. */
function cutBytes(text: string, max: number): string {
  if (Buffer.byteLength(text, 'utf8') <= max) return text;
  let out = '';
  for (const ch of text) {
    if (Buffer.byteLength(out + ch, 'utf8') > max - 3) break;
    out += ch;
  }
  return `${out}…`;
}

/**
 * EVERY relation an agent may name (the gate's readable filter: base tables, partitions, views and materialized
 * views a person allowed by name, never a foreign table; names within Ask's length), each with its columns, keys
 * and declared enum literals. Unlike the prompt projection, no whole-catalog budget applies: the projection is a
 * complete generation, and estate tombstones what it does not name.
 */
export function projectableRelations(catalog: SqlCatalog, viewsAllowed: readonly string[]): Relation[] {
  const allowed = new Set(viewsAllowed);
  const fits = (n: string | null): boolean => n === null || n.length <= ASK_NAME_MAX;
  const qualified = (schema: string | null, name: string): string => (schema === null ? name : `${schema}.${name}`);
  // MySQL: every relation's "schema" is the connected database, a connection detail; tables go unqualified.
  const mysql = catalog.dialect === 'mysql';
  return catalog.relations
    .filter((r) => fits(r.schema) && fits(r.name) && (r.kind === 'table' || r.kind === 'partitioned' || ((r.kind === 'view' || r.kind === 'matview') && allowed.has(qualified(r.schema, r.name)))))
    .map((r) => {
      const schema = mysql ? null : r.schema;
      const columns = r.columns
        .filter((c) => fits(c.name))
        .map((c) => ({
          name: c.name,
          type: c.type.slice(0, ASK_NAME_MAX),
          nullable: c.nullable,
          ...(c.enumValues !== undefined && c.enumValues.length > 0 ? { enum: c.enumValues.filter((v) => v.length <= ASK_NAME_MAX).slice(0, ASK_ENUM_MAX) } : {}),
        }));
      return {
        schema,
        name: r.name,
        table: qualified(schema, r.name),
        kind: r.kind,
        columns,
        ...(columns.length < r.columns.length ? { columnsNotListed: r.columns.length - columns.length } : {}),
        primaryKey: r.primaryKey.filter(fits),
        foreignKeys: r.foreignKeys
          .filter((f) => fits(f.references.schema) && fits(f.references.table))
          .map((f) => ({ columns: [...f.columns], references: { schema: mysql && f.references.schema === catalog.database ? null : f.references.schema, table: f.references.table, columns: [...f.references.columns] } })),
      };
    });
}

function columnText(c: Column): string {
  const enumPart = c.enum !== undefined && c.enum.length > 0 ? ` (one of: ${c.enum.join(', ')})` : '';
  return `${c.name} ${c.type}${c.nullable ? '' : ' not null'}${enumPart}`;
}

/**
 * A relation's document key: its identifier as SQL spells it, a part quoted when it is not a plain identifier (so
 * `"a.b".c` and `a."b.c"` stay two keys), with a backslash and every control character escaped inside the quotes
 * (estate refuses a control character in a key; the escape keeps distinct names distinct). A key over estate's
 * byte bound becomes a stable hash of the identifiers; the exact identifiers always ride in the entry.
 */
export function relationKey(schema: string | null, name: string): string {
  const part = (x: string): string =>
    /^[A-Za-z_][A-Za-z0-9_$]*$/.test(x)
      ? x
      : `"${x
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '""')
          // eslint-disable-next-line no-control-regex
          .replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;
  const key = schema === null ? part(name) : `${part(schema)}.${part(name)}`;
  return Buffer.byteLength(key, 'utf8') <= NAME_MAX_BYTES ? key : `relation:${createHash('sha256').update(JSON.stringify([schema, name])).digest('hex').slice(0, 32)}`;
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
    return { key, title: cutBytes(`${source} · ${key}`, NAME_MAX_BYTES), entry, sections };
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
    title: cutBytes(`${source} · ${key}`, NAME_MAX_BYTES),
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
  const relations = projectableRelations(catalog, s.viewsAllowed);
  const docs = relations.map((r) => relationDoc(s.name, r));
  // A source over estate's generation bounds is refused whole: a partial generation would tombstone what it omits.
  if (docs.length > GENERATION_MAX_DOCS || docs.reduce((n, d) => n + bytes(d), 0) > GENERATION_MAX_BYTES) {
    throw new Error(`${s.name} has ${docs.length} relations, over what one estate generation holds; its structure is not projected`);
  }
  return {
    sourceId: s.id,
    generation,
    label: s.name,
    catalog: { source: s.name, kind: s.dialect, relations: docs.length, describedAt: catalog.describedAt ?? null, format: PROJECTION_FORMAT },
    docs,
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
  /** Per source id, the descriptor whose catalog estate last ACCEPTED (this process). */
  private readonly acked = new Map<string, string>();
  private readonly gate = new Semaphore(PROJECTION_CONCURRENCY);

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
    await this.gate.run(() => this.call('knowledge.replace_source', gen as unknown as Record<string, unknown>));
    this.acked.set(s.id, s.descriptorHash);
    return true;
  }

  /**
   * The descriptor whose structure estate holds for `sourceId`, as this process last saw estate accept it; `null`
   * until then. The relay's visible set admits a source only while this equals its current descriptor, so what
   * estate still holds of an earlier descriptor (a projection pending or failed) is never released.
   */
  projectedDescriptor(sourceId: string): string | null {
    return this.acked.get(sourceId) ?? null;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
