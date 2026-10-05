// DES-ASK-TEAM-CHAT-001 §5.2 / §9 (ASK-C2) — the ask relay over fakes: the answer unit's deltas
// become chatDelta frames with control lines stripped; the chatReply text is the record the
// `step.completed` row's output_ref names, read at the fold (`unitDone`); exactly one reply per
// answer unit whatever the order of row and fold; nothing for a non-answer unit.
import { describe, expect, it } from 'vitest';

import { AskPathIndex } from '../src/api/ask-paths.js';
import { AskRelay, answerStepOf, ordOfOutputRef, refOf, stripControlLines, type RelayUnit } from '../src/api/ask-relay.js';
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
  const reconciled: Array<[string, string, readonly string[]]> = [];
  let holdOutput: Promise<void> | null = null;
  const relay = new AskRelay({
    paths,
    turns,
    units: async () => units,
    workOutput: async (unitId) => {
      outputs.push(unitId);
      if (holdOutput !== null) await holdOutput;
      return opts.output === undefined ? 'The answer.\nHELP: who owns billing?\nSecond line.' : opts.output;
    },
    fold: (f) => emitted.push(f as CoreEvent & Record<string, unknown>),
    recorderReconcile: (chat, turnId, seats) => reconciled.push([chat, turnId, seats]),
    rowGraceMs: 60,
  });
  return { paths, turns, turn, relay, emitted, outputs, units, reconciled, holdOutput: (p: Promise<void> | null) => { holdOutput = p; } };
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
    expect(refOf('unit:run-1:3:2')).toEqual({ ord: 3, attempt: 2 });
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
    expect(h.reconciled, 'the decision recorder\'s audience follows').toEqual([['c1', h.turn.turnId, ['codex']]]);
    h.relay.onTeamRow(row('wicked.team.member.joined', { run_id: 'run-1', member_id: 'm1', open_seq: 1, seat: 'claude', role: 'monitor', status: 'attached', reason: 'r', error: null }));
    expect(h.paths.view('c1')).toMatchObject({ reviewer: 'claude' });
    h.relay.onTeamRow(completed());
    await h.relay.onCoreEvent({ type: 'unitDone', session: 'run-1', ord: 1 } as CoreEvent);
    const reply = h.emitted.find((f) => f.type === 'chatReply')!;
    expect(reply['cliKey']).toBe('codex');
    const stamped = h.turns.decorate(reply as CoreEvent) as CoreEvent & Record<string, unknown>;
    expect(stamped['turn_id'], 'the fold stamps the PA\'s reply with the message\'s turn').toBe(h.turn.turnId);
  });

  it('codex on #810 r1 (1): a re-pick re-dispatches the SAME ord on another seat — the cached unit is dropped and the path row is authoritative, so the retry\'s frames carry the new PA', async () => {
    const unit: RelayUnit = { id: 'run-1:answer-1', ord: 1, status: 'distributed', assigned_cli: 'claude' };
    const h = harness({ pa: 'claude', units: [unit] });
    await h.relay.onCoreEvent({ type: 'unitOutputDelta', session: 'run-1', ord: 1, attempt: 1, text: 'first try\n' } as CoreEvent);
    expect(h.emitted[0]).toMatchObject({ type: 'chatDelta', cliKey: 'claude' });
    // The engine re-picks: the run view now shows the unit on another seat (a NEW record — the
    // relay's cached copy is the stale one), attempt 2 is dispatched.
    h.units[0] = { ...unit, assigned_cli: 'codex' };
    h.relay.onTeamRow(row('wicked.team.path.repicked', { run_id: 'run-1', from: 'claude', to: 'codex', reason: 'timed_out', selection: 'random', pick_seq: 1 }));
    await h.relay.onCoreEvent({ type: 'unitDispatched', session: 'run-1', ord: 1, attempt: 2 } as CoreEvent);
    await h.relay.onCoreEvent({ type: 'unitOutputDelta', session: 'run-1', ord: 1, attempt: 2, text: 'second try\n' } as CoreEvent);
    expect(h.emitted[1]).toMatchObject({ type: 'chatDelta', cliKey: 'codex', text: 'second try\n' });
    expect(h.paths.view('c1')).toMatchObject({ pa: 'codex', selection: 'random' });
    expect(h.turns.turnsOf('c1')[0]!.pending).toEqual(['codex']);
  });

  it('the unit\'s assigned seat stands in while no team row has named the PA (a late bus poll)', async () => {
    const late = harness({ units: [{ id: 'run-1:answer-1', ord: 1, status: 'done', assigned_cli: 'codex' }] }); // random: pa null
    await late.relay.onCoreEvent({ type: 'unitOutputDelta', session: 'run-1', ord: 1, attempt: 1, text: 'typing\n' } as CoreEvent);
    expect(late.emitted[0]).toMatchObject({ type: 'chatDelta', cliKey: 'codex' });
    expect(late.paths.view('c1')).toMatchObject({ pa: 'codex' });
  });

  it('codex on #810 r1 (2): the join is by ATTEMPT — a failed attempt\'s row never decides the successful retry; the fold waits for the row of its own attempt', async () => {
    const h = harness({ pa: 'codex' });
    h.relay.onTeamRow(row('wicked.team.step.completed', { run_id: 'run-1', step_id: 'answer-1', status: 'timed_out', tree: null, output_bytes: 0, output_ref: 'unit:run-1:1:1' }));
    await h.relay.onCoreEvent({ type: 'unitDispatched', session: 'run-1', ord: 1, attempt: 2 } as CoreEvent);
    await h.relay.onCoreEvent({ type: 'unitOutputCaptured', session: 'run-1', ord: 1, attempt: 2, outputBytes: 10, stepStatus: 'ok', governed: true } as CoreEvent);
    await h.relay.onCoreEvent({ type: 'unitDone', session: 'run-1', ord: 1 } as CoreEvent);
    expect(h.emitted.filter((f) => f.type === 'chatReply'), 'the attempt-1 row does not answer attempt 2').toEqual([]);
    h.relay.onTeamRow(row('wicked.team.step.completed', { run_id: 'run-1', step_id: 'answer-1', status: 'ok', tree: null, output_bytes: 10, output_ref: 'unit:run-1:1:2' }));
    await new Promise((r) => setTimeout(r, 5));
    const replies = h.emitted.filter((f) => f.type === 'chatReply');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ ok: true, text: 'The answer.\nSecond line.' });
  });

  it('codex on #810 r1 (5): an UN-TEAMED run publishes no team row — past the grace the reply is read from the record, ok from the engine\'s own capture status', async () => {
    const h = harness({ pa: 'codex' });
    await h.relay.onCoreEvent({ type: 'unitOutputCaptured', session: 'run-1', ord: 1, attempt: 1, outputBytes: 10, stepStatus: 'ok', governed: false } as CoreEvent);
    await h.relay.onCoreEvent({ type: 'unitDone', session: 'run-1', ord: 1 } as CoreEvent);
    expect(h.emitted.filter((f) => f.type === 'chatReply')).toEqual([]);
    await new Promise((r) => setTimeout(r, 120));
    const replies = h.emitted.filter((f) => f.type === 'chatReply');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ ok: true, text: 'The answer.\nSecond line.', run_id: 'run-1', ord: 1 });
  });

  it('codex on #810 r1 (4): a reply whose record read is still in flight when the chat ENDS lands nowhere — the run is forgotten, nothing is folded', async () => {
    const h = harness({ pa: 'codex' });
    let release: () => void = () => undefined;
    h.holdOutput(new Promise<void>((r) => { release = r; }));
    h.relay.onTeamRow(completed());
    const fold = h.relay.onCoreEvent({ type: 'unitDone', session: 'run-1', ord: 1 } as CoreEvent);
    await new Promise((r) => setTimeout(r, 5));
    expect(h.outputs).toEqual(['run-1:answer-1']);
    h.paths.close('c1'); // End: the path (and chatOf(run-1)) is gone
    h.relay.forget('run-1');
    h.paths.open('c1', ['claude'], 'claude'); // the id reused
    release();
    await fold;
    expect(h.emitted.filter((f) => f.type === 'chatReply')).toEqual([]);
  });

  it('codex on #810 r1 (6) + r2 (1): a RUN-terminal frame with no fold (sessionFailed / runCancelled) ends the turn with ok:false — once; stepFailed / unitDenied alone do NOT (the engine fails over or escalates)', async () => {
    const h = harness({ pa: 'codex' });
    await h.relay.onCoreEvent({ type: 'stepFailed', session: 'run-1', ord: 1, attempt: 1, detail: 'timed out; failing over', failureKind: 'timeout' } as CoreEvent);
    await h.relay.onCoreEvent({ type: 'unitDenied', session: 'run-1', ord: 1 } as CoreEvent);
    expect(h.emitted.filter((f) => f.type === 'chatReply'), 'an attempt failure is not the answer\'s end').toEqual([]);
    await h.relay.onCoreEvent({ type: 'sessionFailed', session: 'run-1', ord: 1 } as CoreEvent);
    await h.relay.onCoreEvent({ type: 'runCancelled', session: 'run-1', tool_children_killed: 0 } as CoreEvent);
    const replies = h.emitted.filter((f) => f.type === 'chatReply');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ ok: false, cliKey: 'codex', text: expect.stringMatching(/did not answer: the run failed at this step/), run_id: 'run-1', ord: 1 });
    // A reviewer unit's failure is not the PA's reply.
    const other = harness({ pa: 'codex' });
    await other.relay.onCoreEvent({ type: 'unitDenied', session: 'run-1', ord: 2 } as CoreEvent);
    expect(other.emitted).toEqual([]);
    // A cancelled run answers every pending answer unit once.
    const cancelled = harness({ pa: 'codex' });
    await cancelled.relay.onCoreEvent({ type: 'runCancelled', session: 'run-1', tool_children_killed: 0 } as CoreEvent);
    expect(cancelled.emitted.filter((f) => f.type === 'chatReply').map((f) => [f['ord'], f['ok']])).toEqual([[1, false]]);
  });

  it('codex on #810 r2 (1): the F2 failover — capture timed_out → path.repicked → stepFailed(attempt 1, "failing over") → attempt 2 on the new seat → ONE reply, the retry\'s, ok:true', async () => {
    const unit: RelayUnit = { id: 'run-1:answer-1', ord: 1, status: 'distributed', assigned_cli: 'claude' };
    const h = harness({ pa: 'claude', units: [unit] });
    await h.relay.onCoreEvent({ type: 'unitDispatched', session: 'run-1', ord: 1, attempt: 1 } as CoreEvent);
    await h.relay.onCoreEvent({ type: 'unitOutputCaptured', session: 'run-1', ord: 1, attempt: 1, outputBytes: 0, stepStatus: 'timed_out', governed: true } as CoreEvent);
    h.relay.onTeamRow(row('wicked.team.step.completed', { run_id: 'run-1', step_id: 'answer-1', status: 'timed_out', tree: null, output_bytes: 0, output_ref: 'unit:run-1:1:1' }));
    h.units[0] = { ...unit, assigned_cli: 'codex' };
    h.relay.onTeamRow(row('wicked.team.path.repicked', { run_id: 'run-1', from: 'claude', to: 'codex', reason: 'timed_out', selection: 'random', pick_seq: 1 }));
    await h.relay.onCoreEvent({ type: 'stepFailed', session: 'run-1', ord: 1, attempt: 1, detail: 'step budget exhausted; failing over to codex', failureKind: 'timeout' } as CoreEvent);
    await h.relay.onCoreEvent({ type: 'unitDispatched', session: 'run-1', ord: 1, attempt: 2 } as CoreEvent);
    await h.relay.onCoreEvent({ type: 'unitOutputCaptured', session: 'run-1', ord: 1, attempt: 2, outputBytes: 10, stepStatus: 'ok', governed: true } as CoreEvent);
    h.relay.onTeamRow(row('wicked.team.step.completed', { run_id: 'run-1', step_id: 'answer-1', status: 'ok', tree: null, output_bytes: 10, output_ref: 'unit:run-1:1:2' }));
    await h.relay.onCoreEvent({ type: 'unitDone', session: 'run-1', ord: 1 } as CoreEvent);
    const replies = h.emitted.filter((f) => f.type === 'chatReply');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ ok: true, cliKey: 'codex', text: 'The answer.\nSecond line.', ord: 1 });
  });

  it('codex on #810 r2 (2): a delta of a SUPERSEDED attempt is dropped, and a partial line never crosses attempts', async () => {
    const h = harness({ pa: 'codex' });
    await h.relay.onCoreEvent({ type: 'unitOutputDelta', session: 'run-1', ord: 1, attempt: 1, text: 'HE' } as CoreEvent); // a partial line of attempt 1
    await h.relay.onCoreEvent({ type: 'unitDispatched', session: 'run-1', ord: 1, attempt: 2 } as CoreEvent);
    await h.relay.onCoreEvent({ type: 'unitOutputDelta', session: 'run-1', ord: 1, attempt: 1, text: 'old worker text\n' } as CoreEvent); // straggler
    await h.relay.onCoreEvent({ type: 'unitOutputDelta', session: 'run-1', ord: 1, attempt: 2, text: 'LP: not a control line here\n' } as CoreEvent);
    expect(h.emitted.map((f) => [f.type, f['text']])).toEqual([['chatDelta', 'LP: not a control line here\n']]);
  });

  it('codex on #810 r2 (4): a unit read that resolves after End does not recreate the forgotten run\'s cache', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => { release = r; });
    let reads = 0;
    const paths = new AskPathIndex();
    paths.open('c1', ['codex'], 'codex');
    paths.started('c1', 1, 'run-1', 'answer-1');
    const relay = new AskRelay({
      paths,
      turns: new ChatTurnIndex(),
      units: async () => { reads += 1; await held; return [{ id: 'run-1:answer-1', ord: 1, status: 'done', assigned_cli: 'codex' }]; },
      workOutput: async () => 'x',
      fold: () => undefined,
    });
    const first = relay.onCoreEvent({ type: 'unitOutputDelta', session: 'run-1', ord: 1, attempt: 1, text: 'a\n' } as CoreEvent);
    paths.close('c1');
    relay.forget('run-1');
    release();
    await first;
    // A later run reusing the id reads afresh (nothing was cached for the forgotten run).
    paths.open('c1', ['codex'], 'codex');
    paths.started('c1', 2, 'run-1', 'answer-1');
    await relay.onCoreEvent({ type: 'unitOutputDelta', session: 'run-1', ord: 1, attempt: 1, text: 'b\n' } as CoreEvent);
    expect(reads).toBe(2);
  });

  it('codex on #810 r3 (1): the attempt boundary is ONE across rows and frames — a row for attempt 2 then a delta of attempt 1 (no attempt-2 frame seen) is dropped, and the fold joins the attempt-2 row', async () => {
    const h = harness({ pa: 'codex' });
    h.relay.onTeamRow(row('wicked.team.step.completed', { run_id: 'run-1', step_id: 'answer-1', status: 'timed_out', tree: null, output_bytes: 0, output_ref: 'unit:run-1:1:1' }));
    h.relay.onTeamRow(row('wicked.team.step.completed', { run_id: 'run-1', step_id: 'answer-1', status: 'ok', tree: null, output_bytes: 10, output_ref: 'unit:run-1:1:2' }));
    await h.relay.onCoreEvent({ type: 'unitOutputDelta', session: 'run-1', ord: 1, attempt: 1, text: 'old text\n' } as CoreEvent);
    expect(h.emitted, 'the attempt-1 straggler is dropped').toEqual([]);
    await h.relay.onCoreEvent({ type: 'unitDone', session: 'run-1', ord: 1 } as CoreEvent);
    const replies = h.emitted.filter((f) => f.type === 'chatReply');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ ok: true, text: 'The answer.\nSecond line.' });
  });

  it('codex on #810 r3 (2): a unit read held across a re-dispatch neither caches the old seat nor lets it name the PA', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => { release = r; });
    let reads = 0;
    const units: RelayUnit[] = [{ id: 'run-1:answer-1', ord: 1, status: 'distributed', assigned_cli: 'claude' }];
    const paths = new AskPathIndex();
    const turns = new ChatTurnIndex();
    paths.open('c1', ['claude', 'codex']); // random: pa null
    turns.begin('c1', ['claude', 'codex'], 'Q1');
    paths.started('c1', 1, 'run-1', 'answer-1');
    const emitted: Array<CoreEvent & Record<string, unknown>> = [];
    const relay = new AskRelay({
      paths,
      turns,
      units: async () => { reads += 1; if (reads === 1) await held; return units.map((u) => ({ ...u })); },
      workOutput: async () => 'x',
      fold: (f) => emitted.push(f as CoreEvent & Record<string, unknown>),
    });
    const oldDelta = relay.onCoreEvent({ type: 'unitOutputDelta', session: 'run-1', ord: 1, attempt: 1, text: 'old\n' } as CoreEvent); // read parked
    await relay.onCoreEvent({ type: 'unitDispatched', session: 'run-1', ord: 1, attempt: 2 } as CoreEvent); // re-pick: attempt 2
    units[0] = { ...units[0]!, assigned_cli: 'codex' };
    release();
    await oldDelta;
    expect(emitted, 'the superseded delta streamed nothing').toEqual([]);
    expect(paths.view('c1')!.pa, 'the old seat did not name the PA').toBeNull();
    await relay.onCoreEvent({ type: 'unitOutputDelta', session: 'run-1', ord: 1, attempt: 2, text: 'new\n' } as CoreEvent);
    expect(emitted[0]).toMatchObject({ type: 'chatDelta', cliKey: 'codex', text: 'new\n' });
    expect(reads, 'the stale read was not cached: attempt 2 read the run view afresh').toBe(2);
  });

  it('codex on #810 r4 (1): attempts are 0-BASED — the engine\'s first attempt streams, its row (unit:<run>:<ord>:0) joins the fold, no grace is needed', async () => {
    const h = harness({ pa: 'codex' });
    await h.relay.onCoreEvent({ type: 'unitDispatched', session: 'run-1', ord: 1, attempt: 0 } as CoreEvent);
    await h.relay.onCoreEvent({ type: 'unitOutputDelta', session: 'run-1', ord: 1, attempt: 0, text: 'first attempt\n' } as CoreEvent);
    expect(h.emitted).toEqual([expect.objectContaining({ type: 'chatDelta', text: 'first attempt\n' })]);
    await h.relay.onCoreEvent({ type: 'unitOutputCaptured', session: 'run-1', ord: 1, attempt: 0, outputBytes: 10, stepStatus: 'ok', governed: true } as CoreEvent);
    h.relay.onTeamRow(row('wicked.team.step.completed', { run_id: 'run-1', step_id: 'answer-1', status: 'ok', tree: null, output_bytes: 10, output_ref: 'unit:run-1:1:0' }));
    await h.relay.onCoreEvent({ type: 'unitDone', session: 'run-1', ord: 1 } as CoreEvent);
    expect(h.emitted.filter((f) => f.type === 'chatReply'), 'answered at the fold, not after a grace').toHaveLength(1);
    expect(h.emitted.find((f) => f.type === 'chatReply')).toMatchObject({ ok: true, ord: 1 });
  });

  it('codex on #810 r4 (2): the unit\'s persisted last_attempt is the durable half of the boundary — a row for attempt 1 cannot decide a fold whose stored output is attempt 2\'s (no attempt-2 frame seen)', async () => {
    const h = harness({ pa: 'codex', units: [{ id: 'run-1:answer-1', ord: 1, status: 'done', assigned_cli: 'codex', last_attempt: 2 }] });
    h.relay.onTeamRow(row('wicked.team.step.completed', { run_id: 'run-1', step_id: 'answer-1', status: 'timed_out', tree: null, output_bytes: 0, output_ref: 'unit:run-1:1:1' }));
    await h.relay.onCoreEvent({ type: 'unitDone', session: 'run-1', ord: 1 } as CoreEvent); // no attempt-2 frame was ever seen
    expect(h.emitted.filter((f) => f.type === 'chatReply'), 'the attempt-1 row does not answer').toEqual([]);
    h.relay.onTeamRow(row('wicked.team.step.completed', { run_id: 'run-1', step_id: 'answer-1', status: 'ok', tree: null, output_bytes: 10, output_ref: 'unit:run-1:1:2' }));
    await new Promise((r) => setTimeout(r, 5));
    expect(h.emitted.find((f) => f.type === 'chatReply')).toMatchObject({ ok: true, text: 'The answer.\nSecond line.' });
  });

  it('codex on #810 r4 (3): a re-pick whose bus row is DELAYED — the freshly read unit\'s seat is this attempt\'s voice; the reply is attributed to it and the path learns it before the row', async () => {
    const h = harness({ pa: 'claude', units: [{ id: 'run-1:answer-1', ord: 1, status: 'done', assigned_cli: 'codex', last_attempt: 1 }] });
    h.relay.onTeamRow(row('wicked.team.step.completed', { run_id: 'run-1', step_id: 'answer-1', status: 'ok', tree: null, output_bytes: 10, output_ref: 'unit:run-1:1:1' }));
    await h.relay.onCoreEvent({ type: 'unitDone', session: 'run-1', ord: 1 } as CoreEvent);
    const reply = h.emitted.find((f) => f.type === 'chatReply');
    expect(reply).toMatchObject({ ok: true, cliKey: 'codex' });
    expect(h.paths.view('c1')).toMatchObject({ pa: 'codex', selection: 'random' });
    expect(h.reconciled.at(-1)).toEqual(['c1', h.turn.turnId, ['codex']]);
    // The late row changes nothing.
    h.relay.onTeamRow(row('wicked.team.path.repicked', { run_id: 'run-1', from: 'claude', to: 'codex', reason: 'timed_out', selection: 'random', pick_seq: 1 }));
    expect(h.paths.view('c1')).toMatchObject({ pa: 'codex' });
  });

  it('codex on #810 r5 (1): a CACHED previous-attempt unit does not decide the fold — the reply re-reads the durable record, whose last_attempt moves the boundary to the retry', async () => {
    const units: RelayUnit[] = [{ id: 'run-1:answer-1', ord: 1, status: 'distributed', assigned_cli: 'claude', last_attempt: 1 }];
    const h = harness({ pa: 'claude', units });
    await h.relay.onCoreEvent({ type: 'unitOutputDelta', session: 'run-1', ord: 1, attempt: 1, text: 'first try\n' } as CoreEvent); // caches attempt 1's unit
    h.relay.onTeamRow(row('wicked.team.step.completed', { run_id: 'run-1', step_id: 'answer-1', status: 'timed_out', tree: null, output_bytes: 0, output_ref: 'unit:run-1:1:1' }));
    // The retry on codex: every frame of attempt 2 is missed (the engine's live queue is bounded), its row is late.
    h.units[0] = { id: 'run-1:answer-1', ord: 1, status: 'done', assigned_cli: 'codex', last_attempt: 2 };
    await h.relay.onCoreEvent({ type: 'unitDone', session: 'run-1', ord: 1 } as CoreEvent);
    expect(h.emitted.filter((f) => f.type === 'chatReply'), 'the attempt-1 row does not grade attempt 2\'s stored answer').toEqual([]);
    h.relay.onTeamRow(row('wicked.team.step.completed', { run_id: 'run-1', step_id: 'answer-1', status: 'ok', tree: null, output_bytes: 10, output_ref: 'unit:run-1:1:2' }));
    await new Promise((r) => setTimeout(r, 5));
    const replies = h.emitted.filter((f) => f.type === 'chatReply');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ ok: true, cliKey: 'codex', text: 'The answer.\nSecond line.' });
  });

  it('codex on #810 r5 (2): the grace reply grades itself by THIS attempt\'s capture — a previous attempt\'s timed_out capture is dropped when the boundary advances', async () => {
    const h = harness({ pa: 'codex', units: [{ id: 'run-1:answer-1', ord: 1, status: 'done', assigned_cli: 'codex', last_attempt: 1 }] });
    await h.relay.onCoreEvent({ type: 'unitOutputCaptured', session: 'run-1', ord: 1, attempt: 0, outputBytes: 0, stepStatus: 'timed_out', governed: false } as CoreEvent);
    await h.relay.onCoreEvent({ type: 'unitDispatched', session: 'run-1', ord: 1, attempt: 1 } as CoreEvent); // the retry; its capture is missed, no row ever (un-teamed)
    await h.relay.onCoreEvent({ type: 'unitDone', session: 'run-1', ord: 1 } as CoreEvent);
    await new Promise((r) => setTimeout(r, 120));
    const replies = h.emitted.filter((f) => f.type === 'chatReply');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ ok: true, text: 'The answer.\nSecond line.' });
  });

  it('codex on #810 r6 (1): a fresh read that FAILS at the fold never answers from the stale cache — the reply waits and the retry\'s row answers it', async () => {
    const units: RelayUnit[] = [{ id: 'run-1:answer-1', ord: 1, status: 'distributed', assigned_cli: 'claude', last_attempt: 1 }];
    let reads = 0;
    let failNext = false;
    const paths = new AskPathIndex();
    const turns = new ChatTurnIndex();
    paths.open('c1', ['claude', 'codex'], 'claude');
    turns.begin('c1', ['claude'], 'Q1');
    paths.started('c1', 1, 'run-1', 'answer-1');
    const emitted: Array<CoreEvent & Record<string, unknown>> = [];
    const relay = new AskRelay({
      paths,
      turns,
      units: async () => { reads += 1; if (failNext) { failNext = false; throw new Error('run view unavailable'); } return units.map((u) => ({ ...u })); },
      workOutput: async () => 'Retry text.',
      fold: (f) => emitted.push(f as CoreEvent & Record<string, unknown>),
      rowGraceMs: 60,
    });
    await relay.onCoreEvent({ type: 'unitOutputDelta', session: 'run-1', ord: 1, attempt: 1, text: 'first\n' } as CoreEvent); // caches attempt 1
    relay.onTeamRow(row('wicked.team.step.completed', { run_id: 'run-1', step_id: 'answer-1', status: 'timed_out', tree: null, output_bytes: 0, output_ref: 'unit:run-1:1:1' }));
    units[0] = { id: 'run-1:answer-1', ord: 1, status: 'done', assigned_cli: 'codex', last_attempt: 2 }; // the retry; its frames missed
    failNext = true; // the fresh read at the fold fails once
    await relay.onCoreEvent({ type: 'unitDone', session: 'run-1', ord: 1 } as CoreEvent);
    expect(emitted.filter((f) => f.type === 'chatReply'), 'no answer from an uncertified cache').toEqual([]);
    relay.onTeamRow(row('wicked.team.step.completed', { run_id: 'run-1', step_id: 'answer-1', status: 'ok', tree: null, output_bytes: 10, output_ref: 'unit:run-1:1:2' }));
    await new Promise((r) => setTimeout(r, 10));
    const replies = emitted.filter((f) => f.type === 'chatReply');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ ok: true, cliKey: 'codex', text: 'Retry text.' });
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  it('codex on #810 r6 (2): a late OLD row after the fold does not bypass the wait — the fresh read moves the boundary and the reply waits for the current row (or the grace)', async () => {
    const units: RelayUnit[] = [{ id: 'run-1:answer-1', ord: 1, status: 'distributed', assigned_cli: 'claude', last_attempt: 1 }];
    const h = harness({ pa: 'claude', units });
    await h.relay.onCoreEvent({ type: 'unitOutputDelta', session: 'run-1', ord: 1, attempt: 1, text: 'first\n' } as CoreEvent);
    h.units[0] = { id: 'run-1:answer-1', ord: 1, status: 'done', assigned_cli: 'codex', last_attempt: 2 };
    await h.relay.onCoreEvent({ type: 'unitDone', session: 'run-1', ord: 1 } as CoreEvent); // no row yet → waits (the fresh read moved the boundary to 2)
    h.relay.onTeamRow(row('wicked.team.step.completed', { run_id: 'run-1', step_id: 'answer-1', status: 'timed_out', tree: null, output_bytes: 0, output_ref: 'unit:run-1:1:1' })); // the late OLD row
    await new Promise((r) => setTimeout(r, 10));
    expect(h.emitted.filter((f) => f.type === 'chatReply'), 'the old row answers nothing').toEqual([]);
    h.relay.onTeamRow(row('wicked.team.step.completed', { run_id: 'run-1', step_id: 'answer-1', status: 'ok', tree: null, output_bytes: 10, output_ref: 'unit:run-1:1:2' }));
    await new Promise((r) => setTimeout(r, 10));
    expect(h.emitted.filter((f) => f.type === 'chatReply')).toEqual([expect.objectContaining({ ok: true, cliKey: 'codex' })]);
  });

  it('codex on #810 r1 (8): two unitDone deliveries folded WITHOUT awaiting each other emit one reply', async () => {
    const h = harness({ pa: 'codex' });
    h.relay.onTeamRow(completed());
    await Promise.all([
      h.relay.onCoreEvent({ type: 'unitDone', session: 'run-1', ord: 1 } as CoreEvent),
      h.relay.onCoreEvent({ type: 'unitDone', session: 'run-1', ord: 1 } as CoreEvent),
    ]);
    expect(h.emitted.filter((f) => f.type === 'chatReply')).toHaveLength(1);
    expect(h.outputs).toHaveLength(1);
  });

  it('codex on #810 r1 (9): End forgets the run\'s reply keys too — a new run reusing the id answers afresh', async () => {
    const h = harness({ pa: 'codex' });
    h.relay.onTeamRow(completed());
    await h.relay.onCoreEvent({ type: 'unitDone', session: 'run-1', ord: 1 } as CoreEvent);
    expect(h.emitted.filter((f) => f.type === 'chatReply')).toHaveLength(1);
    h.relay.forget('run-1');
    h.relay.onTeamRow(completed());
    await h.relay.onCoreEvent({ type: 'unitDone', session: 'run-1', ord: 1 } as CoreEvent);
    expect(h.emitted.filter((f) => f.type === 'chatReply')).toHaveLength(2);
  });
});
