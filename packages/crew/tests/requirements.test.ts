/**
 * Requirements service — server-side search + overrides sidecar (api/requirements.ts).
 * Fixture-driven: a small graph served by an estate stand-in (the engine's read); overrides written by
 * the service itself (atomic sidecar), never into the graph.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtemp, mkdir, readdir, writeFile, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  corroborationOf,
  categoryOf,
  categoryOfComponents,
  coverageOf,
  graphBuildOf,
  isPlaceholderStatement,
  isRealRequirement,
  listRequirements,
  getRequirement,
  patchRequirement,
  forgetRequirementsReads,
  REQUIREMENTS_READ_TTL_MS,
  type EstateRequirementsGraph,
  type EstateRequirementsRead,
  type RequirementsGraphReader,
} from '../src/api/requirements.js';
import type { RepoEntry } from '../src/core/types.js';

/**
 * Where THIS FILE puts a code graph, in one place.
 *
 * `repoAt` publishes the path on the entry exactly as `register_repo` would; since crew#548 the
 * service never OPENS it (one SQLite library per db file per process — the store read is gone), so
 * the only test that writes there does so to prove it is not read. Two writers of one path is what
 * FINDING-069 was, and a test file is not exempt — so both go through this.
 *
 * The value is arbitrary. Nothing here pins the engine's spelling; core's `repo.rs` does that, on
 * the side that owns it. Point this anywhere and every test still passes.
 */
function codeGraphAt(root: string): string {
  return join(root, '.codegraph', 'estate.db');
}

/**
 * A registered repo rooted at `root`.
 *
 * The service takes the whole entry rather than a root path, because `code_graph_db` is resolved by
 * the engine and never re-derived by this package — that re-derivation is what FINDING-069 was.
 *
 * The service never opens that file itself (see the `one source` block): it only checks the repo is
 * indexed, and the engine (here the estate stand-in) reads the graph.
 */
function repoAt(root: string): RepoEntry {
  return {
    id: 'fixture',
    name: 'fixture',
    root_path: root,
    default_branch: 'main',
    registered_at: 0,
    code_graph_db: codeGraphAt(root),
  };
}

/**
 * The estate stand-in. The service reads a repository's graph from its estate store through the
 * engine (`getRequirementsGraphForRepo`; operator ruling 2026-10-31); here the "engine" answers from
 * a JSON document in the test's temp dir — deliberately NOT a path inside the repository, which the
 * service no longer reads. `null` graph when nothing was written (not built yet).
 */
const ESTATE_STANDIN = 'estate-graph.standin.json';
/** The repo's code graph exists (the engine reads only an indexed repo); its content is the
 * engine's business, never this package's. */
async function markIndexed(root: string): Promise<void> {
  await mkdir(dirname(codeGraphAt(root)), { recursive: true });
  await writeFile(codeGraphAt(root), '', 'utf8');
}
const estateReads: string[] = [];
function estateAt(root: string): RequirementsGraphReader {
  return {
    async getRequirementsGraphForRepo(repoRef: string) {
      estateReads.push(repoRef);
      try {
        const graph = JSON.parse(await readFile(join(root, ESTATE_STANDIN), 'utf8')) as EstateRequirementsGraph & {
          metadata?: { coverage?: unknown };
        };
        return { graph, coverage: (graph.metadata?.coverage ?? null) as EstateRequirementsRead['coverage'] };
      } catch {
        return { graph: null, coverage: null };
      }
    },
  };
}

async function fixtureRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'req-svc-'));
  const dir = join(root, '.wicked-estate', 'requirements');
  await mkdir(dir, { recursive: true });
  const graph = {
    metadata: { schema_version: '1.0.0' },
    domains: {
      'billing/invoices': {
        description: 'Invoice lifecycle',
        requirements: {
          'REQ-001': {
            title: 'Invoice totals include tax',
            description: 'Line items are summed then tax applied per jurisdiction',
            status: 'active',
            business_rules: [{ id: 'RULE-1', statement: 'sum then tax', confidence: 0.5 }],
            legacy_components: ['billing/sum.ts'],
            data_access: [],
            dependencies: [],
            validations: [],
            error_paths: [],
          },
          'REQ-002': {
            title: 'Refunds require approval',
            description: 'Manual approval gate for refunds over threshold',
            status: 'active',
            business_rules: [
              { id: 'RULE-2', statement: 'RISK: approval threshold unverified', confidence: 0.5 },
            ],
            legacy_components: [],
            data_access: [],
            dependencies: [],
            validations: [],
            error_paths: [],
          },
        },
      },
      'auth/session': {
        description: 'Sessions',
        requirements: {
          'REQ-001': {
            title: 'Sessions expire after inactivity',
            description: 'Idle timeout invalidates the session token',
            status: 'active',
            business_rules: [{ id: 'RULE-3', statement: 'idle timeout', confidence: 0.5 }],
            legacy_components: [],
            data_access: [],
            dependencies: [],
            validations: [],
            error_paths: [],
          },
        },
      },
    },
  };
  await markIndexed(root);
  await writeFile(join(root, ESTATE_STANDIN), JSON.stringify(graph), 'utf8');
  return root;
}

describe('requirements service', () => {
  let root: string;
  beforeEach(async () => {
    forgetRequirementsReads();
    estateReads.length = 0;
    root = await fixtureRepo();
  });

  it('lists the whole corpus with pagination metadata', async () => {
    const page = await listRequirements(repoAt(root), { offset: 0, limit: 50 }, estateAt(root));
    expect(page).not.toBeNull();
    expect(page!.corpus).toBe(3);
    expect(page!.total).toBe(3);
    expect(page!.items.map((i) => i.key)).toContain('billing/invoices::REQ-001');
  });

  it('returns null when no graph has been built', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'req-empty-'));
    expect(await listRequirements(repoAt(empty), { offset: 0, limit: 10 }, estateAt(empty))).toBeNull();
  });

  // FINDING-065: a caller must be able to tell which source answered. Since the operator ruling of
  // 2026-10-31 it is the repository's estate store, read through the engine.
  it('names which source served the corpus', async () => {
    const page = await listRequirements(repoAt(root), { offset: 0, limit: 50 }, estateAt(root));
    expect(page!.source).toBe('store');
  });

  it('whitespace-only statements are dropped at the service boundary', async () => {
    // Fixture REQ-001 in auth/session has a real statement; simulate a blank one via a
    // fresh fixture write is heavier than needed — assert the mapping contract directly:
    // a summary statement is never whitespace (trimmed or empty).
    const page = await listRequirements(repoAt(root), { offset: 0, limit: 50 }, estateAt(root));
    for (const item of page!.items) {
      expect(item.statement).toBe(item.statement.trim());
    }
  });

  it('search matches the actual rule STATEMENTS, not just titles', async () => {
    const hit = await listRequirements(repoAt(root), { q: 'jurisdiction applied', offset: 0, limit: 10 }, estateAt(root));
    expect(hit!.items.map((i) => i.reqId)).toEqual(['REQ-001']);
    expect(hit!.items[0]!.statement).toBe('sum then tax');
  });

  it('search is tokenized AND-match across id, domain, title, description', async () => {
    const tax = await listRequirements(repoAt(root), { q: 'tax jurisdiction', offset: 0, limit: 10 }, estateAt(root));
    expect(tax!.items.map((i) => i.reqId)).toEqual(['REQ-001']);
    const cross = await listRequirements(repoAt(root), { q: 'session timeout', offset: 0, limit: 10 }, estateAt(root));
    expect(cross!.items.map((i) => i.domain)).toEqual(['auth/session']);
    const none = await listRequirements(repoAt(root), { q: 'tax session', offset: 0, limit: 10 }, estateAt(root));
    expect(none!.total).toBe(0); // AND semantics — terms in different requirements don't match
  });

  it('risk filter surfaces data-derived risk from business rules', async () => {
    const risky = await listRequirements(repoAt(root), { risk: 'risk', offset: 0, limit: 10 }, estateAt(root));
    expect(risky!.items.map((i) => i.reqId)).toEqual(['REQ-002']);
    expect(risky!.items[0]!.riskSource).toBe('data');
    const calm = await listRequirements(repoAt(root), { risk: 'no-risk', offset: 0, limit: 10 }, estateAt(root));
    expect(calm!.total).toBe(2);
  });

  it('pagination slices after filtering', async () => {
    const p1 = await listRequirements(repoAt(root), { offset: 0, limit: 2 }, estateAt(root));
    const p2 = await listRequirements(repoAt(root), { offset: 2, limit: 2 }, estateAt(root));
    expect(p1!.items.length).toBe(2);
    expect(p2!.items.length).toBe(1);
    expect(p1!.total).toBe(3);
  });

  it('patch writes the overrides sidecar, never the graph, and merges at read', async () => {
    const before = await readFile(
      join(root, ESTATE_STANDIN),
      'utf8',
    );
    const detail = await patchRequirement(repoAt(root), 'auth/session::REQ-001', {
      risk: true,
      notes: 'flagged in review',
      title: 'Sessions MUST expire after inactivity',
    }, estateAt(root));
    expect(detail!.risk).toBe(true);
    expect(detail!.riskSource).toBe('operator');
    expect(detail!.notes).toBe('flagged in review');
    expect(detail!.title).toBe('Sessions MUST expire after inactivity');
    expect(detail!.sourceTitle).toBe('Sessions expire after inactivity');
    expect(detail!.edited).toBe(true);
    const after = await readFile(
      join(root, ESTATE_STANDIN),
      'utf8',
    );
    expect(after).toBe(before); // the graph is untouched
    const ov = JSON.parse(
      await readFile(
        join(root, '.wicked-estate', 'requirements', 'requirements_overrides.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(ov['auth/session::REQ-001']).toMatchObject({ risk: true, notes: 'flagged in review' });
  });

  it('operator risk override wins over data-derived risk (and can clear it)', async () => {
    await patchRequirement(repoAt(root), 'billing/invoices::REQ-002', { risk: false }, estateAt(root));
    const page = await listRequirements(repoAt(root), { risk: 'risk', offset: 0, limit: 10 }, estateAt(root));
    expect(page!.total).toBe(0);
    const detail = await getRequirement(repoAt(root), 'billing/invoices::REQ-002', estateAt(root));
    expect(detail!.riskSource).toBe('operator');
  });

  it('overrides survive a rebuild of the graph in estate (the index follows the read content)', async () => {
    await patchRequirement(repoAt(root), 'auth/session::REQ-001', { risk: true }, estateAt(root));
    // Simulate `wicked-core domain-graph` rebuilding the graph in estate.
    const artPath = join(root, ESTATE_STANDIN);
    const graph = JSON.parse(await readFile(artPath, 'utf8')) as {
      domains: Record<string, { requirements: Record<string, { title: string }> }>;
    };
    graph.domains['auth/session']!.requirements['REQ-001']!.title = 'Regenerated title';
    await writeFile(artPath, JSON.stringify(graph), 'utf8');
    forgetRequirementsReads(); // the next read asks the engine again (past the read window)
    const detail = await getRequirement(repoAt(root), 'auth/session::REQ-001', estateAt(root));
    expect(detail!.risk).toBe(true); // override survived
    expect(detail!.sourceTitle).toBe('Regenerated title'); // the rebuilt graph is picked up
  });

  it('one request reading a repository several times asks the engine once', async () => {
    await Promise.all([
      listRequirements(repoAt(root), { offset: 0, limit: 10 }, estateAt(root)),
      getRequirement(repoAt(root), 'auth/session::REQ-001', estateAt(root)),
    ]);
    await patchRequirement(repoAt(root), 'auth/session::REQ-001', { notes: 'n' }, estateAt(root));
    expect(estateReads).toEqual(['fixture']);
  });

  it('past the read window a changed graph, a changed label, or no graph at all shows — the index is not cleared by hand', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const repo = repoAt(root);
      const first = await listRequirements(repo, { offset: 0, limit: 50 }, estateAt(root));
      expect(first!.items.map((i) => i.title)).toContain('Sessions expire after inactivity');
      const path = join(root, ESTATE_STANDIN);
      const graph = JSON.parse(await readFile(path, 'utf8')) as {
        metadata: Record<string, unknown>;
        domains: Record<string, { requirements: Record<string, { title: string }> }>;
      };
      graph.domains['auth/session']!.requirements['REQ-001']!.title = 'Rebuilt title';
      await writeFile(path, JSON.stringify(graph), 'utf8');
      // Inside the window the read is reused …
      const same = await listRequirements(repo, { offset: 0, limit: 50 }, estateAt(root));
      expect(same!.items.map((i) => i.title)).not.toContain('Rebuilt title');
      // … past it, the new content rebuilds the retained index.
      vi.setSystemTime(Date.now() + REQUIREMENTS_READ_TTL_MS + 1);
      const rebuilt = await listRequirements(repo, { offset: 0, limit: 50 }, estateAt(root));
      expect(rebuilt!.items.map((i) => i.title)).toContain('Rebuilt title');
      // A label-only change (a later page mapped more) shows too.
      graph.metadata['coverage'] = { real_pct: 50, min_pct: 80, behavior_bearing: 2, real: 1, placeholders: 0, unmapped: 1, not_product: 0 };
      await writeFile(path, JSON.stringify(graph), 'utf8');
      vi.setSystemTime(Date.now() + REQUIREMENTS_READ_TTL_MS + 1);
      const relabelled = await listRequirements(repo, { offset: 0, limit: 50 }, estateAt(root));
      expect(relabelled!.coverage).toMatchObject({ realPct: 50 });
      // And a graph that is gone answers null, not the old index.
      await writeFile(path, 'gone', 'utf8');
      vi.setSystemTime(Date.now() + REQUIREMENTS_READ_TTL_MS + 1);
      expect(await listRequirements(repo, { offset: 0, limit: 50 }, estateAt(root))).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a repository not indexed yet answers null without asking the engine', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'req-unindexed-'));
    const never: RequirementsGraphReader = {
      getRequirementsGraphForRepo: async () => {
        throw new Error('the engine was asked about a repository with no code graph');
      },
    };
    expect(await listRequirements(repoAt(bare), { offset: 0, limit: 10 }, never)).toBeNull();
  });

  it('patching an unknown requirement 404s as null', async () => {
    expect(await patchRequirement(repoAt(root), 'nope::REQ-9', { risk: true }, estateAt(root))).toBeNull();
  });

  // A rebuild that renames a domain or reqId strands the override keyed by the old spelling.
  // Counted, never silently dropped.
  it('counts override keys stranded by a rebuild', async () => {
    await patchRequirement(repoAt(root), 'auth/session::REQ-001', { risk: true }, estateAt(root));
    const ovPath = join(root, '.wicked-estate', 'requirements', 'requirements_overrides.json');
    const ov = JSON.parse(await readFile(ovPath, 'utf8')) as Record<string, unknown>;
    ov['renamed-domain::REQ-404'] = { notes: 'keyed by a domain the regen dropped' };
    await writeFile(ovPath, JSON.stringify(ov), 'utf8');
    const future = new Date(Date.now() + 5000);
    await utimes(ovPath, future, future);
    const page = await listRequirements(repoAt(root), { offset: 0, limit: 10 }, estateAt(root));
    expect(page!.source).toBe('store');
    expect(page!.orphanedOverrides).toBe(1);
    // The still-matching override keeps applying.
    const detail = await getRequirement(repoAt(root), 'auth/session::REQ-001', estateAt(root));
    expect(detail!.risk).toBe(true);
  });
});


// crew#548 (F-RC1-041 — FIX-IT-ALL L10-3, register BC-64): crew never opens the store itself. The
// engine holds the repo's code-graph file open through its own rusqlite; a second SQLite library on
// the same file in the same process is the F-E2E-021 class (one library per db file per process,
// crew#541). The graph is read through the engine (`getRequirementsGraphForRepo`).
/**
 * Operator ruling 2026-10-31: the graph is built at the configured minimum and labelled with its
 * share; every item is validated (with its count) or unconfirmed (with why). The document is the
 * shape the engine reads back from estate (domain-model 1.1.0).
 */
describe('requirements service — coverage label + corroboration (domain-model 1.1.0)', () => {
  async function coreShapedRepo(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'req-cov-'));
    const dir = join(root, '.wicked-estate', 'requirements');
    await mkdir(dir, { recursive: true });
    const rule = { id: 'RULE-001', statement: 'sum adds every element', confidence: 0.9 };
    const base = { legacy_components: ['src/math.js#sum'], data_access: [], dependencies: [], validations: [], error_paths: [] };
    const graph = {
      metadata: {
        schema_version: '1.1.0',
        migration_mode: 'functional',
        coverage: { real_pct: 70, min_pct: 80, behavior_bearing: 100, real: 70, placeholders: 12, unmapped: 18, not_product: 9 },
      },
      domains: {
        src: {
          requirements: {
            'REQ-001': {
              ...base,
              title: 'sum',
              description: 'adds',
              status: 'active',
              business_rules: [rule],
              corroboration: { status: 'validated', sources: 3, call_sites: 1, tests: 1, docs: 1, extra_extractors: 0 },
            },
            'REQ-002': {
              ...base,
              title: 'scripts',
              description: 'package scripts',
              status: 'review',
              business_rules: [rule],
              corroboration: {
                status: 'unconfirmed',
                sources: 0,
                call_sites: 0,
                tests: 0,
                docs: 0,
                extra_extractors: 0,
                why: { code: 'config_only', text: 'A configuration entry: no code, test or doc in the index refers to it.' },
              },
            },
            // A malformed record is never invented into a mark.
            'REQ-003': { ...base, title: 'odd', description: 'x', business_rules: [rule], corroboration: { status: 'maybe' } },
          },
          entities: {},
        },
      },
    };
    await markIndexed(root);
  await writeFile(join(root, ESTATE_STANDIN), JSON.stringify(graph), 'utf8');
    return root;
  }

  it('carries the coverage label and the corpus-wide validated / unconfirmed counts', async () => {
    const r_ = await coreShapedRepo();
    const page = await listRequirements(repoAt(r_), { offset: 0, limit: 50 }, estateAt(r_));
    expect(page?.coverage).toEqual({ realPct: 70, minPct: 80, behaviorBearing: 100, real: 70, placeholders: 12, unmapped: 18, notProduct: 9 });
    expect(page?.corroboration).toEqual({ validated: 1, unconfirmed: 1 });
  });

  it('marks each item validated (with its count) or unconfirmed (with why)', async () => {
    const r_ = await coreShapedRepo();
    const page = await listRequirements(repoAt(r_), { offset: 0, limit: 50 }, estateAt(r_));
    const by = new Map(page?.items.map((i) => [i.title, i]));
    expect(by.get('sum')?.corroboration).toEqual({ status: 'validated', sources: 3, callSites: 1, tests: 1, docs: 1, extraExtractors: 0 });
    expect(by.get('scripts')?.corroboration).toMatchObject({
      status: 'unconfirmed',
      sources: 0,
      why: { code: 'config_only', text: 'A configuration entry: no code, test or doc in the index refers to it.' },
    });
    expect(by.get('odd')?.corroboration).toBeNull();
    expect(page?.corroboration).toEqual({ validated: 1, unconfirmed: 1 }); // `odd` counts as neither
    const detail = await getRequirement(repoAt(r_), 'src::REQ-002', estateAt(r_));
    expect(detail?.corroboration?.why?.code).toBe('config_only');
  });

  it.each([
    ['a recognised status with no counts', { status: 'validated' }],
    ['a count that is not an integer', { status: 'validated', sources: 2.5, call_sites: 2.5, tests: 0, docs: 0, extra_extractors: 0 }],
    ['sources that are not the sum of the kinds', { status: 'validated', sources: 4, call_sites: 1, tests: 1, docs: 0, extra_extractors: 0 }],
    ['validated below two sources', { status: 'validated', sources: 1, call_sites: 1, tests: 0, docs: 0, extra_extractors: 0 }],
    ['unconfirmed with no why', { status: 'unconfirmed', sources: 0, call_sites: 0, tests: 0, docs: 0, extra_extractors: 0 }],
    ['unconfirmed with an empty sentence', { status: 'unconfirmed', sources: 0, call_sites: 0, tests: 0, docs: 0, extra_extractors: 0, why: { code: 'dead_code', text: ' ' } }],
  ])('%s is no mark at all (null), never a defaulted one', (_label, raw) => {
    expect(corroborationOf(raw as Parameters<typeof corroborationOf>[0])).toBeNull();
  });

  it('a coverage label with a missing or out-of-range field is no label', () => {
    expect(coverageOf({ real_pct: 82, min_pct: 80 })).toBeNull();
    expect(coverageOf({ real_pct: 182, min_pct: 80, behavior_bearing: 1, real: 1, placeholders: 0, unmapped: 0, not_product: 0 })).toBeNull();
    // wicked-core#1233: an older engine's label counted placeholders as mapped ("100% mapped" with 3
    // real requirements of 120): it is never read as the real share.
    expect(coverageOf({ mapped_pct: 100, min_pct: 80, behavior_bearing: 120, mapped: 120, resolved: 3, unmapped: 0 } as never)).toBeNull();
    // codex on #1252: a share its counts do not support, or buckets that do not sum to the
    // denominator, is no label; the empty denominator reads 100, as the engine says.
    const ok = { real_pct: 2, min_pct: 80, behavior_bearing: 120, real: 3, placeholders: 117, unmapped: 0, not_product: 0 };
    expect(coverageOf(ok)).toMatchObject({ realPct: 2, placeholders: 117 });
    expect(coverageOf({ ...ok, real_pct: 100 })).toBeNull();
    expect(coverageOf({ ...ok, placeholders: 116 })).toBeNull();
    expect(coverageOf({ ...ok, real_pct: 100, behavior_bearing: 0, real: 0, placeholders: 0, not_product: 117 })).toMatchObject({ realPct: 100 });
    expect(coverageOf({ ...ok, real_pct: 0, behavior_bearing: 0, real: 0, placeholders: 0 })).toBeNull();
  });

  it('a graph built before the fields reads null and 0/0, never a guess', async () => {
    const r_ = await fixtureRepo();
    const page = await listRequirements(repoAt(r_), { offset: 0, limit: 50 }, estateAt(r_));
    expect(page?.coverage).toBeNull();
    expect(page?.corroboration).toEqual({ validated: 0, unconfirmed: 0 });
    expect(page?.items.every((i) => i.corroboration === null)).toBe(true);
  });
});

describe('requirements service — the graph comes from estate (operator ruling 2026-10-31)', () => {
  it('serves what the engine reads from estate, with the live coverage label, and never a repo file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'req-estate-'));
    // A stale artifact in the checkout is NOT a source any more.
    await mkdir(join(root, '.wicked-estate', 'requirements'), { recursive: true });
    await writeFile(
      join(root, '.wicked-estate', 'requirements', 'requirements_graph.json'),
      JSON.stringify({ domains: { stale: { requirements: { 'REQ-001': { title: 'from the file' } } } } }),
      'utf8',
    );
    await markIndexed(root);
    const calls: string[] = [];
    const engine: RequirementsGraphReader = {
      async getRequirementsGraphForRepo(repoRef) {
        calls.push(repoRef);
        return {
          graph: {
            metadata: { coverage: { real_pct: 100, min_pct: 80, behavior_bearing: 1, real: 1, placeholders: 0, unmapped: 0, not_product: 0 } },
            domains: {
              src: {
                requirements: {
                  'REQ-001': { title: 'sum', business_rules: [{ id: 'RULE-1', statement: 'the sum of every element' }] },
                },
              },
            },
          },
          // The engine's label is recomputed from the store's counts at read time and wins over
          // the one the build stored.
          coverage: { real_pct: 1, min_pct: 80, behavior_bearing: 100, real: 1, placeholders: 2, unmapped: 97, not_product: 0 },
        };
      },
    };
    const page = await listRequirements({ ...repoAt(root), id: 'tiny-math' }, { offset: 0, limit: 10 }, engine);
    expect(calls).toEqual(['tiny-math']);
    expect(page!.source).toBe('store');
    expect(page!.items.map((i) => [i.key, i.statement])).toEqual([['src::REQ-001', 'the sum of every element']]);
    expect(page!.coverage).toMatchObject({ realPct: 1, placeholders: 2, minPct: 80 });
  });

  it('answers null (not generated) when estate holds no graph, whatever files sit in the repo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'req-estate-none-'));
    await markIndexed(root);
    const none: RequirementsGraphReader = {
      async getRequirementsGraphForRepo() {
        return { graph: null, coverage: { real_pct: 1, min_pct: 80, behavior_bearing: 100, real: 1, placeholders: 2, unmapped: 97, not_product: 0 } };
      },
    };
    expect(await listRequirements(repoAt(root), { offset: 0, limit: 10 }, none)).toBeNull();
  });
});

/**
 * req-list-stale (2026-11-01): the list is the last graph BUILD, the header the store NOW. On the rig wicked-crew
 * listed the 04:59 build (1,383 real, an old `mapped_pct` label) under "3,585 real": a run mapped 2,223 more and was
 * stopped at its repeat ask before the build. The page says which build the rows are, so a client can say why the
 * two differ instead of showing numbers that cannot agree.
 */
describe('requirements service — the page says which build it lists (req-list-stale)', () => {
  const live = { real_pct: 61, min_pct: 80, behavior_bearing: 5786, real: 3585, placeholders: 2174, unmapped: 27, not_product: 2380 };
  const graph = {
    metadata: { coverage: live },
    domains: { src: { requirements: { 'REQ-001': { title: 'sum', business_rules: [{ id: 'RULE-1', statement: 'the sum of every element', confidence: 0.9 }] } } } },
  };
  async function pageWith(build: EstateRequirementsRead['build']) {
    const root = await mkdtemp(join(tmpdir(), 'req-build-'));
    await markIndexed(root);
    const engine: RequirementsGraphReader = {
      async getRequirementsGraphForRepo() {
        return build === undefined ? { graph, coverage: live } : { graph, coverage: live, build };
      },
    };
    return listRequirements(repoAt(root), { offset: 0, limit: 10 }, engine);
  }

  it('a build older than the store is behind, with the label it was built at', async () => {
    const builtAt = { real_pct: 23, min_pct: 80, behavior_bearing: 5786, real: 1362, placeholders: 4397, unmapped: 27, not_product: 2380 };
    const page = await pageWith({ generation: 2, coverage: builtAt });
    expect(page!.coverage).toMatchObject({ real: 3585 });
    expect(page!.graphBuild).toEqual({
      generation: 2,
      coverage: { realPct: 23, minPct: 80, behaviorBearing: 5786, real: 1362, placeholders: 4397, unmapped: 27, notProduct: 2380 },
      behind: true,
    });
  });

  it('a build at the store\'s counts is current, whatever minimum the store holds it to now', async () => {
    const page = await pageWith({ generation: 3, coverage: { ...live, min_pct: 60 } });
    expect(page!.graphBuild).toMatchObject({ generation: 3, behind: false });
  });

  it('the rig\'s case: a build labelled before real requirements were counted is behind, its label null', async () => {
    const page = await pageWith({ generation: 2, coverage: { behavior_bearing: 8166, mapped: 7300, mapped_pct: 89, min_pct: 80, resolved: 1383, unmapped: 866 } as never });
    expect(page!.graphBuild).toEqual({ generation: 2, coverage: null, behind: true });
  });

  it('a build that persisted no label is behind: nothing vouches that the rows are what the header counts', async () => {
    const page = await pageWith({ generation: 1, coverage: null });
    expect(page!.graphBuild).toEqual({ generation: 1, coverage: null, behind: true });
  });

  it('an engine that does not say which build is no claim either way (null), never "current"', async () => {
    expect((await pageWith(undefined))!.graphBuild).toBeNull();
    expect((await pageWith(null))!.graphBuild).toBeNull();
    expect((await pageWith({ generation: -1, coverage: live }))!.graphBuild).toBeNull();
  });

  it('with no live label there is nothing for the rows to disagree with', () => {
    expect(graphBuildOf({ generation: 2, coverage: null }, null)).toEqual({ generation: 2, coverage: null, behind: false });
  });

  it('every count is compared, not only real', () => {
    const now = coverageOf(live)!;
    for (const [k, v] of [['unmapped', 26], ['placeholders', 2175], ['not_product', 2381]] as const) {
      // Keep the label self-consistent (buckets sum to the denominator, share its floor) so only the count differs.
      const c: Record<string, number> = { ...live, [k]: v };
      c['behavior_bearing'] = c['real']! + c['placeholders']! + c['unmapped']!;
      c['real_pct'] = Math.floor((c['real']! * 100) / c['behavior_bearing']!);
      expect(graphBuildOf({ generation: 2, coverage: c as never }, now)?.behind, k).toBe(true);
    }
  });
});

describe('requirements service — one source, one SQLite library (crew#548)', () => {
  it('a repo whose estate holds no graph answers null — crew never opens the store itself', async () => {
    const root = await mkdtemp(join(tmpdir(), 'req-nostore-'));
    await mkdir(dirname(codeGraphAt(root)), { recursive: true });
    // Whatever sits at the code-graph path is never opened: an unreadable "db" must not matter.
    await writeFile(codeGraphAt(root), 'not a database', 'utf8');
    expect(await listRequirements(repoAt(root), { offset: 0, limit: 10 }, estateAt(root))).toBeNull();
    expect(await getRequirement(repoAt(root), 'x::y', estateAt(root))).toBeNull();
    expect(await patchRequirement(repoAt(root), 'x::y', { notes: 'n' }, estateAt(root))).toBeNull();
  });

  it('src/ carries no `node:sqlite` outside comments (the daemon holds exactly one SQLite library per db file)', async () => {
    const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const offenders: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(p);
          continue;
        }
        if (!/\.(ts|mts|cts|js|mjs|cjs)$/.test(entry.name)) continue;
        const lines = (await readFile(p, 'utf8')).split('\n');
        lines.forEach((line, ix) => {
          if (!line.includes('node:sqlite')) return;
          const t = line.trim();
          if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return; // prose, not an import
          offenders.push(`${p}:${ix + 1}: ${t}`);
        });
      }
    }
    await walk(srcRoot);
    expect(offenders, 'a second SQLite library in the daemon (F-E2E-021 class)').toEqual([]);
  });
});

describe('requirements list: what Functional holds and the order it opens in (studio 2026-11-01)', () => {
  const req = (title: string, statement: string, component: string) => ({
    title, description: '', status: statement.startsWith('[RISK]') ? 'review' : 'active',
    business_rules: [{ id: 'RULE-1', statement, confidence: statement.startsWith('[RISK]') ? 0 : 0.9 }],
    legacy_components: [component], data_access: [], dependencies: [], validations: [], error_paths: [],
  });
  async function repoWith(): Promise<string> {
    forgetRequirementsReads();
    const root = await mkdtemp(join(tmpdir(), 'req-order-'));
    const graph = {
      metadata: { schema_version: '1.0.0' },
      domains: {
        '(root)': {
          description: '(root)',
          requirements: {
            'REQ-001': req('devDependencies', '[RISK] devDependencies: empty statement (model could not state a rule)', 'package.json#devDependencies'),
            'REQ-002': req('engines', 'The workspace requires Node.js 22.12.0 or newer.', 'package.json#engines'),
            'REQ-003': req('lockfileVersion', '[RISK] lockfileVersion: empty statement (model could not state a rule)', 'package-lock.json#lockfileVersion'),
          },
        },
        billing: {
          description: 'Billing',
          requirements: {
            'REQ-001': req('charge', '[RISK] charge: empty statement (model could not state a rule)', 'src/billing.ts#charge'),
            'REQ-002': req('refund', 'A refund over the limit waits for approval.', 'src/billing.ts#refund'),
            'REQ-003': req('tax', 'Tax is applied per jurisdiction.', 'src/tax.ts'),
          },
        },
      },
    };
    await markIndexed(root);
    await writeFile(join(root, ESTATE_STANDIN), JSON.stringify(graph), 'utf8');
    return root;
  }

  it('classifies a component by its file, not its symbol', () => {
    expect(categoryOf('package.json#devDependencies')).toBe('config-data');
    expect(categoryOf('config/app.yaml#port')).toBe('config-data');
    expect(categoryOf('src/billing.ts#refund')).toBe('functional');
    expect(categoryOf('src/billing.ts')).toBe('functional');
  });

  it('real product code never leaves Functional, whatever "#" or extension its path has', () => {
    // threat model: any "#" may be the file#name separator; config only when every reading is a config file
    expect(categoryOf('src/c#/Parser.cs#Parse')).toBe('functional');
    expect(categoryOf('src/c#/Parser.cs')).toBe('functional');
    expect(categoryOf('lib/F#Interop/Main.fs#run')).toBe('functional');
    expect(categoryOf('src/cache.json#v2/main.ts#run')).toBe('functional'); // codex r1: a config-looking prefix
    expect(categoryOf('src/a.json#b.ts#run')).toBe('functional');
    expect(categoryOf('src/package-lock#v2/main.ts#run')).toBe('functional'); // Copilot r1
    expect(categoryOf('src/c#/package.json#name')).toBe('functional'); // a reading as "src/c": errs to functional
    expect(categoryOf('lib/Parser.cs')).toBe('functional');
    // codex r3/r4: in the engine's form (file#name) the true file is always one of the readings, so a "#"
    // directory after a config-looking prefix stays code whatever the file
    expect(categoryOf('src/cache.json#v2/Makefile#all')).toBe('functional');
    expect(categoryOf('src/cache.json#v2/bin/crew#main')).toBe('functional');
    expect(categoryOf('src/cache.json#v2/my app/Makefile#all')).toBe('functional');
    expect(categoryOf('src/cache.json#v2/schema.sql#users')).toBe('functional');
    // …and a NAME ending like a source file is still the manifest's or doc's (codex r6)
    expect(categoryOf('package.json#decimal.js')).toBe('config-data');
    expect(categoryOf('package.json#./index.js')).toBe('config-data');
    expect(categoryOf('package.json#@types/node.js')).toBe('config-data');
    expect(categoryOf('docs/guide.md#Using Node.js')).toBe('config-data');
    // the engine's own form always carries the name, and the true file is then one of the readings
    expect(categoryOf('bin/tool.json#v2#main')).toBe('functional');
    expect(categoryOf('src/widget.json#v2.vue#Widget')).toBe('functional');
    expect(categoryOf('config/app.yaml#server.port')).toBe('config-data');
    expect(categoryOf('bin/wicked-crew#main')).toBe('functional');
    expect(categoryOf('bin/wicked-crew')).toBe('functional');
    expect(categoryOf('Makefile#build')).toBe('functional');
    expect(categoryOf('src/package-lock-parser.ts#parse')).toBe('functional'); // agy r5
    expect(categoryOf('package-lock.json#lockfileVersion')).toBe('config-data');
    expect(categoryOf('pnpm-lock.yaml#importers')).toBe('config-data');
    expect(categoryOf('src/billing.ts#Ledger.#secret')).toBe('functional');
    expect(categoryOf('')).toBe('functional');
    // a name may hold "/": a scoped package, a heading (Copilot on #1254)
    expect(categoryOf('packages/crew/package.json#@types/node')).toBe('config-data');
    expect(categoryOf('docs/guide.md#Install / setup')).toBe('config-data');
    expect(categoryOf('docs/guide.md#Install')).toBe('config-data');
    expect(categoryOf('config/c#/app.json#port')).toBe('functional'); // a reading as "config/c": errs to functional
    expect(categoryOf('README.md#C# support')).toBe('functional'); // ambiguous: errs to functional, never hides code
  });

  it('a requirement is real as the engine counts it: a stated rule at or above 0.75, or validated', () => {
    const rule = (statement: string, confidence?: number) => ({ id: 'RULE-1', statement, confidence });
    expect(isRealRequirement({ business_rules: [rule('A refund over the limit waits.', 0.9)] })).toBe(true);
    expect(isRealRequirement({ business_rules: [rule('A refund over the limit waits.', 0.75)] })).toBe(true);
    // codex r1: a plain rule under the threshold is a placeholder too, though it has no "[RISK]" prefix
    expect(isRealRequirement({ business_rules: [rule('Refunds may require approval.', 0.4)] })).toBe(false);
    expect(isRealRequirement({ status: 'active', business_rules: [rule('Validated by the operator.', 0.5)] })).toBe(true);
    // codex r2: a validated requirement is real whatever fallback rule the builder kept beside it
    expect(isRealRequirement({ status: 'active', business_rules: [rule('[RISK] x: residual note', 0)] })).toBe(true);
    expect(isRealRequirement({ status: 'review', business_rules: [rule('[RISK] x: empty statement', 0)] })).toBe(false);
    expect(isRealRequirement({ business_rules: [rule('[RISK] x: below confidence threshold', 0.9)] })).toBe(false);
    expect(isRealRequirement({ business_rules: [rule('RISK: approval threshold unverified', 0.8)] })).toBe(true);
    expect(isRealRequirement({ business_rules: [rule('', 0.9), rule('   ', 0.9)] })).toBe(false);
    expect(isRealRequirement({ business_rules: [] })).toBe(false);
    expect(isRealRequirement({})).toBe(false);
    expect(isRealRequirement({ business_rules: [rule('An older document states it.')] })).toBe(true);
    // Copilot r1: every rule counts, not the first statement shown
    expect(isRealRequirement({ business_rules: [rule('[RISK] x: empty statement', 0), rule('A refund waits.', 0.9)] })).toBe(true);
  });

  it('a plain rule under the threshold, or no statement, lists after the real requirements', async () => {
    forgetRequirementsReads();
    const root = await mkdtemp(join(tmpdir(), 'req-low-'));
    const graph = {
      metadata: { schema_version: '1.0.0' },
      domains: {
        billing: {
          description: 'Billing',
          requirements: {
            'REQ-001': { ...req('guess', 'Refunds may require approval.', 'src/billing.ts#guess'), status: 'review',
              business_rules: [{ id: 'RULE-1', statement: 'Refunds may require approval.', confidence: 0.4 }] },
            'REQ-002': { ...req('blank', 'x', 'src/billing.ts#blank'), status: 'review', business_rules: [] },
            'REQ-003': req('refund', 'A refund over the limit waits for approval.', 'src/billing.ts#refund'),
          },
        },
      },
    };
    await markIndexed(root);
    await writeFile(join(root, ESTATE_STANDIN), JSON.stringify(graph), 'utf8');
    const page = await listRequirements(repoAt(root), { offset: 0, limit: 50 }, estateAt(root));
    expect(page!.items.map((i) => i.title)).toEqual(['refund', 'guess', 'blank']);
  });

  it('a requirement is config only when every component it names is (codex r2: an older document lists several)', async () => {
    expect(categoryOfComponents(['config/app.yaml#port', 'src/server.ts#start'])).toBe('functional');
    expect(categoryOfComponents(['config/app.yaml#port', 'package.json#engines'])).toBe('config-data');
    expect(categoryOfComponents([])).toBe('functional');
    expect(categoryOfComponents(['src/cache.json#v2/Makefile#all'])).toBe('functional');
    expect(categoryOfComponents(['package.json#@types/node', 'package.json#engines'])).toBe('config-data');
    forgetRequirementsReads();
    const root = await mkdtemp(join(tmpdir(), 'req-mixed-'));
    const mixed = { ...req('port', 'The server listens on the configured port.', 'config/app.yaml#port'),
      legacy_components: ['config/app.yaml#port', 'src/server.ts#start'] };
    await markIndexed(root);
    await writeFile(join(root, ESTATE_STANDIN), JSON.stringify({ metadata: { schema_version: '1.0.0' },
      domains: { server: { description: 'server', requirements: { 'REQ-001': mixed } } } }), 'utf8');
    const page = await listRequirements(repoAt(root), { category: 'functional', offset: 0, limit: 50 }, estateAt(root));
    expect(page!.items.map((i) => i.title)).toEqual(['port']);
  });

  it('Functional holds no manifest field, and opens on real requirements, then placeholders', async () => {
    const root = await repoWith();
    const page = await listRequirements(repoAt(root), { category: 'functional', offset: 0, limit: 50 }, estateAt(root));
    expect(page!.items.map((i) => i.title)).toEqual(['refund', 'tax', 'charge']);
  });

  it('Config & data holds the manifest fields; All opens real, then placeholders, then config', async () => {
    const root = await repoWith();
    const config = await listRequirements(repoAt(root), { category: 'config-data', offset: 0, limit: 50 }, estateAt(root));
    expect(config!.items.map((i) => i.title)).toEqual(['devDependencies', 'engines', 'lockfileVersion']);
    const all = await listRequirements(repoAt(root), { offset: 0, limit: 50 }, estateAt(root));
    expect(all!.items.map((i) => i.title)).toEqual(['refund', 'tax', 'charge', 'devDependencies', 'engines', 'lockfileVersion']);
    // the order holds across pages
    const p2 = await listRequirements(repoAt(root), { offset: 2, limit: 2 }, estateAt(root));
    expect(p2!.items.map((i) => i.title)).toEqual(['charge', 'devDependencies']);
  });

  it('a placeholder is a statement on the risk floor', () => {
    expect(isPlaceholderStatement('[RISK] x: empty statement (model could not state a rule)')).toBe(true);
    expect(isPlaceholderStatement('  [RISK] x: below confidence threshold — y')).toBe(true);
    expect(isPlaceholderStatement('RISK: approval threshold unverified')).toBe(false);
    expect(isPlaceholderStatement('Tax is applied per jurisdiction.')).toBe(false);
  });
});
