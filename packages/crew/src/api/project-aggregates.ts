/**
 * crew#371: a PROJECT's requirements, domain and coverage, as FOLDS over the per-repo reads that
 * already exist (design: program-2026-09 design/DES-W4-CR5-PRODUCT-AGGREGATES.md, posted on the
 * issue). No new source:
 *
 *  - requirements: `listRequirements` over each repo's `requirements_graph.json` artifact (the one
 *    source, crew#548);
 *  - domain: the same artifact, summarised per domain (full graphs stay on
 *    `GET /repos/:id/domain-graph`; N 15k-requirement graphs in one body is not a view);
 *  - coverage: `adapter.getCoverageReportForRepo` per repo, never the vacuous store-wide report.
 *
 * Every `crew.repo` member is a ROW, never dropped: `ok`, `absent` (nothing generated or indexed
 * yet), `error` (with its status and message), or `dangling` (the member's registry record is
 * gone). The studio Product view (wicked-studio#157 / #158) reads these.
 */

import { readFile } from 'node:fs/promises';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { CoreAdapter } from '../core/adapter.js';
import { ProjectsUnsupportedError } from '../core/adapter.js';
import { requirementsGraph } from '../core/repoPaths.js';
import type {
  ProjectAggregateRowBase,
  ProjectAggregateTotals,
  ProjectCoverageResponse,
  ProjectCoverageRow,
  ProjectDomainResponse,
  ProjectDomainRow,
  ProjectDomainSummary,
  ProjectRequirementsResponse,
  ProjectRequirementsRow,
  RepoEntry,
} from '../core/types.js';
import { DEFAULT_PROJECT_ID } from '../projects/default-project.js';
import { listRequirements, type RequirementSummary } from './requirements.js';

const V = '/api/v1';

/** At most this many repos are read at once. */
export const AGGREGATE_CONCURRENCY = 4;
/** A repo's coverage read that takes longer than this is that row's `error`. */
export const COVERAGE_TIMEOUT_MS = 15_000;

type RowBase = ProjectAggregateRowBase;
type AggregateTotals = ProjectAggregateTotals;
type DomainSummary = ProjectDomainSummary;

/** The project's repos, in membership order: registered ones, and the refs whose record is gone. */
type Member = { ref: string; repo: RepoEntry | null };

class AggregateHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function membersOf(adapter: CoreAdapter, projectId: string): Promise<Member[]> {
  if (projectId === DEFAULT_PROJECT_ID) return []; // synthesized, never stored: it has no members
  let project;
  try {
    project = await adapter.projectGet(projectId);
  } catch (err) {
    if (err instanceof ProjectsUnsupportedError) throw new AggregateHttpError(501, err.message);
    throw err;
  }
  if (project === null) throw new AggregateHttpError(404, `Project ${projectId} not found`);
  const refs = (await adapter.projectMembers(projectId)).filter((m) => m.member_kind === 'crew.repo').map((m) => m.member_ref);
  const repos = await adapter.listRepos();
  return [...new Set(refs)].map((ref) => ({ ref, repo: repos.find((r) => r.id === ref) ?? null }));
}

/** Map with at most {@link AGGREGATE_CONCURRENCY} in flight, results in input order. */
async function mapBounded<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(AGGREGATE_CONCURRENCY, items.length) }, worker));
  return out;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function repoOf(m: Member): RowBase['repo'] {
  return { id: m.ref, name: m.repo?.name ?? null };
}

function totalsOf(rows: readonly RowBase[]): AggregateTotals {
  return {
    repos: rows.length,
    ok: rows.filter((r) => r.state === 'ok').length,
    absent: rows.filter((r) => r.state === 'absent').length,
    errors: rows.filter((r) => r.state === 'error').length,
    dangling: rows.filter((r) => r.state === 'dangling').length,
  };
}

const DANGLING = 'the repository is a project member but is no longer registered';

export const ProjectRequirementsQuerySchema = z
  .object({
    q: z.string().optional(),
    risk: z.enum(['risk', 'no-risk']).optional(),
    category: z.enum(['functional', 'config-data']).optional(),
    domain: z.string().optional(),
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export async function projectRequirements(
  adapter: CoreAdapter,
  projectId: string,
  query: z.output<typeof ProjectRequirementsQuerySchema>,
): Promise<ProjectRequirementsResponse> {
  const members = await membersOf(adapter, projectId);
  const filters = { q: query.q, risk: query.risk, category: query.category, domain: query.domain };
  // Pass 1: each repo's matching count (the index is cached per artifact mtime).
  const counted = await mapBounded(members, async (m): Promise<ProjectRequirementsRow> => {
    const base = { repo: repoOf(m), total: 0, corpus: 0, orphanedOverrides: 0, items: [] as RequirementSummary[] };
    if (m.repo === null) return { ...base, state: 'dangling', reason: DANGLING };
    try {
      const page = await listRequirements(m.repo, { ...filters, offset: 0, limit: 0 });
      if (page === null) return { ...base, state: 'absent', reason: 'requirements_graph.json not generated for this repo yet' };
      return { ...base, state: 'ok', total: page.total, corpus: page.corpus, orphanedOverrides: page.orphanedOverrides };
    } catch (err) {
      return { ...base, state: 'error', reason: message(err) };
    }
  });
  // Pass 2: fill the GLOBAL window [offset, offset + limit) across the repos in membership order.
  let skip = query.offset;
  let want = query.limit;
  const rows = await Promise.all(
    counted.map((row, i) => {
      if (row.state !== 'ok' || want === 0) return Promise.resolve(row);
      if (skip >= row.total) {
        skip -= row.total;
        return Promise.resolve(row);
      }
      const offset = skip;
      const limit = Math.min(want, row.total - skip);
      skip = 0;
      want -= limit;
      return listRequirements(members[i]!.repo!, { ...filters, offset, limit })
        .then((page): ProjectRequirementsRow => (page === null ? { ...row, state: 'absent', reason: 'requirements_graph.json disappeared while reading' } : { ...row, items: page.items }))
        .catch((err: unknown): ProjectRequirementsRow => ({ ...row, state: 'error', reason: message(err) }));
    }),
  );
  const ok = rows.filter((r) => r.state === 'ok');
  return {
    projectId,
    totals: { ...totalsOf(rows), total: ok.reduce((n, r) => n + r.total, 0), corpus: ok.reduce((n, r) => n + r.corpus, 0) },
    offset: query.offset,
    limit: query.limit,
    rows,
  };
}

/** The artifact's domains, summarised. `null` when the artifact is absent. */
async function domainsOf(repo: RepoEntry): Promise<DomainSummary[] | null> {
  let raw: string;
  try {
    raw = await readFile(requirementsGraph(repo), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const graph = JSON.parse(raw) as { domains?: Record<string, { description?: unknown; requirements?: unknown; entities?: unknown }> };
  const count = (v: unknown): number => (typeof v === 'object' && v !== null ? Object.keys(v).length : 0);
  return Object.entries(graph.domains ?? {}).map(([name, d]) => ({
    name,
    description: typeof d.description === 'string' ? d.description : null,
    requirements: count(d.requirements),
    entities: count(d.entities),
  }));
}

export async function projectDomain(adapter: CoreAdapter, projectId: string): Promise<ProjectDomainResponse> {
  const members = await membersOf(adapter, projectId);
  const rows = await mapBounded(members, async (m): Promise<ProjectDomainRow> => {
    if (m.repo === null) return { repo: repoOf(m), state: 'dangling', reason: DANGLING, domains: [] };
    try {
      const domains = await domainsOf(m.repo);
      return domains === null
        ? { repo: repoOf(m), state: 'absent', reason: 'requirements_graph.json not generated for this repo yet', domains: [] }
        : { repo: repoOf(m), state: 'ok', domains };
    } catch (err) {
      return { repo: repoOf(m), state: 'error', reason: message(err), domains: [] };
    }
  });
  const merged = new Map<string, { name: string; repoIds: string[]; requirements: number; entities: number }>();
  for (const row of rows) {
    for (const d of row.domains) {
      const m = merged.get(d.name) ?? { name: d.name, repoIds: [], requirements: 0, entities: 0 };
      m.repoIds.push(row.repo.id);
      m.requirements += d.requirements;
      m.entities += d.entities;
      merged.set(d.name, m);
    }
  }
  const all = rows.flatMap((r) => r.domains);
  return {
    projectId,
    totals: {
      ...totalsOf(rows),
      domains: merged.size,
      requirements: all.reduce((n, d) => n + d.requirements, 0),
      entities: all.reduce((n, d) => n + d.entities, 0),
    },
    merged: [...merged.values()].sort((a, b) => a.name.localeCompare(b.name)),
    rows,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000} s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export async function projectCoverage(
  adapter: CoreAdapter,
  projectId: string,
  timeoutMs: number = COVERAGE_TIMEOUT_MS,
): Promise<ProjectCoverageResponse> {
  const members = await membersOf(adapter, projectId);
  const rows = await mapBounded(members, async (m): Promise<ProjectCoverageRow> => {
    if (m.repo === null) return { repo: repoOf(m), state: 'dangling', reason: DANGLING, report: null };
    try {
      const report = await withTimeout(adapter.getCoverageReportForRepo(m.ref), timeoutMs, 'the coverage read');
      return report === null
        ? { repo: repoOf(m), state: 'absent', reason: "the repo's code graph holds no nodes yet", report: null }
        : { repo: repoOf(m), state: 'ok', report };
    } catch (err) {
      return { repo: repoOf(m), state: 'error', reason: message(err), report: null };
    }
  });
  const ok = rows.filter((r) => r.report !== null).map((r) => r.report!);
  const behavior = ok.reduce((n, r) => n + r.behavior_bearing, 0);
  const resolved = ok.reduce((n, r) => n + r.resolved, 0);
  return {
    projectId,
    totals: { ...totalsOf(rows), behavior_bearing: behavior, resolved, coverage: behavior > 0 ? resolved / behavior : null },
    rows,
  };
}

/** `GET /projects/:id/{requirements,domain,coverage}`. */
export function registerProjectAggregateRoutes(app: FastifyInstance, adapter: CoreAdapter): void {
  const fail = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown): unknown => {
    if (err instanceof AggregateHttpError) return reply.code(err.status).send({ error: err.message });
    throw err;
  };
  app.get(
    `${V}/projects/:id/requirements`,
    { config: { manifest: { responseType: 'ProjectRequirementsResponse', statusCodes: [200, 400, 404, 501] } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = ProjectRequirementsQuerySchema.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid query', issues: parsed.error.issues });
      try {
        return await projectRequirements(adapter, id, parsed.data);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );
  app.get(
    `${V}/projects/:id/domain`,
    { config: { manifest: { responseType: 'ProjectDomainResponse', statusCodes: [200, 404, 501] } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        return await projectDomain(adapter, id);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );
  app.get(
    `${V}/projects/:id/coverage`,
    { config: { manifest: { responseType: 'ProjectCoverageResponse', statusCodes: [200, 404, 501] } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        return await projectCoverage(adapter, id);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );
}
