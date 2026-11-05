/**
 * Knowledge queries (DES-KNOWLEDGE-DATA-001 §9.1, M6 part 1): an app's `recall` query reads the knowledge its OWN
 * project may see, on the reserved source `estate` (the broker's relay name, reserved for every registry kind, so no
 * person's source can be called that). Its text (`queries/<id>.json`, {@link parseRecallQueryText}) says what:
 *
 *  - `knowledge`: estate `knowledge.recall` (documents, source structure, approved data shapes), optionally only
 *    what one registry source was derived from;
 *  - `memories`: estate `memory.recall` with the project as its facet intent (what a unit in the project recalls);
 *  - `steering`: the active conformance rules with no project or this project (the asymmetric facet);
 *  - `tables`: one source's catalog as estate holds it (structure, never rows), each table with its approved,
 *    value-free data shape (which says what it joins).
 *
 * **What it may see.** The project is the app's, read from crew's app store, never from the request. `visible` is
 * the relay's own set for that project ({@link AppKnowledgeDeps.visible}: the data gate's predicate over the
 * registry, the project's repos, the projector's acknowledgements). Estate filters by it before ranking; crew reads
 * it AGAIN before release and drops every item one of whose deps left it (`effectiveDeps`, the relay's rule), so a
 * switch turned off between the two reads drops the rows. A named source the project cannot see is refused before
 * any read.
 *
 * **What a row holds.** Crew's own columns ({@link RECALL_COLUMNS}): text cut to 200 (title) and 2,000 (content)
 * code points, a `cite` on every row, and `untrusted: true` on what a source's structure says (a column comment can
 * read like an instruction). Estate holds no row of a person's source (§4.2) and a shape is value-free (§10.2), so
 * no source value can appear. Nothing here goes to a model.
 */

import type { AppColumnType, AppQuery, AppRecallFrom, AppRecallQueryText, ConformanceRule } from '../../core/types.js';
import { agentMay } from '../../knowledge/gate/access.js';
import type { GateSource } from '../../knowledge/gate/sources.js';
import { sourceDep } from '../../knowledge/package.js';
import { type EstateCall, proposalIdOfNode, readCatalog } from '../../knowledge/shapes/shapes.js';
import { approvedShapes, verifiedShapes } from '../../knowledge/shapes/verified.js';
import { recallableMemory } from '../../knowledge/summary.js';
import { ESTATE_SERVER } from '../../mcp/classify.js';
import { effectiveDeps } from '../../mcp/estate-relay.js';
import type { QueryArg } from './texts.js';

/** The source name a `recall` query reads. */
export const RECALL_SOURCE = ESTATE_SERVER;

type Col = { type: AppColumnType; nullable: boolean };
const s = (nullable = false): Col => ({ type: 'string', nullable });

/** The columns each `from` answers, with crew's types. An app's `output` declares a subset. */
export const RECALL_COLUMNS: { readonly [F in AppRecallFrom]: Readonly<Record<string, Col>> } = {
  knowledge: { title: s(), content: s(), cite: s(), kind: s(), source: s(true), score: { type: 'number', nullable: false }, untrusted: { type: 'boolean', nullable: false } },
  memories: { title: s(), content: s(), cite: s(), kind: s(), score: { type: 'number', nullable: false } },
  steering: { title: s(), content: s(), cite: s(), kind: s(), severity: s() },
  tables: { title: s(), content: s(), cite: s(), kind: s(), columns: { type: 'integer', nullable: false }, shape: s(true), untrusted: { type: 'boolean', nullable: false } },
};

/** A grouped answer's columns: one row per value of the grouped column. */
export const RECALL_GROUP_COLUMNS: Readonly<Record<string, Col>> = { key: s(), count: { type: 'integer', nullable: false } };

/** What each `from` may be grouped by. */
export const RECALL_GROUPS: { readonly [F in AppRecallFrom]: readonly NonNullable<AppRecallQueryText['group']>[] } = {
  knowledge: ['kind', 'source'],
  memories: ['kind'],
  steering: ['kind', 'severity'],
  tables: ['kind'],
};

export const RECALL_LIMIT_DEFAULT = 20;
const TITLE_MAX = 200;
const CONTENT_MAX = 2000;
/** What a recall asks estate for; a recall naming one source asks for the relay's cap (16,000), as it keeps only that source's items. */
const TOKEN_BUDGET = 8000;
const TOKEN_BUDGET_NAMED = 16_000;
/** A literal recall text, at most. */
const QUERY_TEXT_MAX = 200;

/** A refusal of a recall, in crew's words (the executor and the check map it to their own codes). */
export class RecallRefusal extends Error {
  constructor(
    readonly code: 'not_visible' | 'not_described' | 'recall_text' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

/**
 * What the declaration and the text cannot get past, before anything is read (the check and the executor alike), or
 * `null`: the fields its `from` needs, a group it allows, `output` a subset of its columns with crew's types (a column
 * that can be empty declared `nullable`), and the parameters (only the `query` argument's one, a string).
 */
export function recallProblem(q: Pick<AppQuery, 'output' | 'params' | 'rowPath' | 'morePath'>, t: AppRecallQueryText): string | null {
  if (q.rowPath !== undefined || q.morePath !== undefined) return 'a recall query has no row or more path';
  if ((t.from === 'knowledge' || t.from === 'memories') && t.query === undefined) return `a recall from ${t.from} needs a query (a literal or a string parameter)`;
  if (t.from === 'tables' && t.source === undefined) return 'a recall from tables names its source';
  if ((t.from === 'memories' || t.from === 'steering') && t.source !== undefined) return `a recall from ${t.from} names no source`;
  if (t.from === 'tables' && t.query !== undefined) return 'a recall from tables reads one source\'s whole catalog: it takes no query';
  if (t.group !== undefined && !RECALL_GROUPS[t.from].includes(t.group)) return `a recall from ${t.from} groups by ${RECALL_GROUPS[t.from].join(' or ')}, not ${t.group}`;
  const columns = t.group !== undefined ? RECALL_GROUP_COLUMNS : RECALL_COLUMNS[t.from];
  for (const o of q.output) {
    const c = Object.hasOwn(columns, o.name) ? columns[o.name] : undefined;
    if (c === undefined) return `a recall from ${t.from}${t.group !== undefined ? ` grouped by ${t.group}` : ''} answers ${Object.keys(columns).join(', ')}; it has no column ${JSON.stringify(o.name)}`;
    if (c.type !== o.type) return `column ${o.name} of a recall is ${c.type}, not ${o.type}`;
    if (c.nullable && o.nullable !== true) return `column ${o.name} of a recall can be empty: declare it nullable`;
  }
  const declared = Object.keys(q.params?.properties ?? {});
  const arg: QueryArg | undefined = t.query;
  if (arg?.kind === 'literal') {
    if (typeof arg.value !== 'string' || arg.value.trim() === '' || Array.from(arg.value).length > QUERY_TEXT_MAX) return `a recall's literal query is 1-${QUERY_TEXT_MAX} characters of text`;
  }
  if (arg?.kind === 'param') {
    const p = q.params !== undefined && Object.hasOwn(q.params.properties, arg.name) ? q.params.properties[arg.name] : undefined;
    if (p === undefined) return `the query comes from parameter ${JSON.stringify(arg.name)}, which is not declared`;
    if (p.type !== 'string') return `parameter ${arg.name} feeds a recall's text, so it is a string`;
    if (p.from !== undefined) return `parameter ${arg.name} is filled from ${p.from}; a recall's text never comes from the viewer`;
  }
  for (const d of declared) if (arg?.kind !== 'param' || arg.name !== d) return `parameter ${d} is not used by the recall (only its query argument takes one)`;
  return null;
}

/** What a recall reads, as crew wires it (server.ts): host-side, this daemon's stores. */
export interface AppKnowledgeDeps {
  /** The gate's read of the registry, now. */
  sources: () => Promise<GateSource[]>;
  /** The deps a unit in `projectId` may see (the relay's own set), read now. */
  visible: (projectId: string) => Promise<string[]>;
  /** Estate, the operator client (this daemon's stores); answers the unwrapped tool result, throws on failure. */
  estate: EstateCall;
  /** The engine's conformance rules. */
  rules: () => Promise<ConformanceRule[]>;
}

/** The registry source a recall names, when the project may see it (and estate holds its structure), else a refusal. */
export async function visibleSource(deps: Pick<AppKnowledgeDeps, 'sources' | 'visible'>, projectId: string, name: string): Promise<GateSource> {
  const src = (await deps.sources()).find((x) => x.name === name);
  if (src === undefined || !agentMay(src.access, src, projectId, 'see')) {
    throw new RecallRefusal('not_visible', `${name} is not a data source this app's project may see (a person ticks the project in the source's Agents box)`);
  }
  if (!(await deps.visible(projectId)).includes(sourceDep(src.id))) {
    throw new RecallRefusal('not_described', `${name}'s structure is not in the knowledge plane yet: a person tests its connection on the Data sources page first`);
  }
  return src;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** At most `max` code points, whitespace runs folded. */
function cut(v: string, max: number): string {
  const t = v.replace(/\s+/g, ' ').trim();
  const cps = Array.from(t);
  return cps.length > max ? `${cps.slice(0, max - 1).join('')}…` : t;
}
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** A knowledge item's kind: a source's structure (`table`), an approved data shape, or a document. */
function knowledgeKind(i: Record<string, unknown>): string {
  if (proposalIdOfNode(str(i['node_id'])) !== null) return 'shape';
  if (str(i['scope']).startsWith('source:')) return 'table';
  return 'document';
}

/** A memory's id in one spelling: recall answers its node id (`mem synthetic <id>:`), the inventory the bare id. */
export function memoryKey(id: string): string {
  return /^mem synthetic (.+):$/.exec(id)?.[1] ?? id;
}

/** A recall's deadline ran out: no further estate call is made. */
export class RecallDeadline extends Error {}

/** Every `source:<id>` in a cite or title, rewritten to the source's current name (`src:<name>`); an unknown id is `src:?`. */
function named(text: string, byId: ReadonlyMap<string, string>): string {
  return text.replace(/source:([A-Za-z0-9._-]{1,128})/g, (_m, id: string) => `src:${byId.get(id) ?? '?'}`);
}

/**
 * The rows of a recall (the module doc), before projection, and the visible set they were RELEASED under (`null` when
 * they do not stand on it; the executor binds the cache to it). Throws {@link RecallRefusal}, {@link RecallDeadline} or estate's error. `deadlineAt` (epoch
 * ms): past it, no further estate call starts.
 */
export async function readRecall(
  deps: AppKnowledgeDeps,
  projectId: string,
  t: AppRecallQueryText,
  queryText: string | null,
  opts: { deadlineAt?: number; now?: () => number } = {},
): Promise<{ rows: Array<Record<string, unknown>>; truncated: boolean; released: string[] | null }> {
  const limit = t.limit ?? RECALL_LIMIT_DEFAULT;
  const rows: Array<Record<string, unknown>> = [];
  const clock = opts.now ?? Date.now;
  const estate: EstateCall = (tool, args) => {
    if (opts.deadlineAt !== undefined && clock() >= opts.deadlineAt) return Promise.reject(new RecallDeadline('the recall ran past its deadline'));
    return deps.estate(tool, args);
  };
  /** The set the rows were released under; `null` for rows that do not stand on it (memories, steering). */
  let released: string[] | null = null;
  /** The set read again now (the release re-check). */
  const fresh = async (): Promise<Set<string>> => {
    const set = await deps.visible(projectId);
    released = set;
    return new Set(set);
  };
  let truncated = false;
  if (t.from === 'knowledge') {
    const only = t.source !== undefined ? await visibleSource(deps, projectId, t.source) : null;
    const visible = await deps.visible(projectId);
    // Estate is asked under the project's WHOLE set (narrowing it would hide what that source was derived from together
    // with another visible source); a named source keeps only its items after, with the relay's larger budget.
    const got = await estate('knowledge.recall', { query: queryText ?? '', visible, token_budget: only === null ? TOKEN_BUDGET : TOKEN_BUDGET_NAMED });
    const items = isObj(got) && Array.isArray(got['items']) ? got['items'] : null;
    if (items === null) throw new RecallRefusal('unavailable', 'estate answered the recall with no items');
    // The release re-check: an item keeps only when every one of its deps is still in the set read now.
    const now = await fresh();
    const byId = new Map((await deps.sources()).map((x) => [x.id, x.name] as const));
    for (const i of items) {
      if (!isObj(i)) continue;
      const itemDeps = effectiveDeps(i);
      if (!itemDeps.every((d) => now.has(d))) continue;
      if (only !== null && !itemDeps.includes(sourceDep(only.id))) continue;
      const srcId = itemDeps.find((d) => d.startsWith('source:'))?.slice('source:'.length) ?? null;
      const srcName = srcId === null ? null : (byId.get(srcId) ?? null);
      // A source is named by its current name, never its registry id, wherever estate's text carries one.
      const provenance = str(i['source']);
      rows.push({
        title: cut(named(str(i['label']) || str(i['node_id']), byId), TITLE_MAX),
        content: cut(str(i['body_snippet']), CONTENT_MAX),
        cite: cut(named(provenance !== '' ? provenance : `knowledge:${str(i['node_id'])}`, byId), TITLE_MAX),
        kind: knowledgeKind(i),
        source: srcName,
        score: num(i['score']),
        untrusted: i['untrusted'] === true || srcId !== null,
      });
    }
  } else if (t.from === 'memories') {
    const got = await estate('memory.recall', { query: queryText ?? '', scope_prefix: '', intent: { project: projectId }, token_budget: TOKEN_BUDGET });
    const items = isObj(got) && Array.isArray(got['items']) ? got['items'] : null;
    if (items === null) throw new RecallRefusal('unavailable', 'estate answered the recall with no items');
    // The release re-check: the recall wire carries no facets, so the store's own inventory, read now, says which
    // memories the project's facet admits; a memory it does not admit, or does not hold, is not released.
    const inventory = await estate('memory.list', {});
    const all = isObj(inventory) && Array.isArray(inventory['items']) ? inventory['items'] : null;
    if (all === null) throw new RecallRefusal('unavailable', 'estate answered no memory inventory to check the recall against');
    const admitted = new Set(all.filter((m) => isObj(m) && typeof m['memory_id'] === 'string' && recallableMemory(m, projectId)).map((m) => memoryKey((m as Record<string, unknown>)['memory_id'] as string)));
    for (const m of items) {
      if (!isObj(m) || typeof m['memory_id'] !== 'string' || !admitted.has(memoryKey(m['memory_id']))) continue;
      const content = str(m['content']);
      rows.push({
        title: cut(content.split('\n')[0] ?? '', 120),
        content: cut(content, CONTENT_MAX),
        cite: `memory:${memoryKey(m['memory_id'])}`,
        kind: str(m['tier']) || str(m['kind']) || 'memory',
        score: num(m['score']),
      });
    }
  } else if (t.from === 'steering') {
    const words = (queryText ?? '').toLowerCase().split(/\s+/).filter((w) => w !== '');
    for (const r of await deps.rules()) {
      if (r.retired === true) continue;
      const scoped = r.targets?.project;
      if (scoped !== undefined && scoped !== projectId) continue;
      const statement = str(r.statement);
      if (!words.every((w) => statement.toLowerCase().includes(w))) continue;
      rows.push({ title: cut(statement, TITLE_MAX), content: cut(statement, CONTENT_MAX), cite: `rule:${r.id}`, kind: r.steering_type ?? 'architecture', severity: str(r.severity) });
    }
  } else {
    const src = await visibleSource(deps, projectId, t.source!);
    const visible = await deps.visible(projectId);
    // Every page must say it is this source's catalog (estate's answer is checked, not trusted).
    const cat = await readCatalog(estate, src.id, visible, { owner: true });
    if (cat?.truncated === true) truncated = true;
    const proposals = await approvedShapes(estate);
    const verified = proposals === null ? null : await verifiedShapes(estate, proposals, src.id, visible, fresh);
    // A shape list that could not be read, or not read whole, is said: the answer is incomplete.
    if (verified === null || verified.failed || !verified.exhausted) truncated = true;
    const now = await fresh();
    if (!now.has(sourceDep(src.id))) throw new RecallRefusal('not_visible', `${src.name} is not a data source this app's project may see now`);
    const shapes = new Map((verified?.shapes ?? []).filter((v) => v.deps.every((d) => now.has(d))).map((v) => [v.relation, v] as const));
    for (const d of cat?.docs ?? []) {
      const entry = isObj(d.entry) ? d.entry : {};
      // The projector's fallback for a relation too large for one record names it without its columns: unknown, said.
      const tooLarge = entry['tooLarge'] === true;
      if (tooLarge) truncated = true;
      const cols = Array.isArray(entry['columns']) ? entry['columns'] : [];
      const count = cols.length + num(entry['columnsNotListed']);
      const names = cols.map((c) => (isObj(c) ? str(c['name']) : '')).filter((n) => n !== '');
      const shape = shapes.get(d.key) ?? null;
      rows.push({
        title: cut(d.key, TITLE_MAX),
        content: shape !== null ? cut(shape.content, CONTENT_MAX) : tooLarge ? 'Too large to list here: its columns are on the source sheet' : cut(`${count} column${count === 1 ? '' : 's'}${names.length > 0 ? `: ${names.join(', ')}` : ''}`, CONTENT_MAX),
        cite: cut(`src:${src.name}/${d.key}`, TITLE_MAX),
        kind: str(entry['kind']) || 'table',
        columns: count,
        shape: shape !== null ? cut(shape.content, CONTENT_MAX) : null,
        untrusted: true,
      });
    }
  }
  if (t.group !== undefined) {
    const by = t.group;
    const counts = new Map<string, number>();
    for (const r of rows) {
      const k = r[by];
      const key = typeof k === 'string' && k !== '' ? k : '(none)';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const grouped = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key, count]) => ({ key, count }));
    return { rows: grouped.slice(0, limit), truncated: truncated || grouped.length > limit, released };
  }
  return { rows: rows.slice(0, limit), truncated: truncated || rows.length > limit, released };
}
