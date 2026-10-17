// Route tests for the memory proposal queue (DES-MEM-FACETED-001 §5.0):
//   GET  /api/v1/proposals            → proposal.list
//   POST /api/v1/proposals/:id/approve → proposal.approve
//   POST /api/v1/proposals/:id/reject  → proposal.reject
//
// Fastify inject() with a mock adapter and a STUBBED estate-mcp client (runtime.callEstateTool)
// — no `wicked-estate-mcp` process is ever spawned. Covers: the right tool + args reach the client,
// the response is shaped through, the policy→steering LANDING on a handed_off outcome (the rule crew
// upserts, and the loud `landing.outcome:"failed"` when it cannot), the MEMORY path staying
// untouched, and the fail-loud ladder (bad state / whitespace id → 400 without calling the client;
// estate -32602 → 400; any other estate/transport failure → 502).

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { EstateMcpError } from '../src/core/estate-mcp-client.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import { MembershipIndex } from '../src/projects/membership-index.js';

type MockAdapter = {
  sessionsDetail: Mock;
  listRepos: Mock;
  // The policy→steering landing seam (DES-MEM-FACETED-001 §5.2).
  steeringSupported: Mock;
  upsertConformanceRule: Mock;
  // DC-S3: the project-rule probe, the read-back and the retire of a rule the engine changed.
  projectRulesSupported: Mock;
  readConformanceRule: Mock;
  retireConformanceRule: Mock;
};

describe('proposal queue routes (DES-MEM-FACETED-001 §5.0)', () => {
  let app: FastifyInstance;
  let proposalTool: Mock;
  let adapter: MockAdapter;

  beforeEach(async () => {
    adapter = {
      sessionsDetail: vi.fn().mockResolvedValue([]),
      listRepos: vi.fn().mockResolvedValue([]),
      steeringSupported: vi.fn().mockReturnValue(true),
      upsertConformanceRule: vi.fn().mockResolvedValue(undefined),
      projectRulesSupported: vi.fn().mockReturnValue(true),
      // The store keeps exactly what was written (the read-back of a faithful engine).
      readConformanceRule: vi.fn(async (id: string) => {
        const calls = adapter.upsertConformanceRule.mock.calls as Array<[{ id: string }]>;
        return [...calls].reverse().find(([r]) => r.id === id)?.[0] ?? null;
      }),
      retireConformanceRule: vi.fn().mockResolvedValue(true),
    };
    const mockAdapter: MockAdapter = adapter;
    proposalTool = vi.fn();
    app = Fastify({ logger: false });
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      if (!body) return done(null, undefined);
      try {
        done(null, JSON.parse(body as string));
      } catch (e) {
        done(e as Error);
      }
    });
    registerRoutes(
      app,
      mockAdapter as unknown as CoreAdapter,
      new GateCache(),
      new ElicitationCache(),
      undefined,
      undefined,
      { callEstateTool: proposalTool as (t: string, a: Record<string, unknown>) => Promise<unknown> },
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // ── GET /proposals ──────────────────────────────────────────────────────────

  it('lists proposals, forwarding kind_type + state to proposal.list', async () => {
    const proposals = [
      { id: 'p1', kind_type: 'memory', payload: { content: 'x' }, facets: {}, provenance: {}, state: 'pending', created_at: 1 },
    ];
    proposalTool.mockResolvedValueOnce({ proposals });

    const res = await app.inject({ method: 'GET', url: '/api/v1/proposals?kind_type=memory&state=pending' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ proposals });
    expect(proposalTool).toHaveBeenCalledWith('proposal.list', { kind_type: 'memory', state: 'pending' });
  });

  it('lists with no filters when the query is empty (args {})', async () => {
    proposalTool.mockResolvedValueOnce({ proposals: [] });

    const res = await app.inject({ method: 'GET', url: '/api/v1/proposals' });

    expect(res.statusCode).toBe(200);
    expect(proposalTool).toHaveBeenCalledWith('proposal.list', {});
  });

  it('400s a bad state token and never calls the client', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/proposals?state=bogus' });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('pending|approved|rejected');
    expect(proposalTool).not.toHaveBeenCalled();
  });

  it('400s a PRESENT-but-blank state/kind_type (fail-loud, never a silent no-filter)', async () => {
    for (const url of [
      '/api/v1/proposals?state=',
      '/api/v1/proposals?state=%20',
      '/api/v1/proposals?kind_type=',
      '/api/v1/proposals?kind_type=%20',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(400);
    }
    expect(proposalTool).not.toHaveBeenCalled();
  });

  // ── POST /proposals/:id/approve ───────────────────────────────────────────────

  // The estate stub routes by tool: `proposal.list` answers the pending (or approved) rows,
  // `proposal.approve` answers `approve` (or throws it), `proposal.reject` answers ok.
  type Row = { id: string; kind_type: string; payload: unknown; facets: Record<string, string>; provenance: Record<string, string> };
  const stubEstate = (o: { pending?: Row[]; approved?: Row[]; approve?: unknown }): void => {
    proposalTool.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
      if (tool === 'proposal.list') {
        const rows = args['state'] === 'approved' ? (o.approved ?? []) : (o.pending ?? []);
        return { proposals: rows.map((r) => ({ ...r, state: args['state'] ?? 'pending', created_at: 1 })) };
      }
      if (tool === 'proposal.approve') {
        if (o.approve instanceof Error) throw o.approve;
        return o.approve ?? { outcome: 'handed_off', payload: (o.pending ?? []).find((r) => r.id === args['id'])?.payload };
      }
      return { ok: true };
    });
  };
  const policy = (id: string, kind_type: string, payload: unknown, facets: Record<string, string> = {}, provenance: Record<string, string> = {}): Row => ({
    id,
    kind_type,
    payload,
    facets,
    provenance,
  });
  const tools = (): string[] => proposalTool.mock.calls.map((c) => c[0] as string);

  it('approves a memory proposal → promoted, forwarding the id (no rule write)', async () => {
    stubEstate({
      pending: [{ id: 'p1', kind_type: 'memory', payload: { content: 'x' }, facets: {}, provenance: {} }],
      approve: { outcome: 'promoted', active_id: 'm-42' },
    });

    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/p1/approve' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ outcome: 'promoted', active_id: 'm-42' });
    expect(proposalTool).toHaveBeenCalledWith('proposal.approve', { id: 'p1' });
    expect(tools()).toEqual(['proposal.list', 'proposal.approve']);
    expect(adapter.upsertConformanceRule).not.toHaveBeenCalled();
  });

  // ── The policy→steering landing (DES-MEM-FACETED-001 §5.2) ────────────────────

  it('lands a policy proposal as a steering rule BEFORE estate approves it (kind_type policy:<type> → steering_type)', async () => {
    stubEstate({ pending: [policy('pol1', 'policy:security', { rule: 'no secrets in logs', severity: 'error' }, { language: 'rust', project: 'proj-a' }, { run_id: 'r-9' })] });
    adapter.upsertConformanceRule.mockImplementation(async () => {
      // The rule is written while the proposal is still pending: estate has not been asked yet.
      expect(tools()).not.toContain('proposal.approve');
    });

    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/pol1/approve' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      outcome: 'handed_off',
      payload: { rule: 'no secrets in logs', severity: 'error' },
      landing: { outcome: 'landed', ruleId: 'proposal:pol1', steering_type: 'security', reach: 'project', project: 'proj-a' },
    });
    expect(tools()).toEqual(['proposal.list', 'proposal.approve']);
    expect(adapter.upsertConformanceRule).toHaveBeenCalledTimes(1);
    expect(adapter.upsertConformanceRule).toHaveBeenCalledWith({
      id: 'proposal:pol1',
      rule_type: 'policy',
      statement: 'no secrets in logs',
      severity: 'error',
      confidence: 0.8,
      targets: { language: 'rust', project: 'proj-a' },
      provenance: { source: 'proposal', ref: 'proposal:pol1', source_kinds: [] },
      steering_type: 'security',
    });
  });

  // ── Scope: a repo- or project-scoped proposal never lands as a rule for every project ──

  it('a repo-faceted proposal with no project facet lands scoped to the project of the run that filed it', async () => {
    await app.close();
    const index = new MembershipIndex();
    index.set('r-9', 'proj-tc');
    app = Fastify({ logger: false });
    registerRoutes(app, adapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), { bus: null, index, log: () => undefined }, undefined, {
      callEstateTool: proposalTool as (t: string, a: Record<string, unknown>) => Promise<unknown>,
    });
    await app.ready();
    stubEstate({ pending: [policy('pr1', 'policy:testing', { rule: 'subtract(a,b) must return a - b', severity: 'warn' }, { repo: 'tiny-calc' }, { run_id: 'r-9' })] });

    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/pr1/approve' });

    expect((res.json() as { landing: unknown }).landing).toEqual({
      outcome: 'landed',
      ruleId: 'proposal:pr1',
      steering_type: 'testing',
      reach: 'project',
      project: 'proj-tc',
    });
    expect(adapter.upsertConformanceRule).toHaveBeenCalledWith(expect.objectContaining({ targets: { project: 'proj-tc' } }));
  });

  it('a repo-faceted proposal that resolves to no project is refused, writes nothing and stays pending — never a global rule', async () => {
    stubEstate({ pending: [policy('pr2', 'policy:testing', { rule: 'subtract(a,b) must return a - b', severity: 'warn' }, { repo: 'tiny-calc' }, { run_id: 'r-orphan' })] });

    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/pr2/approve' });

    expect(res.statusCode).toBe(200);
    const landing = (res.json() as { landing: { outcome: string; error: string } }).landing;
    expect(landing.outcome).toBe('failed');
    expect(landing.error).toMatch(/repo `tiny-calc`/);
    expect(landing.error).toMatch(/no project/);
    expect(landing.error).toMatch(/still pending/);
    expect(adapter.upsertConformanceRule).not.toHaveBeenCalled();
    expect(tools()).not.toContain('proposal.approve');
  });

  // ── Reach: every policy proposal lands with exactly the reach it says ──────────

  it('reach "operator" lands a rule for every project even when the row carries project/repo facets', async () => {
    stubEstate({ pending: [policy('ro1', 'policy:development', { rule: 'always pin the gh account', severity: 'warn', reach: 'operator' }, { project: 'proj-a', repo: 'r' })] });

    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/ro1/approve' });

    expect((res.json() as { landing: unknown }).landing).toEqual({ outcome: 'landed', ruleId: 'proposal:ro1', steering_type: 'development', reach: 'operator' });
    expect(adapter.upsertConformanceRule).toHaveBeenCalledWith(expect.objectContaining({ targets: {} }));
  });

  it('reach "project" with no project to name is refused, never landed everywhere', async () => {
    stubEstate({ pending: [policy('rp1', 'policy:development', { rule: 'x', reach: 'project' })] });

    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/rp1/approve' });

    const landing = (res.json() as { landing: { outcome: string; error: string } }).landing;
    expect(landing.outcome).toBe('failed');
    expect(landing.error).toMatch(/reach "operator"/);
    expect(adapter.upsertConformanceRule).not.toHaveBeenCalled();
  });

  it('an invalid reach fails loud', async () => {
    stubEstate({ pending: [policy('rx1', 'policy:development', { rule: 'x', reach: 'galaxy' }, { project: 'p' })] });
    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/rx1/approve' });
    expect((res.json() as { landing: { error: string } }).landing.error).toMatch(/invalid reach/);
    expect(adapter.upsertConformanceRule).not.toHaveBeenCalled();
  });

  it('the person may change a rule\'s reach at accept: {reach:"operator"} widens, {reach:"project"} keeps the project', async () => {
    stubEstate({ pending: [policy('ra1', 'policy:testing', { rule: 'x', reach: 'project' }, { project: 'proj-a' })] });
    const wide = await app.inject({ method: 'POST', url: '/api/v1/proposals/ra1/approve', payload: { reach: 'operator' } });
    expect((wide.json() as { landing: { reach: string; project?: string } }).landing).toMatchObject({ outcome: 'landed', reach: 'operator' });
    expect(adapter.upsertConformanceRule).toHaveBeenLastCalledWith(expect.objectContaining({ targets: {} }));

    stubEstate({ pending: [policy('ra2', 'policy:testing', { rule: 'x', reach: 'operator' }, { project: 'proj-a' })] });
    const narrow = await app.inject({ method: 'POST', url: '/api/v1/proposals/ra2/approve', payload: { reach: 'project' } });
    expect((narrow.json() as { landing: unknown }).landing).toMatchObject({ outcome: 'landed', reach: 'project', project: 'proj-a' });

    const bad = await app.inject({ method: 'POST', url: '/api/v1/proposals/ra2/approve', payload: { reach: 'pattern' } });
    expect(bad.statusCode).toBe(400);
  });

  // ── DC-S3: a policy landing keeps its project and its proposal ref ─────────

  const projectProposal = (id: string): Row =>
    policy(id, 'policy:development', { rule: 'always run the linter before commit', severity: 'warn' }, { project: 'proj-a', language: 'ts' });

  it('a project-faceted proposal lands with targets.project and ref proposal:<id>, read back intact (DC-S3)', async () => {
    stubEstate({ pending: [projectProposal('pp1')] });

    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/pp1/approve' });

    expect(res.statusCode).toBe(200);
    expect(adapter.upsertConformanceRule).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'proposal:pp1',
        targets: { language: 'ts', project: 'proj-a' },
        provenance: { source: 'proposal', ref: 'proposal:pp1', source_kinds: [] },
      }),
    );
    expect(adapter.readConformanceRule).toHaveBeenCalledWith('proposal:pp1');
    expect((res.json() as { landing: unknown }).landing).toEqual({
      outcome: 'landed',
      ruleId: 'proposal:pp1',
      steering_type: 'development',
      reach: 'project',
      project: 'proj-a',
    });
    expect(adapter.retireConformanceRule).not.toHaveBeenCalled();
  });

  it('an engine without project rules fails a project landing loud, writes nothing and approves nothing (DC-S3)', async () => {
    adapter.projectRulesSupported.mockReturnValue(false);
    stubEstate({ pending: [projectProposal('pp2')] });

    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/pp2/approve' });

    expect(res.statusCode).toBe(200);
    const landing = (res.json() as { landing: { outcome: string; error: string } }).landing;
    expect(landing.outcome).toBe('failed');
    expect(landing.error).toMatch(/project `proj-a`/);
    expect(adapter.upsertConformanceRule).not.toHaveBeenCalled();
    expect(tools()).not.toContain('proposal.approve');
  });

  it('an engine without project rules still lands a proposal that names no project or repo (global, as before)', async () => {
    adapter.projectRulesSupported.mockReturnValue(false);
    stubEstate({ pending: [policy('pp3', 'policy:architecture', { rule: 'prefer composition' })] });

    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/pp3/approve' });

    expect((res.json() as { landing: { outcome: string } }).landing.outcome).toBe('landed');
    expect(adapter.upsertConformanceRule).toHaveBeenCalledWith(expect.objectContaining({ targets: {} }));
  });

  it('a read-back that lost targets.project retires the rule and fails the landing loud — never global (DC-S3)', async () => {
    adapter.readConformanceRule.mockImplementationOnce(async (id: string) => ({
      id,
      rule_type: 'policy',
      statement: 'always run the linter before commit',
      severity: 'warn',
      confidence: 0.8,
      targets: { language: 'ts' },
      provenance: { source: 'proposal', ref: id, source_kinds: [] },
      steering_type: 'development',
    }));
    stubEstate({ pending: [projectProposal('pp4')] });

    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/pp4/approve' });

    const landing = (res.json() as { landing: { outcome: string; error: string } }).landing;
    expect(landing.outcome).toBe('failed');
    expect(landing.error).toMatch(/targets\.project/);
    expect(landing.error).toMatch(/retired/);
    expect(adapter.retireConformanceRule).toHaveBeenCalledWith('proposal:pp4');
    expect(tools()).not.toContain('proposal.approve');
  });

  it('defaults a missing severity to warn and empty targets when the proposal has no language facet', async () => {
    stubEstate({ pending: [policy('pol2', 'policy:architecture', { rule: 'prefer composition' })] });

    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/pol2/approve' });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { landing: { outcome: string } }).landing.outcome).toBe('landed');
    expect(adapter.upsertConformanceRule).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'warn', targets: {}, steering_type: 'architecture' }),
    );
  });

  it('normalizes the natural-word severity "warning" (and case/whitespace) to warn so a capture worker\'s policy still lands', async () => {
    stubEstate({ pending: [policy('polw', 'policy:testing', { rule: 'pin the version', severity: ' Warning ' })] });

    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/polw/approve' });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { landing: { outcome: string } }).landing.outcome).toBe('landed');
    expect(adapter.upsertConformanceRule).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'warn', steering_type: 'testing' }),
    );
  });

  it('still fails LOUD on a genuinely invalid severity (not a known synonym)', async () => {
    stubEstate({ pending: [policy('polbad', 'policy:security', { rule: 'x', severity: 'loud' })] });

    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/polbad/approve' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { landing: { outcome: string; error: string } };
    expect(body.landing.outcome).toBe('failed');
    expect(body.landing.error).toContain('invalid severity');
    expect(adapter.upsertConformanceRule).not.toHaveBeenCalled();
  });

  it('fails the landing LOUD (never a silent drop) when kind_type does not name a steering type — proposal stays pending, no rule written', async () => {
    stubEstate({ pending: [policy('pol3', 'policy:bogus', { rule: 'x', severity: 'warn' })] });

    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/pol3/approve' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { outcome: string; landing: { outcome: string; error: string } };
    expect(body.outcome).toBe('handed_off');
    expect(body.landing.outcome).toBe('failed');
    expect(body.landing.error).toContain('does not name a steering type');
    expect(adapter.upsertConformanceRule).not.toHaveBeenCalled();
    expect(tools()).not.toContain('proposal.approve');
  });

  it('fails the landing LOUD when the payload has no `rule` statement', async () => {
    stubEstate({ pending: [policy('pol4', 'policy:security', { severity: 'error' })] });

    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/pol4/approve' });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { landing: { outcome: string; error: string } }).landing).toMatchObject({
      outcome: 'failed',
    });
    expect((res.json() as { landing: { error: string } }).landing.error).toContain('no `rule` string');
    expect(adapter.upsertConformanceRule).not.toHaveBeenCalled();
  });

  it('fails the landing LOUD on a pre-steering engine and approves nothing', async () => {
    adapter.steeringSupported.mockReturnValue(false);
    stubEstate({ pending: [policy('pol5', 'policy:security', { rule: 'x', severity: 'warn' })] });

    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/pol5/approve' });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { landing: { outcome: string } }).landing.outcome).toBe('failed');
    expect(tools()).toEqual(['proposal.list']);
    expect(adapter.upsertConformanceRule).not.toHaveBeenCalled();
  });

  it('a store that refuses the rule fails the landing loud and leaves the proposal pending, so a second approve lands it', async () => {
    adapter.upsertConformanceRule.mockRejectedValueOnce(new Error('INV-C1: rule id must not be blank'));
    stubEstate({ pending: [policy('pol6', 'policy:testing', { rule: 'x', severity: 'warn' })] });

    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/pol6/approve' });

    expect(res.statusCode).toBe(200);
    const landing = (res.json() as { landing: { outcome: string; error: string } }).landing;
    expect(landing.outcome).toBe('failed');
    expect(landing.error).toContain('INV-C1');
    expect(landing.error).toContain('still pending');
    expect(tools()).not.toContain('proposal.approve');

    // The operator approves again: the proposal is still pending, so this time it lands and approves.
    const retry = await app.inject({ method: 'POST', url: '/api/v1/proposals/pol6/approve' });
    expect((retry.json() as { landing: { outcome: string } }).landing.outcome).toBe('landed');
    expect(proposalTool).toHaveBeenCalledWith('proposal.approve', { id: 'pol6' });
  });

  it('an approve estate does not confirm after the rule landed is a 502 that undoes nothing; approving again finishes', async () => {
    const row = policy('pol7', 'policy:testing', { rule: 'x', severity: 'warn' });
    stubEstate({ pending: [row], approve: new EstateMcpError('wicked-estate-mcp exited before answering', undefined) });

    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/pol7/approve' });

    // Estate may have committed the approve, and a concurrent approve may share the rule: never retire.
    expect(res.statusCode).toBe(502);
    expect(adapter.upsertConformanceRule).toHaveBeenCalledTimes(1);
    expect(adapter.retireConformanceRule).not.toHaveBeenCalled();

    stubEstate({ pending: [row] });
    const retry = await app.inject({ method: 'POST', url: '/api/v1/proposals/pol7/approve' });
    expect((retry.json() as { landing: { outcome: string; ruleId: string } }).landing).toMatchObject({ outcome: 'landed', ruleId: 'proposal:pol7' });
  });

  it('rejecting a pending policy proposal whose rule already landed (a crash before the approve) retires the rule', async () => {
    const row = policy('pol8', 'policy:testing', { rule: 'x', severity: 'warn' });
    stubEstate({ pending: [row], approve: new EstateMcpError('wicked-estate-mcp exited before answering', undefined) });
    await app.inject({ method: 'POST', url: '/api/v1/proposals/pol8/approve' });
    expect(adapter.retireConformanceRule).not.toHaveBeenCalled();

    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/pol8/reject' });

    expect(res.statusCode).toBe(200);
    expect(proposalTool).toHaveBeenCalledWith('proposal.reject', { id: 'pol8' });
    expect(adapter.retireConformanceRule).toHaveBeenCalledWith('proposal:pol8');
  });

  it('rejecting a proposal with no landed rule retires nothing', async () => {
    stubEstate({});
    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/m1/reject' });
    expect(res.statusCode).toBe(200);
    expect(adapter.retireConformanceRule).not.toHaveBeenCalled();
  });

  it('an id that is not pending is passed to estate, which refuses it in its own words', async () => {
    stubEstate({ pending: [], approve: new EstateMcpError('proposal zz is approved — only a pending proposal can be approved/rejected', -32602) });

    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/zz/approve' });

    expect(res.statusCode).toBe(400);
    expect(adapter.upsertConformanceRule).not.toHaveBeenCalled();
  });

  it('400s a whitespace-only id on approve and never calls the client', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/%20/approve' });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('`id` is required');
    expect(proposalTool).not.toHaveBeenCalled();
  });

  it('maps an estate -32602 invalid-params error to 400', async () => {
    stubEstate({ approve: new EstateMcpError('id (string) required', -32602) });

    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/p1/approve' });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('id (string) required');
  });

  it('maps any other estate/transport failure to 502', async () => {
    proposalTool.mockRejectedValueOnce(new EstateMcpError('wicked-estate-mcp exited before answering', undefined));
    // (the first estate call — the pending read — already fails)

    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/p1/approve' });

    expect(res.statusCode).toBe(502);
    expect((res.json() as { error: string }).error).toContain('exited before answering');
  });

  // ── POST /proposals/:id/reject ────────────────────────────────────────────────

  it('rejects a proposal → { ok: true }, forwarding the id', async () => {
    proposalTool.mockResolvedValueOnce({ ok: true });

    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/p1/reject' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(proposalTool).toHaveBeenCalledWith('proposal.reject', { id: 'p1' });
  });

  it('400s a whitespace-only id on reject and never calls the client', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/%20/reject' });

    expect(res.statusCode).toBe(400);
    expect(proposalTool).not.toHaveBeenCalled();
  });
});
