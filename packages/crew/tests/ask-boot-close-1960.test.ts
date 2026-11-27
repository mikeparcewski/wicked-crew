// crew#1960: a chat answer run a restart left parked at its turn gate is ended at boot.
//
// Ask paths live in memory (src/api/ask-paths.ts AskPathIndex), so after a restart no chat holds the run:
// the chat's next message launches a new run, and a chat close (routes.ts endChat) finds no run to cancel.
// The train-16 cert found 6 such runs on one daemon, all `awaiting_human` after their card said Answered.
//
// The run shape is the real one (tests/fixtures/ask-turn-1960.ts: run 85e84baa from that cert).

import { describe, expect, it, vi } from 'vitest';
import { endOrphanedAskTurns } from '../src/api/ask-boot-close.js';
import type { Actor, AuditEntry } from '../src/core/types.js';
import { answeredAsk, DAEMON, disputeRow, plainGate, turnGateRow } from './fixtures/ask-turn-1960.js';

function fakeAudit() {
  const entries: AuditEntry[] = [];
  return {
    entries,
    record(action: string, actor: Actor, fields?: { runId?: string; detail?: Record<string, unknown> }) {
      entries.push({ ts: 1, action, actor, ...fields } as AuditEntry);
      return 1;
    },
  };
}

describe('crew#1960 — endOrphanedAskTurns', () => {
  it('an engine without the open-row read sweeps nothing (a turn gate cannot be told from a dispute)', async () => {
    const cancelRun = vi.fn(async () => 'cancelled');
    const result = await endOrphanedAskTurns({ sessionsDetail: async () => [answeredAsk('a')], cancelRun }, { isAskPath: () => true, heldByChat: () => false, audit: fakeAudit(), actor: DAEMON, log: () => undefined });
    expect(result).toEqual({ cancelled: [], failed: [] });
    expect(cancelRun).not.toHaveBeenCalled();
  });

  it('ends only the ask runs parked at their turn gate that no chat of this daemon holds', async () => {
    const cancelled: string[] = [];
    const adapter = {
      sessionsDetail: async () => [
        answeredAsk('orphan'),
        answeredAsk('escalated', 'rejected'), // an answer held at an escalation: a real gate
        answeredAsk('held'), // a chat opened since boot holds it: its next message answers the gate
        answeredAsk('not-ask'), // the shape of an ask, but no ask launched it
        plainGate('job'),
        answeredAsk('ended', 'done', 'completed'),
        answeredAsk('dispute'), // its answer is done, but a team dispute over a finding waits on a person
        answeredAsk('dispute-too'), // the turn gate AND a dispute open
        answeredAsk('no-rows'), // the engine keeps no open row for it
      ],
      interactionRequests: async (id?: string) =>
        id === 'dispute' ? [disputeRow(id)] : id === 'dispute-too' ? [turnGateRow(id), disputeRow(id)] : id === 'no-rows' ? [] : [turnGateRow(id!)],
      cancelRun: async (id: string) => {
        cancelled.push(id);
        return 'cancelled';
      },
    };
    const audit = fakeAudit();
    const result = await endOrphanedAskTurns(adapter, {
      isAskPath: (id) => id !== 'not-ask' && id !== 'job',
      heldByChat: (id) => id === 'held',
      audit,
      actor: DAEMON,
      log: () => undefined,
    });
    expect(cancelled).toEqual(['orphan']);
    expect(result).toEqual({ cancelled: [{ id: 'orphan', status: 'cancelled' }], failed: [] });
    expect(audit.entries).toEqual([
      expect.objectContaining({ action: 'run.cancelled', runId: 'orphan', actor: DAEMON, detail: { status: 'cancelled', via: 'boot', reason: 'ask_turn_orphaned' } }),
    ]);
  });

  it('a refused cancel is logged and reported, never thrown, and the sweep goes on', async () => {
    const log = vi.fn();
    const adapter = {
      sessionsDetail: async () => [answeredAsk('a'), answeredAsk('b')],
      interactionRequests: async (id?: string) => [turnGateRow(id!)],
      cancelRun: async (id: string) => {
        if (id === 'a') throw new Error('engine busy');
        return 'cancelled';
      },
    };
    const result = await endOrphanedAskTurns(adapter, { isAskPath: () => true, heldByChat: () => false, audit: fakeAudit(), actor: DAEMON, log });
    expect(result).toEqual({ cancelled: [{ id: 'b', status: 'cancelled' }], failed: [{ id: 'a', error: 'engine busy' }] });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('engine busy'));
  });
});

