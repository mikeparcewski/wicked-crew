/**
 * The studio chat recorder (DES-decision-capture §4.3.3, DC-S4b; DOC-4: the pair framing).
 *
 * A chat seat is asked (the scope statement's `## Decisions` section, `chat-scope.ts`) to end every
 * reply with a fenced `wicked-decisions` JSON block labelling the OPERATOR'S words of the turn it is
 * answering. This module is the whole host:
 *
 *  - {@link splitDecisionsBlock} / {@link DecisionFenceFilter}: the block never reaches a reader. The
 *    `chatReply` text is cut before persist and broadcast (`ChatTranscriptStore.rewriteEvent`), and the
 *    streamed `chatDelta` frames hold back a tail that could still become the fence, then drop
 *    everything from the fence on until the turn's reply (review S4 / N8).
 *  - {@link ChatDecisionRecorder}: the recorder is chosen deterministically from the turn's audience
 *    (the first `claude` seat, else the first seat in roster order — review N3); its items become
 *    records when their quote is found, whitespace-normalised, in the SAME turn's operator message
 *    (the model may label words, never invent them); every other seat's items are `labels.votes`.
 *  - It fails OPEN with no regex fallback: a missing or malformed block leaves the turn
 *    "unclassified" (a counter on `/diagnostics`) and the operator's words are STILL recorded, so the
 *    deterministic derivation (`derive.ts`) runs with no model at all. The model only adds offers.
 *  - DOC-4: an item that `approves_proposal` carries `decision_text` written from the seat's approved
 *    proposal; that text becomes the record's statement and the record names the proposal (the
 *    previous turn, the recorder seat). A bare "lets do it" therefore yields a decision whose text is
 *    the proposal's, never auto (`derive.ts` refuses auto for an approval).
 *
 * Words enter the ledger only through `ingestDecision` (§4.3.1): the actor is the one who SENT the
 * message (`noteSend`, from the route), so an agent token's chat message records nothing.
 */

import { z } from 'zod';

import type { ChatTranscriptStore } from '../api/chat-transcripts.js';
import { chatTurnStaleAfterMs } from '../api/chat-turns.js';
import type { Actor, CoreEvent, DecisionView, DiagnosticsDecisions, SteeringType } from '../core/types.js';
import { ingestDecision } from './ingest.js';
import type { DecisionService } from './land.js';
import type { DecisionModelLabels, DecisionRecord, DecisionType } from './types.js';

/** The opening fence, exactly as the codebook (`skills/mem/refs/decision-report.md`) spells it. */
export const DECISIONS_FENCE = '```wicked-decisions';

const STEERING_TYPES = [
  'architecture',
  'development',
  'security',
  'testing',
  'operations',
  'compliance',
  'design-ux',
] as const satisfies ReadonlyArray<SteeringType>;

/** One labelled span, as the codebook defines it. `none` is crew's label, never an item. */
export interface DecisionReportItem {
  quote: string;
  decision_text?: string;
  type: Exclude<DecisionType, 'none'>;
  codify: boolean;
  ambiguous: boolean;
  steering_type: SteeringType;
  approves_proposal: boolean;
  same_as: string | null;
}

export interface ParsedDecisionsBlock {
  items: DecisionReportItem[];
  /** Items the block carried that did not parse (dropped one by one; the block still counts). */
  dropped: number;
}

const ItemSchema = z.object({
  quote: z.string().min(1).max(4000),
  decision_text: z.string().max(600).nullish(),
  type: z.enum(['rule', 'correction', 'scope', 'exception', 'choice', 'confirmation']),
  codify: z.boolean().default(false),
  ambiguous: z.boolean().default(false),
  steering_type: z.enum(STEERING_TYPES).default('development'),
  approves_proposal: z.boolean().default(false),
  same_as: z.string().nullable().default(null),
});

const BlockSchema = z.object({ items: z.array(z.unknown()) });

/**
 * Parse a block body. `null` when the JSON is malformed or the body is not `{items: [...]}`; an item
 * that fails its own shape is dropped and counted, the rest survive.
 */
export function parseDecisionsBlock(body: string): ParsedDecisionsBlock | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  const block = BlockSchema.safeParse(raw);
  if (!block.success) return null;
  const items: DecisionReportItem[] = [];
  let dropped = 0;
  for (const candidate of block.data.items) {
    const item = ItemSchema.safeParse(candidate);
    if (!item.success) {
      dropped += 1;
      continue;
    }
    const d = item.data;
    items.push({
      quote: d.quote,
      ...(typeof d.decision_text === 'string' && d.decision_text.trim() !== '' ? { decision_text: d.decision_text.trim() } : {}),
      type: d.type,
      codify: d.codify,
      ambiguous: d.ambiguous,
      steering_type: d.steering_type,
      approves_proposal: d.approves_proposal,
      same_as: d.same_as,
    });
  }
  return { items, dropped };
}

function trimEnd(text: string): string {
  return text.replace(/\s+$/u, '');
}

/**
 * Cut the LAST fenced `wicked-decisions` block out of a reply. The opening fence must be a line of
 * its own (leading indentation allowed — a list item or a quoted block is still a block; a mention of
 * the fence inside a sentence is prose, codex r1). An opening fence with no closing fence — a reply
 * cut off mid-block — is removed from its line on and reported `truncated`; nothing of a block ever
 * reaches a reader.
 */
export function splitDecisionsBlock(text: string): { text: string; block: string | null; truncated: boolean } {
  const openings = [...text.matchAll(/(^|\n)[ \t]*```wicked-decisions[ \t]*(?=\r?\n|$)/gu)];
  const opening = openings[openings.length - 1];
  if (opening === undefined || opening.index === undefined) return { text, block: null, truncated: false };
  const lineStart = opening.index + opening[1]!.length;
  const afterOpen = text.indexOf('\n', lineStart);
  if (afterOpen === -1) return { text: trimEnd(text.slice(0, lineStart)), block: null, truncated: true };
  const close = /\n[ \t]*```/u.exec(text.slice(afterOpen));
  if (close === null) return { text: trimEnd(text.slice(0, lineStart)), block: null, truncated: true };
  const closeAt = afterOpen + close.index;
  const body = text.slice(afterOpen + 1, closeAt).trim();
  const rest = text.slice(closeAt + close[0].length).replace(/^[ \t]*\r?\n?/u, '');
  return { text: trimEnd(text.slice(0, lineStart) + rest), block: body, truncated: false };
}

/**
 * The `chatDelta` filter: per (chat, seat), hold back the longest tail that is still a prefix of the
 * fence (so a fence split across frames is caught), and from the fence on drop every character
 * until {@link reset} (the turn's `chatReply`, which carries the clean full text anyway).
 */
export class DecisionFenceFilter {
  private readonly state = new Map<string, { held: string; dropping: boolean }>();

  private static key(chat: string, cliKey: string): string {
    return `${chat}\u0000${cliKey}`;
  }

  delta(chat: string, cliKey: string, text: string): string {
    const key = DecisionFenceFilter.key(chat, cliKey);
    const s = this.state.get(key) ?? { held: '', dropping: false };
    if (s.dropping) {
      this.state.set(key, s);
      return '';
    }
    const buf = s.held + text;
    const at = buf.indexOf(DECISIONS_FENCE);
    if (at !== -1) {
      this.state.set(key, { held: '', dropping: true });
      return buf.slice(0, at);
    }
    let hold = 0;
    for (let n = Math.min(buf.length, DECISIONS_FENCE.length - 1); n > 0; n -= 1) {
      if (DECISIONS_FENCE.startsWith(buf.slice(buf.length - n))) {
        hold = n;
        break;
      }
    }
    if (hold === 0) {
      this.state.delete(key);
      return buf;
    }
    this.state.set(key, { held: buf.slice(buf.length - hold), dropping: false });
    return buf.slice(0, buf.length - hold);
  }

  reset(chat: string, cliKey: string): void {
    this.state.delete(DecisionFenceFilter.key(chat, cliKey));
  }
}

/** Whitespace-normalised: the only normalisation quote matching applies. */
function norm(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** The recorder of a turn: the first `claude` seat of its audience, else the first seat (review N3). */
export function pickRecorder(seats: ReadonlyArray<string>): string | undefined {
  return seats.find((s) => s === 'claude' || s.startsWith('claude')) ?? seats[0];
}

interface TurnState {
  chat: string;
  turnId: string;
  at: number;
  actor: Actor;
  text: string;
  seats: string[];
  /** cliKey → the seat's parsed block (`null`: no block, or a malformed one). */
  replies: Map<string, ParsedDecisionsBlock | null>;
  prevTurnId?: string;
}

export interface ChatRecorderDeps {
  service: DecisionService;
  transcripts: ChatTranscriptStore;
  broadcast: (frame: CoreEvent) => void;
  projectOf: (chatId: string) => string | undefined;
  now?: () => number;
  /** A turn whose seats never all answer is closed after this (default: the turn index's stale budget). */
  staleAfterMs?: number;
  /** DC-S7: every finalized turn is handed on (the Consideration + its fact), before the words are judged. */
  onTurnRecorded?: (chat: string, turnId: string) => Promise<void>;
  log?: (msg: string) => void;
}

export interface ChatReplyInput {
  chat: string;
  cliKey: string;
  turnId?: string;
  ok: boolean;
  /** The block body `ChatTranscriptStore.rewriteEvent` cut out of the reply, or `null`. */
  block: string | null;
  /** `failed`: a `chatSessionFailed` frame ended the seat's part with no reply (not counted). */
  kind?: 'reply' | 'failed';
}

export class ChatDecisionRecorder {
  private readonly turns = new Map<string, TurnState>();
  private readonly lastTurn = new Map<string, string>();
  private readonly counters = new Map<string, { replies: number; blocks: number; malformed: number }>();
  private unclassified = 0;
  private recorded = 0;
  private readonly now: () => number;
  private readonly staleAfterMs: number;
  private readonly inFlight = new Set<Promise<unknown>>();
  /** Per chat: the recordings in flight (a sweep's or a reply's), so a close can drain them. */
  private readonly inFlightByChat = new Map<string, Set<Promise<unknown>>>();

  constructor(private readonly deps: ChatRecorderDeps) {
    this.now = deps.now ?? Date.now;
    this.staleAfterMs = deps.staleAfterMs ?? chatTurnStaleAfterMs();
  }

  private static key(chat: string, turnId: string): string {
    return `${chat}\u0000${turnId}`;
  }

  private log(msg: string): void {
    this.deps.log?.(msg);
  }

  private counter(cliKey: string): { replies: number; blocks: number; malformed: number } {
    let c = this.counters.get(cliKey);
    if (c === undefined) {
      c = { replies: 0, blocks: 0, malformed: 0 };
      this.counters.set(cliKey, c);
    }
    return c;
  }

  /** The route recorded a send: who said it (the actor), to whom (the audience the engine reached). */
  noteSend(chat: string, turnId: string, actor: Actor, text: string, seats: ReadonlyArray<string>): void {
    // codex r1: a send sweeps too, so a chat whose seat went quiet does not keep its stale turns
    // until some reply happens to arrive. Tracked, never awaited on the route.
    this.track(this.sweep());
    const prev = this.lastTurn.get(chat);
    this.turns.set(ChatDecisionRecorder.key(chat, turnId), {
      chat,
      turnId,
      at: this.now(),
      actor,
      text,
      seats: [...new Set(seats)],
      replies: new Map(),
      ...(prev !== undefined ? { prevTurnId: prev } : {}),
    });
    this.lastTurn.set(chat, turnId);
  }

  /** A seat ended its part of a turn. Resolves once any recording it triggered has settled. */
  async onReply(input: ChatReplyInput): Promise<void> {
    let parsed: ParsedDecisionsBlock | null = null;
    if (input.kind !== 'failed') {
      const c = this.counter(input.cliKey);
      c.replies += 1;
      if (input.block !== null) {
        parsed = parseDecisionsBlock(input.block);
        if (parsed === null) c.malformed += 1;
        else c.blocks += 1;
      }
    }
    await this.sweep();
    if (input.turnId === undefined) return;
    const turn = this.turns.get(ChatDecisionRecorder.key(input.chat, input.turnId));
    if (turn === undefined) return; // a turn this daemon never saw sent (a restart): nothing to record
    turn.replies.set(input.cliKey, parsed);
    if (turn.seats.every((s) => turn.replies.has(s))) await this.finalize(turn);
  }

  /** The chat is gone: whatever its open turns gathered is recorded now. */
  async closed(chat: string): Promise<void> {
    for (const turn of [...this.turns.values()]) {
      if (turn.chat === chat) await this.finalize(turn);
    }
    // A recording a sweep (or a reply) started earlier is still this chat's: it resolves the
    // project and appends to the transcript when it settles, so the close waits for it — a reuse
    // of the id after this returns cannot receive it (codex on #808 r5, 3).
    for (;;) {
      const pending = this.inFlightByChat.get(chat);
      if (pending === undefined || pending.size === 0) break;
      await Promise.all([...pending]);
    }
    this.lastTurn.delete(chat);
  }

  private track(work: Promise<unknown>): void {
    const tracked: Promise<unknown> = work
      .catch((err: unknown) => this.log(`[decisions] chat recorder: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
  }

  /** Resolves once every recording in flight has settled (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  diagnostics(): DiagnosticsDecisions {
    const recorder: DiagnosticsDecisions['recorder'] = {};
    for (const [k, v] of this.counters) recorder[k] = { ...v };
    return { mode: this.deps.service.mode, recorder, unclassified_turns: this.unclassified, recorded_turns: this.recorded };
  }

  private async sweep(): Promise<void> {
    const now = this.now();
    for (const turn of [...this.turns.values()]) {
      if (now - turn.at >= this.staleAfterMs) await this.finalize(turn);
    }
  }

  private async finalize(turn: TurnState): Promise<void> {
    this.turns.delete(ChatDecisionRecorder.key(turn.chat, turn.turnId));
    const work = this.record(turn).catch((err: unknown) =>
      this.log(`[decisions] chat ${turn.chat} turn ${turn.turnId}: ${err instanceof Error ? err.message : String(err)}`),
    );
    this.track(work);
    let byChat = this.inFlightByChat.get(turn.chat);
    if (byChat === undefined) {
      byChat = new Set();
      this.inFlightByChat.set(turn.chat, byChat);
    }
    const mine: Promise<unknown> = work.finally(() => {
      byChat.delete(mine);
      if (byChat.size === 0) this.inFlightByChat.delete(turn.chat);
    });
    byChat.add(mine);
    await mine;
  }

  private async record(turn: TurnState): Promise<void> {
    // DC-S7: what the seats considered and cited this turn — whoever sent the message.
    if (this.deps.onTurnRecorded !== undefined) {
      await this.deps.onTurnRecorded(turn.chat, turn.turnId).catch((err: unknown) =>
        this.log(`[decisions] considered for chat ${turn.chat} turn ${turn.turnId}: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
    // §4.3.1: an agent's words are not a decision source. The block was still stripped and counted.
    if (turn.actor.kind !== 'human') return;
    const recorder = pickRecorder(turn.seats);
    const own = recorder !== undefined ? (turn.replies.get(recorder) ?? null) : null;
    if (own === null) this.unclassified += 1;
    const projectId = this.deps.projectOf(turn.chat) ?? null;
    const haystack = norm(turn.text);
    const records: DecisionRecord[] = [];
    if (own !== null && recorder !== undefined) {
      for (const item of own.items) {
        const quote = norm(item.quote);
        if (quote === '' || !haystack.includes(quote)) {
          this.log(`[decisions] chat ${turn.chat} turn ${turn.turnId}: ${recorder} quote not found in the operator's message; dropped`);
          continue;
        }
        const labels: DecisionModelLabels = {
          is_decision: true,
          type: item.type,
          codify: item.codify,
          ambiguous: item.ambiguous,
          steering_type: item.steering_type,
          same_as: item.same_as,
          approves_proposal: item.approves_proposal,
          recorder,
        };
        const votes: Array<{ cli_key: string; type: DecisionType; codify: boolean }> = [];
        for (const [cliKey, other] of turn.replies) {
          if (cliKey === recorder || other === null) continue;
          const vote = other.items.find((o) => norm(o.quote) === quote);
          if (vote !== undefined) votes.push({ cli_key: cliKey, type: vote.type, codify: vote.codify });
        }
        const approved = item.approves_proposal && item.decision_text !== undefined;
        const record = await ingestDecision(this.deps.service, {
          host: 'studio-chat',
          actor: turn.actor,
          words: quote,
          projectId,
          chatId: turn.chat,
          turnId: turn.turnId,
          labels,
          votes,
          proposal:
            approved && turn.prevTurnId !== undefined
              ? { turn_id: turn.prevTurnId, cli_key: recorder, excerpt: item.decision_text!.slice(0, 300) }
              : null,
          ...(approved ? { statement: item.decision_text } : {}),
        });
        if (record !== null) records.push(record);
      }
    }
    if (records.length === 0) {
      // No usable block, or no quote that matched: the words are recorded as typed, and the
      // deterministic derivation alone decides the route (§4.3.3 fails open, no regex fallback).
      const record = await ingestDecision(this.deps.service, {
        host: 'studio-chat',
        actor: turn.actor,
        words: turn.text,
        projectId,
        chatId: turn.chat,
        turnId: turn.turnId,
      });
      if (record !== null) records.push(record);
    }
    if (records.length === 0) return; // WICKED_DECISIONS=off, or nothing to record
    this.recorded += 1;
    const items: DecisionView[] = [];
    for (const r of records) {
      const view = this.deps.service.deps.ledger.view(r.id);
      if (view !== null) items.push(view);
    }
    const frame = {
      type: 'chatDecisions',
      chat: turn.chat,
      turn_id: turn.turnId,
      items,
      ...(projectId !== null ? { project_id: projectId } : {}),
    };
    this.deps.broadcast(frame as unknown as CoreEvent);
    this.deps.transcripts.recordDecisions({ chat: turn.chat, turnId: turn.turnId, items });
  }
}
