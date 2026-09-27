// Standing orders (Studio OS behaviour 10) — the store, the evaluator, the routes and the seat parse,
// each over fakes. The end-to-end proof over createServer is standing-orders-journey.test.ts.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, RosterSeat } from '../src/core/types.js';
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
});

function harness(runs: Record<string, { projectId?: string; phases: string[]; steering?: boolean }>, decideCode = 200) {
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
        : { projectId: r.projectId, problem: `problem ${runId}`, phaseOf: (ord) => r.phases[ord], firstOrd: 0, landsDoctrine: r.steering === true };
    },
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
      runFacts: async () => ({ projectId: 'A', problem: 'problem r1', phaseOf: () => 'intake', firstOrd: 0, landsDoctrine: false }),
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

  function fakeAdapter(reply: string | null, ok = true) {
    let listener: ((e: CoreEvent) => void) | null = null;
    const calls: string[] = [];
    const adapter = {
      projectsSupported: () => true,
      projectList: async () => [{ id: 'p-a', name: 'Project A' }],
      onEvent: (fn: (e: CoreEvent) => void) => {
        listener = fn;
        return () => {
          listener = null;
        };
      },
      chatOpen: async (id: string, clis: string[]) => {
        calls.push(`open ${clis.join(',')}`);
        return [{ cliKey: clis[0]!, ok: true }];
      },
      chatSend: async (id: string, text: string) => {
        calls.push(`send ${text.includes('p-a: Project A') ? 'with-projects' : 'no-projects'}`);
        if (reply !== null) setTimeout(() => listener?.({ type: 'chatReply', chat: id, cliKey: 'claude', text: reply, ok } as unknown as CoreEvent), 5);
        return ['claude'];
      },
      chatClose: async () => {
        calls.push('close');
      },
    } as unknown as CoreAdapter;
    return { adapter, calls };
  }
  const roster = (): RosterSeat[] =>
    [
      { key: 'codex', chat_admission: { unscoped: { ok: false, reason: 'signed out' } } },
      { key: 'claude', chat_admission: { unscoped: { ok: true } } },
    ] as unknown as RosterSeat[];

  it('one seat, one turn, the chat closed after', async () => {
    const { adapter, calls } = fakeAdapter(JSON.stringify(gateRule('intake', 'approve', 'p-a')));
    const out = await seatParser({ adapter, roster })('auto-approve intake on project A');
    expect(out).toEqual({ ok: true, rule: gateRule('intake', 'approve', 'p-a'), seat: 'claude' });
    expect(calls).toEqual(['open claude', 'send with-projects', 'close']);
  });

  it('an answer with no rule is a 422 carrying the answer; silence is a 502; no seat is a 409', async () => {
    expect(await seatParser({ adapter: fakeAdapter('no idea').adapter, roster })('x')).toMatchObject({ ok: false, code: 422, answer: 'no idea' });
    const silent = fakeAdapter(null);
    expect(await seatParser({ adapter: silent.adapter, roster, timeoutMs: 30 })('x')).toMatchObject({ ok: false, code: 502 });
    expect(silent.calls).toContain('close');
    expect(await seatParser({ adapter: silent.adapter, roster: () => [] })('x')).toMatchObject({ ok: false, code: 409 });
  });

  it('a seat that will not open is a 502 that leaves no reply timer armed (codex on #686)', async () => {
    const { adapter } = fakeAdapter(null);
    (adapter as unknown as { chatOpen: unknown }).chatOpen = async (_id: string, clis: string[]) => [{ cliKey: clis[0]!, ok: false, error: 'signed out' }];
    vi.useFakeTimers();
    try {
      expect(await seatParser({ adapter, roster })('x')).toMatchObject({ ok: false, code: 502 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a project list that fails is a 502 from the parse, not a thrown 500 (codex on #686)', async () => {
    const { adapter } = fakeAdapter(null);
    (adapter as unknown as { projectList: unknown }).projectList = async () => {
      throw new Error('engine gone');
    };
    expect(await seatParser({ adapter, roster })('x')).toMatchObject({ ok: false, code: 502, error: 'engine gone' });
  });

  it('a FAILED turn is a failure even when its text holds a rule-shaped object (codex on #686)', async () => {
    const failed = fakeAdapter(JSON.stringify(gateRule('intake', 'approve')), false);
    expect(await seatParser({ adapter: failed.adapter, roster })('x')).toMatchObject({ ok: false, code: 502 });
  });
});
