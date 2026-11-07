/**
 * DES-CATALOG-002 CS6, Model run cost: the facts a cost report rests on, on a fixture run store shaped as the adapter
 * serves it (named `workflow_id`, `run_identity`, units with their Tool commands).
 *
 *  - the population: terminal runs of the window, grouped by workflow; open, system, unnamed and the asking run are
 *    left out and counted; failed and cancelled runs count;
 *  - wall time from the RECORDED terminal time (event, else the engine's `finished_at`), unmeasured runs counted;
 *  - pricing from frame counts (full / partial / unpriced / none / unknown), spend percentiles over full runs only;
 *  - `POST /insights/facts` answers only the `facts` Tool of a `run-cost` run, behind the real auth hooks with no
 *    operator bearer, and its numbers are the hand-computed ones;
 *  - `wicked-crew insights-facts` prints them, citable by id, inside the step's context budget.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog } from '../src/api/audit.js';
import { isUnitTokenRoute, registerAuthHooks } from '../src/api/auth.js';
import type { Actor } from '../src/core/types.js';
import { runInsightsFacts } from '../src/cli/insights-facts.js';
import { COST_TEXT_BUDGET, costFacts, costWindow, renderCostFacts, type CostFacts } from '../src/insights/cost.js';
import { ReviewService, collectRunFacts } from '../src/insights/review-service.js';
import { factsUnitResolver, registerInsightsRoutes } from '../src/insights/routes.js';
import type { RunFact } from '../src/insights/run-facts.js';
import { InsightsStore } from '../src/insights/store.js';
import { removeScratch } from './setup/scratch.js';

const dirs: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const d of dirs.splice(0)) removeScratch(d);
});

const MIN = 60_000;
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-07T00:00:00Z');
const FACTS_CMD = ['wicked-crew', 'insights-facts'];

interface Fixture {
  id: string;
  workflow: string;
  daysAgo: number;
  status: string;
  /** Minutes from launch to the terminal event; `null` = no terminal event. */
  endMin?: number | null;
  /** The engine's finished_at, minutes after launch. */
  finishedMin?: number;
  costs?: Array<number | null>;
  unreadable?: boolean;
  units?: Array<{ ord: number; step: string; tool_cmd: string[] | null }>;
}

const FIXTURES: Fixture[] = [
  { id: 'bug-1', workflow: 'bug', daysAgo: 10, status: 'completed', endMin: 60, costs: [1.0, 0.5] },
  { id: 'bug-2', workflow: 'bug', daysAgo: 5, status: 'failed', endMin: 30, costs: [2.0] },
  // Cancelled, its terminal event missing: the engine's finished_at times it. One priced and one unpriced frame.
  { id: 'bug-3', workflow: 'bug', daysAgo: 2, status: 'cancelled', endMin: null, finishedMin: 90, costs: [0.25, null] },
  { id: 'bug-4', workflow: 'bug', daysAgo: 1, status: 'completed', endMin: 120, costs: [3.0] },
  // Events unreadable: pricing unknown, wall unmeasured.
  { id: 'bug-5', workflow: 'bug', daysAgo: 3, status: 'completed', unreadable: true },
  { id: 'feature-1', workflow: 'feature', daysAgo: 4, status: 'completed', endMin: 200, costs: [] },
  // Left out: open, system, unnamed, the asking run, and a run older than the window.
  { id: 'bug-open', workflow: 'bug', daysAgo: 1, status: 'executing', costs: [9.0] },
  { id: 'chat-1', workflow: 'chat', daysAgo: 1, status: 'completed', endMin: 5, costs: [0.1] },
  { id: 'free-1', workflow: 'wf-free-1', daysAgo: 1, status: 'completed', endMin: 5, costs: [0.1] },
  {
    id: 'rc-1', workflow: 'run-cost', daysAgo: 0.01, status: 'executing',
    units: [{ ord: 1, step: 'facts', tool_cmd: FACTS_CMD }, { ord: 2, step: 'model', tool_cmd: null }, { ord: 3, step: 'check', tool_cmd: null }],
  },
  { id: 'bug-old', workflow: 'bug', daysAgo: 100, status: 'completed', endMin: 10, costs: [50] },
  // Fences: another workflow's unit running the facts command, and a shadow run-cost whose `facts` is an agent step.
  { id: 'bug-x', workflow: 'bug', daysAgo: 0.02, status: 'executing', units: [{ ord: 1, step: 'facts', tool_cmd: FACTS_CMD }] },
  { id: 'rc-shadow', workflow: 'run-cost', daysAgo: 0.02, status: 'executing', units: [{ ord: 1, step: 'facts', tool_cmd: null }] },
];

const created = (f: Fixture): number => NOW - f.daysAgo * DAY;

function views(): unknown[] {
  return FIXTURES.map((f) => ({
    session: {
      id: f.id,
      status: f.status,
      created_at: Math.floor(created(f) / 1000),
      deliver_requested: false,
      delivery: 'none',
      archived_at: null,
      workflow_id: f.workflow,
      run_identity: f.workflow.startsWith('wf-') ? { kind: 'free_text', name: null, user_plan: false, system: false } : { kind: 'preset', name: f.workflow, user_plan: false, system: f.workflow === 'chat' },
      project_id: null,
      repo_ref: null,
      title: f.id,
      ...(f.finishedMin !== undefined ? { finished_at: Math.floor(created(f) / 1000) * 1000 + f.finishedMin * MIN } : {}),
    },
    units: (f.units ?? [{ ord: 1, step: 'work', tool_cmd: null }]).map((u) => ({ id: `${f.id}:${u.step}`, ord: u.ord, tool_cmd: u.tool_cmd, assigned_cli: 'claude' })),
  }));
}

function eventsOf(id: string): unknown[] {
  const f = FIXTURES.find((x) => x.id === id) as Fixture;
  if (f.unreadable === true) throw new Error('log unreadable');
  const t0 = Math.floor(created(f) / 1000) * 1000;
  const out: Array<Record<string, unknown>> = [{ type: 'sessionStarted', ts: t0 }];
  (f.costs ?? []).forEach((c, i) => out.push({ type: 'cliUsage', ts: t0 + (i + 1) * 1000, inputTokens: 10, outputTokens: 5, ...(c === null ? {} : { costUsd: c }) }));
  if (f.endMin != null) {
    const type = f.status === 'failed' ? 'sessionFailed' : f.status === 'cancelled' ? 'sessionCancelled' : 'sessionCompleted';
    out.push({ type, ts: t0 + f.endMin * MIN });
  }
  return out;
}

function service(): ReviewService {
  const root = mkdtempSync(join(tmpdir(), 'insights-cost-'));
  dirs.push(root);
  return new ReviewService({
    store: new InsightsStore(join(root, 'daemon-insights.json')),
    adapter: {
      sessionsDetail: async () => views() as never,
      runEvents: async (id) => eventsOf(id) as never,
      seatsForWorkflow: async () => [],
    },
    reviewsDir: join(root, 'reviews'),
    estateTool: async () => ({}),
    log: () => undefined,
    now: () => new Date(NOW),
  });
}

async function collected(): Promise<RunFact[]> {
  const w = costWindow(NOW);
  return collectRunFacts({ sessionsDetail: async () => views() as never, runEvents: async (id) => eventsOf(id) as never }, { startMs: w.startMs, endMs: w.endMs }, NOW, () => undefined);
}

describe('the cost facts (hand-computed on the fixture store)', () => {
  it('states its population: terminal named runs of the window, grouped; open, system, unnamed and the asking run left out', async () => {
    const f = costFacts(await collected(), { window: costWindow(NOW), generatedAtMs: NOW, excludeRunId: 'rc-1' });
    expect(f.excluded).toEqual({ open: 3, system: 1, unnamed: 1, self: 1 });
    expect(f.groups.map((g) => [g.id, g.workflow, g.runs])).toEqual([['G1', 'bug', 5], ['G2', 'feature', 1]]);
    const bug = f.groups[0] as CostFacts['groups'][number];
    // Failed and cancelled runs count.
    expect(bug.outcomes).toEqual({ passed: 3, failed: 1, cancelled: 1 });
    // Wall: 60, 30, 90 (finished_at, no terminal event) and 120 minutes; bug-5 has no recorded terminal time.
    expect(bug.wall).toEqual({ n: 4, unmeasured: 1, p50: 75, p75: 97.5, p90: 111 });
    expect(bug.pricing).toEqual({ full: 3, partial: 1, unpriced: 0, none: 0, unknown: 1 });
    // Spend over the fully priced runs only: 1.5, 2.0, 3.0.
    expect(bug.spend.n).toBe(3);
    expect(bug.spend.p50).toBeCloseTo(2.0, 12);
    expect(bug.spend.p75).toBeCloseTo(2.5, 12);
    expect(bug.spend.p90).toBeCloseTo(2.8, 12);
    expect(bug.spend.total).toBeCloseTo(6.5, 12);
    expect(bug.partialTotal).toBeCloseTo(0.25, 12);
    const feature = f.groups[1] as CostFacts['groups'][number];
    expect(feature.pricing.none).toBe(1);
    expect(feature.spend).toEqual({ n: 0, p50: null, p75: null, p90: null, total: 0 });
    expect(feature.wall).toEqual({ n: 1, unmeasured: 0, p50: 200, p75: 200, p90: 200 });
    // Rows: newest first, every population run, each traceable to its recorded run.
    expect(f.rows.map((r) => r.run)).toEqual(['bug-4', 'bug-3', 'bug-5', 'feature-1', 'bug-2', 'bug-1']);
    expect(f.rows.find((r) => r.run === 'bug-3')).toMatchObject({ group: 'G1', outcome: 'cancelled', wallMinutes: 90, pricing: 'partial', pricedFrames: 1, unpricedFrames: 1 });
    expect(f.rows.find((r) => r.run === 'bug-5')).toMatchObject({ wallMinutes: null, pricing: 'unknown' });
  });

  it('the preparer extracted from the review keeps the review snapshot the same', async () => {
    const s = service();
    const snap = await s.snapshot([], NOW);
    expect(snap.runs.map((r) => r.id).sort()).toEqual(
      (await collected()).filter((r) => r.createdAtMs >= snap.window.startMs - 4 * (snap.window.endMs - snap.window.startMs)).map((r) => r.id).sort(),
    );
    expect(snap.runs.find((r) => r.id === 'bug-5')?.eventsUnreadable).toBe(true);
  });
});

describe('POST /insights/facts', () => {
  const unitTokens: Record<string, { runId: string; ord: number }> = {
    facts: { runId: 'rc-1', ord: 1 },
    model: { runId: 'rc-1', ord: 2 },
    otherWorkflow: { runId: 'bug-x', ord: 1 },
    shadowAgent: { runId: 'rc-shadow', ord: 1 },
  };
  function rig(withFacts = true): FastifyInstance {
    const app = Fastify({ logger: false });
    apps.push(app);
    // The real hooks, required mode: an operator route needs a bearer; the unit-token route never takes one.
    const human: Actor = { id: 'h', kind: 'human', trust: 'admin' } as Actor;
    registerAuthHooks(app, { mode: 'required', verifiers: [{ name: 'test', verify: async (t) => (t === 'human' ? human : null) }], allowedOrigins: null });
    const s = service();
    registerInsightsRoutes(app, {
      store: new InsightsStore(join(dirs[dirs.length - 1] as string, 'other.json')),
      service: s,
      audit: AuditLog.noop(),
      ...(withFacts
        ? {
            facts: {
              unitOf: factsUnitResolver(async (req) => {
                const u = unitTokens[(JSON.parse(req) as { token: string }).token];
                if (u === undefined) throw new Error('invalid_token: no such unit');
                return JSON.stringify({ unit: { ...u, attempt: 0, phase: 'x', seat: 'tool' } });
              }, async () => views() as never),
              collect: (opts, nowMs) => s.collect(opts, nowMs),
              now: () => NOW,
            },
          }
        : {}),
    });
    return app;
  }
  const post = (app: FastifyInstance, payload: unknown) => app.inject({ method: 'POST', url: '/api/v1/insights/facts', payload: payload as Record<string, unknown> });

  it('is a unit-token route (method and path exact), so it needs no operator bearer', async () => {
    expect(isUnitTokenRoute('POST', '/api/v1/insights/facts')).toBe(true);
    for (const [m, p] of [['GET', '/api/v1/insights/facts'], ['POST', '/api/v1/insights/facts/x'], ['POST', '/api/v1/insights'], ['GET', '/api/v1/insights']] as const) {
      expect(isUnitTokenRoute(m, p), `${m} ${p}`).toBe(false);
    }
    const app = rig();
    // A unit token is no operator credential: the operator routes still refuse it.
    expect((await app.inject({ method: 'GET', url: '/api/v1/insights', headers: { authorization: 'Bearer facts' } })).statusCode).toBe(401);
    expect((await post(app, { token: 'facts' })).statusCode).toBe(200);
  });

  it("answers the facts step of a run-cost run with the hand-computed numbers, leaving the run itself out", async () => {
    const res = await post(rig(), { token: 'facts' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as CostFacts;
    expect(body).toEqual(JSON.parse(JSON.stringify(costFacts(await collected(), { window: costWindow(NOW), generatedAtMs: NOW, excludeRunId: 'rc-1' }))));
    expect(body.window).toEqual({ startMs: NOW - 90 * DAY, endMs: NOW, days: 90 });
    expect(body.excluded.self).toBe(1);
    expect(body.groups[0]).toMatchObject({ workflow: 'bug', runs: 5, wall: { p50: 75 }, spend: { n: 3, p50: 2 } });
  });

  it('refuses every other unit: a bad token, another step, another workflow, an agent step named facts', async () => {
    const app = rig();
    expect((await post(app, {})).statusCode).toBe(400);
    expect((await post(app, { token: 'facts', extra: 1 })).statusCode).toBe(400);
    expect((await post(app, { token: 'nope' })).statusCode).toBe(401);
    for (const token of ['model', 'otherWorkflow', 'shadowAgent']) {
      const res = await post(app, { token });
      expect(res.statusCode, token).toBe(403);
      expect(res.json().code).toBe('not_the_facts_step');
    }
    expect((await post(rig(false), { token: 'facts' })).statusCode).toBe(503);
  });

  it('wicked-crew insights-facts prints them through the route; refusals and a missing token are said', async () => {
    const app = rig();
    const fetchVia = (async (url: string, init: RequestInit) => {
      const r = await app.inject({ method: 'POST', url: new URL(url).pathname, payload: init.body as string, headers: { 'content-type': 'application/json' } });
      return new Response(r.body, { status: r.statusCode, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const run = async (env: NodeJS.ProcessEnv) => {
      let out = '';
      const err: string[] = [];
      const code = await runInsightsFacts({ env, out: (t) => { out += t; }, err: (l) => err.push(l), fetch: fetchVia });
      return { code, out, err: err.join('\n') };
    };
    const ok = await run({ WICKED_MCP_TOKEN: 'facts', WICKED_CREW_URL: 'http://127.0.0.1:7700/' });
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('RUN-COST FACTS v1');
    expect(ok.out).toContain('window: 2026-08-09T00:00:00.000Z to 2026-11-07T00:00:00.000Z (90 days)');
    expect(ok.out).toContain('left out: 3 open, 1 system, 1 unnamed, 1 this run');
    expect(ok.out).toContain('G1 workflow=bug runs=5 passed=3 failed=1 cancelled=1');
    expect(ok.out).toContain('G1.wall (minutes): n=4 unmeasured=1 p50=75.00 p75=97.50 p90=111.00');
    expect(ok.out).toContain('G1.pricing (runs): full=3 partial=1 unpriced=0 none=0 unknown=1');
    expect(ok.out).toContain('G1.spend (USD, fully priced runs only): n=3 p50=2.000000 p75=2.500000 p90=2.800000 total=6.500000 partial_total=0.250000');
    expect(ok.out).toContain('G2.spend (USD, fully priced runs only): n=0 p50=none p75=none p90=none total=none partial_total=0.000000');
    expect(ok.out).toMatch(/^R2 G1 run=bug-3 outcome=cancelled launched=2026-11-05T00:00:00\.000Z wall=90\.00 spend=0\.250000 pricing=partial frames=1\/1 retries=0$/mu);
    expect(ok.out).toContain('runs (newest first; 6 of 6 shown');

    const refused = await run({ WICKED_MCP_TOKEN: 'model', WICKED_CREW_URL: 'http://127.0.0.1:7700' });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('not_the_facts_step');
    expect(refused.out).toBe('');
    const none = await run({ WICKED_CREW_URL: 'http://127.0.0.1:7700' });
    expect(none.code).toBe(2);
    expect(none.err).toContain('WICKED_MCP_TOKEN');
  });
});

describe('the printed facts fit the step context', () => {
  it('keeps the header and every group, adds rows newest first up to the budget, and says how many were left out', () => {
    const many: RunFact[] = Array.from({ length: 2000 }, (_, i) => ({
      id: `run-${String(i).padStart(4, '0')}-0123456789abcdef0123456789abcdef`,
      title: 't', workflow: i % 2 === 0 ? 'bug' : 'feature', repo: null, projectId: null, agents: [],
      createdAtMs: NOW - (i + 1) * MIN, endedAtMs: NOW - i * MIN, terminalAtMs: NOW - i * MIN, status: 'completed', outcome: 'passed',
      deliverRequested: false, delivered: false, archived: false, timeToPrMs: null, floorMs: 0, waitHumanMs: 0, overrides: [],
      spendUsd: 0.000061, spendReported: true, pricedFrames: 1, unpricedFrames: 0, tokens: 0, retries: 0, stalls: 0, benched: [],
      failureSignature: null, unresolved: false,
    }));
    const f = costFacts(many, { window: costWindow(NOW), generatedAtMs: NOW });
    const text = renderCostFacts(f);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(COST_TEXT_BUDGET + 200);
    expect(text).toContain('G1 workflow=bug runs=1000');
    expect(text).toContain('G2.spend (USD, fully priced runs only): n=1000');
    // Six decimals: a sub-cent spend is printed as recorded, not rounded away.
    expect(text).toContain('spend=0.000061');
    const shown = Number(/runs \(newest first; (\d+) of 2000 shown/u.exec(text)?.[1]);
    expect(shown).toBeGreaterThan(50);
    expect(shown).toBeLessThan(2000);
    expect(text).toContain(`(${2000 - shown} older runs omitted to fit the step's context)`);
    expect(text).toContain('R1 G');
  });
});
