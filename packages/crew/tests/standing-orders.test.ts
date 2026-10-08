// Standing orders (Studio OS behaviour 10) — the store, the evaluator, the routes and the seat parse,
// each over fakes. The end-to-end proof over createServer is standing-orders-journey.test.ts.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, RosterSeat, TeamRow } from '../src/core/types.js';
import { openPlanGateRisk } from '../src/team/routes.js';
import { StandingOrderEvaluator, type GateFact, type RunFacts } from '../src/standing-orders/evaluator.js';
import { seatParser } from '../src/standing-orders/parse.js';
import { registerStandingOrderRoutes, ruleFromAnswer, type ParseOutcome } from '../src/standing-orders/routes.js';
import { refusal, StandingOrderStore, type StandingOrderRule } from '../src/standing-orders/store.js';
import { AuditLog } from '../src/api/audit.js';
import { removeScratch } from './setup/scratch.js';

const scratch = mkdtempSync(join(tmpdir(), 'crew-so-unit-'));
afterAll(() => removeScratch(scratch));

const gateRule = (phase: string, action: StandingOrderRule['action'], projectId?: string, activeWhen: 'away' | 'always' = 'away'): StandingOrderRule => ({
  scope: projectId === undefined ? { kind: 'all' } : { kind: 'project', projectId },
  trigger: { kind: 'gate', phase },
  action,
  activeWhen,
});

const HUMAN = { id: 'local', kind: 'human', trust: 'admin' } as const;

describe('StandingOrderStore — the audit trail is the record', () => {
  it('every change is one trail entry, and a fresh store folds the trail back to the same state', async () => {
    const path = join(scratch, 'rt-audit.log');
    const trail = new AuditLog(path);
    const a = new StandingOrderStore(trail);
    const o = a.add('approve intake on A', gateRule('intake', 'approve', 'A'), HUMAN);
    const gone = a.add('hold delivers', gateRule('deliver', 'hold'), HUMAN);
    // Full UUIDs: a retire removes every order with its id (codex on #686).
    expect(o.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(a.setAway(true, HUMAN)).toBe(true);
    expect(a.setAway(true, HUMAN)).toBe(false); // no change, no entry
    a.queue(o, 'r1', 'hello');
    expect(a.remove(gone.id, HUMAN)).toBe(true);
    expect(a.remove(gone.id, HUMAN)).toBe(false);
    await trail.flush();
    expect((await trail.readAll()).map((e) => e.action).reverse()).toEqual([
      'standing-order.created', 'standing-order.created', 'standing-order.away', 'standing-order.notified', 'standing-order.retired',
    ]);
    const b = new StandingOrderStore(AuditLog.noop());
    await b.hydrate(new AuditLog(path));
    expect(b.snapshot()).toEqual(a.snapshot());
    const s = b.snapshot();
    expect(s.away).toBe(true);
    expect(s.orders.map((x) => x.text)).toEqual(['approve intake on A']);
    expect(s.outbox).toMatchObject([{ orderId: o.id, orderText: o.text, runId: 'r1', text: 'hello', status: 'queued' }]);
  });

  it('an unreadable trail is said and starts empty, never guessed at', async () => {
    const warned: string[] = [];
    const s = new StandingOrderStore(AuditLog.noop());
    await s.hydrate({ readAll: async () => { throw new Error('EACCES'); } }, (m) => warned.push(m));
    expect(s.snapshot()).toEqual({ away: false, awaySince: null, orders: [], outbox: [] });
    expect(warned[0]).toMatch(/hydrate failed/);
  });

  it('a created entry whose rule no longer validates is skipped', async () => {
    const path = join(scratch, 'bad-rule-audit.log');
    writeFileSync(path, JSON.stringify({ ts: 1, action: 'standing-order.created', actor: HUMAN, detail: { standingOrder: { id: 'x', text: 't' }, rule: { action: 'launch' } } }) + '\n');
    const s = new StandingOrderStore(AuditLog.noop());
    await s.hydrate(new AuditLog(path));
    expect(s.orders()).toEqual([]);
  });

  it('the invariant: approve never names deliver, a plan approval or a finding', () => {
    expect(refusal(gateRule('deliver', 'approve'))).toMatch(/deliver gate/);
    expect(refusal(gateRule('plan_approval', 'approve'))).toMatch(/plan_approval/);
    expect(refusal({ scope: { kind: 'all' }, trigger: { kind: 'finding', severity: 'high' }, action: 'approve', activeWhen: 'away' })).toMatch(/finding/);
    expect(refusal(gateRule('deliver', 'hold'))).toBeNull();
    expect(refusal(gateRule('intake', 'approve'))).toBeNull();
  });

  it('a plan approval may be trusted only for ONE project\'s band 0-19 runs of ONE preset (brainstorm idea 13)', () => {
    const plan = (over: Partial<{ scope: StandingOrderRule['scope']; band: string; preset: string }>): StandingOrderRule => ({
      scope: over.scope ?? { kind: 'project', projectId: 'A' },
      trigger: {
        kind: 'gate', phase: 'plan_approval',
        ...(over.band !== undefined ? { band: over.band } : {}),
        ...(over.preset !== undefined ? { preset: over.preset } : {}),
      },
      action: 'approve',
      activeWhen: 'always',
    });
    expect(refusal(plan({ band: '0-19', preset: 'bugfix' }))).toBeNull();
    expect(refusal(plan({ band: '20-39', preset: 'bugfix' }))).toMatch(/band 0-19/);
    expect(refusal(plan({ band: '0-19' }))).toMatch(/preset/);
    expect(refusal(plan({ preset: 'bugfix' }))).toMatch(/band 0-19/);
    expect(refusal(plan({ scope: { kind: 'all' }, band: '0-19', preset: 'bugfix' }))).toMatch(/project/);
    // The deliver gate is never trusted, however narrow the rule.
    expect(refusal({ ...plan({ band: '0-19', preset: 'bugfix' }), trigger: { kind: 'gate', phase: 'deliver', band: '0-19', preset: 'bugfix' } })).toMatch(/deliver gate/);
  });
});

interface HarnessRun {
  projectId?: string;
  phases: string[];
  steering?: boolean;
  band?: string;
  /** `team_plan.preset` — the preset the launch named. */
  preset?: string;
  /** The OPEN plan gate's own band and risk, off its `gate.opened` row; absent = unreadable. */
  planGate?: { band: string; highRisk: boolean };
}

function harness(runs: Record<string, HarnessRun>, decideCode = 200) {
  const audited: Array<{ action: string; actor: { id: string }; runId?: string; detail?: Record<string, unknown> }> = [];
  const audit = {
    record: (action: string, actor: { id: string }, fields?: { runId?: string; detail?: Record<string, unknown> }) => {
      audited.push({ action, actor, ...(fields?.runId !== undefined ? { runId: fields.runId } : {}), ...(fields?.detail !== undefined ? { detail: fields.detail } : {}) });
      return Date.now();
    },
  };
  const store = new StandingOrderStore(audit);
  const decided: Array<{ id: string; decision: unknown; actor: { id: string; kind: string }; extra?: Record<string, unknown> }> = [];
  let open: GateFact[] = [];
  const reads = { n: 0 };
  const logs: string[] = [];
  const evaluator = new StandingOrderEvaluator({
    store,
    decideGate: async (id, decision, actor, extra) => {
      decided.push({ id, decision, actor, ...(extra !== undefined ? { extra } : {}) });
      return decideCode === 200 ? { code: 200, body: { status: 'executing' } } : { code: decideCode, body: { code: 'gate_changed' } };
    },
    audit,
    runFacts: async (runId): Promise<RunFacts | undefined> => {
      const r = runs[runId];
      return r === undefined
        ? undefined
        : { projectId: r.projectId, problem: `problem ${runId}`, phaseOf: (ord) => r.phases[ord], firstOrd: 0, landsDoctrine: r.steering === true, band: r.band, preset: r.preset };
    },
    planGate: async (runId) => runs[runId]?.planGate,
    openGates: async () => {
      reads.n += 1;
      return open;
    },
    log: (m) => logs.push(m),
  });
  return { store, evaluator, decided, audited, logs, reads, setOpen: (g: GateFact[]) => (open = g) };
}

const gate = (runId: string, ord: number, gateKind = 'def', reviewingOrd: number | null = ord - 1): CoreEvent =>
  ({ type: 'awaitingHuman', session: runId, ord, reviewingOrd, prompt: 'go?', gateKind }) as CoreEvent;

describe('StandingOrderEvaluator', () => {
  it('an away order is dormant while present and acts once away', async () => {
    const h = harness({ r1: { projectId: 'A', phases: ['intake', 'design'] } });
    const o = h.store.add('approve intake on A', gateRule('intake', 'approve', 'A'), HUMAN);
    await h.evaluator.onEvent(gate('r1', 1));
    expect(h.decided).toEqual([]);
    h.store.setAway(true, HUMAN);
    await h.evaluator.onEvent(gate('r1', 1));
    expect(h.decided).toEqual([
      { id: 'r1', decision: { approve: true, ord: 1 }, actor: { id: `standing-order:${o.id}`, kind: 'system', trust: 'operator' }, extra: { standingOrder: { id: o.id, text: o.text } } },
    ]);
  });

  it('"intake" is the pre-run gate: before the first unit, reviewing nothing — not a later gate', async () => {
    const h = harness({ r1: { projectId: 'A', phases: ['understand', 'build'] } });
    h.store.setAway(true, HUMAN);
    h.store.add('approve intake', gateRule('intake', 'approve', 'A'), HUMAN);
    await h.evaluator.onEvent(gate('r1', 1, 'def', 0)); // after understand: not intake
    expect(h.decided).toEqual([]);
    await h.evaluator.onEvent(gate('r1', 0, 'run_level', null)); // before unit 0: intake
    expect(h.decided.map((d) => d.decision)).toEqual([{ approve: true, ord: 0 }]);
  });

  it('never approves a gate of a steering-author run (its approval lands doctrine)', async () => {
    const h = harness({ r1: { projectId: 'A', phases: ['understand', 'build'], steering: true } });
    h.store.setAway(true, HUMAN);
    h.store.add('approve anything', gateRule('*', 'approve'), HUMAN);
    await h.evaluator.onEvent(gate('r1', 1, 'def', 0));
    expect(h.decided).toEqual([]);
  });

  it('a band-scoped order approves only a run whose accepted plan is in that band (brainstorm idea 8)', async () => {
    const h = harness({
      low: { projectId: 'A', phases: ['build', 'review'], band: '0-19' },
      mid: { projectId: 'A', phases: ['build', 'review'], band: '40-69' },
      none: { projectId: 'A', phases: ['build', 'review'] },
    });
    h.store.add('Always approve band 0-19 unit reviews on A', {
      scope: { kind: 'project', projectId: 'A' }, trigger: { kind: 'gate', phase: '*', band: '0-19' }, action: 'approve', activeWhen: 'always',
    }, HUMAN);
    await h.evaluator.onEvent(gate('mid', 1));
    await h.evaluator.onEvent(gate('none', 1));
    expect(h.decided).toEqual([]);
    await h.evaluator.onEvent(gate('low', 1));
    expect(h.decided.map((d) => d.id)).toEqual(['low']);
  });

  it('a plan-trust order approves the plan gate of a matching band 0-19 run, and never its deliver gate (idea 13)', async () => {
    const low = { band: '0-19', highRisk: false };
    const h = harness({
      match: { projectId: 'A', phases: ['build', 'review', 'deliver'], preset: 'bugfix', planGate: low },
      otherPreset: { projectId: 'A', phases: ['build'], preset: 'feature', planGate: low },
      otherProject: { projectId: 'B', phases: ['build'], preset: 'bugfix', planGate: low },
      midBand: { projectId: 'A', phases: ['build'], preset: 'bugfix', planGate: { band: '20-39', highRisk: false } },
      highRisk: { projectId: 'A', phases: ['build'], preset: 'bugfix', planGate: { band: '0-19', highRisk: true } },
      unreadable: { projectId: 'A', phases: ['build'], preset: 'bugfix' },
    });
    const o = h.store.add('Trust bugfix runs on A at band 0-19: skip plan approval', {
      scope: { kind: 'project', projectId: 'A' },
      trigger: { kind: 'gate', phase: 'plan_approval', band: '0-19', preset: 'bugfix' },
      action: 'approve',
      activeWhen: 'always',
    }, HUMAN);
    for (const id of ['otherPreset', 'otherProject', 'midBand', 'highRisk', 'unreadable']) {
      await h.evaluator.onEvent(gate(id, 0, 'plan_approval', null));
    }
    expect(h.decided).toEqual([]);
    await h.evaluator.onEvent(gate('match', 0, 'plan_approval', null));
    expect(h.decided).toEqual([
      { id: 'match', decision: { approve: true, ord: 0 }, actor: { id: `standing-order:${o.id}`, kind: 'system', trust: 'operator' }, extra: { standingOrder: { id: o.id, text: o.text } } },
    ]);
    // The same run's unit gates and its deliver gate still wait for a person.
    await h.evaluator.onEvent(gate('match', 1, 'def', 0));
    await h.evaluator.onEvent(gate('match', 2, 'deliver', 1));
    expect(h.decided).toHaveLength(1);
  });

  it('a wildcard or band-only approve still never answers a plan gate', async () => {
    const h = harness({ r1: { projectId: 'A', phases: ['build'], preset: 'bugfix', band: '0-19', planGate: { band: '0-19', highRisk: false } } });
    h.store.add('approve band 0-19 on A', {
      scope: { kind: 'project', projectId: 'A' }, trigger: { kind: 'gate', phase: '*', band: '0-19' }, action: 'approve', activeWhen: 'always',
    }, HUMAN);
    await h.evaluator.onEvent(gate('r1', 0, 'plan_approval', null));
    expect(h.decided).toEqual([]);
  });

  it('an `always` order acts while present', async () => {
    const h = harness({ r1: { projectId: 'A', phases: ['intake', 'design'] } });
    h.store.add('always approve intake', gateRule('intake', 'approve', undefined, 'always'), HUMAN);
    await h.evaluator.onEvent(gate('r1', 1));
    expect(h.decided).toHaveLength(1);
  });

  it('scope and phase must both match; a run_level gate reads the upcoming unit\'s phase', async () => {
    const h = harness({ a: { projectId: 'A', phases: ['intake', 'design'] }, b: { projectId: 'B', phases: ['intake', 'design'] } });
    h.store.setAway(true, HUMAN);
    h.store.add('approve design on A', gateRule('design', 'approve', 'A'), HUMAN);
    await h.evaluator.onEvent(gate('b', 1, 'def', 1)); // project B
    await h.evaluator.onEvent(gate('a', 1, 'def', 0)); // reviews intake
    expect(h.decided).toEqual([]);
    await h.evaluator.onEvent(gate('a', 1, 'run_level', null)); // before design, nothing to review
    expect(h.decided.map((d) => d.id)).toEqual(['a']);
  });

  it.each(['deliver', 'plan_approval', 'escalation', 'failure', 'triage'])(
    'THE INVARIANT: a %s gate is never answered, even by a wildcard approve',
    async (kind) => {
      const h = harness({ r1: { projectId: 'A', phases: ['build', 'deliver'] } });
      h.store.setAway(true, HUMAN);
      h.store.add('approve anything', gateRule('*', 'approve'), HUMAN);
      await h.evaluator.onEvent(gate('r1', 1, kind));
      expect(h.decided).toEqual([]);
    },
  );

  it('hold wins over approve and is recorded once, naming the order', async () => {
    const h = harness({ r1: { projectId: 'A', phases: ['intake', 'design'] } });
    h.store.setAway(true, HUMAN);
    h.store.add('approve everything', gateRule('*', 'approve'), HUMAN);
    const hold = h.store.add('hold intake on A', gateRule('intake', 'hold', 'A'), HUMAN);
    await h.evaluator.onEvent(gate('r1', 1));
    await h.evaluator.onEvent(gate('r1', 1)); // the same gate again (a replayed frame)
    expect(h.decided).toEqual([]);
    expect(h.audited.filter((a) => a.action === 'standing-order.held')).toEqual([
      {
        action: 'standing-order.held',
        actor: { id: `standing-order:${hold.id}`, kind: 'system', trust: 'operator' },
        runId: 'r1',
        detail: { standingOrder: { id: hold.id, text: hold.text }, ord: 1, gateKind: 'def', phase: 'intake' },
      },
    ]);
  });

  it('notify QUEUES the message and records it — nothing is sent', async () => {
    const h = harness({ r1: { projectId: 'A', phases: ['intake', 'design'] } });
    h.store.setAway(true, HUMAN);
    const n = h.store.add('tell me about intake gates', gateRule('intake', 'notify'), HUMAN);
    await h.evaluator.onEvent(gate('r1', 1));
    const outbox = h.store.snapshot().outbox;
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ orderId: n.id, runId: 'r1', status: 'queued' });
    expect(outbox[0]!.text).toMatch(/intake gate is waiting/);
    expect(h.audited.find((a) => a.action === 'standing-order.notified')).toMatchObject({
      actor: { id: `standing-order:${n.id}` },
      runId: 'r1',
      detail: { queued: true, messageId: outbox[0]!.id },
    });
    expect(h.decided).toEqual([]);
  });

  it('a HIGH finding wakes you through the queue; a medium one does not match a high order', async () => {
    const h = harness({ r1: { projectId: 'A', phases: ['build'] } });
    h.store.setAway(true, HUMAN);
    h.store.add('wake me for any HIGH', { scope: { kind: 'all' }, trigger: { kind: 'finding', severity: 'high' }, action: 'notify', activeWhen: 'away' }, HUMAN);
    const row = (severity: string, id: string) =>
      ({ type: 'teamEvent', event: { event_type: 'wicked.team.finding.raised', payload: { run_id: 'r1', finding_id: id, severity, claim: 'null deref' } } }) as unknown as CoreEvent;
    await h.evaluator.onTeamFrame(row('medium', 'f1'));
    await h.evaluator.onTeamFrame(row('high', 'f2'));
    await h.evaluator.onTeamFrame(row('high', 'f2'));
    expect(h.store.snapshot().outbox.map((m) => m.text)).toEqual(['HIGH finding on problem r1: null deref']);
  });

  it('a refusal from the gate path (409: a person got there first) is logged, not retried', async () => {
    const h = harness({ r1: { projectId: 'A', phases: ['intake', 'design'] } }, 409);
    h.store.setAway(true, HUMAN);
    h.store.add('approve intake', gateRule('intake', 'approve'), HUMAN);
    await h.evaluator.onEvent(gate('r1', 1));
    await h.evaluator.onEvent(gate('r1', 1));
    expect(h.decided).toHaveLength(1);
    expect(h.logs[0]).toMatch(/did not answer the gate before unit 1 on r1: 409/);
  });

  it('a sweep answers a gate that was already open', async () => {
    const h = harness({ r1: { projectId: 'A', phases: ['intake', 'design'] } });
    h.store.setAway(true, HUMAN);
    h.store.add('approve intake', gateRule('intake', 'approve'), HUMAN);
    h.setOpen([{ runId: 'r1', ord: 1, reviewingOrd: 0, gateKind: 'def', prompt: 'go?' }]);
    await h.evaluator.sweep();
    expect(h.decided.map((d) => d.decision)).toEqual([{ approve: true, ord: 1 }]);
  });

  it('a gate still open after a restart does not queue its notice twice (codex on #686)', async () => {
    const h = harness({ r1: { projectId: 'A', phases: ['intake', 'design'] } });
    h.store.add('tell me about any gate', gateRule('*', 'notify', undefined, 'always'), HUMAN);
    h.setOpen([{ runId: 'r1', ord: 1, reviewingOrd: 0, gateKind: 'def', prompt: 'go?' }]);
    await h.evaluator.sweep();
    // A fresh evaluator over the same store: what a restart's boot sweep is.
    const again = new StandingOrderEvaluator({
      store: h.store,
      decideGate: async () => ({ code: 200, body: {} }),
      audit: { record: () => Date.now() },
      runFacts: async () => ({ projectId: 'A', problem: 'problem r1', phaseOf: () => 'intake', firstOrd: 0, landsDoctrine: false, band: undefined }),
      openGates: async () => [{ runId: 'r1', ord: 1, reviewingOrd: 0, gateKind: 'def', prompt: 'go?' }],
    });
    await again.sweep();
    expect(h.store.snapshot().outbox).toHaveLength(1);
  });

  it('a sweep with no active gate order never reads the engine (the boot sweep of every daemon)', async () => {
    const h = harness({ r1: { projectId: 'A', phases: ['intake', 'design'] } });
    await h.evaluator.sweep(); // no orders
    h.store.add('approve intake', gateRule('intake', 'approve'), HUMAN); // dormant: not away
    h.store.add('wake me for HIGH', { scope: { kind: 'all' }, trigger: { kind: 'finding', severity: 'high' }, action: 'notify', activeWhen: 'always' }, HUMAN);
    await h.evaluator.sweep();
    expect(h.reads.n).toBe(0);
    h.store.setAway(true, HUMAN);
    await h.evaluator.sweep();
    expect(h.reads.n).toBe(1);
  });
});

describe('standing-order routes', () => {
  async function app(parse: (t: string) => Promise<ParseOutcome> = async () => ({ ok: false, code: 409, error: 'no seat' })) {
    const h = harness({ r1: { projectId: 'A', phases: ['intake', 'design'] } });
    const a = Fastify({ logger: false });
    registerStandingOrderRoutes(a, { store: h.store, evaluator: h.evaluator, parse });
    await a.ready();
    return { a, h };
  }

  it('creates, lists, flips away (sweeping), and retires', async () => {
    const { a, h } = await app();
    h.setOpen([{ runId: 'r1', ord: 1, reviewingOrd: 0, gateKind: 'def', prompt: 'go?' }]);
    const created = await a.inject({ method: 'POST', url: '/api/v1/standing-orders', payload: { text: 'approve intake', rule: gateRule('intake', 'approve') } });
    expect(created.statusCode).toBe(201);
    expect(h.decided).toEqual([]); // not away yet
    const away = await a.inject({ method: 'PUT', url: '/api/v1/standing-orders/away', payload: { away: true } });
    expect(away.json()).toMatchObject({ away: true });
    expect(h.decided).toHaveLength(1); // the sweep answered the open gate
    const id = (created.json() as { order: { id: string } }).order.id;
    expect((await a.inject({ method: 'GET', url: '/api/v1/standing-orders' })).json()).toMatchObject({ orders: [{ id }] });
    expect((await a.inject({ method: 'DELETE', url: `/api/v1/standing-orders/${id}` })).statusCode).toBe(200);
    expect((await a.inject({ method: 'DELETE', url: `/api/v1/standing-orders/${id}` })).statusCode).toBe(404);
    await a.close();
  });

  it('refuses an order that would approve the deliver gate (400 order_refused) and a malformed rule (400)', async () => {
    const { a } = await app();
    const deliver = await a.inject({ method: 'POST', url: '/api/v1/standing-orders', payload: { text: 'ship it', rule: gateRule('deliver', 'approve') } });
    expect(deliver.statusCode).toBe(400);
    expect(deliver.json()).toMatchObject({ code: 'order_refused' });
    const bad = await a.inject({ method: 'POST', url: '/api/v1/standing-orders', payload: { text: 'x', rule: { action: 'approve' } } });
    expect(bad.statusCode).toBe(400);
    await a.close();
  });

  it('parse returns the seat\'s rule with the invariant\'s refusal in words; a failure keeps its code', async () => {
    const { a } = await app(async (t) =>
      t === 'ship everything' ? { ok: true, rule: gateRule('deliver', 'approve'), seat: 'claude' } : { ok: false, code: 422, error: 'no rule', answer: 'hmm' },
    );
    const ok = await a.inject({ method: 'POST', url: '/api/v1/standing-orders/parse', payload: { text: 'ship everything' } });
    expect(ok.json()).toMatchObject({ seat: 'claude', rule: { action: 'approve' }, refused: expect.stringMatching(/deliver/) });
    const bad = await a.inject({ method: 'POST', url: '/api/v1/standing-orders/parse', payload: { text: 'blah' } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toEqual({ error: 'no rule', answer: 'hmm' });
    await a.close();
  });
});

describe('the seat parse', () => {
  it('reads the first rule-shaped JSON out of an answer', () => {
    expect(ruleFromAnswer('Sure:\n```json\n' + JSON.stringify(gateRule('intake', 'approve', 'A')) + '\n```')).toEqual(gateRule('intake', 'approve', 'A'));
    expect(ruleFromAnswer('I cannot')).toBeUndefined();
    expect(ruleFromAnswer('{"action":"launch"}')).toBeUndefined();
  });

  /**
   * The stub engine (ASK-C4): `launchRun` takes the one-step path and, unless the seat stays silent,
   * plays the run's frames — the step's capture, then the terminal frame — with the step's stored
   * output behind `workOutput(<run>:parse-1)`. `early` plays them BEFORE `launchRun` resolves.
   */
  function fakeAdapter(reply: string | null, ok = true, early = false) {
    let listener: ((e: CoreEvent) => void) | null = null;
    const calls: string[] = [];
    const launches: Array<Record<string, unknown>> = [];
    const outputs = new Map<string, string>();
    const adapter = {
      projectsSupported: () => true,
      projectList: async () => [{ id: 'p-a', name: 'Project A' }],
      onEvent: (fn: (e: CoreEvent) => void) => {
        listener = fn;
        return () => {
          listener = null;
        };
      },
      launchRun: async (input: Record<string, unknown>) => {
        launches.push(input);
        const plan = input['plan'] as { steps: Array<{ instructions: string }> };
        calls.push(`launch ${String(input['primary'])} ${plan.steps[0]!.instructions.includes('p-a: Project A') ? 'with-projects' : 'no-projects'}`);
        // The run id IS the launch's session id (the engine's contract).
        const runId = String(input['sessionId']);
        if (reply !== null) {
          outputs.set(`${runId}:parse-1`, reply);
          const play = () => {
            // Another run's end in between is not this parse's.
            listener?.({ type: 'sessionCompleted', session: 'someone-else' } as unknown as CoreEvent);
            listener?.({ type: 'unitOutputCaptured', session: runId, ord: 0, attempt: 0, stepStatus: ok ? 'ok' : 'failed' } as unknown as CoreEvent);
            listener?.({ type: ok ? 'sessionCompleted' : 'sessionFailed', session: runId } as unknown as CoreEvent);
          };
          if (early) play();
          else setTimeout(play, 5);
        }
        return runId;
      },
      workOutput: async (unitId: string) => outputs.get(unitId) ?? null,
      cancelRun: async (runId: string) => {
        calls.push(`cancel ${runId}`);
        return '{}';
      },
    } as unknown as CoreAdapter;
    return { adapter, calls, launches };
  }
  const roster = (): RosterSeat[] =>
    [
      { key: 'codex', chat_admission: { unscoped: { ok: false, reason: 'signed out' } } },
      { key: 'claude', chat_admission: { unscoped: { ok: true } } },
    ] as unknown as RosterSeat[];

  it('one seat, one step: a one-step path with primary = the chosen seat and no reviewer, never the chat pool', async () => {
    const { adapter, calls, launches } = fakeAdapter(JSON.stringify(gateRule('intake', 'approve', 'p-a')));
    const out = await seatParser({ adapter, roster })('auto-approve intake on project A');
    expect(out).toEqual({ ok: true, rule: gateRule('intake', 'approve', 'p-a'), seat: 'claude' });
    expect(calls).toEqual(['launch claude with-projects']);
    expect(launches[0]).toMatchObject({
      primary: 'claude',
      plan: { steps: [{ catalog: 'understand', id: 'parse-1' }], monitors: { asked: 0 } },
    });
    expect(JSON.parse(String(launches[0]!['clisJson']))).toEqual([{ key: 'claude', chat_admission: { unscoped: { ok: true } } }]);
    expect(launches[0]).not.toHaveProperty('repoRef');
    expect(launches[0]).not.toHaveProperty('deliver');
    expect(adapter).not.toHaveProperty('chatOpen');
    expect(adapter).not.toHaveProperty('chatSend');
  });

  it('a run that ends before launchRun resolves is still read (frames are kept from before the launch)', async () => {
    const { adapter } = fakeAdapter(JSON.stringify(gateRule('intake', 'approve', 'p-a')), true, true);
    expect(await seatParser({ adapter, roster })('x')).toMatchObject({ ok: true, seat: 'claude' });
  });

  it('an answer with no rule is a 422 carrying the answer; silence is a 502 and the path is cancelled; no seat is a 409', async () => {
    expect(await seatParser({ adapter: fakeAdapter('no idea').adapter, roster })('x')).toMatchObject({ ok: false, code: 422, answer: 'no idea' });
    const silent = fakeAdapter(null);
    expect(await seatParser({ adapter: silent.adapter, roster, timeoutMs: 30 })('x')).toMatchObject({ ok: false, code: 502, error: 'the claude seat did not answer in 0.03 s' });
    expect(silent.calls).toEqual(['launch claude with-projects', `cancel ${String(silent.launches[0]!['sessionId'])}`]);
    expect(await seatParser({ adapter: silent.adapter, roster: () => [] })('x')).toMatchObject({ ok: false, code: 409 });
  });

  it('a path that will not launch is a 502 that leaves no reply timer armed (codex on #686)', async () => {
    const { adapter } = fakeAdapter(null);
    (adapter as unknown as { launchRun: unknown }).launchRun = async () => {
      throw new Error('signed out');
    };
    vi.useFakeTimers();
    try {
      expect(await seatParser({ adapter, roster })('x')).toMatchObject({ ok: false, code: 502, error: 'the claude seat could not open: signed out' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a launch that hangs is the same timeout 502, and the run it finally names is cancelled (codex on ASK-C4)', async () => {
    const { adapter, calls } = fakeAdapter(null);
    let release: (id: string) => void = () => undefined;
    let sessionId = '';
    (adapter as unknown as { launchRun: unknown }).launchRun = (input: Record<string, unknown>) => {
      sessionId = String(input['sessionId']);
      return new Promise<string>((r) => { release = r; });
    };
    expect(await seatParser({ adapter, roster, timeoutMs: 30 })('x')).toMatchObject({ ok: false, code: 502, error: 'the claude seat did not answer in 0.03 s' });
    // The run the hung launch may already have started is cancelled under its session id …
    expect(calls).toEqual([`cancel ${sessionId}`]);
    release(sessionId);
    await new Promise((r) => setTimeout(r, 5));
    // … and again once the launch names it (a no-op on an engine that already cancelled it).
    expect(calls).toEqual([`cancel ${sessionId}`, `cancel ${sessionId}`]);
  });

  it('another run\'s terminal frame is never this parse\'s', async () => {
    const { adapter } = fakeAdapter(null);
    let listener: ((e: CoreEvent) => void) | null = null;
    (adapter as unknown as { onEvent: unknown }).onEvent = (fn: (e: CoreEvent) => void) => { listener = fn; return () => { listener = null; }; };
    (adapter as unknown as { launchRun: unknown }).launchRun = async (input: Record<string, unknown>) => {
      listener?.({ type: 'sessionCompleted', session: 'someone-else' } as unknown as CoreEvent);
      return String(input['sessionId']);
    };
    expect(await seatParser({ adapter, roster, timeoutMs: 30 })('x')).toMatchObject({ ok: false, code: 502, error: 'the claude seat did not answer in 0.03 s' });
  });

  it('a project list that fails is a 502 from the parse, not a thrown 500 (codex on #686)', async () => {
    const { adapter, calls } = fakeAdapter(null);
    (adapter as unknown as { projectList: unknown }).projectList = async () => {
      throw new Error('engine gone');
    };
    expect(await seatParser({ adapter, roster })('x')).toMatchObject({ ok: false, code: 502, error: 'engine gone' });
    expect(calls).toEqual([]);
  });

  it('a FAILED step is a failure even when its text holds a rule-shaped object (codex on #686)', async () => {
    const failed = fakeAdapter(JSON.stringify(gateRule('intake', 'approve')), false);
    expect(await seatParser({ adapter: failed.adapter, roster })('x')).toMatchObject({ ok: false, code: 502, error: "the claude seat's turn failed" });
    // The run ended on its own: nothing to cancel.
    expect(failed.calls).toEqual(['launch claude with-projects']);
  });
});

describe('openPlanGateRisk — the open plan gate\'s own band, off its gate.opened row (idea 13)', () => {
  const row = (event_id: number, event_type: string, payload: Record<string, unknown>): TeamRow =>
    ({ event_id, event_type, payload: { run_id: 'r1', ord: null, ...payload }, emitted_at: event_id }) as unknown as TeamRow;

  it('reads the newest undecided plan_approval gate', () => {
    const rows = [
      row(1, 'wicked.team.gate.opened', { kind: 'plan_approval', gate_id: 'g1', band: '40-69', high_risk: true }),
      row(2, 'wicked.team.gate.decided', { gate_id: 'g1', decision: 'human_approved' }),
      row(3, 'wicked.team.gate.opened', { kind: 'unit_review', gate_id: 'u1', band: '0-19' }),
      row(4, 'wicked.team.gate.opened', { kind: 'plan_approval', gate_id: 'g2', band: '0-19', high_risk: false }),
    ];
    expect(openPlanGateRisk(rows)).toEqual({ band: '0-19', highRisk: false });
  });

  it('no open plan gate, or one without a band, reads as unknown (the order fails closed)', () => {
    expect(openPlanGateRisk([])).toBeUndefined();
    expect(openPlanGateRisk([
      row(1, 'wicked.team.gate.opened', { kind: 'plan_approval', gate_id: 'g1', band: '0-19' }),
      row(2, 'wicked.team.gate.decided', { gate_id: 'g1' }),
    ])).toBeUndefined();
    expect(openPlanGateRisk([row(1, 'wicked.team.gate.opened', { kind: 'plan_approval', gate_id: 'g1', high_risk: false })])).toBeUndefined();
    // A row that does not say its risk is not "low risk" (codex on #693).
    expect(openPlanGateRisk([row(1, 'wicked.team.gate.opened', { kind: 'plan_approval', gate_id: 'g1', band: '0-19' })])).toBeUndefined();
  });
});
