/**
 * Per-chat TURN tracking for `POST /chats/:id/messages` (F-RECON-017).
 *
 * The engine queues a message sent to a seat that is still answering the previous one — silently:
 * `chatSend` answers the seats it accepted, the worker receives the text the instant the previous
 * turn's final block lands, and the reply frames (`chatDelta` / `chatReply`) carry chat + seat but
 * NO message correlation. The recon saw exactly that: Q3 sent 58 s into Q2's turn got a 202, and
 * Q2's reply then rendered under Q3's bubble. Neither the daemon nor the skin could tell.
 *
 * This index is the daemon's own record of which seats are mid-turn in which chat:
 *
 *  - `begin` opens a turn for the seats a send actually reached (the engine's answer) and mints a
 *    `turnId` the 202 returns;
 *  - `inFlight` is the refusal predicate the route consults FIRST: a send that targets a seat still
 *    mid-turn is refused (409 `turn_in_flight`, naming the turn and the busy seats) — targeting
 *    only idle seats passes, so a stalled seat (opencode 0 bytes for 300 s) never blocks a
 *    follow-up to the one that answered;
 *  - `observe` folds the engine's frames: a seat's `chatReply` (ok or not) or `chatSessionFailed`
 *    ends its part of the turn, `chatClosed` drops the chat's turns;
 *  - `decorate` stamps `turn_id` onto the chat frames of a seat mid-turn, so a skin can file a
 *    delta/reply under the message it answers instead of the newest bubble.
 *
 * A turn whose frames were lost (an engine restart, a seat reaped without a frame) must never wedge
 * the chat: a turn older than `staleAfterMs` (default 15 min — three engine turn budgets) is treated
 * as ended by every read, and reported in the 409's `stale` reason when it is what let a send pass.
 */

import { randomUUID } from 'node:crypto';
import type { CoreEvent } from '../core/types.js';

/** One live turn: the message a set of seats is answering. */
export interface ChatTurn {
  turnId: string;
  chatId: string;
  /** Every seat the send reached (the engine's `chatSend` answer). */
  seats: string[];
  /** The seats that have not ended their part yet. */
  pending: string[];
  /** Epoch ms of the accepted send. */
  startedAt: number;
  /** A bounded excerpt of the message, for the 409 body and diagnostics. */
  excerpt: string;
}

/** What a refused send is told (the 409 body's `turn`). */
export interface ChatTurnInFlight {
  turnId: string;
  chatId: string;
  seats: string[];
  /** The targeted seats still answering — the reason for the refusal. */
  busy: string[];
  startedAt: number;
  ageMs: number;
  excerpt: string;
}

export const CHAT_TURN_EXCERPT_CHARS = 120;
/** Three engine turn budgets (300 s each): a turn this old with no closing frame is lost, not live. */
export const CHAT_TURN_STALE_AFTER_MS = 15 * 60_000;

/** The frame kinds that carry a seat's progress on a turn (`chat` + `cliKey` fields). */
const SEAT_PROGRESS_FRAMES: ReadonlySet<string> = new Set(['chatDelta', 'chatReply', 'chatSessionFailed']);
/** The frame kinds that END a seat's part of its turn. */
const SEAT_DONE_FRAMES: ReadonlySet<string> = new Set(['chatReply', 'chatSessionFailed']);

function excerptOf(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > CHAT_TURN_EXCERPT_CHARS ? `${one.slice(0, CHAT_TURN_EXCERPT_CHARS)}…` : one;
}

export class ChatTurnIndex {
  /** chatId → live turns (a seat is in at most one — `inFlight` refuses the second). */
  private readonly turns = new Map<string, ChatTurn[]>();
  private readonly now: () => number;
  private readonly staleAfterMs: number;

  constructor(opts: { now?: () => number; staleAfterMs?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.staleAfterMs = opts.staleAfterMs ?? CHAT_TURN_STALE_AFTER_MS;
  }

  /** Drop turns whose frames were lost (see the module doc); returns the survivors. */
  private live(chatId: string): ChatTurn[] {
    const list = this.turns.get(chatId);
    if (list === undefined) return [];
    const now = this.now();
    const kept = list.filter((t) => t.pending.length > 0 && now - t.startedAt < this.staleAfterMs);
    if (kept.length === 0) this.turns.delete(chatId);
    else if (kept.length !== list.length) this.turns.set(chatId, kept);
    return kept;
  }

  /**
   * The turn that makes a send to `targets` (every seat of the chat when omitted) refusable: one
   * whose pending seats intersect the targets. `null` when every targeted seat is idle.
   */
  inFlight(chatId: string, targets?: readonly string[]): ChatTurnInFlight | null {
    for (const turn of this.live(chatId)) {
      const busy = targets === undefined ? [...turn.pending] : turn.pending.filter((s) => targets.includes(s));
      if (busy.length === 0) continue;
      return {
        turnId: turn.turnId,
        chatId,
        seats: [...turn.seats],
        busy,
        startedAt: turn.startedAt,
        ageMs: Math.max(0, this.now() - turn.startedAt),
        excerpt: turn.excerpt,
      };
    }
    return null;
  }

  /** Open a turn for the seats a send reached. An empty seat list opens nothing (nothing to wait for). */
  begin(chatId: string, seats: readonly string[], text: string): ChatTurn | null {
    const unique = [...new Set(seats)];
    if (unique.length === 0) return null;
    const turn: ChatTurn = {
      turnId: randomUUID(),
      chatId,
      seats: unique,
      pending: [...unique],
      startedAt: this.now(),
      excerpt: excerptOf(text),
    };
    const list = this.live(chatId);
    list.push(turn);
    this.turns.set(chatId, list);
    return turn;
  }

  /** The live turn a seat of a chat is answering, if any. */
  turnOf(chatId: string, cliKey: string): ChatTurn | undefined {
    return this.live(chatId).find((t) => t.pending.includes(cliKey));
  }

  /** Every live turn of a chat (diagnostics / tests). */
  turnsOf(chatId: string): ChatTurn[] {
    return this.live(chatId).map((t) => ({ ...t, seats: [...t.seats], pending: [...t.pending] }));
  }

  /** Fold one engine frame. Safe on every event type; non-chat frames are ignored. */
  observe(event: CoreEvent): void {
    const chatId = typeof event.chat === 'string' ? event.chat : undefined;
    if (chatId === undefined) return;
    if (event.type === 'chatClosed') {
      this.turns.delete(chatId);
      return;
    }
    if (!SEAT_DONE_FRAMES.has(event.type)) return;
    const cliKey = typeof event.cliKey === 'string' ? event.cliKey : undefined;
    if (cliKey === undefined) return;
    const turn = this.turnOf(chatId, cliKey);
    if (turn === undefined) return;
    turn.pending = turn.pending.filter((s) => s !== cliKey);
    this.live(chatId); // prunes the turn once its last seat ended
  }

  /**
   * The frame with `turn_id` stamped when it is a seat's progress on a live turn; the frame itself
   * otherwise. Call BEFORE `observe` — the closing `chatReply` is the one most worth correlating.
   */
  decorate(event: CoreEvent): CoreEvent {
    if (!SEAT_PROGRESS_FRAMES.has(event.type)) return event;
    const chatId = typeof event.chat === 'string' ? event.chat : undefined;
    const cliKey = typeof event.cliKey === 'string' ? event.cliKey : undefined;
    if (chatId === undefined || cliKey === undefined) return event;
    const turn = this.turnOf(chatId, cliKey);
    return turn === undefined ? event : ({ ...event, turn_id: turn.turnId } as CoreEvent);
  }

  /** The chat is gone (a `DELETE` or an engine reclaim) — nothing left to wait for. */
  closed(chatId: string): void {
    this.turns.delete(chatId);
  }
}
