/**
 * REQUIREMENTS SERVICE — server-side search + operator overrides over the evidence-gated
 * `requirements_graph.json` artifact.
 *
 * ONE source (crew#548, F-RC1-041 — FIX-IT-ALL L10-3): until 0.7.35 this module ALSO opened the
 * repo's code-graph store through a second SQLite library (`node:sqlite`, read-only, per request)
 * and served the live `nodes.requirement` rows first, falling back to the artifact. The engine
 * holds the same file open in-process through its own rusqlite (`getCoverageReportForRepo`), and
 * a second library on one SQLite file in one process is the F-E2E-021 class that corrupted the
 * bus db (one library per db file per process — crew#541). The store path is DELETED: the
 * artifact `wicked-core domain-graph` regenerates when its coverage bar passes is the only
 * source, and `RequirementsPage.source` always reads `'artifact'`. Named loss: a repo whose
 * domain-graph never passed its coverage bar answers the existing 404 ("requirements_graph.json
 * not generated") where the live store used to answer — the observed lag the old header cited as
 * the reason the store went primary; not on any RC2 journey (register BC-64). Live freshness, if
 * wanted later, is ONE additive core-ts read (`requirementsIndexJson`), never a second library.
 *
 * Why server-side: 15k+ requirements — shipping them to the browser for JS-side
 * filtering is not search. The daemon builds a flat index (cached, invalidated on
 * artifact/overrides mtime), and queries run here: tokenized AND-match over
 * id/domain/title/statements, risk + domain filters, offset/limit pagination.
 *
 * Why an OVERRIDES sidecar: the artifact is DERIVED (regenerated from the estate
 * store), so operator edits written into it would be clobbered on the next
 * `domain-graph` run. Edits live in `requirements_overrides.json` beside the artifact,
 * keyed `domain::reqId`, and are merged at read time — the overlay survives
 * regeneration and keeps provenance honest (`riskSource: operator` vs `data`).
 *
 * ORPHANED OVERRIDES: an override key matches by exact string, so a key the corpus no
 * longer mints simply stops matching — silently. That happens on an artifact regeneration
 * that renames a domain or reqId. The index therefore COUNTS the keys that matched no row
 * and surfaces the count as `orphanedOverrides` on every page, so the edits' existence is
 * never invisible. It does NOT re-key them: guessing the mapping here would attach an
 * operator's risk note to the wrong requirement.
 */
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { requirementsGraph, requirementsOverrides } from '../core/repoPaths.js';
import type { RepoEntry } from '../core/types.js';

interface ArtifactRequirement {
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

export interface RequirementOverride {
  title?: string | undefined;
  notes?: string | undefined;
  status?: string | undefined;
  risk?: boolean | undefined;
}

export type RequirementCategory = 'functional' | 'config-data';

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
  /** mtime of the artifact that built this index. */
  sourceMtimeMs: number;
  overridesMtimeMs: number;
  total: number;
  /** Override keys that matched NO row — stale after a re-index/migration (module header). */
  orphanedOverrides: number;
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

/** The artifact-built index for `repo` — cached, rebuilt when the artifact or the overrides
 * sidecar changes mtime; `null` when the artifact does not exist yet (the route's 404). */
async function buildIndex(repo: RepoEntry): Promise<RepoIndex | null> {
  const [artMtime, ovMtime] = await Promise.all([
    mtimeMs(requirementsGraph(repo)),
    mtimeMs(requirementsOverrides(repo)),
  ]);
  if (artMtime < 0) return null; // no artifact — requirements not generated yet
  const cached = cache.get(repo.root_path);
  if (cached && cached.sourceMtimeMs === artMtime && cached.overridesMtimeMs === ovMtime) {
    return cached;
  }

  const raw = await readFile(requirementsGraph(repo), 'utf8');
  const graph = JSON.parse(raw) as { domains?: Record<string, ArtifactDomain> };
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
    sourceMtimeMs: artMtime,
    overridesMtimeMs: ovMtime,
    total: entries.length,
    orphanedOverrides: countOrphanedOverrides(overrides, byKey),
  };
  cache.set(repo.root_path, index);
  return index;
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
   * Which source served this corpus. Always `'artifact'` since 0.7.35 (crew#548 — the live-store
   * read through a second SQLite library is gone; module header); the `'store'` arm stays in the
   * wire type (`wicked-crew-api-types`) for readers of older daemons. (FINDING-065)
   */
  source: 'store' | 'artifact';
  /**
   * Override keys that matched no requirement in this corpus — operator edits stranded by an
   * estate id-scheme migration (method/field SymbolIds re-mint on a full re-extract) or by an
   * artifact regeneration that renamed their domain/reqId. Counted so the edits' existence is
   * never silent; deliberately NOT re-keyed (module header says why).
   */
  orphanedOverrides: number;
}

/** Tokenized AND-match: every whitespace-separated term must appear in the haystack. */
export async function listRequirements(
  repo: RepoEntry,
  query: RequirementsQuery,
): Promise<RequirementsPage | null> {
  const index = await buildIndex(repo);
  if (index === null) return null;
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
    source: 'artifact',
    orphanedOverrides: index.orphanedOverrides,
  };
}

export async function getRequirement(
  repo: RepoEntry,
  key: string,
): Promise<RequirementDetail | null> {
  const index = await buildIndex(repo);
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
): Promise<RequirementDetail | null> {
  const index = await buildIndex(repo);
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
  cache.delete(repo.root_path); // next read rebuilds with the new overrides
  return getRequirement(repo, key);
}
