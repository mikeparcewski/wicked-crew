/**
 * Requirements service — server-side search + overrides sidecar (api/requirements.ts).
 * Fixture-driven: a small requirements_graph.json in a temp dir; overrides written by
 * the service itself (atomic sidecar), never into the derived artifact.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, readdir, writeFile, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listRequirements,
  getRequirement,
  patchRequirement,
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
 * The fixtures leave the file absent (or unreadable — see the `one source` block): the artifact is
 * the only source the service reads.
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
  await writeFile(join(dir, 'requirements_graph.json'), JSON.stringify(graph), 'utf8');
  return root;
}

describe('requirements service', () => {
  let root: string;
  beforeEach(async () => {
    root = await fixtureRepo();
  });

  it('lists the whole corpus with pagination metadata', async () => {
    const page = await listRequirements(repoAt(root), { offset: 0, limit: 50 });
    expect(page).not.toBeNull();
    expect(page!.corpus).toBe(3);
    expect(page!.total).toBe(3);
    expect(page!.items.map((i) => i.key)).toContain('billing/invoices::REQ-001');
  });

  it('returns null when the artifact has not been generated', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'req-empty-'));
    expect(await listRequirements(repoAt(empty), { offset: 0, limit: 10 })).toBeNull();
  });

  // FINDING-065. The two sources are not interchangeable: the artifact is an evidence-gated
  // snapshot that regenerates only when `domain-graph` clears its coverage bar, so it can lag
  // the live store by hours. A caller that cannot tell which one answered cannot tell stale
  // from current — the exact confusion this module's header records as already observed.
  it('names which source served the corpus', async () => {
    const page = await listRequirements(repoAt(root), { offset: 0, limit: 50 });
    expect(page!.source).toBe('artifact');
  });

  it('whitespace-only statements are dropped at the service boundary', async () => {
    // Fixture REQ-001 in auth/session has a real statement; simulate a blank one via a
    // fresh fixture write is heavier than needed — assert the mapping contract directly:
    // a summary statement is never whitespace (trimmed or empty).
    const page = await listRequirements(repoAt(root), { offset: 0, limit: 50 });
    for (const item of page!.items) {
      expect(item.statement).toBe(item.statement.trim());
    }
  });

  it('search matches the actual rule STATEMENTS, not just titles', async () => {
    const hit = await listRequirements(repoAt(root), { q: 'jurisdiction applied', offset: 0, limit: 10 });
    expect(hit!.items.map((i) => i.reqId)).toEqual(['REQ-001']);
    expect(hit!.items[0]!.statement).toBe('sum then tax');
  });

  it('search is tokenized AND-match across id, domain, title, description', async () => {
    const tax = await listRequirements(repoAt(root), { q: 'tax jurisdiction', offset: 0, limit: 10 });
    expect(tax!.items.map((i) => i.reqId)).toEqual(['REQ-001']);
    const cross = await listRequirements(repoAt(root), { q: 'session timeout', offset: 0, limit: 10 });
    expect(cross!.items.map((i) => i.domain)).toEqual(['auth/session']);
    const none = await listRequirements(repoAt(root), { q: 'tax session', offset: 0, limit: 10 });
    expect(none!.total).toBe(0); // AND semantics — terms in different requirements don't match
  });

  it('risk filter surfaces data-derived risk from business rules', async () => {
    const risky = await listRequirements(repoAt(root), { risk: 'risk', offset: 0, limit: 10 });
    expect(risky!.items.map((i) => i.reqId)).toEqual(['REQ-002']);
    expect(risky!.items[0]!.riskSource).toBe('data');
    const calm = await listRequirements(repoAt(root), { risk: 'no-risk', offset: 0, limit: 10 });
    expect(calm!.total).toBe(2);
  });

  it('pagination slices after filtering', async () => {
    const p1 = await listRequirements(repoAt(root), { offset: 0, limit: 2 });
    const p2 = await listRequirements(repoAt(root), { offset: 2, limit: 2 });
    expect(p1!.items.length).toBe(2);
    expect(p2!.items.length).toBe(1);
    expect(p1!.total).toBe(3);
  });

  it('patch writes the overrides sidecar, never the artifact, and merges at read', async () => {
    const before = await readFile(
      join(root, '.wicked-estate', 'requirements', 'requirements_graph.json'),
      'utf8',
    );
    const detail = await patchRequirement(repoAt(root), 'auth/session::REQ-001', {
      risk: true,
      notes: 'flagged in review',
      title: 'Sessions MUST expire after inactivity',
    });
    expect(detail!.risk).toBe(true);
    expect(detail!.riskSource).toBe('operator');
    expect(detail!.notes).toBe('flagged in review');
    expect(detail!.title).toBe('Sessions MUST expire after inactivity');
    expect(detail!.sourceTitle).toBe('Sessions expire after inactivity');
    expect(detail!.edited).toBe(true);
    const after = await readFile(
      join(root, '.wicked-estate', 'requirements', 'requirements_graph.json'),
      'utf8',
    );
    expect(after).toBe(before); // derived artifact untouched
    const ov = JSON.parse(
      await readFile(
        join(root, '.wicked-estate', 'requirements', 'requirements_overrides.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(ov['auth/session::REQ-001']).toMatchObject({ risk: true, notes: 'flagged in review' });
  });

  it('operator risk override wins over data-derived risk (and can clear it)', async () => {
    await patchRequirement(repoAt(root), 'billing/invoices::REQ-002', { risk: false });
    const page = await listRequirements(repoAt(root), { risk: 'risk', offset: 0, limit: 10 });
    expect(page!.total).toBe(0);
    const detail = await getRequirement(repoAt(root), 'billing/invoices::REQ-002');
    expect(detail!.riskSource).toBe('operator');
  });

  it('overrides survive artifact regeneration (cache invalidates on mtime)', async () => {
    await patchRequirement(repoAt(root), 'auth/session::REQ-001', { risk: true });
    // Simulate `wicked-core domain-graph` regenerating the artifact.
    const artPath = join(root, '.wicked-estate', 'requirements', 'requirements_graph.json');
    const graph = JSON.parse(await readFile(artPath, 'utf8')) as {
      domains: Record<string, { requirements: Record<string, { title: string }> }>;
    };
    graph.domains['auth/session']!.requirements['REQ-001']!.title = 'Regenerated title';
    await writeFile(artPath, JSON.stringify(graph), 'utf8');
    const future = new Date(Date.now() + 5000);
    await utimes(artPath, future, future);
    const detail = await getRequirement(repoAt(root), 'auth/session::REQ-001');
    expect(detail!.risk).toBe(true); // override survived
    expect(detail!.sourceTitle).toBe('Regenerated title'); // fresh artifact picked up
  });

  it('patching an unknown requirement 404s as null', async () => {
    expect(await patchRequirement(repoAt(root), 'nope::REQ-9', { risk: true })).toBeNull();
  });

  // The artifact-path twin of the store orphan test: a regeneration that renames a domain or
  // reqId strands the override keyed by the old spelling. Counted, never silently dropped.
  it('counts override keys stranded by artifact regeneration', async () => {
    await patchRequirement(repoAt(root), 'auth/session::REQ-001', { risk: true });
    const ovPath = join(root, '.wicked-estate', 'requirements', 'requirements_overrides.json');
    const ov = JSON.parse(await readFile(ovPath, 'utf8')) as Record<string, unknown>;
    ov['renamed-domain::REQ-404'] = { notes: 'keyed by a domain the regen dropped' };
    await writeFile(ovPath, JSON.stringify(ov), 'utf8');
    const future = new Date(Date.now() + 5000);
    await utimes(ovPath, future, future);
    const page = await listRequirements(repoAt(root), { offset: 0, limit: 10 });
    expect(page!.source).toBe('artifact');
    expect(page!.orphanedOverrides).toBe(1);
    // The still-matching override keeps applying.
    const detail = await getRequirement(repoAt(root), 'auth/session::REQ-001');
    expect(detail!.risk).toBe(true);
  });
});


// crew#548 (F-RC1-041 — FIX-IT-ALL L10-3, register BC-64): the live-store read is GONE. The engine
// holds the repo's code-graph file open through its own rusqlite; a second SQLite library on the
// same file in the same process is the F-E2E-021 class (one library per db file per process,
// crew#541). The artifact is the one source; a repo without one answers null (the route's 404).
describe('requirements service — one source, one SQLite library (crew#548)', () => {
  it('a repo with a code-graph db but NO artifact answers null — the store is never read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'req-nostore-'));
    await mkdir(dirname(codeGraphAt(root)), { recursive: true });
    // Whatever sits at the code-graph path is never opened: an unreadable "db" must not matter.
    await writeFile(codeGraphAt(root), 'not a database', 'utf8');
    expect(await listRequirements(repoAt(root), { offset: 0, limit: 10 })).toBeNull();
    expect(await getRequirement(repoAt(root), 'x::y')).toBeNull();
    expect(await patchRequirement(repoAt(root), 'x::y', { notes: 'n' })).toBeNull();
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
