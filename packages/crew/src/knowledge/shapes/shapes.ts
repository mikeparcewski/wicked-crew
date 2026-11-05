/**
 * Data shapes as recommendations (DES-KNOWLEDGE-DATA-001 §10.1): what the profiler learned becomes INERT proposals in
 * estate's one review queue, like memories and policies. Nothing here writes knowledge: a person approves a shape in
 * the review, and only then does estate write the node, its typed edges and its derived deps (B3a's approve).
 *
 * One shape per profiled relation, `kind_type: knowledge`, `class: concept`, scoped to the source
 * (`source:<registry id>`), its content the value-free summary, and its links:
 * - `derived_from` the relation's catalog document (so the shape always sits on its table in the map);
 * - `joins` to each relation it joins, with the evidence (a foreign key, or a name-and-type match the overlap band
 *   confirmed);
 * - `describes` (`relate_code[]`) to each code entity named exactly like the relation in a repo's code graph.
 *
 * The proposer declares no `deps`: estate derives them from the endpoints at approve (§4.3) and refuses a declared
 * set that differs.
 */

import type { JoinProfile, RelationProfile, SourceProfile } from './profile.js';

/** The shape payload's crew-owned record (studio's review card reads it; estate stores it as given). */
export interface ShapeRecord {
  format: 1;
  sourceId: string;
  source: string;
  relation: string;
  profile: RelationProfile;
  joins: JoinProfile[];
  describes: CodeMatch[];
  /** Related tables whose join did not fit estate's 200 links (the record above keeps every join). */
  linksNotListed?: number;
}

/** A code entity named exactly like a relation. */
export interface CodeMatch {
  repo: string;
  symbolId: string;
  name: string;
  kind: string;
  file: string;
}

export interface ShapeProposal {
  kind_type: 'knowledge';
  payload: {
    content: string;
    source: string;
    class: 'concept';
    scope: string;
    observed_at: string;
    capture: 'profile';
    relate: Array<{ rel: string; from?: string; to: string; confidence: number; evidence?: Record<string, unknown> }>;
    relate_code: Array<{ rel: string; from: string; code_id: string; repo: string; confidence: number; evidence: Record<string, unknown> }>;
    shape: ShapeRecord;
  };
  facets: Record<string, string>;
}

/** Estate's id segment encoding (`source.rs` `encode_key`): every byte outside `[A-Za-z0-9._-]` as `%XX`. */
export function encodeKey(key: string): string {
  let out = '';
  for (const b of Buffer.from(key, 'utf8')) {
    const c = String.fromCharCode(b);
    out += /[A-Za-z0-9._-]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** The knowledge class kinds (estate `KClass::as_kind`). */
const CLASS_KIND: Record<string, string> = { doc: 'kdoc', section: 'ksection', chunk: 'kchunk', concept: 'kconcept' };

/** The knowledge node an approved proposal becomes (estate: `<kind> synthetic proposal:<id>:`; class default chunk). */
export function proposalNodeId(proposalId: string, cls: unknown): string {
  return `${CLASS_KIND[typeof cls === 'string' ? cls : 'chunk'] ?? 'kchunk'} synthetic proposal:${proposalId}:`;
}

/** The proposal id of an approved proposal's node id, or `null` when the id is not one. */
export function proposalIdOfNode(nodeId: string): string | null {
  const m = /^k(?:doc|section|chunk|concept) synthetic proposal:(.+):$/.exec(nodeId);
  return m === null ? null : m[1]!;
}

/** The knowledge node id of a source's catalog document (estate `doc_symbol`: `kdoc synthetic source:<id>/<key>:`). */
export function catalogDocId(sourceId: string, key: string): string {
  return `kdoc synthetic source:${sourceId}/${encodeKey(key)}:`;
}

const OVERLAP_WORDS: Record<string, string> = {
  all: 'every value matches',
  most: 'most values match',
  some: 'some values match',
  none: 'no value matches',
  empty: 'no values yet',
};

const CARD_WORDS: Record<string, string> = {
  none: 'no values',
  single: 'one distinct value',
  low: 'low cardinality',
  high: 'high cardinality',
  unique: 'unique',
  unknown: 'cardinality not measured',
};

function joinWords(j: JoinProfile, self: string): string {
  if (j.from === j.to) return `joins itself on ${j.columns.join(', ')} = ${j.references.join(', ')} (${j.basis === 'fk' ? 'a foreign key' : 'matching name and type'})`;
  const other = j.from === self ? j.to : j.from;
  const on = j.from === self ? `${j.columns.join(', ')} = ${other}.${j.references.join(', ')}` : `${j.references.join(', ')} = ${other}.${j.columns.join(', ')}`;
  const basis = j.basis === 'fk' ? 'a foreign key' : 'matching name and type';
  return `joins ${other} on ${on} (${basis}${j.overlap !== null ? `; ${OVERLAP_WORDS[j.overlap]}` : ''})`;
}

/** The value-free summary a shape's content carries (what recall finds once it is approved). Pure. */
export function shapeContent(sourceName: string, p: RelationProfile, joins: readonly JoinProfile[], describes: readonly CodeMatch[], at: string): string {
  const head = `${p.key} in data source ${sourceName}`;
  if (p.rows === null) return `${head}: not profiled (${p.error ?? 'unreadable'}). Profiled ${at.slice(0, 10)}; no value kept.`;
  const keys = p.columns.filter((c) => c.keyCandidate).map((c) => c.name);
  const cols = p.columns.map((c) => {
    const nulls = c.nullPct === null ? '' : !c.hasNulls ? 'no nulls' : c.nullPct === 0 ? 'under 5% null' : `${c.nullPct}% null`;
    return [`${c.name} ${c.type}`, nulls, CARD_WORDS[c.cardinality]].filter((x) => x !== '').join(', ');
  });
  const lines = [
    `${head}: ${p.rows} rows.`,
    keys.length > 0 ? `Key candidates: ${keys.join(', ')}.` : 'No key candidate.',
    ...joins.map((j) => `It ${joinWords(j, p.key)}.`),
    ...describes.map((d) => `Code entity ${d.name} (${d.kind}) in repository ${d.repo} is named like it.`),
    `Columns: ${cols.join('; ')}${p.columnsNotListed !== undefined ? ` (${p.columnsNotListed} more not profiled)` : ''}.`,
    `Profiled ${at.slice(0, 10)}, value-free: counts in bands, never a value.`,
  ];
  return lines.join(' ');
}

/** The proposals for a profiled source: one per relation (module doc). Pure. */
export function shapeProposals(
  src: { id: string; name: string },
  profile: SourceProfile,
  describes: ReadonlyMap<string, readonly CodeMatch[]>,
  at: string,
): ShapeProposal[] {
  return profile.relations.map((p) => {
    const self = catalogDocId(src.id, p.key);
    const joins = profile.joins.filter((j) => j.from === p.key);
    const seenJoins = profile.joins.filter((j) => j.from === p.key || j.to === p.key);
    const code = p.rows === null ? [] : [...(describes.get(p.key) ?? [])];
    const relate: ShapeProposal['payload']['relate'] = [{ rel: 'derived_from', to: self, confidence: 1 }];
    // One edge per related table (estate keeps one typed edge per rel and endpoints): every join condition between
    // the two rides in its evidence. A self-join is said in the content only (estate draws no edge to itself).
    const byTarget = new Map<string, JoinProfile[]>();
    // A relation that was not read asserts nothing but where it sits.
    for (const j of p.rows === null ? [] : joins) if (j.to !== p.key) byTarget.set(j.to, [...(byTarget.get(j.to) ?? []), j]);
    // Estate takes at most 200 links per proposal (relate + relate_code): code links first (a few), then joins while they fit.
    const codeLinks = code.slice(0, 3);
    let linksNotListed = 0;
    for (const [to, js] of byTarget) {
      if (relate.length + codeLinks.length >= SHAPE_LINKS_MAX) {
        linksNotListed++;
        continue;
      }
      relate.push({ rel: 'joins', from: self, to: catalogDocId(src.id, to), confidence: js.some((j) => j.basis === 'fk') ? 0.95 : 0.75, evidence: joinEvidence(js) });
    }
    const relate_code = codeLinks.map((c) => ({
      rel: 'describes',
      from: self,
      code_id: c.symbolId,
      repo: c.repo,
      confidence: 0.6,
      evidence: codeEvidence(c),
    }));
    return {
      kind_type: 'knowledge' as const,
      payload: {
        content: shapeContent(src.name, p, seenJoins, code, at),
        source: `crew:profile/${src.name}/${p.key}`,
        class: 'concept' as const,
        scope: `source:${src.id}`,
        observed_at: at,
        capture: 'profile' as const,
        relate,
        relate_code,
        shape: { format: 1 as const, sourceId: src.id, source: src.name, relation: p.key, profile: p, joins, describes: code, ...(linksNotListed > 0 ? { linksNotListed } : {}) },
      },
      facets: {},
    };
  });
}

/** Estate takes at most this many links (relate + relate_code) in one proposal. */
export const SHAPE_LINKS_MAX = 200;

/** Estate refuses evidence over 1,024 serialized bytes; crew keeps under this, cutting honestly. */
export const EVIDENCE_MAX_BYTES = 1000;

/**
 * The evidence of one `joins` edge: its strongest basis and every condition (`on`), held under estate's evidence
 * bound. A condition that does not fit is counted in `more`; an identifier list too long for the bound is cut and
 * marked `cut` (the shape's own record keeps every identifier). Pure.
 */
export function joinEvidence(js: readonly JoinProfile[]): Record<string, unknown> {
  const basis = js.some((j) => j.basis === 'fk') ? 'fk' : 'name_type';
  const cond = (j: JoinProfile, names = 64): Record<string, unknown> => {
    const cut = (xs: string[]): string[] => xs.map((x) => (x.length > names ? x.slice(0, names) : x));
    const c = { columns: cut(j.columns), references: cut(j.references), basis: j.basis, ...(j.overlap !== null ? { overlap: j.overlap } : {}) };
    return c.columns.some((x, i) => x !== j.columns[i]) || c.references.some((x, i) => x !== j.references[i]) ? { ...c, cut: true } : c;
  };
  const size = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');
  const on: Array<Record<string, unknown>> = [];
  let more = 0;
  for (const j of js) {
    let c = cond(j);
    for (const n of [32, 16, 8]) if (size({ basis, on: [...on, c], more: js.length }) > EVIDENCE_MAX_BYTES) c = cond(j, n);
    if (size({ basis, on: [...on, c], more: js.length }) > EVIDENCE_MAX_BYTES) {
      c = { columns: [], references: [], basis: j.basis, cut: true };
      if (size({ basis, on: [...on, c], more: js.length }) > EVIDENCE_MAX_BYTES) {
        more++;
        continue;
      }
    }
    on.push(c);
  }
  return more > 0 ? { basis, on, more } : { basis, on };
}

/** A `describes` edge's evidence under estate's bound: long names and paths are cut and marked (the record keeps them). Pure. */
export function codeEvidence(c: CodeMatch): Record<string, unknown> {
  const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);
  const ev = { basis: 'name', name: cut(c.name, 120), kind: cut(c.kind, 40), file: cut(c.file, 300) };
  const wasCut = ev.name !== c.name || ev.kind !== c.kind || ev.file !== c.file;
  const out: Record<string, unknown> = wasCut ? { ...ev, cut: true } : ev;
  return Buffer.byteLength(JSON.stringify(out), 'utf8') <= EVIDENCE_MAX_BYTES ? out : { basis: 'name', cut: true };
}

/** JSON with every object's keys sorted, so two equal records compare equal however a store ordered them. Pure. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** A shape's identity for the queue: its source, relation, profile bands and links, never its date or its prose. */
export function shapeIdentity(shape: { sourceId?: unknown; relation?: unknown; profile?: unknown; joins?: unknown; describes?: unknown }): string {
  return stableJson({ sourceId: shape.sourceId, relation: shape.relation, profile: shape.profile, joins: shape.joins, describes: shape.describes });
}

/** One estate tool call (the operator client: write mode, this daemon's stores). */
export type EstateCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

/** A catalog estate replaced while it was being paged, again on every retry. */
export class CatalogChangedError extends Error {}

export const CATALOG_PAGES_MAX = 20;
const CATALOG_ATTEMPTS = 3;

/**
 * Every catalog document of a source, read as ONE generation: page 0, then each next page pinned to its generation.
 * A generation replaced mid-read starts the read again (at most 3 times, then {@link CatalogChangedError}), so a
 * caller never holds a mix of two generations or a silently partial list. `null` = estate holds no structure for the
 * source that `visible` lets this caller see. `truncated` = more pages than {@link CATALOG_PAGES_MAX}.
 */
export async function readCatalog(
  estate: EstateCall,
  sourceId: string,
  visible: readonly string[],
  /** `owner`: every page must say it is `sourceId`'s (an answer of another source, or one that does not say, is refused). */
  opts: { owner?: boolean } = {},
): Promise<{ docs: Array<{ key: string; title: string | null; entry: unknown }>; generation: number | null; truncated: boolean } | null> {
  const replaced = (err: unknown): boolean => /changed|generation/i.test(err instanceof Error ? err.message : String(err));
  for (let attempt = 0; attempt < CATALOG_ATTEMPTS; attempt++) {
    const docs: Array<{ key: string; title: string | null; entry: unknown }> = [];
    let generation: number | null = null;
    let truncated = false;
    let complete = true;
    for (let page = 0; page < CATALOG_PAGES_MAX; page++) {
      let got: { sourceId?: unknown; pages?: unknown; generation?: unknown; docs?: Array<{ key?: unknown; title?: unknown; entry?: unknown }> } | null;
      try {
        got = (await estate('knowledge.source_catalog', { sourceId, page, visible: [...visible], ...(generation !== null ? { generation } : {}) })) as typeof got;
      } catch (err) {
        // A generation replaced mid-read (on any page) starts the read again; unknown and hidden answer alike (no
        // existence leak); anything else is estate failing, and says so.
        if (replaced(err)) {
          complete = false;
          break;
        }
        if (page === 0 && /unknown|hidden|not visible|no visible|no source/i.test(err instanceof Error ? err.message : String(err))) return null;
        throw err;
      }
      if (got === null || typeof got !== 'object') {
        if (page === 0) return null;
        complete = false;
        break;
      }
      if (opts.owner === true && got.sourceId !== sourceId) throw new Error(`estate answered a catalog that is not source ${sourceId}'s`);
      if (typeof got.generation === 'number') generation = got.generation;
      for (const d of got.docs ?? []) if (typeof d.key === 'string') docs.push({ key: d.key, title: typeof d.title === 'string' ? d.title : null, entry: d.entry ?? null });
      const pages = typeof got.pages === 'number' ? got.pages : 1;
      if (page + 1 >= pages) break;
      if (page + 1 === CATALOG_PAGES_MAX) truncated = true;
    }
    if (complete) return { docs, generation, truncated };
  }
  throw new CatalogChangedError(`the structure of source ${sourceId} kept changing while it was read`);
}

/** The keys of a source's catalog documents in estate (one generation), or `null` when estate holds none. */
export async function catalogKeys(estate: EstateCall, sourceId: string): Promise<{ keys: string[]; generation: number | null } | null> {
  const got = await readCatalog(estate, sourceId, [`source:${sourceId}`]);
  return got === null ? null : { keys: got.docs.map((d) => d.key), generation: got.generation };
}

interface ListedProposal {
  id?: unknown;
  state?: unknown;
  payload?: { content?: unknown; shape?: { sourceId?: unknown; relation?: unknown; profile?: unknown; joins?: unknown; describes?: unknown } };
}

/**
 * File each shape unless the queue already holds the same one (pending, approved, or declined: a person who said no
 * is not asked again for the same shape). "The same" is {@link shapeIdentity}: the profile's bands and the links, not
 * the day it was profiled. Answers the ids filed and the count skipped. The caller serializes filing per source.
 */
export async function fileShapes(estate: EstateCall, proposals: readonly ShapeProposal[]): Promise<{ filed: Array<{ id: string; relation: string }>; skipped: number }> {
  const listed = (await estate('proposal.list', { kind_type: 'knowledge' })) as { proposals?: ListedProposal[] } | null;
  const have = new Set(
    (listed?.proposals ?? [])
      .filter((p) => typeof p.payload?.shape?.sourceId === 'string')
      .map((p) => shapeIdentity(p.payload!.shape!)),
  );
  const filed: Array<{ id: string; relation: string }> = [];
  let skipped = 0;
  for (const p of proposals) {
    const key = shapeIdentity(p.payload.shape);
    if (have.has(key)) {
      skipped++;
      continue;
    }
    const got = (await estate('proposal.submit', { kind_type: p.kind_type, payload: p.payload, facets: p.facets })) as { id?: unknown } | null;
    if (typeof got?.id !== 'string' || got.id === '') throw new Error('proposal.submit returned no id');
    have.add(key);
    filed.push({ id: got.id, relation: p.payload.shape.relation });
  }
  return { filed, skipped };
}
