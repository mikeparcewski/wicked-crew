import { describe, expect, it } from 'vitest';

import type { CoreEvent } from '../src/core/types.js';
import { chatTurn, clock, docLines, foldLines } from '../src/working-doc/event-lines.js';

const T0 = Date.UTC(2026, 10, 20, 12, 30, 0);
const min = (n: number) => T0 + n * 60_000;
let seq = 0;
const ev = (type: string, ts: number, extra: Record<string, unknown> = {}): CoreEvent =>
  ({ type, session: 'run-1', ts, seq: ++seq, ...extra }) as unknown as CoreEvent;

function answeredChat(): CoreEvent[] {
  seq = 0;
  return [
    ev('unitPlanned', min(0), { ord: 1, description: 'answer-1 — In tiny-math, what does sum return?' }),
    ev('unitExecuting', min(1), { ord: 1 }),
    ev('unitDone', min(2), { ord: 1 }),
    ev('awaitingHuman', min(3), { ord: 1, gateKind: 'terminal' }),
  ];
}

describe('an answered chat’s turn in the working document (studio#1243, T17)', () => {
  it('keeps the turn gate out of Open questions', () => {
    const m = foldLines(answeredChat());
    expect(docLines(m).questions).toEqual([]);
    expect(chatTurn(m)).toBe(true);
  });

  it('keeps an answered Terminal decision after a follow-up, without an open question', () => {
    const log = answeredChat();
    log.push(
      ev('unitPlanned', min(4), { ord: 2, description: 'answer-2 — What about an empty input?' }),
      ev('unitExecuting', min(5), { ord: 2 }),
      ev('unitDone', min(6), { ord: 2 }),
      ev('awaitingHuman', min(7), { ord: 2, gateKind: 'terminal' }),
    );
    const m = foldLines(log);
    expect(docLines(m)).toEqual({
      questions: [],
      decisions: [`Terminal · answered ${clock(min(5))}`],
      next: [],
    });
    expect(chatTurn(m)).toBe(true);
  });

  it('still asks for a feature run’s terminal decision', () => {
    seq = 0;
    const m = foldLines([
      ev('unitPlanned', min(0), { ord: 1, description: 'build — Fix sum' }),
      ev('unitPlanned', min(0), { ord: 2, description: 'review - Review sum' }),
      ev('unitExecuting', min(1), { ord: 1 }),
      ev('unitDone', min(2), { ord: 1 }),
      ev('unitExecuting', min(3), { ord: 2 }),
      ev('unitDone', min(4), { ord: 2 }),
      ev('awaitingHuman', min(5), { ord: 2, gateKind: 'terminal' }),
    ]);
    expect(docLines(m).questions).toEqual([`Waiting on you · Terminal · since ${clock(min(5))}`]);
    expect(chatTurn(m)).toBe(false);
  });

  it('still asks for an escalation when an answer was denied', () => {
    seq = 0;
    const m = foldLines([
      ev('unitPlanned', min(0), { ord: 1, description: 'answer-1 — Explain sum' }),
      ev('unitExecuting', min(1), { ord: 1 }),
      ev('unitDenied', min(2), { ord: 1 }),
      ev('awaitingHuman', min(3), { ord: 1, gateKind: 'escalation' }),
    ]);
    expect(docLines(m).questions).toEqual([`Waiting on you · A failed check or review · since ${clock(min(3))}`]);
    expect(chatTurn(m)).toBe(false);
  });

  it('asks nothing for a finished run, which is no longer a chat turn', () => {
    const log = answeredChat();
    log.push(ev('sessionCompleted', min(4)));
    const m = foldLines(log);
    expect(docLines(m).questions).toEqual([]);
    expect(chatTurn(m)).toBe(false);
  });

  it.each(['unitExecuting', 'unitDenied', 'stepFailed'])('a later %s means the answer is no longer done', (type) => {
    const log = answeredChat();
    log.push(ev(type, min(4), { ord: 1 }), ev('awaitingHuman', min(5), { ord: 1, gateKind: 'escalation' }));
    const m = foldLines(log);
    expect(chatTurn(m)).toBe(false);
    expect(docLines(m).questions).toContain(`Waiting on you · A failed check or review · since ${clock(min(5))}`);
    log.push(ev('unitDone', min(6), { ord: 1 }));
    expect(chatTurn(foldLines(log))).toBe(true);
  });

  it('requires every planned answer to be done', () => {
    const log = answeredChat();
    log.push(ev('unitPlanned', min(4), { ord: 2, description: 'answer-2 — Explain more' }));
    expect(chatTurn(foldLines(log))).toBe(false);
    expect(chatTurn(foldLines([]))).toBe(false);
  });

  it.each(['answer-1', 'answer-1 - Explain sum'])('recognizes the step id in %s', (description) => {
    const log = answeredChat();
    log[0] = { ...log[0], description } as unknown as CoreEvent;
    expect(chatTurn(foldLines(log))).toBe(true);
  });

  it.each([undefined, 'Answer-1 — Explain sum', 'answer-1.extra — Explain sum', 'answer-1 Explain sum'])('rejects an invalid step description: %s', (description) => {
    const log = answeredChat();
    log[0] = { ...log[0], description } as unknown as CoreEvent;
    const m = foldLines(log);
    expect(chatTurn(m)).toBe(false);
    expect(docLines(m).questions).toEqual([`Waiting on you · Terminal · since ${clock(min(3))}`]);
  });
});
