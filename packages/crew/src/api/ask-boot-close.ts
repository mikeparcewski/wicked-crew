/**
 * crew#1960: a chat's answer run that a restart left parked at its TURN gate is ended at boot.
 *
 * An ask's run waits `awaiting_human` at its turn gate after every answer (the answer step's
 * unconditional `human_confirm`); the chat's NEXT message answers that gate (`propose_plan(answer-N)`
 * then `confirm_gate`), and closing the chat cancels the run (`endChat` in routes.ts). Both need the
 * daemon's ask-path record ({@link AskPathIndex}), which is in memory only: after a restart no chat
 * holds the run, a reopened chat launches a NEW run on its first message, and a close finds no run
 * to cancel. The parked run then waits forever with nothing a person can do to it (the answered card
 * has no Stop, by design: e2e-1105).
 *
 * So at boot the daemon ends each such run the way a chat close ends it (`cancelRun`), once, and
 * audits it `run.cancelled {via: 'boot', reason: 'ask_turn_orphaned'}`. A run qualifies only when
 * the durable launch record says an ask launched it (`run.launched {askPath: true}`), it waits at
 * its turn gate ({@link isAskTurn}: every unit an answer step, every one done), and no chat of this
 * daemon holds it now. An ask held at a real gate (an escalation: its answer is not done) is never
 * touched. A refused cancel is logged and reported, never thrown: boot must finish.
 */

import type { Actor, SessionView } from '../core/types.js';
import { isAskTurn } from './ask-paths.js';

/** The engine calls the sweep needs (the real `CoreAdapter` has both). */
export interface AskBootCloseSurface {
  sessionsDetail(): Promise<SessionView[]>;
  cancelRun(runId: string): Promise<string>;
}

export interface AskBootCloseDeps {
  /** Did an ask launch the run (the durable `run.launched {askPath}` record)? */
  isAskPath(runId: string): boolean;
  /** Does a chat of this daemon hold the run right now (a chat opened since boot may already have launched one)? */
  heldByChat(runId: string): boolean;
  audit: { record(action: string, actor: Actor, fields?: { runId?: string; detail?: Record<string, unknown> }): number };
  actor: Actor;
  log: (message: string) => void;
}

export interface AskBootCloseResult {
  cancelled: Array<{ id: string; status: string }>;
  failed: Array<{ id: string; error: string }>;
}

/** End every ask run a restart left parked at its turn gate. Never throws. */
export async function endOrphanedAskTurns(adapter: AskBootCloseSurface, deps: AskBootCloseDeps): Promise<AskBootCloseResult> {
  const result: AskBootCloseResult = { cancelled: [], failed: [] };
  if (typeof adapter.sessionsDetail !== 'function' || typeof adapter.cancelRun !== 'function') return result;
  let views: SessionView[];
  try {
    views = await adapter.sessionsDetail();
  } catch (err) {
    deps.log(`[chats] ask-turn boot sweep could not list runs: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }
  for (const v of views) {
    const id = v.session.id;
    if (!deps.isAskPath(id) || !isAskTurn(v) || deps.heldByChat(id)) continue;
    try {
      const status = await adapter.cancelRun(id);
      deps.audit.record('run.cancelled', deps.actor, { runId: id, detail: { status, via: 'boot', reason: 'ask_turn_orphaned' } });
      result.cancelled.push({ id, status });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      deps.log(`[chats] could not end ask run ${id} left at its turn gate by a restart: ${error}`);
      result.failed.push({ id, error });
    }
  }
  return result;
}
