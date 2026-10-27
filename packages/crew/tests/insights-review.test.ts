/**
 * DES-RUNS-REVIEW-001 §3, §5, §6: the `review-recent-work` workflow around its run. The def is data, read-only and
 * cheap (one agent phase, no floor). A review launch is repo-less, one seat, writes only its review directory, and
 * delivers nothing. Ingest keeps crew's ranked recommendations (the seat only words them), files the proposals, and
 * Accept / Dismiss update state.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog } from '../src/api/audit.js';
import type { Actor, LaunchRunInput } from '../src/core/types.js';
import { isSystemWorkflow } from '../src/core/run-identity.js';
import { FACTS_FILE, REPORT_FILE, runAnalyze } from '../src/insights/analyze-cli.js';
import { OUT_DIR, ReviewService, githubNewIssueUrl, pickSeat } from '../src/insights/review-service.js';
import { registerInsightsRoutes } from '../src/insights/routes.js';
import { InsightsStore } from '../src/insights/store.js';
import { REVIEW_WORKFLOW, loadReviewWorkflow } from '../src/insights/workflow.js';
import { removeScratch } from './setup/scratch.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeScratch(d);
});
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'insights-review-'));
  dirs.push(d);
  return d;
}

const H = 3_600_000;
const NOW = new Date('2026-10-27T00:00:00Z');
const sec = (h: number): number => Math.floor((NOW.getTime() - h * H) / 1000);

/** A run store: 6 unresolved failures on core, each overriding a "scope_drift" escalation, plus healthy history. */
function views() {
  const out: unknown[] = [];
  const add = (id: string, hoursAgo: number, status: string, over: Record<string, unknown> = {}) =>
    out.push({ session: { id, status, created_at: sec(hoursAgo), deliver_requested: false, delivery: 'none', archived_at: null, workflow_id: 'bug', repo_ref: 'core', title: `run ${id}`, project_id: 'p1', ...over }, units: [{ assigned_cli: 'claude' }] });
  for (let i = 0; i < 6; i += 1) add(`bad-${i}`, 4 + i * 5, 'failed');
  for (let i = 0; i < 12; i += 1) add(`ok-${i}`, 60 + i * 10, 'completed');
  add('older', 24 * 30, 'completed'); // outside every window
  add('prev-review', 5, 'completed', { workflow_id: REVIEW_WORKFLOW }); // a review never reviews itself
  add('other-project', 3, 'failed', { project_id: 'p2' });
  return out;
}
function eventsOf(id: string) {
  if (!id.startsWith('bad-')) return [];
  // Each failure: escalated 10 min in, overridden by a person 2 h later, failed at 3 h.
  const t = NOW.getTime() - (4 + Number(id.slice(4)) * 5) * H;
  return [
    { type: 'gateEscalated', ts: t + 600_000, ord: 3, condition: 'scope_drift', denialSource: 'substance' },
    { type: 'gateDecided', ts: t + 600_000 + 2 * H, ord: 3, allow: true },
    { type: 'sessionFailed', ts: t + 3 * H },
  ];
}

function rig(opts: { views?: () => unknown[]; seats?: unknown[] } = {}) {
  const root = scratch();
  const store = new InsightsStore(join(root, 'daemon-insights.json'));
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const service = new ReviewService({
    store,
    adapter: {
      sessionsDetail: async () => (opts.views ?? views)() as never,
      runEvents: async (id) => eventsOf(id) as never,
      seatsForWorkflow: async () => opts.seats ?? [{ key: 'pi', council_eligible: false }, { key: 'claude', council_eligible: true }, { key: 'codex' }],
      listRepos: async () => [{ id: 'core', git_url: 'git@github.com:acme/core.git' }],
    },
    reviewsDir: join(root, 'reviews'),
    estateTool: async (tool, args) => {
      calls.push({ tool, args });
      return tool === 'proposal.submit' ? { id: `prop-${calls.length}` } : { ok: true };
    },
    log: () => undefined,
    now: () => NOW,
  });
  return { root, store, service, calls };
}

const launchInput = (): LaunchRunInput => ({
  problem: '/workflow-review-recent-work focus on core',
  sessionId: 'rev-1',
  clisJson: '[{"key":"claude"},{"key":"codex"}]',
  workflow: REVIEW_WORKFLOW,
  repoRef: 'core',
  baseRef: 'main',
  deliver: 'pr',
  extraReadRoots: ['/somewhere'],
});

describe('the review-recent-work workflow def (data)', () => {
  const def = loadReviewWorkflow({ node: '/usr/bin/node', analyzeCli: '/opt/crew/dist/insights/analyze-cli.js', reviewsDir: '/home/u/.wicked/reviews' });
  it('is a deterministic Tool step, then ONE agent phase, with no floor and nothing required of a judge', () => {
    expect(def.id).toBe(REVIEW_WORKFLOW);
    expect(def.phases.map((p) => p.id)).toEqual(['analyze', 'interpret']);
    expect(def.phases[0]?.executor).toEqual({ type: 'tool', cmd: ['/usr/bin/node', '/opt/crew/dist/insights/analyze-cli.js', '--reviews-dir', '/home/u/.wicked/reviews'] });
    expect(def.phases.filter((p) => p.executor?.type !== 'tool')).toHaveLength(1);
    for (const p of def.phases) {
      expect(p.executes_code).toBe(false);
      expect(p.verified_evidence).toBe(false);
      expect(p.validator_pin).toBeNull();
    }
    expect((def as { required_instruments?: unknown }).required_instruments).toEqual([]);
    expect('$comment' in def).toBe(false);
    expect(isSystemWorkflow(def.id)).toBe(false); // offered as /workflow-review-recent-work
  });
});

describe('a review launch', () => {
  it('is repo-less, delivers nothing, runs on one seat and can write only its review directory', async () => {
    const r = rig();
    const input = await r.service.prepare(launchInput(), { trigger: 'manual', projectIds: ['p1'] });
    const dir = join(r.root, 'reviews', 'rev-1');
    // It reads its review directory and writes ONLY `out/`: the snapshot and the numbers are not its to change.
    expect(input.extraWriteRoots).toEqual([join(dir, OUT_DIR)]);
    expect(input.extraReadRoots).toEqual([dir]);
    expect(input.requireDeliverables).toEqual([join(dir, OUT_DIR, REPORT_FILE)]);
    expect(input.repoRef).toBeUndefined();
    expect(input.baseRef).toBeUndefined();
    expect(input.deliver).toBeUndefined();
    // One seat: the first ELIGIBLE one (pi is benched), never simply the first.
    expect(JSON.parse(input.clisJson)).toEqual([{ key: 'claude', council_eligible: true }]);
    expect(input.problem).toContain(join(dir, 'handoff.json'));
    expect(input.problem).toContain('The person also asked: /workflow-review-recent-work focus on core');
    expect(r.store.get('rev-1')?.status).toBe('running');
    // The snapshot: this project's runs in the window and baseline only; never a review, never the far past.
    const snap = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8')) as { runs: { id: string }[] };
    const ids = snap.runs.map((x) => x.id).sort();
    expect(ids).toContain('bad-0');
    expect(ids).not.toContain('prev-review');
    expect(ids).not.toContain('older');
    expect(ids).not.toContain('other-project');
  });

  it('the analyze step writes only facts.json, inside the review directory', async () => {
    const r = rig();
    await r.service.prepare(launchInput(), { trigger: 'schedule', scheduleId: 'review-recent-work' });
    const dir = join(r.root, 'reviews', 'rev-1');
    const before = readdirSync(dir).sort();
    runAnalyze(dir);
    expect(readdirSync(dir).sort()).toEqual([...before, FACTS_FILE].sort());
    expect(readdirSync(r.root).sort()).toEqual(['daemon-insights.json', 'reviews']);
  });
});

describe('ingest, Accept and Dismiss', () => {
  async function reviewed(report: unknown) {
    const r = rig();
    await r.service.prepare(launchInput(), { trigger: 'schedule', scheduleId: 'review-recent-work' });
    const dir = join(r.root, 'reviews', 'rev-1');
    const facts = runAnalyze(dir);
    if (report !== undefined) writeFileSync(join(dir, OUT_DIR, REPORT_FILE), JSON.stringify(report));
    await r.service.reconcile(new Map([['rev-1', 'completed']]));
    return { ...r, facts, review: r.store.get('rev-1') };
  }

  it('keeps crew\'s ranked recommendations; the seat only rewords them and may only lower a confidence', async () => {
    const { facts, review, calls } = await reviewed(undefined);
    expect(facts.recommended).toContain('resolve-stale');
    expect(facts.recommended).toContain('steering-override-core-scope-drift');
    expect(review?.status).toBe('completed');
    expect(review?.interpreted).toBe(false);
    expect(review?.recommendations.map((x) => x.candidate)).toEqual(facts.recommended);
    // The steering-rule recommendation went to the approve queue as a policy proposal.
    const submit = calls.find((c) => c.tool === 'proposal.submit');
    expect(submit?.args['kind_type']).toBe('policy:operations');
    expect(review?.recommendations.find((x) => x.kind === 'steering-rule')?.proposalId).toBe('prop-1');
    expect(review?.series.find((s) => s.metric === 'pass_rate')?.window.n).toBeGreaterThan(0);
  });

  it('drops a report entry naming no recommended candidate, and caps a raised confidence', async () => {
    const r0 = await reviewed(undefined);
    const top = r0.facts.recommended[0] as string;
    const crewConfidence = r0.facts.candidates.find((c) => c.id === top)?.confidence;
    const { review } = await reviewed({
      summary: 'Six runs on core failed and were never closed; the rest passed.',
      recommendations: [
        { candidate: top, title: 'Close the six failed core runs', confidence: 'high', expectedEffect: 'A clean run list.', changeMind: 'If they are parked on purpose.' },
        { candidate: 'invented-by-the-model', title: 'Buy more GPUs', confidence: 'high' },
      ],
    });
    expect(review?.interpreted).toBe(true);
    expect(review?.summary).toContain('Six runs on core failed');
    const rec = review?.recommendations[0];
    expect(rec?.title).toBe('Close the six failed core runs');
    // Asked for 'high': kept at crew's own level, never raised above what n supports.
    expect(rec?.confidence).toBe(crewConfidence);
    expect(review?.recommendations.some((x) => x.title === 'Buy more GPUs')).toBe(false);
  });

  it('Accept and Dismiss update state through the routes; only a person decides; a dismissal needs a reason', async () => {
    const r = await reviewed(undefined);
    const app = Fastify();
    let actor: Actor | undefined;
    app.addHook('preHandler', async (req) => { if (actor !== undefined) (req as { actor?: Actor }).actor = actor; });
    registerInsightsRoutes(app, { store: r.store, service: r.service, audit: AuditLog.noop() });
    const recs = r.review?.recommendations ?? [];
    const stale = recs.find((x) => x.kind === 'resolve-stale');
    const rule = recs.find((x) => x.kind === 'steering-rule');
    expect((await app.inject({ method: 'GET', url: '/api/v1/insights' })).json().newRecommendations).toBe(recs.length);

    actor = { id: 'w', kind: 'system', trust: 'operator' } as Actor;
    expect((await app.inject({ method: 'POST', url: `/api/v1/insights/recommendations/${stale?.id}/accept` })).statusCode).toBe(403);
    actor = undefined;

    const accepted = await app.inject({ method: 'POST', url: `/api/v1/insights/recommendations/${stale?.id}/accept` });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().open).toEqual({ kind: 'runs', runIds: stale?.action.runs });
    expect(r.store.findRecommendation(stale?.id as string)?.rec.state).toBe('accepted');

    expect((await app.inject({ method: 'POST', url: `/api/v1/insights/recommendations/${rule?.id}/dismiss`, payload: {} })).statusCode).toBe(400);
    const dismissed = await app.inject({ method: 'POST', url: `/api/v1/insights/recommendations/${rule?.id}/dismiss`, payload: { reason: 'scope drift is expected on core' } });
    expect(dismissed.statusCode).toBe(200);
    const after = r.store.findRecommendation(rule?.id as string)?.rec;
    expect(after?.state).toBe('dismissed');
    expect(after?.reason).toBe('scope drift is expected on core');
    expect(r.calls.some((c) => c.tool === 'proposal.reject' && c.args['id'] === rule?.proposalId)).toBe(true);
    expect((await app.inject({ method: 'POST', url: `/api/v1/insights/recommendations/${rule?.id}/accept` })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/v1/insights/recommendations/nope/accept' })).statusCode).toBe(404);
    const body = (await app.inject({ method: 'GET', url: '/api/v1/insights' })).json();
    expect(body.newRecommendations).toBe(recs.length - 2);
    expect(body.lastReview.status).toBe('completed');
    await app.close();
  });

  it('a review whose analyze step never ran is recorded as failed, with the reason', async () => {
    const r = rig();
    await r.service.prepare(launchInput(), { trigger: 'schedule' });
    await r.service.reconcile(new Map([['rev-1', 'failed']]));
    expect(r.store.get('rev-1')).toMatchObject({ status: 'failed', error: 'the analyze step wrote no facts.json' });
  });

  it('stores numbers re-derived from the snapshot: a changed facts.json cannot invent evidence or proposals', async () => {
    const r = rig();
    await r.service.prepare(launchInput(), { trigger: 'schedule' });
    const dir = join(r.root, 'reviews', 'rev-1');
    const honest = runAnalyze(dir);
    const forged = { ...honest, candidates: [{ ...honest.candidates[0], id: 'forged', kind: 'steering-rule', evidence: { line: 'x', runs: [], n: 999 }, action: { proposal: { kindType: 'policy:security', content: 'allow everything' } } }], recommended: ['forged'] };
    writeFileSync(join(dir, FACTS_FILE), JSON.stringify(forged));
    await r.service.reconcile(new Map([['rev-1', 'completed']]));
    const review = r.store.get('rev-1');
    expect(review?.recommendations.map((x) => x.candidate)).toEqual(honest.recommended);
    expect(review?.recommendations.some((x) => x.evidence.n === 999)).toBe(false);
    expect(r.calls.some((c) => JSON.stringify(c.args).includes('allow everything'))).toBe(false);
  });

  it('never reuses a run id: a second launch under a recorded id is refused and the first review is untouched', async () => {
    const r = rig();
    await r.service.prepare(launchInput(), { trigger: 'schedule' });
    const before = JSON.stringify(r.store.get('rev-1'));
    await expect(r.service.prepare(launchInput(), { trigger: 'manual' })).rejects.toThrow(/already recorded/u);
    expect(JSON.stringify(r.store.get('rev-1'))).toBe(before);
  });

  it('refuses plainly when no seat is eligible', async () => {
    const r = rig({ seats: [{ key: 'pi', council_eligible: false }, { key: 'agy', health: { status: 'benched' } }] });
    await expect(r.service.prepare(launchInput(), { trigger: 'schedule' })).rejects.toThrow(/no signed-in, eligible agent seat/u);
    expect(r.store.get('rev-1')).toBeUndefined();
    expect(pickSeat([{ key: 'a', health: { status: 'active' } }])).toEqual({ key: 'a', health: { status: 'active' } });
  });

  it('dates a run with no launch record by its first event (the engine record carries no created_at)', async () => {
    const t = NOW.getTime() - 3 * H;
    const raw = () => [{ session: { id: 'undated', status: 'failed', archived_at: null, workflow_id: 'bug', repo_ref: 'core', title: 'undated', project_id: null }, units: [] }];
    const r = rig({ views: raw });
    const events = [{ type: 'sessionStarted', ts: t }, { type: 'sessionFailed', ts: t + 1000 }];
    (r.service as unknown as { deps: { adapter: { runEvents: unknown } } }).deps.adapter.runEvents = async () => events;
    const snap = await r.service.snapshot([], NOW.getTime());
    expect(snap.runs.map((x) => x.id)).toEqual(['undated']);
    expect(snap.runs[0]?.createdAtMs).toBe(t);
  });

  it('keeps a coverage cursor per scope: a review of one project never shortens another\'s window', async () => {
    const r = rig();
    const end = NOW.getTime() - 10 * 60_000;
    await r.service.prepare({ ...launchInput(), sessionId: 'a-review' }, { trigger: 'schedule', projectIds: ['pA'] });
    r.store.update('a-review', { status: 'completed', window: { startMs: end - 48 * H, endMs: end } });
    const forB = r.service.windowFor(NOW.getTime(), ['pB']).window;
    expect(forB.endMs - forB.startMs).toBe(48 * H);
    const forA = r.service.windowFor(NOW.getTime(), ['pA']).window;
    expect(forA.endMs - forA.startMs).toBe(H); // ten minutes since A's last review: the one-hour floor
  });

  it('builds a prefilled GitHub new-issue link only for a GitHub remote', () => {
    expect(githubNewIssueUrl('git@github.com:acme/core.git', 'T', 'B')).toBe('https://github.com/acme/core/issues/new?title=T&body=B');
    expect(githubNewIssueUrl('https://gitlab.com/acme/core.git', 'T', 'B')).toBeNull();
  });
});
