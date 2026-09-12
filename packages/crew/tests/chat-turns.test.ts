// F-RECON-017: a message sent while a targeted seat is still answering is REFUSED (409
// `turn_in_flight`, naming the turn + busy seats), never queued silently; the 202 carries the
// `turnId`; the seat's reply frames leave the daemon stamped with `turn_id`. Index unit + the route.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChatTurnIndex } from '../src/api/chat-turns.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes } from '../src/api/routes.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent } from '../src/core/types.js';

describe('ChatTurnIndex', () => {
  it('begin → inFlight for the seats the send reached; a seat ends its part on chatReply / chatSessionFailed', () => {
    let now = 1_000;
    const idx = new ChatTurnIndex({ now: () => now });
    const turn = idx.begin('c1', ['claude', 'opencode'], 'Where does the evidence come from?')!;
    expect(turn.pending).toEqual(['claude', 'opencode']);
    now += 5_000;
    const busy = idx.inFlight('c1')!;
    expect(busy).toEqual(expect.objectContaining({ turnId: turn.turnId, busy: ['claude', 'opencode'], ageMs: 5_000 }));
    // Targeting only an idle seat (none here) — every targeted seat is busy → refused.
    expect(idx.inFlight('c1', ['claude'])!.busy).toEqual(['claude']);
    idx.observe({ type: 'chatReply', chat: 'c1', cliKey: 'claude', text: 'answer', ok: true } as CoreEvent);
    // claude is idle now: a send targeting claude passes; one targeting opencode (still mid-turn) is refused.
    expect(idx.inFlight('c1', ['claude'])).toBeNull();
    expect(idx.inFlight('c1', ['opencode'])!.busy).toEqual(['opencode']);
    expect(idx.inFlight('c1')!.busy).toEqual(['opencode']);
    idx.observe({ type: 'chatSessionFailed', chat: 'c1', cliKey: 'opencode', reason: 'TimedOut' } as CoreEvent);
    expect(idx.inFlight('c1')).toBeNull();
    expect(idx.turnsOf('c1')).toEqual([]);
  });

  it('decorate stamps turn_id on a seat\'s chatDelta/chatReply while mid-turn (call BEFORE observe); other frames untouched', () => {
    const idx = new ChatTurnIndex();
    const turn = idx.begin('c1', ['claude'], 'q')!;
    const delta = idx.decorate({ type: 'chatDelta', chat: 'c1', cliKey: 'claude', text: 'partial' } as CoreEvent);
    expect(delta['turn_id']).toBe(turn.turnId);
    const reply = { type: 'chatReply', chat: 'c1', cliKey: 'claude', text: 'done', ok: true } as CoreEvent;
    expect(idx.decorate(reply)['turn_id']).toBe(turn.turnId);
    idx.observe(reply);
    // After the seat ended its part, a late frame carries no stamp.
    expect('turn_id' in idx.decorate({ type: 'chatDelta', chat: 'c1', cliKey: 'claude', text: 'x' } as CoreEvent)).toBe(false);
    const other = { type: 'sessionCompleted', session: 'r1' } as CoreEvent;
    expect(idx.decorate(other)).toBe(other);
  });

  it('a turn whose frames were lost goes STALE after the ceiling and never wedges the chat; chatClosed/closed drop everything', () => {
    let now = 0;
    const idx = new ChatTurnIndex({ now: () => now, staleAfterMs: 10_000 });
    idx.begin('c1', ['claude'], 'q');
    now = 9_999;
    expect(idx.inFlight('c1')).not.toBeNull();
    now = 10_000;
    expect(idx.inFlight('c1')).toBeNull();
    idx.begin('c2', ['claude'], 'q');
    idx.observe({ type: 'chatClosed', chat: 'c2' } as CoreEvent);
    expect(idx.inFlight('c2')).toBeNull();
    idx.begin('c3', ['claude'], 'q');
    idx.closed('c3');
    expect(idx.inFlight('c3')).toBeNull();
    expect(idx.begin('c4', [], 'nothing reached')).toBeNull();
  });
});

describe('POST /chats/:id/messages — refuse mid-turn, correlate replies (F-RECON-017)', () => {
  let app: FastifyInstance;
  let turns: ChatTurnIndex;
  let sent: Array<{ text: string; targets?: string[] }>;
  let seatsReached: string[];

  beforeEach(async () => {
    sent = [];
    seatsReached = ['claude', 'opencode'];
    turns = new ChatTurnIndex();
    app = Fastify({ logger: false });
    registerRoutes(
      app,
      {
        chatSend: async (_id: string, text: string, targets?: string[]) => {
          sent.push({ text, ...(targets !== undefined ? { targets } : {}) });
          return targets ?? seatsReached;
        },
        chatClose: async () => undefined,
      } as unknown as CoreAdapter,
      new GateCache(),
      new ElicitationCache(),
      undefined,
      undefined,
      undefined,
      { chatTurns: turns, signedIn: () => null },
    );
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  const send = (body: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/v1/chats/e057/messages', payload: body });

  it('202 carries the turnId; a second send while a targeted seat is mid-turn is 409 turn_in_flight naming the turn + busy seats; nothing is sent', async () => {
    const first = await send({ text: 'Q2: which repos consume api-types?' });
    expect(first.statusCode).toBe(202);
    const body1 = first.json() as { seats: string[]; turnId: string };
    expect(body1.seats).toEqual(['claude', 'opencode']);
    expect(typeof body1.turnId).toBe('string');

    const second = await send({ text: 'Q3: where does evidence come from?' });
    expect(second.statusCode).toBe(409);
    const body2 = second.json() as { code: string; error: string; chatId: string; turn: { turnId: string; busy: string[]; excerpt: string } };
    expect(body2.code).toBe('turn_in_flight');
    expect(body2.chatId).toBe('e057');
    expect(body2.turn.turnId).toBe(body1.turnId);
    expect(body2.turn.busy).toEqual(['claude', 'opencode']);
    expect(body2.turn.excerpt).toContain('Q2');
    expect(body2.error).toMatch(/still answering the previous message/);
    expect(sent.length, 'the refused message never reached the engine').toBe(1);
  });

  it('a send that targets only IDLE seats passes while another seat is still answering; a seat\'s reply frees it', async () => {
    const first = await send({ text: 'Q1' });
    const turn1 = (first.json() as { turnId: string }).turnId;
    // claude replied; opencode still "thinking" (the recon's 300 s stall).
    turns.observe({ type: 'chatReply', chat: 'e057', cliKey: 'claude', text: 'a', ok: true } as CoreEvent);
    expect((await send({ text: 'follow-up for everyone' })).statusCode).toBe(409);
    const targeted = await send({ text: 'follow-up for claude', targets: ['claude'] });
    expect(targeted.statusCode).toBe(202);
    const turn2 = (targeted.json() as { turnId: string }).turnId;
    expect(turn2).not.toBe(turn1);
    expect(sent.at(-1)).toEqual({ text: 'follow-up for claude', targets: ['claude'] });
    // The frames of each seat are stamped with the turn THEY answer — Q2's reply can no longer land under Q3's bubble.
    expect(turns.decorate({ type: 'chatReply', chat: 'e057', cliKey: 'opencode', text: 'late', ok: true } as CoreEvent)['turn_id']).toBe(turn1);
    expect(turns.decorate({ type: 'chatDelta', chat: 'e057', cliKey: 'claude', text: 'x' } as CoreEvent)['turn_id']).toBe(turn2);
  });

  it('DELETE /chats/:id drops the chat\'s turns (a reopened id starts clean)', async () => {
    await send({ text: 'Q1' });
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/chats/e057' })).statusCode).toBe(200);
    expect((await send({ text: 'Q1 again' })).statusCode).toBe(202);
  });
});
