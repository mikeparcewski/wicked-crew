/**
 * REQUIREMENTS SERVICE — server-side search + operator overrides over the LIVE
 * estate store, with the `requirements_graph.json` artifact as fallback.
 *
 * Why the store is primary: the artifact is an evidence-gated SNAPSHOT — it only
 * regenerates when `wicked-core domain-graph` passes its coverage bar, so mid-extraction
 * it can lag the store by hours (observed: a UI serving day-old placeholder titles while
 * the store held thousands of validated statements). Requirements content lives in
 * estate (`nodes.requirement` + RULE-* annotations); the UI reads that truth directly
 * (read-only `node:sqlite`) and falls back to the artifact for repos without a store
 * or on runtimes without the sqlite builtin.
 *
 * Why server-side: 15k+ requirements — shipping them to the browser for JS-side
 * filtering is not search. The daemon builds a flat index (cached, invalidated on
 * store/artifact mtime with a small TTL guard against WAL-churn thrash), and queries
 * run here: tokenized AND-match over id/domain/title/statements, risk + domain
 * filters, offset/limit pagination.
 *
 * Why an OVERRIDES sidecar: the artifact is DERIVED (regenerated from the estate
 * store), so operator edits written into it would be clobbered on the next
 * `domain-graph` run. Edits live in `requirements_overrides.json` beside the artifact,
 * keyed `domain::reqId`, and are merged at read time — the overlay survives
 * regeneration and keeps provenance honest (`riskSource: operator` vs `data`).
 */
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { codeGraphDb, requirementsGraph, requirementsOverrides } from '../core/repoPaths.js';
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
  /** mtime of whichever source built this index (store db+wal, or artifact). */
  sourceMtimeMs: number;
  fromStore: boolean;
  overridesMtimeMs: number;
  builtAtMs: number;
  total: number;
}

const RISK_RE = /risk/i;
const RISK_PREFIX = '[RISK]';
/** WAL churn during extraction touches the db every few seconds — don't rebuild a
 * 15k-row index per keystroke; a fresh-enough index is authoritative for this long. */
const REBUILD_TTL_MS = 5_000;

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

/** Minimal surface of the `node:sqlite` builtin (typed locally: the project's
 * @types/node predates it; the import is resolved dynamically at runtime). */
interface SqliteDatabase {
  prepare(sql: string): { all(): unknown[] };
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => SqliteDatabase;
}

/** Lazily resolved sqlite builtin — absent on older Node runtimes → artifact fallback. */
let sqliteMod: SqliteModule | null | undefined;
async function sqlite(): Promise<SqliteModule | null> {
  if (sqliteMod === undefined) {
    try {
      const name = 'node:sqlite';
      sqliteMod = (await import(name)) as SqliteModule;
    } catch {
      sqliteMod = null;
    }
  }
  return sqliteMod;
}

interface StoreRow {
  sym: string;
  name: string | null;
  file: string | null;
  requirement: string;
  validated: number;
}

/** Build the index from the LIVE estate store (read-only). Returns null when the
 * store can't serve (no db, no sqlite builtin, schema mismatch) — caller falls back. */
async function buildStoreIndex(
  repo: RepoEntry,
  sourceMtime: number,
  ovMtime: number,
): Promise<RepoIndex | null> {
  const mod = await sqlite();
  if (mod === null) return null;
  const overrides = await readOverrides(repo);
  let db: SqliteDatabase | null = null;
  const entries: IndexEntry[] = [];
  const byKey = new Map<string, IndexEntry>();
  try {
    db = new mod.DatabaseSync(codeGraphDb(repo), { readOnly: true });
    const rules = new Map<number, { statement: string; confidence: number | null }[]>();
    for (const r of db
      .prepare("SELECT node_sym, value, confidence FROM annotations WHERE key LIKE 'RULE-%'")
      .all() as { node_sym: number; value: string | null; confidence: number | null }[]) {
      const list = rules.get(r.node_sym) ?? [];
      list.push({ statement: r.value ?? '', confidence: r.confidence });
      rules.set(r.node_sym, list);
    }
    const rows = db
      .prepare(
        `SELECT n.symbol AS sid, s.sym AS sym, n.name, n.file, n.requirement,
                n.requirement_validated AS validated
         FROM nodes n JOIN symbols s ON s.sid = n.symbol
         WHERE n.requirement IS NOT NULL AND n.requirement != ''`,
      )
      .all() as (StoreRow & { sid: number })[];
    for (const row of rows) {
      const key = row.sym;
      const ov = overrides[key];
      const file = row.file ?? '';
      const slash = file.lastIndexOf('/');
      const domain = slash > 0 ? file.slice(0, slash) : '(root)';
      const dataRisk = row.requirement.startsWith(RISK_PREFIX);
      const risk = ov?.risk !== undefined ? ov.risk : dataRisk;
      const riskSource: RequirementSummary['riskSource'] =
        ov?.risk !== undefined ? 'operator' : dataRisk ? 'data' : null;
      const title = ov?.title ?? (row.name !== null && row.name !== '' ? row.name : key);
      const nodeRules = rules.get(row.sid) ?? [];
      const summary: RequirementSummary = {
        key,
        domain,
        reqId: key,
        title,
        category: categoryOf(file),
        statement: row.requirement,
        status: ov?.status ?? (row.validated === 1 ? 'validated' : 'active'),
        risk,
        riskSource,
        edited: ov !== undefined,
      };
      const source: ArtifactRequirement = {
        title,
        description: file,
        status: summary.status,
        legacy_components: file === '' ? [] : [file],
        business_rules: nodeRules,
      };
      const haystack =
        `${key} ${domain} ${title} ${row.requirement} ${nodeRules.map((r) => r.statement).join(' ')} ${ov?.notes ?? ''}`.toLowerCase();
      const entry: IndexEntry = { summary, haystack, source };
      entries.push(entry);
      byKey.set(key, entry);
    }
  } catch {
    return null; // schema drift or unreadable store — artifact fallback
  } finally {
    db?.close();
  }
  return {
    entries,
    byKey,
    sourceMtimeMs: sourceMtime,
    fromStore: true,
    overridesMtimeMs: ovMtime,
    builtAtMs: Date.now(),
    total: entries.length,
  };
}

async function buildIndex(repo: RepoEntry): Promise<RepoIndex | null> {
  const db = codeGraphDb(repo);
  const [dbMtime, walMtime, artMtime, ovMtime] = await Promise.all([
    mtimeMs(db),
    mtimeMs(`${db}-wal`),
    mtimeMs(requirementsGraph(repo)),
    mtimeMs(requirementsOverrides(repo)),
  ]);
  const storeMtime = Math.max(dbMtime, walMtime);

  const cached = cache.get(repo.root_path);
  // TTL applies ONLY to store-built indexes: extraction WAL churn changes the db
  // mtime every few seconds and must not trigger a rebuild per request. Artifact
  // mtime changes only on regen, so artifact-built indexes always mtime-check.
  if (cached?.fromStore === true && Date.now() - cached.builtAtMs < REBUILD_TTL_MS) return cached;

  if (storeMtime >= 0) {
    if (cached && cached.sourceMtimeMs === storeMtime && cached.overridesMtimeMs === ovMtime) {
      cached.builtAtMs = Date.now();
      return cached;
    }
    const fromStore = await buildStoreIndex(repo, storeMtime, ovMtime);
    if (fromStore !== null) {
      cache.set(repo.root_path, fromStore);
      return fromStore;
    }
  }

  if (artMtime < 0) return null; // no store, no artifact — requirements not generated yet
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
    fromStore: false,
    overridesMtimeMs: ovMtime,
    builtAtMs: Date.now(),
    total: entries.length,
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
   * Which of the two sources served this corpus. The module header explains why that
   * matters operationally — the artifact is an evidence-gated snapshot that can lag the
   * live store by hours, and a UI serving stale placeholder titles while the store held
   * thousands of validated statements is an observed failure, not a hypothetical. Without
   * this the caller cannot tell which one it is looking at. (FINDING-065)
   */
  source: 'store' | 'artifact';
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
    source: index.fromStore ? 'store' : 'artifact',
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
