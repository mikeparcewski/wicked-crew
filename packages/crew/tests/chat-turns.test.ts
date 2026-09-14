// F-RECON-017: a message sent while a targeted seat is still answering is REFUSED (409
// `turn_in_flight`, naming the turn + busy seats), never queued silently; the 202 carries the
// `turnId`; the seat's reply frames leave the daemon stamped with `turn_id`. Index unit + the route.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatTranscriptStore } from '../src/api/chat-transcripts.js';
import {
  CHAT_TURN_BUDGET_SECS_DEFAULT,
  CHAT_TURN_STALE_BUDGETS,
  ChatTurnIndex,
  chatTurnBudgetSecs,
  chatTurnStaleAfterMs,
} from '../src/api/chat-turns.js';
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

  it('DES-L5 R16: the budget is the engine\'s WICKED_CHAT_TURN_SECS (default 600) and the stale ceiling is 3× it', () => {
    expect(CHAT_TURN_BUDGET_SECS_DEFAULT).toBe(600);
    expect(chatTurnBudgetSecs({})).toBe(600);
    expect(chatTurnBudgetSecs({ WICKED_CHAT_TURN_SECS: '5' })).toBe(5);
    // Garbage, zero and negatives fall back — never a NaN ceiling that wedges or never wedges.
    for (const bad of ['', 'soon', '0', '-3']) {
      expect(chatTurnBudgetSecs({ WICKED_CHAT_TURN_SECS: bad })).toBe(600);
    }
    expect(CHAT_TURN_STALE_BUDGETS).toBe(3);
    expect(chatTurnStaleAfterMs({})).toBe(3 * 600 * 1000);
    expect(chatTurnStaleAfterMs({ WICKED_CHAT_TURN_SECS: '5' })).toBe(15_000);
    // The index's default ceiling IS the derived one (30 min at the default, was 15).
    let now = 0;
    const idx = new ChatTurnIndex({ now: () => now });
    idx.begin('c1', ['claude'], 'q');
    now = 30 * 60_000 - 1;
    expect(idx.inFlight('c1')).not.toBeNull();
    now = 30 * 60_000;
    expect(idx.inFlight('c1')).toBeNull();
  });

  it('DES-L5: reconcile squares the reserved audience with the engine\'s answer; abort retracts a refused send', () => {
    const idx = new ChatTurnIndex();
    // Reserved for claude + opencode; the engine reached claude + pi (opencode dropped, pi added).
    const t = idx.begin('c1', ['claude', 'opencode'], 'q')!;
    // A fast frame between begin and reconcile already ended claude's part.
    idx.observe({ type: 'chatReply', chat: 'c1', cliKey: 'claude', text: 'a', ok: true } as CoreEvent);
    const after = idx.reconcile('c1', t.turnId, ['claude', 'pi'])!;
    expect(after.seats).toEqual(['claude', 'pi']);
    expect(after.pending, 'opencode was never reached; claude already ended; pi joins').toEqual(['pi']);
    expect(idx.inFlight('c1', ['opencode'])).toBeNull();
    expect(idx.inFlight('c1', ['pi'])!.busy).toEqual(['pi']);
    // An empty answer ends the turn; an unknown turn is a no-op.
    const t2 = idx.begin('c2', ['claude'], 'q')!;
    expect(idx.reconcile('c2', t2.turnId, [])).toBeNull();
    expect(idx.inFlight('c2')).toBeNull();
    expect(idx.reconcile('c2', 'no-such-turn', ['claude'])).toBeNull();
    // abort: the reservation goes, other turns of the chat stay.
    const t3 = idx.begin('c3', ['claude'], 'q')!;
    const t4 = idx.begin('c3', ['opencode'], 'q')!;
    idx.abort('c3', t3.turnId);
    expect(idx.turnsOf('c3').map((x) => x.turnId)).toEqual([t4.turnId]);
    idx.abort('c3', t4.turnId);
    expect(idx.inFlight('c3')).toBeNull();
    idx.abort('nope', 'x'); // no throw
  });
});

describe('POST /chats/:id/messages — refuse mid-turn, correlate replies (F-RECON-017)', () => {
  let app: FastifyInstance;
  let turns: ChatTurnIndex;
  let transcripts: ChatTranscriptStore;
  let transcriptDir: string;
  let sent: Array<{ text: string; targets?: string[] }>;
  let seatsReached: string[];
  /** When set, `chatSend` parks until released — the F-E2E-041 window under test. */
  let holdSend: { promise: Promise<void>; release: () => void } | null;

  beforeEach(async () => {
    sent = [];
    seatsReached = ['claude', 'opencode'];
    holdSend = null;
    turns = new ChatTurnIndex();
    transcriptDir = mkdtempSync(join(tmpdir(), 'chat-transcripts-'));
    transcripts = new ChatTranscriptStore({ dir: join(transcriptDir, 'chats') });
    app = Fastify({ logger: false });
    registerRoutes(
      app,
      {
        chatSeats: async () => seatsReached,
        chatSend: async (_id: string, text: string, targets?: string[]) => {
          sent.push({ text, ...(targets !== undefined ? { targets } : {}) });
          if (holdSend !== null) await holdSend.promise;
          if (text === 'refuse-me') throw new Error('engine refused this send');
          return targets ?? seatsReached;
        },
        chatClose: async () => undefined,
      } as unknown as CoreAdapter,
      new GateCache(),
      new ElicitationCache(),
      undefined,
      undefined,
      undefined,
      { chatTurns: turns, chatTranscripts: transcripts, signedIn: () => null },
    );
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    rmSync(transcriptDir, { recursive: true, force: true });
  });

  const stamp = (event: CoreEvent): void => {
    // The daemon's frame hook, in order: stamp → transcript → fold (server.ts).
    const stamped = turns.decorate(event);
    transcripts.observe(stamped);
    turns.observe(event);
  };

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

  it('F-E2E-041: two CONCURRENT sends → exactly one 202 and one 409 turn_in_flight; a delta during the engine call is already stamped', async () => {
    let release: () => void = () => undefined;
    holdSend = { promise: new Promise<void>((r) => { release = r; }), release: () => release() };
    const a = send({ text: 'Q-a' });
    const b = send({ text: 'Q-b' });
    // Both requests are in flight; the engine has not answered the first. Before DES-L5 the second
    // passed `inFlight` here (the turn was opened only AFTER `chatSend` resolved) — two 202s.
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.length, 'only ONE message reached the engine').toBe(1);
    // A delta that lands while `chatSend` is still pending carries the turn it answers.
    const early = turns.decorate({ type: 'chatDelta', chat: 'e057', cliKey: 'claude', text: 'thinking…' } as CoreEvent);
    expect(typeof early['turn_id']).toBe('string');
    holdSend.release();
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([202, 409]);
    const refused = ra.statusCode === 409 ? ra : rb;
    const accepted = ra.statusCode === 202 ? ra : rb;
    expect((refused.json() as { code: string }).code).toBe('turn_in_flight');
    expect((refused.json() as { turn: { turnId: string } }).turn.turnId).toBe((accepted.json() as { turnId: string }).turnId);
    expect(early['turn_id']).toBe((accepted.json() as { turnId: string }).turnId);
  });

  it('a send the engine refuses retracts its reservation (the next send is not refused for it); an empty audience is 409 "no warm seats"', async () => {
    // Nothing warm and no targets: refused BEFORE the engine is asked, nothing reserved.
    seatsReached = [];
    const empty = await send({ text: 'nobody home' });
    expect(empty.statusCode).toBe(409);
    expect((empty.json() as { error: string }).error).toMatch(/no warm seats/);
    expect(sent.length, 'nothing reached the engine for an empty audience').toBe(0);
    expect(turns.inFlight('e057')).toBeNull();
    // The engine refuses the send: the reservation `begin` made is ABORTED, so the next send passes.
    seatsReached = ['claude'];
    const refused = await send({ text: 'refuse-me' });
    expect(refused.statusCode).toBe(400);
    expect(turns.inFlight('e057'), 'a refused send leaves no turn behind').toBeNull();
    expect((await send({ text: 'ok', targets: ['claude'] })).statusCode).toBe(202);
    expect(turns.inFlight('e057', ['claude'])!.busy).toEqual(['claude']);
  });

  it('DES-L5 (D-13): the transcript — user + stamped seat replies in order with usage on GET /chats/:id.messages; an unstamped reply is not persisted; chatClosed drops the file', async () => {
    const first = await send({ text: 'Q1: what does the estate index?' });
    const turnId = (first.json() as { turnId: string }).turnId;
    stamp({ type: 'chatDelta', chat: 'e057', cliKey: 'claude', text: 'code, ' } as CoreEvent);
    stamp({
      type: 'chatReply', chat: 'e057', cliKey: 'claude', text: 'code, memory and knowledge', ok: true,
      usage: { inputTokens: 120, outputTokens: 8, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null },
    } as CoreEvent);
    stamp({
      type: 'chatReply', chat: 'e057', cliKey: 'opencode', ok: false, usage: null,
      text: "seat 'opencode' exceeded the 600 s turn budget (WICKED_CHAT_TURN_SECS) and was released — target it on your next message to re-seat it. Partial reply before the cut:\n…",
    } as CoreEvent);
    // A straggler AFTER the turn ended carries no turn_id → never persisted.
    stamp({ type: 'chatReply', chat: 'e057', cliKey: 'opencode', text: 'late', ok: true } as CoreEvent);
    const detail = await app.inject({ method: 'GET', url: '/api/v1/chats/e057' });
    expect(detail.statusCode).toBe(200);
    const messages = (detail.json() as { messages: Array<Record<string, unknown>> }).messages;
    expect(messages.map((m) => [m['kind'], m['turnId'], m['cliKey'] ?? null])).toEqual([
      ['user', turnId, null],
      ['seat', turnId, 'claude'],
      ['seat', turnId, 'opencode'],
    ]);
    expect(messages[0]).toMatchObject({ text: 'Q1: what does the estate index?', seats: ['claude', 'opencode'] });
    expect(messages[1]).toMatchObject({ ok: true, usage: { inputTokens: 120, outputTokens: 8, costUsd: null } });
    expect(messages[2]).toMatchObject({ ok: false, usage: null });
    expect((messages[2] as { text: string }).text).toMatch(/turn budget \(WICKED_CHAT_TURN_SECS\)/);
    for (const m of messages) expect(typeof m['at']).toBe('number');
    if (process.platform !== 'win32') {
      expect(statSync(join(transcriptDir, 'chats')).mode & 0o777).toBe(0o700);
      expect(statSync(join(transcriptDir, 'chats', 'e057.jsonl')).mode & 0o777).toBe(0o600);
    }
    // The engine's chatClosed (any reason) drops the file — the SAME arm server.ts folds for scopes.
    transcripts.drop('e057');
    expect(readdirSync(join(transcriptDir, 'chats'))).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/v1/chats/e057' })).json()).toMatchObject({ messages: [] });
  });
});
