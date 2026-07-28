/**
 * REQUIREMENTS SERVICE — server-side search + operator overrides over the
 * `requirements_graph.json` artifact (produced by `wicked-core domain-graph`).
 *
 * Why server-side: the first real artifact is 38MB / ~35k requirements — shipping it
 * to the browser for JS-side filtering is not search. The daemon parses it ONCE into a
 * flat index (cached, invalidated on file mtime), and queries run here: tokenized
 * AND-match over id/domain/title/description, risk + domain filters, offset/limit
 * pagination.
 *
 * Why an OVERRIDES sidecar: the artifact is DERIVED (regenerated from the estate
 * store), so operator edits written into it would be clobbered on the next
 * `domain-graph` run. Edits live in `requirements_overrides.json` beside the artifact,
 * keyed `domain::reqId`, and are merged at read time — the overlay survives
 * regeneration and keeps provenance honest (`riskSource: operator` vs `data`).
 */
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';

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

export interface RequirementSummary {
  key: string; // `${domain}::${reqId}`
  domain: string;
  reqId: string;
  title: string;
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
  artifactMtimeMs: number;
  overridesMtimeMs: number;
  total: number;
}

const RISK_RE = /risk/i;

function artifactPath(rootPath: string): string {
  return join(rootPath, '.wicked-estate', 'requirements', 'requirements_graph.json');
}
function overridesPath(rootPath: string): string {
  return join(rootPath, '.wicked-estate', 'requirements', 'requirements_overrides.json');
}

async function mtimeMs(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return -1;
  }
}

async function readOverrides(rootPath: string): Promise<Record<string, RequirementOverride>> {
  try {
    const raw = await readFile(overridesPath(rootPath), 'utf8');
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

async function buildIndex(rootPath: string): Promise<RepoIndex | null> {
  const [artMtime, ovMtime] = await Promise.all([
    mtimeMs(artifactPath(rootPath)),
    mtimeMs(overridesPath(rootPath)),
  ]);
  if (artMtime < 0) return null; // artifact absent — requirements not generated yet

  const cached = cache.get(rootPath);
  if (cached && cached.artifactMtimeMs === artMtime && cached.overridesMtimeMs === ovMtime) {
    return cached;
  }

  const raw = await readFile(artifactPath(rootPath), 'utf8');
  const graph = JSON.parse(raw) as { domains?: Record<string, ArtifactDomain> };
  const overrides = await readOverrides(rootPath);

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
      const summary: RequirementSummary = {
        key,
        domain,
        reqId,
        title,
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
    artifactMtimeMs: artMtime,
    overridesMtimeMs: ovMtime,
    total: entries.length,
  };
  cache.set(rootPath, index);
  return index;
}

export interface RequirementsQuery {
  q?: string | undefined;
  risk?: 'risk' | 'no-risk' | undefined;
  domain?: string | undefined;
  offset: number;
  limit: number;
}

export interface RequirementsPage {
  total: number; // total matching the filters (not the whole corpus)
  corpus: number; // whole corpus size
  offset: number;
  limit: number;
  items: RequirementSummary[];
}

/** Tokenized AND-match: every whitespace-separated term must appear in the haystack. */
export async function listRequirements(
  rootPath: string,
  query: RequirementsQuery,
): Promise<RequirementsPage | null> {
  const index = await buildIndex(rootPath);
  if (index === null) return null;
  const terms = (query.q ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const domainFilter = query.domain?.toLowerCase();
  const matched: RequirementSummary[] = [];
  for (const e of index.entries) {
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
  };
}

export async function getRequirement(
  rootPath: string,
  key: string,
): Promise<RequirementDetail | null> {
  const index = await buildIndex(rootPath);
  const entry = index?.byKey.get(key);
  if (index === null || entry === undefined) return null;
  const overrides = await readOverrides(rootPath);
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
  rootPath: string,
  key: string,
  patch: RequirementOverride,
): Promise<RequirementDetail | null> {
  const index = await buildIndex(rootPath);
  if (index === null || !index.byKey.has(key)) return null;
  const overrides = await readOverrides(rootPath);
  const next: RequirementOverride = { ...overrides[key] };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.notes !== undefined) next.notes = patch.notes;
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.risk !== undefined) next.risk = patch.risk;
  overrides[key] = next;
  const path = overridesPath(rootPath);
  await mkdir(dirname(path), { recursive: true });
  // Collision-proof temp name: pid alone can collide for concurrent in-process
  // patches; a monotonic per-process counter disambiguates.
  const tmp = `${path}.tmp-${process.pid}-${++tmpSeq}`;
  await writeFile(tmp, JSON.stringify(overrides, null, 2), 'utf8');
  await rename(tmp, path);
  cache.delete(rootPath); // next read rebuilds with the new overrides
  return getRequirement(rootPath, key);
}
