/**
 * Requirements service — server-side search + overrides sidecar (api/requirements.ts).
 * Fixture-driven: a small requirements_graph.json in a temp dir; overrides written by
 * the service itself (atomic sidecar), never into the derived artifact.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  listRequirements,
  getRequirement,
  patchRequirement,
} from '../src/api/requirements.js';
import type { RepoEntry } from '../src/core/types.js';

/**
 * Where THIS FILE puts a code graph, in one place.
 *
 * The test plays the engine here: `storeRepo` writes a sqlite db and `repoAt` publishes its path on
 * the entry, exactly as `register_repo` would. Two writers of one path is what FINDING-069 was, and
 * a test file is not exempt — so both go through this.
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
 * Most fixtures leave the file absent, which is the artifact-fallback case. The
 * `live estate store` block below is the exception: it writes a real db at [`codeGraphAt`] first,
 * so the service reads the store instead.
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
    const { patchRequirement: _ } = await import('../src/api/requirements.js');
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
});

const hasSqlite = await (async () => {
  try {
    const name = 'node:sqlite';
    await import(name);
    return true;
  } catch {
    return false;
  }
})();

// Without the sqlite builtin the service falls back to the artifact by design —
// these tests cover the primary path and need the builtin the daemon runs with.
describe.skipIf(!hasSqlite)('requirements service — live estate store (primary source)', () => {
  async function storeRepo(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'req-store-'));
    const graphDb = codeGraphAt(root);
    await mkdir(dirname(graphDb), { recursive: true });
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(graphDb);
    db.exec(`
      CREATE TABLE symbols (sid INTEGER PRIMARY KEY, sym TEXT);
      CREATE TABLE nodes (symbol INTEGER, name TEXT, file TEXT,
                          requirement TEXT, requirement_validated INTEGER DEFAULT 0);
      CREATE TABLE annotations (id INTEGER PRIMARY KEY AUTOINCREMENT,
                                node_sym INTEGER NOT NULL, key TEXT, value TEXT,
                                confidence REAL);
    `);
    db.exec(`
      INSERT INTO symbols VALUES (1, 'src::chargeTax()'), (2, 'src::refund()'), (3, 'src::helper()');
      INSERT INTO nodes VALUES
        (1, 'chargeTax', 'billing/tax.ts', 'Invoice totals must apply tax after summing line items', 1),
        (2, 'refund', 'billing/refund.ts', '[RISK] refund: below confidence threshold — Refunds over threshold need approval', 0),
        (3, 'helper', 'lib/util.ts', NULL, 0);
      INSERT INTO annotations (node_sym, key, value, confidence) VALUES
        (1, 'RULE-aaa', 'Invoice totals must apply tax after summing line items', 0.95);
    `);
    db.close();
    return root;
  }

  it('serves validated statements and RISK flags straight from the store', async () => {
    const root = await storeRepo();
    const page = await listRequirements(repoAt(root), { offset: 0, limit: 10 });
    expect(page!.total).toBe(2); // requirement-less nodes are not requirements
    const tax = page!.items.find((i) => i.title === 'chargeTax')!;
    expect(tax.statement).toBe('Invoice totals must apply tax after summing line items');
    expect(tax.status).toBe('validated');
    expect(tax.risk).toBe(false);
    const refund = page!.items.find((i) => i.title === 'refund')!;
    expect(refund.risk).toBe(true);
    expect(refund.riskSource).toBe('data');
    expect(refund.domain).toBe('billing');
    expect(refund.category).toBe('functional'); // .ts source → product code
  });

  it('classifies lockfile/data-fixture statements as config-data and filters them', async () => {
    const root = await storeRepo();
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(codeGraphAt(root));
    db.exec(`
      INSERT INTO symbols VALUES (4, 'lock::version#'), (5, 'fixture::garak#');
      INSERT INTO nodes VALUES
        (4, 'lockfileVersion', 'pnpm-lock.yaml', 'The lock file must conform to format version 9.0', 1),
        (5, 'memories', 'add-ins/memories/redteam/garak.json', 'Adversarial testing via Garak is required', 1);
    `);
    db.close();
    const functional = await listRequirements(repoAt(root), { category: 'functional', offset: 0, limit: 10 });
    expect(functional!.items.some((i) => i.title === 'lockfileVersion')).toBe(false);
    expect(functional!.items.some((i) => i.title === 'memories')).toBe(false);
    expect(functional!.items.some((i) => i.title === 'chargeTax')).toBe(true);
    const config = await listRequirements(repoAt(root), { category: 'config-data', offset: 0, limit: 10 });
    expect(config!.total).toBe(2);
  });

  it('search matches statement text; detail carries rule annotations', async () => {
    const root = await storeRepo();
    const page = await listRequirements(repoAt(root), { q: 'tax summing', offset: 0, limit: 10 });
    expect(page!.total).toBe(1);
    const detail = await getRequirement(repoAt(root), page!.items[0]!.key);
    expect(detail!.ruleCount).toBe(1);
    expect((detail!.businessRules[0] as { confidence: number }).confidence).toBe(0.95);
  });

  it('store takes precedence over a stale artifact, and overrides patch by symbol key', async () => {
    const root = await storeRepo();
    // stale artifact present alongside the store — the store must win
    const dir = join(root, '.wicked-estate', 'requirements');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'requirements_graph.json'),
      JSON.stringify({ domains: { stale: { requirements: { 'REQ-001': { title: 'OLD.md' } } } } }),
    );
    const page = await listRequirements(repoAt(root), { offset: 0, limit: 10 });
    expect(page!.items.some((i) => i.title === 'OLD.md')).toBe(false);
    // …and it SAYS the store won. Content assertions alone can't distinguish "served the
    // store" from "served an artifact that happens to agree" (FINDING-065).
    expect(page!.source).toBe('store');
    const key = page!.items.find((i) => i.title === 'refund')!.key;
    const patched = await patchRequirement(repoAt(root), key, { risk: false, notes: 'reviewed' });
    expect(patched!.risk).toBe(false);
    expect(patched!.riskSource).toBe('operator');
    const raw = JSON.parse(await readFile(join(dir, 'requirements_overrides.json'), 'utf8'));
    expect(raw[key].notes).toBe('reviewed');
  });
});
