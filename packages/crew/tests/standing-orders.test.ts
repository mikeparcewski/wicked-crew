// Standing orders (Studio OS behaviour 10) — the store, the evaluator, the routes and the seat parse,
// each over fakes. The end-to-end proof over createServer is standing-orders-journey.test.ts.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';

import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, RosterSeat } from '../src/core/types.js';
import { StandingOrderEvaluator, type GateFact, type RunFacts } from '../src/standing-orders/evaluator.js';
import { seatParser } from '../src/standing-orders/parse.js';
import { registerStandingOrderRoutes, ruleFromAnswer, type ParseOutcome } from '../src/standing-orders/routes.js';
import { refusal, StandingOrderStore, type StandingOrderRule } from '../src/standing-orders/store.js';
import { removeScratch } from './setup/scratch.js';

const scratch = mkdtempSync(join(tmpdir(), 'crew-so-unit-'));
afterAll(() => removeScratch(scratch));

const gateRule = (phase: string, action: StandingOrderRule['action'], projectId?: string, activeWhen: 'away' | 'always' = 'away'): StandingOrderRule => ({
  scope: projectId === undefined ? { kind: 'all' } : { kind: 'project', projectId },
  trigger: { kind: 'gate', phase },
  action,
  activeWhen,
});

describe('StandingOrderStore', () => {
  it('round-trips the flag, orders and outbox through its file', () => {
    const path = join(scratch, 'rt.json');
    const a = new StandingOrderStore(path);
    const o = a.add('approve intake on A', gateRule('intake', 'approve', 'A'), 10);
    a.setAway(true, 20);
    a.queue({ orderId: o.id, orderText: o.text, runId: 'r1', text: 'hello', at: 30 });
    const b = new StandingOrderStore(path);
    const s = b.snapshot();
    expect(s.away).toBe(true);
    expect(s.awaySince).toBe(20);
    expect(s.orders).toEqual([{ id: o.id, text: 'approve intake on A', rule: gateRule('intake', 'approve', 'A'), createdAt: 10 }]);
    expect(s.outbox).toMatchObject([{ orderId: o.id, runId: 'r1', text: 'hello', status: 'queued' }]);
    expect(b.remove(o.id)).toBe(true);
    expect(b.remove(o.id)).toBe(false);
    expect(new StandingOrderStore(path).orders()).toEqual([]);
  });

  it('an unreadable file is said and read as empty, never guessed at', () => {
    const path = join(scratch, 'torn.json');
    writeFileSync(path, '{"away": tru', 'utf8');
    const warned: string[] = [];
    const s = new StandingOrderStore(path, (m) => warned.push(m));
    expect(s.snapshot()).toEqual({ away: false, awaySince: null, orders: [], outbox: [] });
    expect(warned[0]).toMatch(/cannot read/);
  });

  it('drops a stored order whose rule no longer validates', () => {
    const path = join(scratch, 'bad-rule.json');
    writeFileSync(path, JSON.stringify({ away: false, orders: [{ id: 'x', text: 't', rule: { action: 'launch' } }], outbox: [] }));
    expect(new StandingOrderStore(path).orders()).toEqual([]);
  });

  it('the invariant: approve never names deliver, a plan approval or a finding', () => {
    expect(refusal(gateRule('deliver', 'approve'))).toMatch(/deliver gate/);
    expect(refusal(gateRule('plan_approval', 'approve'))).toMatch(/plan_approval/);
    expect(refusal({ scope: { kind: 'all' }, trigger: { kind: 'finding', severity: 'high' }, action: 'approve', activeWhen: 'away' })).toMatch(/finding/);
    expect(refusal(gateRule('deliver', 'hold'))).toBeNull();
    expect(refusal(gateRule('intake', 'approve'))).toBeNull();
  });
});

function harness(runs: Record<string, { projectId?: string; phases: string[] }>, decideCode = 200) {
  const store = StandingOrderStore.memory();
  const decided: Array<{ id: string; decision: unknown; actor: { id: string; kind: string }; extra?: Record<string, unknown> }> = [];
  const audited: Array<{ action: string; actor: { id: string }; runId?: string; detail?: Record<string, unknown> }> = [];
  let open: GateFact[] = [];
  const logs: string[] = [];
  const evaluator = new StandingOrderEvaluator({
    store,
    decideGate: async (id, decision, actor, extra) => {
      decided.push({ id, decision, actor, ...(extra !== undefined ? { extra } : {}) });
      return decideCode === 200 ? { code: 200, body: { status: 'executing' } } : { code: decideCode, body: { code: 'gate_changed' } };
    },
    audit: {
      record: (action, actor, fields) => {
        audited.push({ action, actor, ...(fields?.runId !== undefined ? { runId: fields.runId } : {}), ...(fields?.detail !== undefined ? { detail: fields.detail } : {}) });
        return Date.now();
      },
    },
    runFacts: async (runId): Promise<RunFacts | undefined> => {
      const r = runs[runId];
      return r === undefined ? undefined : { projectId: r.projectId, problem: `problem ${runId}`, phaseOf: (ord) => r.phases[ord] };
    },
    openGates: async () => open,
    log: (m) => logs.push(m),
  });
  return { store, evaluator, decided, audited, logs, setOpen: (g: GateFact[]) => (open = g) };
}

const gate = (runId: string, ord: number, gateKind = 'def', reviewingOrd: number | null = ord - 1): CoreEvent =>
  ({ type: 'awaitingHuman', session: runId, ord, reviewingOrd, prompt: 'go?', gateKind }) as CoreEvent;

describe('StandingOrderEvaluator', () => {
  it('an away order is dormant while present and acts once away', async () => {
    const h = harness({ r1: { projectId: 'A', phases: ['intake', 'design'] } });
    const o = h.store.add('approve intake on A', gateRule('intake', 'approve', 'A'));
    await h.evaluator.onEvent(gate('r1', 1));
    expect(h.decided).toEqual([]);
    h.store.setAway(true);
    await h.evaluator.onEvent(gate('r1', 1));
    expect(h.decided).toEqual([
      { id: 'r1', decision: { approve: true, ord: 1 }, actor: { id: `standing-order:${o.id}`, kind: 'system', trust: 'operator' }, extra: { standingOrder: { id: o.id, text: o.text } } },
    ]);
  });

  it('an `always` order acts while present', async () => {
    const h = harness({ r1: { projectId: 'A', phases: ['intake', 'design'] } });
    h.store.add('always approve intake', gateRule('intake', 'approve', undefined, 'always'));
    await h.evaluator.onEvent(gate('r1', 1));
    expect(h.decided).toHaveLength(1);
  });

  it('scope and phase must both match; a run_level gate reads the upcoming unit\'s phase', async () => {
    const h = harness({ a: { projectId: 'A', phases: ['intake', 'design'] }, b: { projectId: 'B', phases: ['intake', 'design'] } });
    h.store.setAway(true);
    h.store.add('approve design on A', gateRule('design', 'approve', 'A'));
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
      h.store.setAway(true);
      h.store.add('approve anything', gateRule('*', 'approve'));
      await h.evaluator.onEvent(gate('r1', 1, kind));
      expect(h.decided).toEqual([]);
    },
  );

  it('hold wins over approve and is recorded once, naming the order', async () => {
    const h = harness({ r1: { projectId: 'A', phases: ['intake', 'design'] } });
    h.store.setAway(true);
    h.store.add('approve everything', gateRule('*', 'approve'));
    const hold = h.store.add('hold intake on A', gateRule('intake', 'hold', 'A'));
    await h.evaluator.onEvent(gate('r1', 1));
    await h.evaluator.onEvent(gate('r1', 1)); // the same gate again (a replayed frame)
    expect(h.decided).toEqual([]);
    expect(h.audited).toEqual([
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
    h.store.setAway(true);
    const n = h.store.add('tell me about intake gates', gateRule('intake', 'notify'));
    await h.evaluator.onEvent(gate('r1', 1));
    const outbox = h.store.snapshot().outbox;
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ orderId: n.id, runId: 'r1', status: 'queued' });
    expect(outbox[0]!.text).toMatch(/intake gate is waiting/);
    expect(h.audited[0]).toMatchObject({ action: 'standing-order.notified', runId: 'r1', detail: { queued: true, messageId: outbox[0]!.id } });
    expect(h.decided).toEqual([]);
  });

  it('a HIGH finding wakes you through the queue; a medium one does not match a high order', async () => {
    const h = harness({ r1: { projectId: 'A', phases: ['build'] } });
    h.store.setAway(true);
    h.store.add('wake me for any HIGH', { scope: { kind: 'all' }, trigger: { kind: 'finding', severity: 'high' }, action: 'notify', activeWhen: 'away' });
    const row = (severity: string, id: string) =>
      ({ type: 'teamEvent', event: { event_type: 'wicked.team.finding.raised', payload: { run_id: 'r1', finding_id: id, severity, claim: 'null deref' } } }) as unknown as CoreEvent;
    await h.evaluator.onTeamFrame(row('medium', 'f1'));
    await h.evaluator.onTeamFrame(row('high', 'f2'));
    await h.evaluator.onTeamFrame(row('high', 'f2'));
    expect(h.store.snapshot().outbox.map((m) => m.text)).toEqual(['HIGH finding on problem r1: null deref']);
  });

  it('a refusal from the gate path (409: a person got there first) is logged, not retried', async () => {
    const h = harness({ r1: { projectId: 'A', phases: ['intake', 'design'] } }, 409);
    h.store.setAway(true);
    h.store.add('approve intake', gateRule('intake', 'approve'));
    await h.evaluator.onEvent(gate('r1', 1));
    await h.evaluator.onEvent(gate('r1', 1));
    expect(h.decided).toHaveLength(1);
    expect(h.logs[0]).toMatch(/did not answer the gate before unit 1 on r1: 409/);
  });

  it('a sweep answers a gate that was already open', async () => {
    const h = harness({ r1: { projectId: 'A', phases: ['intake', 'design'] } });
    h.store.setAway(true);
    h.store.add('approve intake', gateRule('intake', 'approve'));
    h.setOpen([{ runId: 'r1', ord: 1, reviewingOrd: 0, gateKind: 'def', prompt: 'go?' }]);
    await h.evaluator.sweep();
    expect(h.decided.map((d) => d.decision)).toEqual([{ approve: true, ord: 1 }]);
  });
});

describe('standing-order routes', () => {
  async function app(parse: (t: string) => Promise<ParseOutcome> = async () => ({ ok: false, code: 409, error: 'no seat' })) {
    const h = harness({ r1: { projectId: 'A', phases: ['intake', 'design'] } });
    const a = Fastify({ logger: false });
    registerStandingOrderRoutes(a, { store: h.store, evaluator: h.evaluator, audit: { record: () => 0 }, parse });
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

  function fakeAdapter(reply: string | null) {
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
        if (reply !== null) setTimeout(() => listener?.({ type: 'chatReply', chat: id, cliKey: 'claude', text: reply, ok: true } as unknown as CoreEvent), 5);
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
});
