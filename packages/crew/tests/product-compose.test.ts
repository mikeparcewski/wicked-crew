// crew#372 slice 2: POST /projects/:id/product/compose re-reads the selected requirements on the
// server and launches a governed run through POST /runs itself (a fake POST /runs here records the
// body it was handed). Nothing launches when a ref is unknown or foreign.
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { COMPOSE_MAX_REQUIREMENTS, composeInstructions, registerProductRoutes } from '../src/api/product.js';
import type { CoreAdapter } from '../src/core/adapter.js';

describe('POST /projects/:id/product/compose (crew#372)', () => {
  let base: string;
  let app: FastifyInstance;
  const launched: Array<{ body: Record<string, unknown>; auth: string | undefined }> = [];
  let runsAnswer: { status: number; body: unknown } = { status: 201, body: { runId: 'run-compose-1' } };

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'product-compose-'));
    const root = join(base, 'alpha');
    mkdirSync(join(root, '.wicked-estate', 'requirements'), { recursive: true });
    writeFileSync(
      join(root, '.wicked-estate', 'requirements', 'requirements_graph.json'),
      JSON.stringify({
        metadata: { schema_version: '1.0.0', migration_mode: 'x' },
        domains: {
          billing: {
            requirements: {
              r1: { title: 'Invoices are numbered', description: '', business_rules: [{ id: 'b', statement: 'Each invoice gets the next number', confidence: 1, provenance: { source: 's' } }], validations: [], error_paths: [] },
              r2: { title: 'Refunds need approval', description: '', business_rules: [], validations: [], error_paths: [] },
            },
            entities: {},
          },
        },
      }),
    );
    const repos = [{ id: 'alpha', name: 'alpha', root_path: root }, { id: 'outsider', name: 'outsider', root_path: root }];
    const adapter = {
      projectGet: vi.fn(async (id: string) => (id === 'p1' ? { id } : null)),
      projectMembers: vi.fn(async () => [{ member_kind: 'crew.repo', member_ref: 'alpha' }]),
      listRepos: vi.fn(async () => repos),
    };
    app = Fastify({ logger: false });
    app.post('/api/v1/runs', async (req, reply) => {
      launched.push({ body: req.body as Record<string, unknown>, auth: req.headers.authorization });
      return reply.code(runsAnswer.status).send(runsAnswer.body);
    });
    registerProductRoutes(app, adapter as unknown as CoreAdapter);
    await app.ready();
  });
  beforeEach(() => {
    launched.length = 0;
    runsAnswer = { status: 201, body: { runId: 'run-compose-1' } };
  });
  afterAll(async () => {
    await app.close();
    rmSync(base, { recursive: true, force: true });
  });

  const compose = (payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/api/v1/projects/p1/product/compose', payload: payload as Record<string, unknown>, headers });

  it('re-reads each requirement and launches produce → review (human gate) via POST /runs, filed, no deliver', async () => {
    const res = await compose(
      { requirements: [{ repoId: 'alpha', key: 'billing::r1' }, { repoId: 'alpha', key: 'billing::r2' }], instructions: 'one epic per domain' },
      { authorization: 'Bearer t0k' },
    );
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toEqual({ runId: 'run-compose-1', requirements: 2 });
    expect(launched).toHaveLength(1);
    const body = launched[0]!.body;
    expect(launched[0]!.auth).toBe('Bearer t0k'); // the caller's run, audited as theirs
    expect(body).toMatchObject({ projectId: 'p1', deliver: 'none' });
    const steps = (body['plan'] as { steps: Array<Record<string, unknown>> }).steps;
    expect(steps.map((s) => [s['catalog'], s['id']])).toEqual([['produce', 'draft'], ['review', 'review']]);
    expect(steps[1]!['gate']).toEqual({ human_confirm: { unconditional: true } });
    // The SERVER's text of each requirement reaches the draft, plus the steer and the artifact shape.
    const draft = String(steps[0]!['instructions']);
    expect(draft).toContain('alpha billing::r1: Invoices are numbered — Each invoice gets the next number');
    expect(draft).toContain('alpha billing::r2: Refunds need approval');
    expect(draft).toContain("Operator's steer: one epic per domain");
    expect(draft).toContain('"requirementRefs"');
  });

  it('an unknown key or a repo that is not the project\'s is a 400 naming each; nothing launches', async () => {
    const res = await compose({ requirements: [{ repoId: 'alpha', key: 'billing::nope' }, { repoId: 'outsider', key: 'billing::r1' }, { repoId: 'alpha', key: 'billing::r1' }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().unknown).toEqual([
      { repoId: 'alpha', key: 'billing::nope', reason: 'no such requirement in the repository' },
      { repoId: 'outsider', key: 'billing::r1', reason: 'not a registered repository of this project' },
    ]);
    expect(launched).toEqual([]);
  });

  it('a malformed body is a 400, an unknown project a 404 — nothing launches', async () => {
    expect((await compose({ requirements: [] })).statusCode).toBe(400);
    expect((await compose({ requirements: [{ repoId: 'alpha', key: 'billing::r1' }], extra: 1 })).statusCode).toBe(400);
    const many = Array.from({ length: COMPOSE_MAX_REQUIREMENTS + 1 }, () => ({ repoId: 'alpha', key: 'billing::r1' }));
    expect((await compose({ requirements: many })).statusCode).toBe(400);
    const res = await app.inject({ method: 'POST', url: '/api/v1/projects/nope/product/compose', payload: { requirements: [{ repoId: 'alpha', key: 'billing::r1' }] } });
    expect(res.statusCode).toBe(404);
    expect(launched).toEqual([]);
  });

  it("POST /runs' own refusal is relayed with its status", async () => {
    runsAnswer = { status: 409, body: { error: 'no eligible seat', code: 'no_eligible_seat' } };
    const res = await compose({ requirements: [{ repoId: 'alpha', key: 'billing::r1' }] });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('no_eligible_seat');
  });

  it('the instructions stay under the engine\'s 8 KB step cap at the maximum selection', () => {
    const rows = Array.from({ length: COMPOSE_MAX_REQUIREMENTS }, (_, i) => ({ repoId: `repo-${i}`, key: `domain-${i}::req-${i}`, title: 'T'.repeat(300), statement: 'S'.repeat(300) }));
    const text = composeInstructions('a-project-id', rows, 'x'.repeat(500));
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(7600);
    // Every requirement still has its line, and the artifact shape survives the cut.
    for (let i = 0; i < rows.length; i++) expect(text).toContain(`- repo-${i} domain-${i}::req-${i}: `);
    expect(text).toContain('"requirementRefs"');
    const wide = composeInstructions('p', rows.map((r) => ({ ...r, title: 'é'.repeat(400) })), undefined);
    expect(Buffer.byteLength(wide, 'utf8')).toBeLessThanOrEqual(7600);
  });
});
