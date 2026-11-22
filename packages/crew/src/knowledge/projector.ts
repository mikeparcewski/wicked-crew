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

import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { callEstateTool } from '../core/estate-mcp-client.js';
import { Semaphore } from '../mcp/estate-relay.js';
import { dropEstateTombstones, entryId, normalizeRegistryFile } from '../mcp/registry.js';
import type { McpRegistryStore } from '../mcp/registry-store.js';
import { ASK_ENUM_MAX, ASK_NAME_MAX } from '../sources/ask.js';
import type { SqlCatalog } from '../sources/catalog/types.js';
import type { SourceCatalogStore } from '../sources/store.js';
import { onEstateLane, replaceSource } from './estate-write.js';
import { gateSourceOf, type GateSource } from './gate/sources.js';
import { projectionKey } from './package.js';

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

/** Estate's per-generation bounds (estate#389 `source.rs`): estate refuses a generation over them. */
export const GENERATION_MAX_DOCS = 5_000;
export const GENERATION_MAX_BYTES = 32 * 1024 * 1024;
/** (crew#1328) The document that says how many relations a source over those bounds does not list here. */
export const NOT_LISTED_KEY = '~relations-not-listed';
/** Estate refuses a key or title over 512 bytes; crew keeps under this. */
const NAME_MAX_BYTES = 500;
/** Build one source generation at a time; estate writes also share a single lane with trackers. */
export const PROJECTION_CONCURRENCY = 1;

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
 * source its whole generation. `partial`: the source is over one generation, so not every relation is listed; each
 * document says so (its entry, and the head of its text, which a recall hit's snippet carries), so an agent whose
 * recall misses a table never reads that as "no such table" (coord on #1735, 1735-1).
 */
function relationDoc(source: string, r: Relation, partial = false): ReplaceSourceArgs['docs'][number] {
  const key = relationKey(r.schema, r.name);
  const where = partial ? `data source ${source} (whose knowledge catalog is partial: not every relation is listed; read one by name with mcp:${source}/list_tables and table_names)` : `data source ${source}`;
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
      ...(partial ? { catalogPartial: true } : {}),
    };
    const listed = columns.length > 0 ? columns.map(columnText).join('; ') : 'none listed';
    const more = notListed > 0 ? ` (${notListed} more not listed)` : '';
    const sections = [{ key: 'columns', text: `${key}: a ${r.kind} in ${where}. Columns: ${listed}${more}.` }];
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
    entry: { relation: r.table, schema: r.schema, name: r.name, kind: r.kind, tooLarge: true, ...(partial ? { catalogPartial: true } : {}) },
    sections: [{ key: 'columns', text: `${key}: a ${r.kind} in ${where}; its structure is too large to list here (mcp:${source}/list_tables has it).` }],
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
  let all = relations.map((r) => relationDoc(s.name, r));
  // Over one generation: every relation document says the catalog is partial (1735-1), then the cut is taken.
  if (!withinBounds(all)) all = relations.map((r) => relationDoc(s.name, r, true));
  const { docs, notListed } = withinGenerationBounds(s.name, all);
  return {
    sourceId: s.id,
    generation,
    label: s.name,
    catalog: { source: s.name, kind: s.dialect, relations: all.length - notListed, ...(notListed > 0 ? { relationsNotListed: notListed } : {}), describedAt: catalog.describedAt ?? null, format: PROJECTION_FORMAT },
    docs,
  };
}

/**
 * (crew#1328) A source over one estate generation (5,000 documents or 32 MB) used to be refused whole, so none of its
 * structure reached recall. Now each relation document says the catalog is partial (relationDoc), its relations go in
 * catalog order while they fit, and one more document says how many
 * are not listed here and how to read one by name (`mcp:<source>/list_tables` with `table_names`), as a relation too
 * wide to list is named (relationDoc). The generation is complete as estate counts it: a relation it does not list is
 * not in estate (one listed by an earlier generation is deleted by this one), and the catalog says so
 * (`relationsNotListed`, which a catalog read reports as truncated).
 */
function withinBounds(all: ReplaceSourceArgs['docs']): boolean {
  return all.length <= GENERATION_MAX_DOCS && all.reduce((n, d) => n + bytes(d), 0) <= GENERATION_MAX_BYTES;
}

function withinGenerationBounds(source: string, all: ReplaceSourceArgs['docs']): { docs: ReplaceSourceArgs['docs']; notListed: number } {
  if (withinBounds(all)) return { docs: all, notListed: 0 };
  const note = (n: number): ReplaceSourceArgs['docs'][number] => ({
    key: NOT_LISTED_KEY,
    title: cutBytes(`${source} · relations not listed here`, NAME_MAX_BYTES),
    entry: { kind: 'not_listed', relationsNotListed: n },
    sections: [{ key: 'note', text: `${NOT_LISTED_KEY}: data source ${source} has ${n} more relations than one knowledge generation holds; they are not listed here. Read one by name with mcp:${source}/list_tables and table_names.` }],
  });
  // The note's bytes are reserved at the largest count it can say, so it always fits.
  const budget = GENERATION_MAX_BYTES - bytes(note(all.length));
  const docs: ReplaceSourceArgs['docs'] = [];
  let used = 0;
  for (const d of all) {
    const b = bytes(d);
    if (docs.length >= GENERATION_MAX_DOCS - 1 || used + b > budget) break;
    docs.push(d);
    used += b;
  }
  const notListed = all.length - docs.length;
  docs.push(note(notListed));
  return { docs, notListed };
}

export type EstateCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

export interface SourceProjectorDeps {
  /** The registry (read after the mutation that wrote a catalog has landed). */
  /** `amend` drops an erased source's tombstone (the daemon's store has it; a test that erases nothing may omit it). */
  store: Pick<McpRegistryStore, 'read' | 'settled'> & Partial<Pick<McpRegistryStore, 'amend'>>;
  catalogs: SourceCatalogStore;
  /** Estate, in write mode (the operator client's spawn). */
  call?: EstateCall;
  log?: (message: string) => void;
  /** TESTS ONLY: the clock generations are taken from. */
  now?: () => number;
  /** TESTS ONLY: the wait between SQLite contention retries. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * (crew#1328) Where the acknowledgements are kept across a restart (`<mcp state>/knowledge-acks.json`); absent = in
   * memory only. A file that cannot be read starts empty (each source then waits for its next projection, as before).
   * (crew#1741) One read back from it is provisional until estate is seen to hold its generation (the boot backfill
   * checks, then projects).
   */
  acksFile?: string;
  /** TESTS ONLY: how a refused erasure is retried later. */
  schedule?: (fn: () => void, ms: number) => void;
}

/** (crew#1741) The acknowledgement file's version: each entry names the generation estate took. */
const ACKS_VERSION = 2;

/** One acknowledgement (see {@link SourceProjector}'s `acked`). */
interface Ack {
  key: string;
  generation: number;
  confirmed: boolean;
}

/** A refused erasure is tried again after this long (and at the next boot). */
const ERASE_RETRY_MS = 5 * 60_000;

/** The empty generation that erases a removed data source's structure from estate (crew#1328 item 1). */
export function removedSourceGeneration(sourceId: string, generation: number): ReplaceSourceArgs {
  return { sourceId, generation, label: 'removed source', catalog: { removed: true, format: PROJECTION_FORMAT }, docs: [] };
}

/** The one writer of source structure into estate (module doc). */
export class SourceProjector {
  private readonly call: EstateCall;
  private readonly now: () => number;
  private readonly chains = new Map<string, Promise<void>>();
  /** The last generation sent per source id (this process): the next is always higher. */
  private readonly sent = new Map<string, number>();
  /**
   * Per source id, the projection key (descriptor and allowed views) and the generation estate last ACCEPTED.
   * `confirmed` = this process saw estate take it, or saw estate still hold that generation (crew#1741): one read back
   * from the file is not, since estate's store may have been swapped or rolled back while crew was down.
   */
  private readonly acked = new Map<string, Ack>();
  private readonly gate = new Semaphore(PROJECTION_CONCURRENCY);
  /**
   * (crew#1328, codex and agy on #1735) Per source id, the one lane every estate write of that id runs on: a
   * projection and an erasure. Each job reads the registry INSIDE the lane and acts on what it holds then, and every
   * registry change that matters to an id (a catalog written, a removal, a restore) queues a job after it lands, so
   * the last write estate takes for an id always matches the registry: a removal is never followed by a projection of
   * what was removed, and a restore is never followed by an erasure of what it brought back.
   */
  private readonly lanes = new Map<string, Promise<void>>();

  constructor(private readonly deps: SourceProjectorDeps) {
    this.call = deps.call ?? ((tool, args) => callEstateTool(tool, args));
    this.now = deps.now ?? Date.now;
    if (deps.acksFile !== undefined) {
      try {
        const raw = JSON.parse(readFileSync(deps.acksFile, 'utf8')) as { version?: unknown; acked?: unknown };
        // A version 1 file (crew#1735) names no generation, so none of it can be confirmed: each source waits for its
        // boot projection, and the next write replaces the file.
        if (raw.version !== 1 && (raw.version !== ACKS_VERSION || typeof raw.acked !== 'object' || raw.acked === null || Array.isArray(raw.acked))) throw new Error(`not a version ${ACKS_VERSION} acknowledgement file`);
        if (raw.version === ACKS_VERSION) {
          for (const [id, v] of Object.entries(raw.acked as Record<string, unknown>)) {
            const a = v as { key?: unknown; generation?: unknown } | null;
            if (typeof a === 'object' && a !== null && typeof a.key === 'string' && typeof a.generation === 'number' && Number.isSafeInteger(a.generation)) this.acked.set(id, { key: a.key, generation: a.generation, confirmed: false });
          }
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') deps.log?.(`[knowledge] the projection acknowledgements could not be read, so each source waits for its next projection: ${message(err)}`);
      }
    }
  }

  /**
   * Write the acknowledgements (atomic and durable: the file is flushed before the rename, the directory synced after
   * it, as `api/run-sources.ts` does). Throws: a caller that must not go on without it says so.
   */
  private persistAcks(): void {
    const file = this.deps.acksFile;
    if (file === undefined) return;
    const dir = dirname(file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomUUID()}.tmp`;
    const acked = Object.fromEntries([...this.acked].map(([id, a]) => [id, { key: a.key, generation: a.generation }]));
    try {
      writeFileSync(tmp, JSON.stringify({ version: ACKS_VERSION, acked }), { flag: 'wx', mode: 0o600, flush: true });
      renameSync(tmp, file);
    } finally {
      rmSync(tmp, { force: true });
    }
    // The rename has committed: a directory sync that fails is said, never the write's failure.
    try {
      const fd = openSync(dir, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      this.deps.log?.(`[knowledge] the acknowledgements' directory could not be synced: ${message(err)}`);
    }
  }

  /**
   * (crew#1741) On `sourceId`'s lane: confirm an acknowledgement read back from the file when estate's committed
   * generation for the source is the acknowledged one. Anything else (another generation, no catalog, estate failing)
   * leaves it provisional: the source waits for its projection. Never throws.
   */
  private async confirmNow(sourceId: string): Promise<void> {
    const ack = this.acked.get(sourceId);
    if (ack === undefined || ack.confirmed) return;
    let held: unknown;
    try {
      // On the one estate lane the writes share: N kept acknowledgements never start N estate processes at once.
      held = await onEstateLane(() => this.call('knowledge.source_catalog', { sourceId, page: 0, visible: [`source:${sourceId}`] }));
    } catch (err) {
      this.deps.log?.(`[knowledge] estate's generation of ${sourceId} could not be read, so it waits for its projection: ${message(err)}`);
      return;
    }
    const generation = typeof held === 'object' && held !== null ? (held as { generation?: unknown }).generation : undefined;
    if (this.acked.get(sourceId) === ack && generation === ack.generation) ack.confirmed = true;
  }

  /**
   * Drop `sourceId`'s acknowledgement on disk before estate is sent anything that may replace it, so a crash mid-send
   * leaves none, never one for a key estate may no longer hold. Throws when the drop cannot be written, and then keeps
   * the acknowledgement in memory too (codex and agy on #1735): the next attempt drops it again before ITS send.
   */
  private dropAck(sourceId: string): void {
    const prior = this.acked.get(sourceId);
    if (prior === undefined) return;
    this.acked.delete(sourceId);
    try {
      this.persistAcks();
    } catch (err) {
      this.acked.set(sourceId, prior);
      throw err;
    }
  }

  /** Run `fn` on `sourceId`'s lane (after every job queued there before it). */
  private exclusive<T>(sourceId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.lanes.get(sourceId) ?? Promise.resolve();
    const run = prior.then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.lanes.set(sourceId, tail);
    void tail.then(() => {
      if (this.lanes.get(sourceId) === tail) this.lanes.delete(sourceId);
    });
    return run;
  }

  /**
   * (crew#1328, crew#1354) Data sources the registry tombstoned (a removal, a restore that dropped them): each one's
   * structure is erased from estate on its lane. Never throws; a refused erasure is retried (and the boot backfill
   * erases every tombstone still in the registry).
   */
  erase(sourceIds: readonly string[]): void {
    for (const id of new Set(sourceIds)) {
      const key = `\u0000erase:${id}`;
      const prior = this.chains.get(key) ?? Promise.resolve();
      const next: Promise<void> = prior
        .then(() => this.exclusive(id, () => this.eraseNow(id)))
        .catch((err: unknown) => {
          this.deps.log?.(`[knowledge] the structure of removed source ${id} was not erased from estate (it is retried): ${message(err)}`);
          (this.deps.schedule ?? ((fn, ms) => void setTimeout(fn, ms).unref?.()))(() => this.erase([id]), ERASE_RETRY_MS);
        });
      this.chains.set(key, next);
      void next.then(() => {
        if (this.chains.get(key) === next) this.chains.delete(key);
      });
    }
  }

  /** On `sourceId`'s lane: erase it if the registry still holds its tombstone and no entry of that id. */
  private async eraseNow(sourceId: string): Promise<void> {
    await this.deps.store.settled();
    const file = normalizeRegistryFile(await this.deps.store.read());
    if (!(file.estateTombstones ?? []).some((t) => t.kind === 'source' && t.id === sourceId)) return;
    // Live again (a restore brought it back): its own projection replaces what estate holds; nothing is erased.
    if (!file.servers.some((x) => entryId(x) === sourceId)) {
      await this.gate.run(async () => {
        this.dropAck(sourceId);
        await replaceSource(this.call, removedSourceGeneration(sourceId, this.nextGeneration(sourceId)) as unknown as Record<string, unknown>, this.deps);
      });
    }
    // (crew#1740) Housekeeping, not an operator change: written in place, keeping no restore point.
    await this.deps.store.amend?.((f) => dropEstateTombstones(f, 'source', new Set([sourceId])));
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
    let erased: string[];
    try {
      const file = normalizeRegistryFile(await this.deps.store.read());
      names = file.servers.map((s) => s.name);
      erased = (file.estateTombstones ?? []).filter((t) => t.kind === 'source').map((t) => t.id);
    } catch (err) {
      this.deps.log?.(`[knowledge] the registry could not be read to project source structure: ${message(err)}`);
      return;
    }
    // (crew#1328) A source removed before a restart whose erasure estate had not taken is erased now.
    this.erase(erased);
    // (crew#1741) An acknowledgement read back from the file is checked against estate on its lane, before the
    // projection queued below, so a source estate still holds is admitted without waiting for its turn to be sent.
    for (const [id, a] of this.acked) {
      if (a.confirmed) continue;
      void this.exclusive(id, () => this.confirmNow(id));
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
    const id = entryId(r);
    return this.exclusive(id, () => this.projectNow(id));
  }

  /** On `sourceId`'s lane: project the entry of that id as the registry and its catalog hold it NOW. */
  private async projectNow(sourceId: string): Promise<boolean> {
    await this.deps.store.settled();
    const r = normalizeRegistryFile(await this.deps.store.read()).servers.find((x) => entryId(x) === sourceId);
    // Removed since it was named: its erasure runs on this lane, and nothing of it is projected again.
    if (r === undefined) return false;
    const s = await gateSourceOf(r, this.deps.catalogs);
    if (s === null) return false;
    if (s.description === null) return false;
    // The slot is taken BEFORE the generation is built, so a backfill holds at most this many generations.
    return this.gate.run(async () => {
      const gen = sourceGeneration(s, this.nextGeneration(s.id));
      if (gen === null) return false;
      const key = projectionKey(s);
      // (crew#1328) The kept acknowledgement of another key goes BEFORE the send: a crash mid-send then leaves none,
      // never one for a key estate may no longer hold. If it cannot be dropped, nothing is sent (the next describe or
      // boot projects again).
      if (this.acked.get(s.id)?.key !== key) this.dropAck(s.id);
      await replaceSource(this.call, gen as unknown as Record<string, unknown>, this.deps);
      this.acked.set(s.id, { key, generation: gen.generation, confirmed: true });
      try {
        this.persistAcks();
      } catch (err) {
        // Held in memory (true for this process); after a restart the source waits for the boot projection.
        this.deps.log?.(`[knowledge] the acknowledgement of ${s.name}'s projection could not be written: ${message(err)}`);
      }
      return true;
    });
  }

  /**
   * The {@link projectionKey} (descriptor and allowed views) whose structure estate holds for `sourceId`, as crew last
   * saw estate accept it (kept across a restart when {@link SourceProjectorDeps.acksFile} is set, and answered after one only once estate is seen to still hold it: crew#1741); `null` until then. The relay's visible set admits a source only while this
   * equals the source's current key, so what estate still holds of an earlier descriptor or an earlier view
   * allowlist (a projection pending or failed, a restored registry generation) is never released.
   */
  projectedDescriptor(sourceId: string): string | null {
    const a = this.acked.get(sourceId);
    return a?.confirmed === true ? a.key : null;
  }
}

function message(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split(/\r?\n/, 1)[0]!;
}
