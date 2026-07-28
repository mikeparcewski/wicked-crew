/**
 * Requirements service — server-side search + overrides sidecar (api/requirements.ts).
 * Fixture-driven: a small requirements_graph.json in a temp dir; overrides written by
 * the service itself (atomic sidecar), never into the derived artifact.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listRequirements,
  getRequirement,
  patchRequirement,
} from '../src/api/requirements.js';

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
    const page = await listRequirements(root, { offset: 0, limit: 50 });
    expect(page).not.toBeNull();
    expect(page!.corpus).toBe(3);
    expect(page!.total).toBe(3);
    expect(page!.items.map((i) => i.key)).toContain('billing/invoices::REQ-001');
  });

  it('returns null when the artifact has not been generated', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'req-empty-'));
    expect(await listRequirements(empty, { offset: 0, limit: 10 })).toBeNull();
  });

  it('search is tokenized AND-match across id, domain, title, description', async () => {
    const tax = await listRequirements(root, { q: 'tax jurisdiction', offset: 0, limit: 10 });
    expect(tax!.items.map((i) => i.reqId)).toEqual(['REQ-001']);
    const cross = await listRequirements(root, { q: 'session timeout', offset: 0, limit: 10 });
    expect(cross!.items.map((i) => i.domain)).toEqual(['auth/session']);
    const none = await listRequirements(root, { q: 'tax session', offset: 0, limit: 10 });
    expect(none!.total).toBe(0); // AND semantics — terms in different requirements don't match
  });

  it('risk filter surfaces data-derived risk from business rules', async () => {
    const risky = await listRequirements(root, { risk: 'risk', offset: 0, limit: 10 });
    expect(risky!.items.map((i) => i.reqId)).toEqual(['REQ-002']);
    expect(risky!.items[0]!.riskSource).toBe('data');
    const calm = await listRequirements(root, { risk: 'no-risk', offset: 0, limit: 10 });
    expect(calm!.total).toBe(2);
  });

  it('pagination slices after filtering', async () => {
    const p1 = await listRequirements(root, { offset: 0, limit: 2 });
    const p2 = await listRequirements(root, { offset: 2, limit: 2 });
    expect(p1!.items.length).toBe(2);
    expect(p2!.items.length).toBe(1);
    expect(p1!.total).toBe(3);
  });

  it('patch writes the overrides sidecar, never the artifact, and merges at read', async () => {
    const before = await readFile(
      join(root, '.wicked-estate', 'requirements', 'requirements_graph.json'),
      'utf8',
    );
    const detail = await patchRequirement(root, 'auth/session::REQ-001', {
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
    await patchRequirement(root, 'billing/invoices::REQ-002', { risk: false });
    const page = await listRequirements(root, { risk: 'risk', offset: 0, limit: 10 });
    expect(page!.total).toBe(0);
    const detail = await getRequirement(root, 'billing/invoices::REQ-002');
    expect(detail!.riskSource).toBe('operator');
  });

  it('overrides survive artifact regeneration (cache invalidates on mtime)', async () => {
    await patchRequirement(root, 'auth/session::REQ-001', { risk: true });
    // Simulate `wicked-core domain-graph` regenerating the artifact.
    const artPath = join(root, '.wicked-estate', 'requirements', 'requirements_graph.json');
    const graph = JSON.parse(await readFile(artPath, 'utf8')) as {
      domains: Record<string, { requirements: Record<string, { title: string }> }>;
    };
    graph.domains['auth/session']!.requirements['REQ-001']!.title = 'Regenerated title';
    await writeFile(artPath, JSON.stringify(graph), 'utf8');
    const future = new Date(Date.now() + 5000);
    await utimes(artPath, future, future);
    const detail = await getRequirement(root, 'auth/session::REQ-001');
    expect(detail!.risk).toBe(true); // override survived
    expect(detail!.sourceTitle).toBe('Regenerated title'); // fresh artifact picked up
  });

  it('patching an unknown requirement 404s as null', async () => {
    expect(await patchRequirement(root, 'nope::REQ-9', { risk: true })).toBeNull();
  });
});
