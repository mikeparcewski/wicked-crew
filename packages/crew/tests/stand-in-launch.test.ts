// (DES-STANDIN-001 §4, crew K2a; wicked-core#1843, crew#1856) THE STAND-IN CHOICE: `POST /runs` asks the engine's
// preflight before anything is written and answers a short roster with no consent `409 stand_in_choice`; a person's
// `standIns: true` or the `standInReview: 'always'` setting launches stand-in-aware with server-built consent; the
// `use_stand_ins` gate answer reaches `grantStandIns` with the open gate's opening and the person as actor.
import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { AuditLog } from '../src/api/audit.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { Actor, LaunchRunInput } from '../src/core/types.js';
import { registerAuthHooks } from '../src/api/auth.js';
import { STAND_IN_SETTING_UNRECORDED, consentFor, preflightRefusal, readPreflight } from '../src/core/stand-in.js';
import { withRunViews } from './support/run-views.js';

/** The engine's own preflight for a one-CLI roster: `Core.independencePreflight`'s JSON as wicked-core serializes it
 *  (`src/independence.rs` `IndependencePreflight`, written by its test
 *  `t_r2_one_signed_in_cli_is_short_for_every_independent_role`), copied verbatim. */
const ONE_HELPER = readFileSync(new URL('./fixtures/stand-in-preflight-one-helper.json', import.meta.url), 'utf8');
/** (crew#1932) The engine's own preflight for the three repro shapes, through crew's `CoreAdapter.independencePreflight`
 *  on core-ts 0.15.49 (a scratch store, the roster Claude Code + Codex + Pi CLI, repo-bound). Copied verbatim, except
 *  one field named on the `bug` file. */
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
/** Repro 3: `capture-learnings` (Learn my style) on three helpers: every short role is conditional. */
const THREE_CAPTURE = fixture('stand-in-preflight-three-helpers-capture.json');
/** Repro 2: `bug` (Revise this PR) on three helpers. Its QE reviewer reads the host's skills routing, which this probe
 *  host lacks (it admitted none); on the daemon the repro ran on the card named no tester, so the QE row carries that
 *  daemon's answer (one real seat, not short). Every other role is the engine's: the short ones are conditional. */
const THREE_BUG = fixture('stand-in-preflight-three-helpers-bug.json');
/** Repro 1: a launch with no plan and no workflow on Claude Code alone. The engine's preflight sizes it by the default
 *  floor (a reviewer and a judge, short here), though its one planned unit has no review step (run f93b8927 ran one
 *  build step and seated no one). */
const ONE_PLANLESS = fixture('stand-in-preflight-one-helper-planless.json');

const withActor = (app: FastifyInstance) => app.addHook('onRequest', async (req) => {
  const named = req.headers['x-test-actor'];
  if (typeof named === 'string') {
    const [kind, trust] = named.split('/');
    (req as unknown as { actor: unknown }).actor = { id: `test-${kind}`, kind, trust };
  }
});

describe('stand-in consent and refusal bodies (pure)', () => {
  it('a person\'s flag is this job; the setting is every job; neither is no consent', () => {
    expect(consentFor(true, undefined, 'ann (human)', 7)).toEqual({ scope: 'job', by: 'ann (human)', at: 7, via: 'launch' });
    // Under the setting the consent is the saved author's, never the launcher's (wicked-core#1930 F6).
    const saved = { scope: 'always', by: 'priya (human)', at: 3, via: 'setting' };
    expect(consentFor(false, 'always', 'ci-bot (agent)', 7, saved)).toEqual(saved);
    expect(consentFor(false, 'always', 'ci-bot (agent)', 7)).toEqual({ scope: 'always', by: STAND_IN_SETTING_UNRECORDED, at: 7, via: 'setting' });
    expect(consentFor(false, 'always', 'ci-bot (agent)', 7, { ...saved, scope: 'job' })?.by).toBe(STAND_IN_SETTING_UNRECORDED);
    expect(consentFor(true, 'always', 'ann (human)', 7)?.scope).toBe('job');
    expect(consentFor(false, 'ask', 'ann (human)')).toBeNull();
    expect(consentFor(false, undefined, 'ann (human)')).toBeNull();
  });

  it('reads the engine\'s one-helper preflight and asks the four choices', () => {
    const p = readPreflight(ONE_HELPER);
    expect(p?.short).toBe(true);
    const r = preflightRefusal(p!);
    expect(r).toMatchObject({ code: 'stand_in_choice', retryWith: { standIns: true } });
    expect(r && 'choices' in r ? r.choices.map((c) => c.id) : []).toEqual(['job', 'always', 'sign_in', 'cancel']);
    expect(r?.error).toMatch(/stand-ins/);
    expect(r?.error).not.toMatch(/independent review\b(?!s)/);
  });

  it('a role no signed-in helper can stand in for is no_usable_helper; not short is no refusal', () => {
    const p = readPreflight(ONE_HELPER)!;
    const none = { ...p, roles: p.roles.map((r, i) => (i === 0 ? { ...r, canStandIn: false, standInFrom: null } : r)) };
    expect(preflightRefusal(none)).toMatchObject({ code: 'no_usable_helper' });
    expect(preflightRefusal({ ...p, short: false })).toBeNull();
  });

  // coord round 2 F4: the words state only the needs this launch has, never "signed in" (the person may have picked
  // the job's helpers), and never end on an API field.
  it('the choice names the roles the job needs, then the ones it needs only if the job calls for them', () => {
    const p = readPreflight(ONE_HELPER)!;
    const e = preflightRefusal(p)!.error;
    expect(e).toMatch(/^This job's helpers can't check it independently: it needs a reviewer, a judge and a QE reviewer that did not build the work, and, if the job calls for them, a rules checker, a rules council, a council and a monitor\./);
    expect(e).toMatch(/They are not independent reviews\./);
    expect(e).not.toMatch(/signed in/i);
    expect(e).not.toMatch(/standIns/);
    expect(e).toMatch(/Use stand-ins for this job or for every job, or add another helper to the job\.$/);
    // (crew#1932) Short only on roles a run needs if an event calls for them: no question at launch (no stand-in fills them).
    const condOnly = { ...p, roles: p.roles.map((r) => (r.conditional ? r : { ...r, shortBy: 0 })) };
    expect(preflightRefusal(condOnly)).toBeNull();
    // A conditional role no helper can stand in for does not refuse the launch either (consent could not change it).
    expect(preflightRefusal({ ...condOnly, roles: condOnly.roles.map((r) => (r.conditional ? { ...r, canStandIn: false, standInFrom: null } : r)) })).toBeNull();
    // One step (no plan, no workflow): never asked, whatever is short.
    expect(preflightRefusal(p, true)).toBeNull();
    expect((preflightRefusal(p) as { choices: Array<{ id: string; label: string }> }).choices.find((c) => c.id === 'sign_in')?.label).toBe('Add or sign in another helper');
  });

  it('no_usable_helper says what to do on a picked roster too', () => {
    const p = readPreflight(ONE_HELPER)!;
    const none = { ...p, roles: p.roles.map((r, i) => (i === 0 ? { ...r, canStandIn: false, standInFrom: null } : r)) };
    const e = preflightRefusal(none)!.error;
    expect(e).toBe('No helper on this job can be a reviewer for it, even as a stand-in, so it can\'t start. Add another helper to the job, or sign one in, and start it again.');
  });

  it('a malformed preflight reads as none', () => {
    for (const raw of ['{', '[]', '{"short":true}', '{"short":true,"roles":[{"role":"judge"}]}']) expect(readPreflight(raw)).toBeNull();
  });
});

describe('POST /runs asks the stand-in question (T-K1, T-K2)', () => {
  let app: FastifyInstance;
  const launched: LaunchRunInput[] = [];
  const preflights: LaunchRunInput[] = [];
  let settings: Record<string, unknown> = {};
  let preflight = ONE_HELPER;
  let supports = true;
  let draining = false;

  beforeAll(async () => {
    const adapter = {
      getSettings: async () => settings,
      sessions: async () => [], sessionsDetail: async () => [], listRepos: async () => [],
      listWorkflows: () => [], getWorkflow: () => null,
      launchRun: vi.fn(async (input: LaunchRunInput) => { launched.push(input); return input.sessionId; }),
      supportsStandIns: () => supports,
      isDraining: () => draining,
      independencePreflight: vi.fn(async (input: LaunchRunInput) => { preflights.push(input); return preflight; }),
    };
    app = Fastify({ logger: false });
    withActor(app);
    registerRoutes(app, adapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), undefined, {
      audit: { record: vi.fn(() => Date.now()) } as unknown as AuditLog, authMode: 'off',
    }, { rosterWithStanding: () => [], judgeCoverage: () => null });
    await app.ready();
  });
  afterAll(async () => { await app.close(); });
  beforeEach(() => {
    launched.length = 0; preflights.length = 0; settings = {}; preflight = ONE_HELPER; supports = true; draining = false;
  });

  const post = (body: Record<string, unknown>, actor = 'human/operator') =>
    app.inject({ method: 'POST', url: '/api/v1/runs', headers: { 'x-test-actor': actor }, payload: { problem: 'fix it', clisJson: '[]', workflow: 'bug', ...body } });

  it('a one-CLI roster with no consent is 409 stand_in_choice and nothing is launched', async () => {
    const res = await post({});
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ code: 'stand_in_choice', retryWith: { standIns: true }, preflight: { short: true } });
    expect(res.json().choices.map((c: { id: string }) => c.id)).toEqual(['job', 'always', 'sign_in', 'cancel']);
    expect(preflights).toHaveLength(1);
    expect(launched).toEqual([]);
  });

  // coord round 2 F5: a draining daemon refuses before it asks; the choice would only lead to the 503.
  it('a draining daemon with a short roster and no consent answers 503 maintenance_drain, not the choice', async () => {
    draining = true;
    const res = await post({});
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json().code).toBe('maintenance_drain');
    expect(preflights).toEqual([]);
    expect(launched).toEqual([]);
  });

  it('standIns: true from a person launches aware with server-built consent for this job, without asking', async () => {
    const before = Date.now();
    const res = await post({ standIns: true });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().assuranceNotice).toBeUndefined();
    expect(preflights).toHaveLength(1);
    expect(launched).toHaveLength(1);
    expect(launched[0]!.standInAware).toBe(true);
    expect(launched[0]!.standIn).toMatchObject({ scope: 'job', by: 'test-human (human)', via: 'launch' });
    expect(launched[0]!.standIn!.at).toBeGreaterThanOrEqual(before);
  });

  it('standIns from a worker\'s bearer is 403 and nothing is launched', async () => {
    const res = await post({ standIns: true }, 'agent/operator');
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().code).toBe('human_operator_only');
    expect(launched).toEqual([]);
  });

  it('the setting always launches aware for every job, a worker\'s launch inheriting it', async () => {
    settings = { standInReview: 'always' };
    for (const actor of ['human/operator', 'agent/operator']) {
      const res = await post({}, actor);
      expect(res.statusCode, res.body).toBe(201);
    }
    expect(preflights).toHaveLength(2);
    expect(launched.map((l) => [l.standInAware, l.standIn?.scope, l.standIn?.via])).toEqual([[true, 'always', 'setting'], [true, 'always', 'setting']]);
  });

  it('a roster that is not short launches aware with no consent (a mid-run loss asks then)', async () => {
    preflight = JSON.stringify({ ...JSON.parse(ONE_HELPER), short: false });
    const res = await post({});
    expect(res.statusCode, res.body).toBe(201);
    expect(launched[0]!.standInAware).toBe(true);
    expect(launched[0]!.standIn).toBeUndefined();
  });

  it('no usable base is 409 no_usable_helper, consent or not (consent answers only the choice)', async () => {
    const p = JSON.parse(ONE_HELPER);
    p.roles[0].canStandIn = false; p.roles[0].standInFrom = null;
    preflight = JSON.stringify(p);
    for (const [body, saved] of [[{}, {}], [{ standIns: true }, {}], [{}, { standInReview: 'always' }]] as const) {
      settings = { ...saved };
      const res = await post({ ...body });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().code).toBe('no_usable_helper');
    }
    expect(launched).toEqual([]);
  });

  it('with no helper signed in at all the engine answers (its no_eligible_seat names each bench), not the choice', async () => {
    const p = JSON.parse(ONE_HELPER);
    p.signedIn = [];
    p.roles[0].canStandIn = false; p.roles[0].standInFrom = null;
    preflight = JSON.stringify(p);
    const res = await post({});
    expect(res.statusCode, res.body).toBe(201);
    expect(launched).toHaveLength(1);
  });

  it('an engine without stand-ins keeps today\'s launch, and refuses standIns (501)', async () => {
    supports = false;
    expect((await post({})).statusCode).toBe(201);
    expect(launched[0]!.standInAware).toBeUndefined();
    expect(preflights).toEqual([]);
    const res = await post({ standIns: true });
    expect(res.statusCode, res.body).toBe(501);
  });

  // crew#1932: the launch asks only for roles every run of its plan seats, the ones a stand-in can fill. A role the run
  // needs only if an event calls for it (a council, the monitors, the rules checks) takes the run's own path.
  it('crew#1932 repro 3: Learn my style (capture-learnings) on three helpers launches, asking nothing', async () => {
    preflight = THREE_CAPTURE;
    const res = await post({ workflow: 'capture-learnings' });
    expect(res.statusCode, res.body).toBe(201);
    expect(preflights).toHaveLength(1);
    expect(launched).toHaveLength(1);
    expect(launched[0]!.standInAware).toBe(true);
    expect(launched[0]!.standIn).toBeUndefined();
  });

  it('crew#1932 repro 2: a bug job (Revise this PR) on three helpers launches, asking nothing', async () => {
    preflight = THREE_BUG;
    const res = await post({ workflow: 'bug' });
    expect(res.statusCode, res.body).toBe(201);
    expect(launched[0]!.standInAware).toBe(true);
    expect(launched[0]!.standIn).toBeUndefined();
  });

  it('crew#1932 repro 1: a launch with no plan and no workflow (one step) is never asked, on any roster', async () => {
    preflight = ONE_PLANLESS;
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs', headers: { 'x-test-actor': 'human/operator' }, payload: { problem: 'fix it', clisJson: '[]' } });
    expect(res.statusCode, res.body).toBe(201);
    expect(launched).toHaveLength(1);
    // Aware with no consent: a check its work calls for holds at the run's stand_in_needed gate, never seated unasked.
    expect(launched[0]!.standInAware).toBe(true);
    expect(launched[0]!.standIn).toBeUndefined();
  });

  it('crew#1932: a job its plan cannot check independently is still asked, and the words lead with what every run needs', async () => {
    // The bug job on Claude Code alone: the reviewer, judge and QE reviewer are short on every run.
    const p = JSON.parse(THREE_BUG);
    for (const r of p.roles) if (!r.conditional) { r.real = []; r.shortBy = r.needed; }
    preflight = JSON.stringify(p);
    const res = await post({ workflow: 'bug' });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().code).toBe('stand_in_choice');
    expect(res.json().error).toMatch(/^This job's helpers can't check it independently: it needs a reviewer, a judge and a QE reviewer that did not build the work, and, if the job calls for them, /);
    expect(launched).toEqual([]);
  });

  it('a reduced launch keeps today\'s path, and standIns beside it is a 400', async () => {
    expect((await post({ reducedAssurance: true })).statusCode).toBe(201);
    expect(launched[0]!.standInAware).toBeUndefined();
    expect(preflights).toEqual([]);
    expect((await post({ reducedAssurance: true, standIns: true })).statusCode).toBe(400);
  });
});

describe('PUT /settings standInReview is a person\'s', () => {
  let app: FastifyInstance;
  const saved: unknown[] = [];
  beforeAll(async () => {
    const adapter = {
      getSettings: async () => ({}),
      updateSettings: vi.fn(async (patch: Record<string, unknown>) => { saved.push(patch); return patch; }),
      sessions: async () => [], sessionsDetail: async () => [], listRepos: async () => [], listWorkflows: () => [], getWorkflow: () => null,
    };
    app = Fastify({ logger: false });
    withActor(app);
    registerRoutes(app, adapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), undefined, {
      audit: { record: vi.fn(() => Date.now()) } as unknown as AuditLog, authMode: 'off',
    });
    await app.ready();
  });
  afterAll(async () => { await app.close(); });
  const put = (body: unknown, actor = 'human/admin') =>
    app.inject({ method: 'PUT', url: '/api/v1/settings', headers: { 'x-test-actor': actor }, payload: body as Record<string, unknown> });

  it('a person saves ask or always; a worker is 403; a typo is 400', async () => {
    expect((await put({ standInReview: 'always' })).statusCode).toBe(200);
    expect((await put({ standInReview: 'ask' })).statusCode).toBe(200);
    expect(saved).toEqual([{ standInReview: 'always' }, { standInReview: 'ask' }]);
    expect((await put({ standInReview: 'always' }, 'agent/admin')).statusCode).toBe(403);
    expect((await put({ standInReview: 'sometimes' })).statusCode).toBe(400);
    expect(saved).toHaveLength(2);
  });
});

// codex r1 on b7-standin: the consent guards behind crew's REAL auth hooks (required mode), each actor by its bearer: an
// agent's or a system's token never consents, at launch or in the setting (the gate's is in the use_stand_ins block
// below). (In `off` mode the daemon
// has no identities at all: every request is the local person, as for every human-only rule.)
describe('stand-in consent behind the real auth hooks', () => {
  let app: FastifyInstance;
  const launched: LaunchRunInput[] = [];
  const saved: unknown[] = [];
  const TOKENS: Record<string, Actor> = {
    human: { id: 'priya', kind: 'human', trust: 'admin' },
    agent: { id: 'seat-codex', kind: 'agent', trust: 'admin' },
    system: { id: 'ci', kind: 'system', trust: 'admin' },
  };
  beforeAll(async () => {
    const adapter = {
      getSettings: async () => ({}),
      updateSettings: vi.fn(async (patch: Record<string, unknown>) => { saved.push(patch); return patch; }),
      sessions: async () => [], sessionsDetail: async () => [], listRepos: async () => [],
      listWorkflows: () => [], getWorkflow: () => null,
      launchRun: vi.fn(async (input: LaunchRunInput) => { launched.push(input); return input.sessionId; }),
      supportsStandIns: () => true,
      independencePreflight: vi.fn(async () => ONE_HELPER),
    };
    app = Fastify({ logger: false });
    registerAuthHooks(app, { mode: 'required', verifiers: [{ name: 'test', verify: async (t) => TOKENS[t] ?? null }], allowedOrigins: null });
    registerRoutes(app, adapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), undefined, {
      audit: { record: vi.fn(() => Date.now()) } as unknown as AuditLog, authMode: 'required',
    }, { rosterWithStanding: () => [], judgeCoverage: () => null });
    await app.ready();
  });
  afterAll(async () => { await app.close(); });
  const as = (token: string) => ({ authorization: `Bearer ${token}` });

  it('only a person\'s bearer consents at launch or saves always', async () => {
    for (const token of ['agent', 'system']) {
      const launch = await app.inject({ method: 'POST', url: '/api/v1/runs', headers: as(token), payload: { problem: 'fix it', clisJson: '[]', standIns: true } });
      expect(launch.statusCode, launch.body).toBe(403);
      const put = await app.inject({ method: 'PUT', url: '/api/v1/settings', headers: as(token), payload: { standInReview: 'always' } });
      expect(put.statusCode, put.body).toBe(403);
    }
    expect(launched).toEqual([]);
    expect(saved).toEqual([]);
    const launch = await app.inject({ method: 'POST', url: '/api/v1/runs', headers: as('human'), payload: { problem: 'fix it', clisJson: '[]', standIns: true } });
    expect(launch.statusCode, launch.body).toBe(201);
    expect(launched[0]!.standIn).toMatchObject({ scope: 'job', by: 'priya (human)' });
    expect((await app.inject({ method: 'PUT', url: '/api/v1/settings', headers: as('human'), payload: { standInReview: 'always' } })).statusCode).toBe(200);
  });
});

describe('POST /runs/:id/gate use_stand_ins → grantStandIns (crew#1856)', () => {
  let app: FastifyInstance;
  const grants: unknown[][] = [];
  const confirms: unknown[][] = [];
  const saved: unknown[] = [];
  let row: Record<string, unknown> = {};
  let grantError: Error | null = null;

  const view = (id: string) => ({
    session: {
      id, workflow_id: 'bug', problem: 'p', entity_mode: 'shared', collection_scope: null, clis: ['claude'],
      status: 'awaiting_human', human_confirm: 'none', unit_ix: 0, attempt: 0, workdir: null, repo_ref: null,
      extra_write_roots: [], archived_at: null, archive_note: null,
    },
    units: [{ id: `${id}:review`, session_id: id, ord: 4, description: 'review', phase_ref: 'review', status: 'rejected', assigned_cli: 'claude' }],
  });

  const makeAdapter = () => ({
      sessionsDetail: vi.fn().mockResolvedValue([view('run-s')]),
      listRepos: vi.fn().mockResolvedValue([]),
      listWorkflows: () => [],
      interactionRequests: vi.fn(async () => [row]),
      runEvents: vi.fn(async () => []),
      supportsStandIns: () => true,
      grantStandIns: vi.fn(async (...args: unknown[]) => { if (grantError !== null) throw grantError; grants.push(args); return 'executing'; }),
      confirmGate: vi.fn(async (...args: unknown[]) => { confirms.push(args); return 'executing'; }),
      updateSettings: vi.fn(async (patch: Record<string, unknown>) => { saved.push(patch); return patch; }),
  });
  beforeAll(async () => {
    const adapter = makeAdapter();
    app = Fastify({ logger: false });
    withActor(app);
    registerRoutes(app, withRunViews(adapter as unknown as CoreAdapter), new GateCache(), new ElicitationCache(), undefined, {
      audit: { record: vi.fn(() => Date.now()) } as unknown as AuditLog, authMode: 'off',
    });
    await app.ready();
  });
  afterAll(async () => { await app.close(); });
  beforeEach(() => {
    grants.length = 0; confirms.length = 0; saved.length = 0; grantError = null;
    // The engine's durable gate row (wicked-core `src/interaction.rs` `InteractionRequest`, serde snake_case).
    row = { kind: 'gate', ord: 4, prompt: 'No helper left to judge this step', gate_kind: 'stand_in_needed', gate_seq: 3, created_at: 1 };
  });
  const post = (body: Record<string, unknown>, actor = 'human/operator') =>
    app.inject({ method: 'POST', url: '/api/v1/runs/run-s/gate', headers: { 'x-test-actor': actor }, payload: body });

  it('this job: the grant names the open opening, the person and the ord; no plain confirm', async () => {
    const res = await post({ approve: true, action: 'use_stand_ins', scope: 'job', ord: 4 });
    expect(res.statusCode, res.body).toBe(200);
    expect(grants).toEqual([['run-s', 'job', 3, 'test-human (human)', 4]]);
    expect(confirms).toEqual([]);
    expect(saved).toEqual([]);
  });

  it('every job: the grant, then the standing setting', async () => {
    const res = await post({ approve: true, action: 'use_stand_ins', scope: 'always' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'executing', standInReview: 'saved' });
    expect(grants).toEqual([['run-s', 'always', 3, 'test-human (human)', 4]]);
    expect(saved).toEqual([{ standInReview: 'always', standInConsent: { scope: 'always', by: 'test-human (human)', at: expect.any(Number), via: 'setting' } }]);
  });

  // codex delta on b7-standin: the gate consent behind crew's REAL auth hooks (required mode), each actor by its bearer.
  it('behind the real auth hooks only a person\'s bearer grants, and the grant names that person', async () => {
    const TOKENS: Record<string, Actor> = {
      human: { id: 'priya', kind: 'human', trust: 'operator' },
      agent: { id: 'seat-codex', kind: 'agent', trust: 'operator' },
      system: { id: 'ci', kind: 'system', trust: 'admin' },
    };
    const authed = Fastify({ logger: false });
    registerAuthHooks(authed, { mode: 'required', verifiers: [{ name: 'test', verify: async (t) => TOKENS[t] ?? null }], allowedOrigins: null });
    registerRoutes(authed, withRunViews(makeAdapter() as unknown as CoreAdapter), new GateCache(), new ElicitationCache(), undefined, {
      audit: { record: vi.fn(() => Date.now()) } as unknown as AuditLog, authMode: 'required',
    });
    await authed.ready();
    try {
      const answer = (token: string) => authed.inject({
        method: 'POST', url: '/api/v1/runs/run-s/gate', headers: { authorization: `Bearer ${token}` },
        payload: { approve: true, action: 'use_stand_ins', scope: 'always' },
      });
      for (const token of ['agent', 'system']) expect((await answer(token)).statusCode).toBe(403);
      expect(grants).toEqual([]);
      expect(saved).toEqual([]);
      const res = await answer('human');
      expect(res.statusCode, res.body).toBe(200);
      expect(grants).toEqual([['run-s', 'always', 3, 'priya (human)', 4]]);
      expect(saved).toEqual([{ standInReview: 'always', standInConsent: { scope: 'always', by: 'priya (human)', at: expect.any(Number), via: 'setting' } }]);
    } finally {
      await authed.close();
    }
  });

  it('a worker or a standing order cannot consent', async () => {
    const res = await post({ approve: true, action: 'use_stand_ins', scope: 'job' }, 'agent/operator');
    expect(res.statusCode).toBe(403);
    expect(grants).toEqual([]);
  });

  it('scope is required with use_stand_ins and only with it', async () => {
    expect((await post({ approve: true, action: 'use_stand_ins' })).statusCode).toBe(400);
    expect((await post({ approve: true, scope: 'job' })).statusCode).toBe(400);
    expect((await post({ approve: false, action: 'use_stand_ins', scope: 'job' })).statusCode).toBe(400);
    expect(grants).toEqual([]);
  });

  it('another gate, or a row without its opening, is refused before the engine is asked', async () => {
    row = { ...row, gate_kind: 'escalation' };
    const other = await post({ approve: true, action: 'use_stand_ins', scope: 'job' });
    expect(other.statusCode).toBe(409);
    expect(other.json().code).toBe('gate_changed');
    row = { kind: 'gate', ord: 4, prompt: 'p', gate_kind: 'stand_in_needed', created_at: 1 };
    const unknown = await post({ approve: true, action: 'use_stand_ins', scope: 'job' });
    expect(unknown.statusCode).toBe(409);
    expect(unknown.json().code).toBe('gate_unknown');
    expect(grants).toEqual([]);
  });

  it('the engine\'s gate_changed (a re-opened gate) is a 409 gate_changed, and every job is not saved', async () => {
    grantError = new Error('gate_changed: the gate opened again since (opening 4, not 3)');
    const res = await post({ approve: true, action: 'use_stand_ins', scope: 'always' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('gate_changed');
    expect(saved).toEqual([]);
  });
});
