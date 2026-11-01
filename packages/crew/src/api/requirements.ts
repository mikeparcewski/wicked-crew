/**
 * REQUIREMENTS SERVICE — server-side search + operator overrides over a repository's requirements
 * graph, read from the repository's ESTATE store (operator ruling 2026-10-31: the graph is saved to
 * estate, never a JSON file in the repo). `wicked-core domain-graph` saves it there
 * (`persist_domain_model`); the engine reads it back READ-ONLY through core-ts
 * (`getRequirementsGraphForRepo`, the same one-library path as `getCoverageReportForRepo`), with
 * the coverage label recomputed from the store's own counts at read time.
 *
 * HISTORY: until crew 0.16 this module read the `<repo>/.wicked-estate/requirements/
 * requirements_graph.json` artifact, and before 0.7.35 it ALSO opened the code-graph store through
 * a second SQLite library (`node:sqlite`) — the F-E2E-021 class that corrupted the bus db (one
 * library per db file per process — crew#541, crew#548). That rule still holds: the store is read
 * ONLY by the engine, through core-ts.
 *
 * Why server-side: 15k+ requirements — shipping them to the browser for JS-side filtering is not
 * search. The daemon builds a flat index and queries run here: tokenized AND-match over
 * id/domain/title/statements, risk + domain filters, offset/limit pagination. One engine read
 * serves a repository for `REQUIREMENTS_READ_TTL_MS`; the index is rebuilt when the read's content
 * (graph + coverage label) or the overrides sidecar's mtime changes.
 *
 * Why an OVERRIDES sidecar: the graph is DERIVED (rebuilt into the estate store by each
 * `domain-graph` run), so operator edits written into it would be clobbered on the next build.
 * Edits live in `requirements_overrides.json` (repoPaths), keyed `domain::reqId`, and are merged
 * at read time — the overlay survives a rebuild (the engine keeps each requirement's id across
 * builds) and keeps provenance honest (`riskSource: operator` vs `data`).
 *
 * ORPHANED OVERRIDES: an override key matches by exact string, so a key the corpus no
 * longer mints simply stops matching — silently. That happens on a rebuild that regroups a
 * domain or retires a requirement. The index therefore COUNTS the keys that matched no row
 * and surfaces the count as `orphanedOverrides` on every page, so the edits' existence is
 * never invisible. It does NOT re-key them: guessing the mapping here would attach an
 * operator's risk note to the wrong requirement.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { codeGraphDb, requirementsOverrides } from '../core/repoPaths.js';
import type { RepoEntry } from '../core/types.js';

interface ArtifactCorroboration {
  status?: unknown;
  sources?: unknown;
  call_sites?: unknown;
  tests?: unknown;
  docs?: unknown;
  extra_extractors?: unknown;
  why?: { code?: unknown; text?: unknown } | null;
}

interface ArtifactCoverage {
  real_pct?: unknown;
  min_pct?: unknown;
  behavior_bearing?: unknown;
  real?: unknown;
  placeholders?: unknown;
  unmapped?: unknown;
  not_product?: unknown;
}

interface ArtifactRequirement {
  corroboration?: ArtifactCorroboration;
  title?: string;
  description?: string;
  status?: string;
  legacy_components?: unknown[];
  data_access?: unknown[];
  dependencies?: unknown[];
  business_rules?: unknown[];
  validations?: unknown[];
  error_paths?: unknown[];
}

interface ArtifactDomain {
  description?: string;
  requirements?: Record<string, ArtifactRequirement>;
}

/** The domain-model document the engine reads back from estate (`load_domain_graph`). */
export interface EstateRequirementsGraph {
  metadata?: { coverage?: ArtifactCoverage };
  domains?: Record<string, ArtifactDomain>;
}

/** What the engine answers for one repository: its graph (null until a build reached the minimum)
 * and the coverage label from the store's own counts (present either way). */
export interface EstateRequirementsRead {
  graph: EstateRequirementsGraph | null;
  coverage: ArtifactCoverage | null;
}

/** The one read this module needs from the engine — `CoreAdapter.getRequirementsGraphForRepo`. */
export interface RequirementsGraphReader {
  getRequirementsGraphForRepo(repoRef: string): Promise<EstateRequirementsRead>;
}

/** How long one engine read of a repository's graph serves later reads. A request that reads the
 * same repository several times (product compose over many requirements, the project aggregates'
 * two passes, PATCH then re-read) costs ONE read — the engine recomputes coverage over the whole
 * store on each. A build that lands is visible within this window. */
export const REQUIREMENTS_READ_TTL_MS = 5_000;

const reads = new Map<string, { at: number; read: Promise<EstateRequirementsRead> }>();

/** One key for everything cached about a repository: its id AND where it is registered. */
function repoKey(repo: RepoEntry): string {
  return `${repo.id}\0${repo.root_path}`;
}

/** Forget what was read for `repo` (or everything): the next read asks the engine again. */
export function forgetRequirementsReads(repo?: RepoEntry): void {
  if (repo === undefined) {
    reads.clear();
    cache.clear();
    return;
  }
  reads.delete(repoKey(repo));
  cache.delete(repoKey(repo));
}

/** The repository's requirements graph from estate. Reads of one repository within
 * {@link REQUIREMENTS_READ_TTL_MS} — concurrent or not — share one engine call; a failed read is
 * never kept. A repo whose daemon resolved no graph root throws `CodeGraphRootUnresolvableError`
 * (the routes' 503); a repo not indexed yet has nothing to read (`graph: null`, the 404) and costs
 * no engine call. */
export async function readRequirementsGraph(
  repo: RepoEntry,
  reader: RequirementsGraphReader,
): Promise<EstateRequirementsRead> {
  const key = repoKey(repo);
  if (!existsSync(codeGraphDb(repo))) {
    forgetRequirementsReads(repo);
    return { graph: null, coverage: null };
  }
  const hit = reads.get(key);
  if (hit && Date.now() - hit.at < REQUIREMENTS_READ_TTL_MS) return hit.read;
  const read = reader.getRequirementsGraphForRepo(repo.id);
  reads.set(key, { at: Date.now(), read });
  read.catch(() => {
    if (reads.get(key)?.read === read) reads.delete(key);
  });
  return read;
}

export interface RequirementOverride {
  title?: string | undefined;
  notes?: string | undefined;
  status?: string | undefined;
  risk?: boolean | undefined;
}

export type RequirementCategory = 'functional' | 'config-data';

/**
 * How many independent sources support a requirement (operator ruling 2026-10-31, "validation by
 * duplication"), as `wicked-core domain-graph` computed it (domain-model 1.1.0
 * `requirement.corroboration`): `validated` at two or more (callers, tests, docs, agreeing extractor
 * seats), else `unconfirmed` with why. `null` on an artifact built before the field.
 */
export interface RequirementCorroboration {
  status: 'validated' | 'unconfirmed';
  sources: number;
  callSites: number;
  tests: number;
  docs: number;
  extraExtractors: number;
  /** Present when unconfirmed: a stable code and the sentence to show on the item. */
  why?: { code: string; text: string };
}

/**
 * How much of the repository's product code is REAL requirements (domain-model 1.1.0
 * `metadata.coverage`, schema bundle 1.3.0; wicked-core#1233). `realPct` is the one number the
 * minimum is checked against; `placeholders` are shown, never counted.
 */
export interface RequirementsCoverage {
  realPct: number;
  minPct: number;
  behaviorBearing: number;
  real: number;
  placeholders: number;
  unmapped: number;
  notProduct: number;
}

/** A count as the artifact must carry it: a finite, non-negative integer — else `null`. */
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/** At or above this many independent sources an item is validated (core's `VALIDATED_MIN_SOURCES`). */
const VALIDATED_MIN_SOURCES = 2;

/**
 * The artifact's corroboration in wire shape, or `null` when absent or malformed — never invented
 * and never defaulted: every count must be present, `sources` must be their sum, the status must
 * agree with it, and an unconfirmed item must say why (a non-empty code and sentence). A record
 * that fails any of those is not shown as a mark at all, rather than as a mark it does not support.
 */
export function corroborationOf(raw: ArtifactCorroboration | undefined): RequirementCorroboration | null {
  if (raw === undefined || raw === null || typeof raw !== 'object') return null;
  if (raw.status !== 'validated' && raw.status !== 'unconfirmed') return null;
  const sources = count(raw.sources);
  const callSites = count(raw.call_sites);
  const tests = count(raw.tests);
  const docs = count(raw.docs);
  const extraExtractors = count(raw.extra_extractors);
  if (sources === null || callSites === null || tests === null || docs === null || extraExtractors === null) return null;
  if (sources !== callSites + tests + docs + extraExtractors) return null;
  if ((raw.status === 'validated') !== (sources >= VALIDATED_MIN_SOURCES)) return null;
  const out: RequirementCorroboration = { status: raw.status, sources, callSites, tests, docs, extraExtractors };
  if (raw.status === 'unconfirmed') {
    const why = raw.why;
    if (!why || typeof why.code !== 'string' || typeof why.text !== 'string') return null;
    if (why.code.trim() === '' || why.text.trim() === '') return null;
    out.why = { code: why.code, text: why.text };
  }
  return out;
}

/**
 * The engine's coverage label in wire shape, or `null` when absent or not the bundle-1.3.0 shape (an
 * older engine's `mapped_pct` label counted placeholders as mapped, so it is never shown as the real
 * share).
 */
export function coverageOf(raw: ArtifactCoverage | undefined): RequirementsCoverage | null {
  if (raw === undefined || raw === null || typeof raw !== 'object') return null;
  const out = {
    realPct: count(raw.real_pct),
    minPct: count(raw.min_pct),
    behaviorBearing: count(raw.behavior_bearing),
    real: count(raw.real),
    placeholders: count(raw.placeholders),
    unmapped: count(raw.unmapped),
    notProduct: count(raw.not_product),
  };
  // Every field present and an integer, percentages in range —
  // or no label at all.
  if (Object.values(out).some((v) => v === null)) return null;
  const c = out as RequirementsCoverage;
  if (c.realPct > 100 || c.minPct < 1 || c.minPct > 100) return null;
  return c;
}

/** Product-functional requirements come from CODE; statements extracted from
 * lockfiles, manifests, data fixtures, and docs are honest observations about
 * those assets but are NOT product behavior — they class as config-data so the
 * default view can focus on the product. */
export function categoryOf(file: string): RequirementCategory {
  const f = file.toLowerCase();
  const base = f.slice(f.lastIndexOf('/') + 1);
  if (/\.(json|ya?ml|lock|toml|ini|env|md|mdx|txt|csv)$/.test(base)) return 'config-data';
  if (base.includes('pnpm-lock') || base.includes('package-lock')) return 'config-data';
  return 'functional';
}

export interface RequirementSummary {
  key: string; // `${domain}::${reqId}`
  domain: string;
  reqId: string;
  title: string;
  category: RequirementCategory;
  /** First business-rule statement — the requirement's actual content (empty when none). */
  statement: string;
  status: string;
  risk: boolean;
  riskSource: 'operator' | 'data' | null;
  edited: boolean;
  /** Validated (with its source count) or unconfirmed (with why); `null` on an older artifact. */
  corroboration: RequirementCorroboration | null;
}

export interface RequirementDetail extends RequirementSummary {
  description: string;
  notes: string;
  sourceTitle: string;
  ruleCount: number;
  componentCount: number;
  validationCount: number;
  errorPathCount: number;
  businessRules: unknown[];
  legacyComponents: unknown[];
}

interface IndexEntry {
  summary: RequirementSummary;
  haystack: string; // lowercased searchable text
  source: ArtifactRequirement;
}

interface RepoIndex {
  entries: IndexEntry[];
  byKey: Map<string, IndexEntry>;
  /** Content hash of the estate read that built this index. */
  sourceToken: string;
  overridesMtimeMs: number;
  total: number;
  /** Override keys that matched NO row — stale after a re-index/migration (module header). */
  orphanedOverrides: number;
  coverage: RequirementsCoverage | null;
  validated: number;
  unconfirmed: number;
}

/** Keys in the overrides sidecar that no corpus row claimed — counted, never dropped silently. */
function countOrphanedOverrides(
  overrides: Record<string, RequirementOverride>,
  byKey: Map<string, IndexEntry>,
): number {
  let orphaned = 0;
  for (const key of Object.keys(overrides)) if (!byKey.has(key)) orphaned += 1;
  return orphaned;
}

const RISK_RE = /risk/i;

// Paths come from `repoPaths` — this module used to spell the code-graph path itself, which is
// one of the five copies FINDING-069 was made of. It takes the whole `RepoEntry` rather than a
// root path for exactly that reason: a bare string is an invitation to re-derive.

async function mtimeMs(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return -1;
  }
}

async function readOverrides(repo: RepoEntry): Promise<Record<string, RequirementOverride>> {
  try {
    const raw = await readFile(requirementsOverrides(repo), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, RequirementOverride>)
      : {};
  } catch {
    return {};
  }
}

const cache = new Map<string, RepoIndex>();
let tmpSeq = 0;

/** The index for `repo`, built from its graph in estate — cached, rebuilt when the graph read back
 * from estate or the overrides sidecar changes; `null` when no graph has been built yet (the
 * route's 404). */
async function buildIndex(repo: RepoEntry, reader: RequirementsGraphReader): Promise<RepoIndex | null> {
  return (await buildIndexRead(repo, reader)).index;
}

/** {@link buildIndex}, with the coverage of the very read it was built from: what a page that
 * finds no graph says about the share mapped so far (domain-graph-3; codex r1/r2 on #1250 — never
 * a second read, never another request's). */
async function buildIndexRead(
  repo: RepoEntry,
  reader: RequirementsGraphReader,
): Promise<{ index: RepoIndex | null; coverage: RequirementsCoverage | null }> {
  const [read, ovMtime] = await Promise.all([
    readRequirementsGraph(repo, reader),
    mtimeMs(requirementsOverrides(repo)),
  ]);
  const graph = read.graph;
  if (graph === null || typeof graph !== 'object') {
    cache.delete(repoKey(repo)); // nothing built (any more): no stale index survives
    return { index: null, coverage: coverageOf(read.coverage ?? undefined) };
  }
  const token = createHash('sha1')
    .update(JSON.stringify(graph))
    .update(JSON.stringify(read.coverage ?? null))
    .digest('hex');
  const cached = cache.get(repoKey(repo));
  if (cached && cached.sourceToken === token && cached.overridesMtimeMs === ovMtime) {
    return { index: cached, coverage: cached.coverage };
  }
  const overrides = await readOverrides(repo);

  const entries: IndexEntry[] = [];
  const byKey = new Map<string, IndexEntry>();
  for (const [domain, dom] of Object.entries(graph.domains ?? {})) {
    for (const [reqId, req] of Object.entries(dom.requirements ?? {})) {
      const key = `${domain}::${reqId}`;
      const ov = overrides[key];
      // Data-derived risk: any business rule whose serialized form names risk (the
      // extraction harness's RESOLVED-or-RISK floor surfaces here at current fidelity).
      const dataRisk = (req.business_rules ?? []).some((r) => RISK_RE.test(JSON.stringify(r)));
      const risk = ov?.risk !== undefined ? ov.risk : dataRisk;
      const riskSource: RequirementSummary['riskSource'] =
        ov?.risk !== undefined ? 'operator' : dataRisk ? 'data' : null;
      const title = ov?.title ?? req.title ?? reqId;
      const statements = (req.business_rules ?? [])
        .map((r) => {
          const st = (r as { statement?: unknown }).statement;
          return typeof st === 'string' ? st.trim() : '';
        })
        .filter((st) => st !== '');
      const firstComponent = (req.legacy_components ?? []).find((c) => typeof c === 'string') as
        | string
        | undefined;
      const summary: RequirementSummary = {
        key,
        domain,
        reqId,
        title,
        category: categoryOf(firstComponent ?? ''),
        statement: statements[0] ?? '',
        status: ov?.status ?? req.status ?? 'active',
        risk,
        riskSource,
        edited: ov !== undefined,
        corroboration: corroborationOf(req.corroboration),
      };
      // Statements are part of the haystack: searching the requirements means
      // searching the actual rule text, not just titles and ids.
      const haystack = `${reqId} ${domain} ${title} ${req.description ?? ''} ${statements.join(' ')} ${ov?.notes ?? ''}`.toLowerCase();
      const entry: IndexEntry = { summary, haystack, source: req };
      entries.push(entry);
      byKey.set(key, entry);
    }
  }
  const index: RepoIndex = {
    entries,
    byKey,
    sourceToken: token,
    overridesMtimeMs: ovMtime,
    total: entries.length,
    orphanedOverrides: countOrphanedOverrides(overrides, byKey),
    // The label from the store's own counts at read time (a later run that maps more shows up
    // without a rebuild); the build's own label only when an engine sent none.
    coverage: coverageOf(read.coverage ?? graph.metadata?.coverage),
    validated: entries.filter((e) => e.summary.corroboration?.status === 'validated').length,
    unconfirmed: entries.filter((e) => e.summary.corroboration?.status === 'unconfirmed').length,
  };
  cache.set(repoKey(repo), index);
  return { index, coverage: index.coverage };
}

export interface RequirementsQuery {
  q?: string | undefined;
  risk?: 'risk' | 'no-risk' | undefined;
  domain?: string | undefined;
  category?: RequirementCategory | undefined;
  offset: number;
  limit: number;
}

export interface RequirementsPage {
  total: number; // total matching the filters (not the whole corpus)
  corpus: number; // whole corpus size
  offset: number;
  limit: number;
  items: RequirementSummary[];
  /**
   * Which source served this corpus: `'store'`, the repository's estate store read through the
   * engine (operator ruling 2026-10-31; module header). `'artifact'` was the
   * `requirements_graph.json` file older daemons read. (FINDING-065)
   */
  source: 'store' | 'artifact';
  /**
   * Override keys that matched no requirement in this corpus — operator edits stranded by an
   * estate id-scheme migration (method/field SymbolIds re-mint on a full re-extract) or by an
   * artifact regeneration that renamed their domain/reqId. Counted so the edits' existence is
   * never silent; deliberately NOT re-keyed (module header says why).
   */
  orphanedOverrides: number;
  /**
   * The share of behaviours the graph maps and the minimum it was built at ("82% of behaviours
   * mapped"); `null` on an artifact built before domain-model 1.1.0.
   */
  coverage: RequirementsCoverage | null;
  /** How many requirements of the whole corpus are validated / unconfirmed (0/0 on an older artifact). */
  corroboration: { validated: number; unconfirmed: number };
}

/**
 * The answer for a repository whose `requirements_graph.json` has not been generated: a 404 with a
 * typed `code`, never a bare sentence a client can only show as a refusal. It is a state, not an
 * error. `workflow` names the preset whose last step (`wicked-core domain-graph`) writes the graph,
 * so a client can offer to start it. Wire shape: `RequirementsNotGenerated` (api-types 0.154.0).
 */
export const REQUIREMENTS_NOT_GENERATED = {
  error: 'No requirements graph yet for this repository',
  code: 'notGenerated',
  workflow: 'domain-extraction',
} as const;

/** Tokenized AND-match: every whitespace-separated term must appear in the haystack. */
export async function listRequirements(
  repo: RepoEntry,
  query: RequirementsQuery,
  reader: RequirementsGraphReader,
): Promise<RequirementsPage | null> {
  return (await listRequirementsRead(repo, query, reader)).page;
}

/** {@link listRequirements}, with the share mapped so far when there is no graph yet: both from one
 * engine read (the route's notGenerated answer carries it). */
export async function listRequirementsRead(
  repo: RepoEntry,
  query: RequirementsQuery,
  reader: RequirementsGraphReader,
): Promise<{ page: RequirementsPage | null; coverage: RequirementsCoverage | null }> {
  const { index, coverage } = await buildIndexRead(repo, reader);
  if (index === null) return { page: null, coverage };
  return { page: pageOf(index, query), coverage };
}

function pageOf(index: RepoIndex, query: RequirementsQuery): RequirementsPage {
  const terms = (query.q ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const domainFilter = query.domain?.toLowerCase();
  const matched: RequirementSummary[] = [];
  for (const e of index.entries) {
    if (query.category !== undefined && e.summary.category !== query.category) continue;
    if (query.risk === 'risk' && !e.summary.risk) continue;
    if (query.risk === 'no-risk' && e.summary.risk) continue;
    if (domainFilter !== undefined && !e.summary.domain.toLowerCase().includes(domainFilter)) continue;
    if (terms.length > 0 && !terms.every((t) => e.haystack.includes(t))) continue;
    matched.push(e.summary);
  }
  return {
    total: matched.length,
    corpus: index.total,
    offset: query.offset,
    limit: query.limit,
    items: matched.slice(query.offset, query.offset + query.limit),
    source: 'store',
    orphanedOverrides: index.orphanedOverrides,
    coverage: index.coverage,
    corroboration: { validated: index.validated, unconfirmed: index.unconfirmed },
  };
}

export async function getRequirement(
  repo: RepoEntry,
  key: string,
  reader: RequirementsGraphReader,
): Promise<RequirementDetail | null> {
  const index = await buildIndex(repo, reader);
  const entry = index?.byKey.get(key);
  if (index === null || entry === undefined) return null;
  const overrides = await readOverrides(repo);
  const ov = overrides[key];
  const src = entry.source;
  return {
    ...entry.summary,
    description: src.description ?? '',
    notes: ov?.notes ?? '',
    sourceTitle: src.title ?? entry.summary.reqId,
    ruleCount: (src.business_rules ?? []).length,
    componentCount: (src.legacy_components ?? []).length,
    validationCount: (src.validations ?? []).length,
    errorPathCount: (src.error_paths ?? []).length,
    businessRules: (src.business_rules ?? []).slice(0, 10),
    legacyComponents: (src.legacy_components ?? []).slice(0, 10),
  };
}

/** Merge a patch into the overrides sidecar (atomic write) and return the fresh detail. */
export async function patchRequirement(
  repo: RepoEntry,
  key: string,
  patch: RequirementOverride,
  reader: RequirementsGraphReader,
): Promise<RequirementDetail | null> {
  const index = await buildIndex(repo, reader);
  if (index === null || !index.byKey.has(key)) return null;
  const overrides = await readOverrides(repo);
  const next: RequirementOverride = { ...overrides[key] };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.notes !== undefined) next.notes = patch.notes;
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.risk !== undefined) next.risk = patch.risk;
  overrides[key] = next;
  const path = requirementsOverrides(repo);
  await mkdir(dirname(path), { recursive: true });
  // Collision-proof temp name: pid alone can collide for concurrent in-process
  // patches; a monotonic per-process counter disambiguates.
  const tmp = `${path}.tmp-${process.pid}-${++tmpSeq}`;
  await writeFile(tmp, JSON.stringify(overrides, null, 2), 'utf8');
  await rename(tmp, path);
  // The overrides changed, the graph did not: the index rebuilds from the read already in hand.
  cache.delete(repoKey(repo));
  return getRequirement(repo, key, reader);
}
