// DES-ASK-TEAM-CHAT-001 §5.2 / §9 (ASK-C2) — the ask relay over fakes: the answer unit's deltas
// become chatDelta frames with control lines stripped; the chatReply text is the record the
// `step.completed` row's output_ref names, read at the fold (`unitDone`); exactly one reply per
// answer unit whatever the order of row and fold; nothing for a non-answer unit.
import { describe, expect, it } from 'vitest';

import { AskPathIndex } from '../src/api/ask-paths.js';
import { AskRelay, answerStepOf, ordOfOutputRef, stripControlLines, type RelayUnit } from '../src/api/ask-relay.js';
import { ChatTurnIndex } from '../src/api/chat-turns.js';
import type { BusEvent } from '../src/core/bus.js';
import type { CoreEvent } from '../src/core/types.js';

const row = (type: string, payload: Record<string, unknown>): BusEvent =>
  ({ event_id: 1, event_type: type, domain: 'team', subdomain: 'x', payload, idempotency_key: 'k', emitted_at: 1 }) as BusEvent;

function harness(opts: { pa?: string; output?: string | null; units?: RelayUnit[] } = {}) {
  const paths = new AskPathIndex();
  const turns = new ChatTurnIndex();
  paths.open('c1', ['claude', 'codex'], opts.pa);
  const turn = turns.begin('c1', opts.pa !== undefined ? [opts.pa] : ['claude', 'codex'], 'Q1')!;
  paths.started('c1', 1, 'run-1', 'answer-1');
  const units: RelayUnit[] = opts.units ?? [
    { id: 'run-1:answer-1', ord: 1, status: 'done', assigned_cli: 'codex' },
    { id: 'run-1:review-1', ord: 2, status: 'done', assigned_cli: 'claude' },
  ];
  const emitted: Array<CoreEvent & Record<string, unknown>> = [];
  const outputs: string[] = [];
  const relay = new AskRelay({
    paths,
    turns,
    units: async () => units,
    workOutput: async (unitId) => {
      outputs.push(unitId);
      return opts.output === undefined ? 'The answer.\nHELP: who owns billing?\nSecond line.' : opts.output;
    },
    fold: (f) => emitted.push(f as CoreEvent & Record<string, unknown>),
  });
  return { paths, turns, turn, relay, emitted, outputs };
}

describe('the grammar helpers', () => {
  it('strips the control lines of the team grammar and keeps prose', () => {
    expect(stripControlLines('Answer.\nHELP: a question\nPLAN+ {"steps":[]}\nPLAN build-1: ok\nADVICE f-1: accepted\nSTEP review-1: ok\nSCOPE narrow\nRISK low\nDONE\nMore.')).toBe('Answer.\nMore.');
    expect(stripControlLines('  HELP: indented\nkept')).toBe('kept');
    expect(stripControlLines('HELPFUL: not a control line\nRISKY: nor this')).toBe('HELPFUL: not a control line\nRISKY: nor this');
  });
  it('reads the ord out of unit:<run>:<ord>:<attempt> and the answer step out of <run>:answer-N', () => {
    expect(ordOfOutputRef('unit:run-1:3:1')).toBe(3);
    expect(ordOfOutputRef('unit:run:with:colons:7:2')).toBe(7);
    expect(ordOfOutputRef('tree:abc')).toBeNull();
    expect(answerStepOf('run-1', 'run-1:answer-2')).toBe('answer-2');
    expect(answerStepOf('run-1', 'run-1:review-1')).toBeNull();
    expect(answerStepOf('run-1', 'run-2:answer-1')).toBeNull();
  });
});

describe('AskRelay — deltas', () => {
  it('folds the answer unit\'s unitOutputDelta into chatDelta{chat, cliKey:<PA>} with control lines stripped across chunk boundaries; a non-answer unit emits nothing', async () => {
    const h = harness({ pa: 'codex' });
    await h.relay.onCoreEvent({ type: 'unitOutputDelta', session: 'run-1', ord: 1, attempt: 1, text: 'Hello\nHE' } as CoreEvent);
    await h.relay.onCoreEvent({ type: 'unitOutputDelta', session: 'run-1', ord: 1, attempt: 1, text: 'LP: who?\nworld\npartial' } as CoreEvent);
    await h.relay.onCoreEvent({ type: 'unitOutputDelta', session: 'run-1', ord: 2, attempt: 1, text: 'reviewer typing\n' } as CoreEvent);
    expect(h.emitted.map((f) => [f.type, f['chat'], f['cliKey'], f['text']])).toEqual([
      ['chatDelta', 'c1', 'codex', 'Hello\n'],
      ['chatDelta', 'c1', 'codex', 'world\n'],
    ]);
  });
  it('a run this daemon holds no path for is ignored', async () => {
    const h = harness({ pa: 'codex' });
    await h.relay.onCoreEvent({ type: 'unitOutputDelta', session: 'run-9', ord: 1, attempt: 1, text: 'x\n' } as CoreEvent);
    expect(h.emitted).toEqual([]);
  });
});

describe('AskRelay — the reply', () => {
  const completed = (status = 'ok') => row('wicked.team.step.completed', { run_id: 'run-1', step_id: 'answer-1', status, tree: null, output_bytes: 10, output_ref: 'unit:run-1:1:1' });

  it('row then unitDone → exactly ONE chatReply whose text is the record (control lines stripped), ok:true, run_id + ord; the deltas that disagreed are overwritten by it', async () => {
    const h = harness({ pa: 'codex' });
    await h.relay.onCoreEvent({ type: 'unitOutputDelta', session: 'run-1', ord: 1, attempt: 1, text: 'a different text\n' } as CoreEvent);
    h.relay.onTeamRow(completed());
    expect(h.emitted.filter((f) => f.type === 'chatReply'), 'no reply at the row').toEqual([]);
    await h.relay.onCoreEvent({ type: 'unitDone', session: 'run-1', ord: 1 } as CoreEvent);
    await h.relay.onCoreEvent({ type: 'unitDone', session: 'run-1', ord: 1 } as CoreEvent); // a second fold frame: still one reply
    const replies = h.emitted.filter((f) => f.type === 'chatReply');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ type: 'chatReply', chat: 'c1', cliKey: 'codex', text: 'The answer.\nSecond line.', ok: true, run_id: 'run-1', ord: 1 });
    expect(h.outputs, 'read through work_output by the unit id').toEqual(['run-1:answer-1']);
  });

  it('unitDone BEFORE the row (the bus poll is late) → the reply lands when the row does; a row with no unitDone → no reply and no error', async () => {
    const h = harness({ pa: 'codex' });
    await h.relay.onCoreEvent({ type: 'unitDone', session: 'run-1', ord: 1 } as CoreEvent);
    expect(h.emitted).toEqual([]);
    h.relay.onTeamRow(completed());
    await new Promise((r) => setTimeout(r, 5));
    expect(h.emitted.filter((f) => f.type === 'chatReply')).toHaveLength(1);
    // Another answer step whose row landed but whose fold has not: nothing yet.
    h.relay.onTeamRow(row('wicked.team.step.completed', { run_id: 'run-1', step_id: 'answer-2', status: 'ok', tree: null, output_bytes: 1, output_ref: 'unit:run-1:3:1' }));
    await new Promise((r) => setTimeout(r, 5));
    expect(h.emitted.filter((f) => f.type === 'chatReply')).toHaveLength(1);
  });

  it('a failed step is ok:false with the record\'s text; a step with NO record is ok:false and says so', async () => {
    const failed = harness({ pa: 'codex' });
    failed.relay.onTeamRow(completed('timed_out'));
    await failed.relay.onCoreEvent({ type: 'unitDone', session: 'run-1', ord: 1 } as CoreEvent);
    expect(failed.emitted.find((f) => f.type === 'chatReply')).toMatchObject({ ok: false, text: 'The answer.\nSecond line.' });
    const none = harness({ pa: 'codex', output: null });
    none.relay.onTeamRow(completed('failed'));
    await none.relay.onCoreEvent({ type: 'unitDone', session: 'run-1', ord: 1 } as CoreEvent);
    expect(none.emitted.find((f) => f.type === 'chatReply')).toMatchObject({ ok: false, text: expect.stringMatching(/codex did not answer \(failed\)/) });
  });

  it('a RANDOM pick: the turn was reserved for the eligible roster; path.started names the PA → the path records it and the turn narrows to that voice, so the reply is stamped for it', async () => {
    const h = harness(); // no primary: pa null, turn reserved for [claude, codex]
    expect(h.paths.view('c1')).toMatchObject({ pa: null, selection: 'random' });
    h.relay.onTeamRow(row('wicked.team.path.started', { run_id: 'run-1', cli: 'codex', selection: 'random', roster: ['claude', 'codex'], request: 'Q1', workflow: null, plan: true }));
    expect(h.paths.view('c1')).toMatchObject({ pa: 'codex', selection: 'random' });
    expect(h.turns.turnsOf('c1')[0]!.pending).toEqual(['codex']);
    h.relay.onTeamRow(row('wicked.team.member.joined', { run_id: 'run-1', member_id: 'm1', open_seq: 1, seat: 'claude', role: 'monitor', status: 'attached', reason: 'r', error: null }));
    expect(h.paths.view('c1')).toMatchObject({ reviewer: 'claude' });
    h.relay.onTeamRow(completed());
    await h.relay.onCoreEvent({ type: 'unitDone', session: 'run-1', ord: 1 } as CoreEvent);
    const reply = h.emitted.find((f) => f.type === 'chatReply')!;
    expect(reply['cliKey']).toBe('codex');
    const stamped = h.turns.decorate(reply as CoreEvent) as CoreEvent & Record<string, unknown>;
    expect(stamped['turn_id'], 'the fold stamps the PA\'s reply with the message\'s turn').toBe(h.turn.turnId);
  });

  it('path.repicked moves the voice; the unit\'s assigned seat is authoritative when the rows are late', async () => {
    const h = harness({ pa: 'claude', units: [{ id: 'run-1:answer-1', ord: 1, status: 'done', assigned_cli: 'codex' }] });
    h.relay.onTeamRow(row('wicked.team.path.repicked', { run_id: 'run-1', from: 'claude', to: 'codex', reason: 'benched', selection: 'random', pick_seq: 1 }));
    expect(h.paths.view('c1')).toMatchObject({ pa: 'codex', selection: 'random' });
    const late = harness({ pa: 'claude', units: [{ id: 'run-1:answer-1', ord: 1, status: 'done', assigned_cli: 'codex' }] });
    await late.relay.onCoreEvent({ type: 'unitOutputDelta', session: 'run-1', ord: 1, attempt: 1, text: 'typing\n' } as CoreEvent);
    expect(late.emitted[0]).toMatchObject({ type: 'chatDelta', cliKey: 'codex' });
    expect(late.paths.view('c1')).toMatchObject({ pa: 'codex' });
  });
});
