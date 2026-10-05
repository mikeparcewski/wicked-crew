// F-RECON-017: a message sent while a targeted seat is still answering is REFUSED (409
// `turn_in_flight`, naming the turn + busy seats), never queued silently; the 202 carries the
// `turnId`; the seat's reply frames leave the daemon stamped with `turn_id`. Index unit + the route.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { AskPathIndex } from '../src/api/ask-paths.js';
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

describe('POST /chats/:id/messages — an ask starts a PATH; refuse mid-turn; correlate replies (ASK-C1, F-RECON-017)', () => {
  let app: FastifyInstance;
  let turns: ChatTurnIndex;
  let askPaths: AskPathIndex;
  let transcripts: ChatTranscriptStore;
  let transcriptDir: string;
  let launched: Array<Record<string, unknown>>;
  let proposed: Array<{ runId: string; plan: unknown; requestId: string }>;
  let approved: string[];
  let cancelled: string[];
  /** What the fake engine says the path is doing right now. */
  let runStatus: string;
  /** When set, `launchRun` parks until released — the F-E2E-041 window under test. */
  let holdLaunch: { promise: Promise<void>; release: () => void } | null;
  /** When set, `proposePlan` parks until released — the continuation window (codex on #808, 1). */
  let holdPropose: { promise: Promise<void>; release: () => void } | null;
  /** Per message text: a launch that parks until released (codex on #808 r2, 1 — two launches of
   *  two generations in flight at once). */
  let holdFor: Map<string, { promise: Promise<void>; release: () => void }>;
  /** When set, `cancelRun` parks until released (codex on #808 r2, 2). */
  let holdCancel: { promise: Promise<void>; release: () => void } | null;
  /** When set, the status read (`sessionsDetail`) parks until released (codex on #808 r3, 2). */
  let holdStatus: { promise: Promise<void>; release: () => void } | null;
  /** The rules in force, as the fake engine's `considerRules` answers (codex on #808 r2, 7+8). */
  let rulesNow: Array<{ id: string; statement: string; severity: string; targets: Record<string, unknown> }>;
  const gate = (): { promise: Promise<void>; release: () => void } => {
    let release: () => void = () => undefined;
    const promise = new Promise<void>((r) => { release = r; });
    return { promise, release: () => release() };
  };
  /** The server's event fold, as `registerRoutes` is handed it (codex on #808, 5). */
  let closeChat: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    launched = [];
    proposed = [];
    approved = [];
    cancelled = [];
    runStatus = 'awaiting_human';
    holdLaunch = null;
    holdPropose = null;
    holdFor = new Map();
    holdCancel = null;
    holdStatus = null;
    rulesNow = [];
    closeChat = vi.fn();
    turns = new ChatTurnIndex();
    askPaths = new AskPathIndex();
    transcriptDir = mkdtempSync(join(tmpdir(), 'chat-transcripts-'));
    transcripts = new ChatTranscriptStore({ dir: join(transcriptDir, 'chats') });
    app = Fastify({ logger: false });
    registerRoutes(
      app,
      {
        launchRun: async (input: Record<string, unknown>) => {
          launched.push(input);
          const n = launched.length;
          const text = (input['plan'] as { steps: Array<{ instructions: string }> }).steps[0]!.instructions;
          if (holdLaunch !== null) await holdLaunch.promise;
          const held = holdFor.get(text);
          if (held !== undefined) await held.promise;
          if (text.endsWith('refuse-me')) throw new Error('engine refused this launch');
          return `run-${n}`;
        },
        projectRulesSupported: () => true,
        considerRules: async () => ({ in_force: rulesNow, set_aside: [] }),
        sessionsDetail: async () => {
          if (holdStatus !== null) await holdStatus.promise;
          return [{ session: { id: 'run-1', status: runStatus }, units: [] }];
        },
        proposePlan: async (runId: string, plan: unknown, requestId: string) => {
          if (holdPropose !== null) await holdPropose.promise;
          proposed.push({ runId, plan, requestId });
          return { ok: true };
        },
        chatList: async () => [{ chatId: 'pool-only', seats: ['claude'], idleSecs: 3 }],
        confirmGate: async (runId: string) => {
          approved.push(runId);
          return 'awaiting_human';
        },
        cancelRun: async (runId: string) => {
          if (holdCancel !== null) await holdCancel.promise;
          cancelled.push(runId);
          return 'cancelled';
        },
      } as unknown as CoreAdapter,
      new GateCache(),
      new ElicitationCache(),
      undefined,
      undefined,
      { chatTurns: turns, chatTranscripts: transcripts, askPaths, signedIn: () => null, closeChat: closeChat as unknown as (frame: CoreEvent) => void },
    );
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    rmSync(transcriptDir, { recursive: true, force: true });
  });

  const stamp = (event: CoreEvent): void => {
    const stamped = turns.decorate(event);
    transcripts.observe(stamped);
    turns.observe(event);
  };

  /** The chat as `POST /chats` leaves it: eligible seats recorded, nothing warmed. */
  const opened = (chatId: string, eligible: string[], primary?: string) => askPaths.open(chatId, eligible, primary);
  const send = (body: Record<string, unknown>, chatId = 'e057') =>
    app.inject({ method: 'POST', url: `/api/v1/chats/${chatId}/messages`, payload: body });

  it('the FIRST message launches ONE path with the §5.1 body: one `understand` step at the turn gate with the message as its instructions, one reviewer asked, the eligible roster, the chosen primary; 202 carries turnId/runId/stepId', async () => {
    opened('e057', ['claude', 'opencode'], 'claude');
    const first = await send({ text: 'Q2: which repos consume api-types?' });
    expect(first.statusCode).toBe(202);
    const body = first.json() as { seats: string[]; turnId: string; runId: string; stepId: string };
    expect(body.seats).toEqual(['claude']);
    expect(typeof body.turnId).toBe('string');
    expect(body.runId).toBe('run-1');
    expect(body.stepId).toBe('answer-1');
    expect(launched).toHaveLength(1);
    const input = launched[0]!;
    expect(input['primary']).toBe('claude');
    expect(input['plan']).toEqual({
      steps: [
        {
          catalog: 'understand',
          id: 'answer-1',
          gate: { human_confirm: { unconditional: true } },
          budget_secs: 600,
          instructions: 'Q2: which repos consume api-types?',
        },
      ],
      monitors: { asked: 1 },
    });
    expect(input['humanConfirm'], 'auto mode: the turn gate is the step\'s own').toBeUndefined();
    expect(input['workflow'], 'a user-composed plan, not a preset').toBeUndefined();
    expect(JSON.parse(input['clisJson'] as string).map((c: { key: string }) => c.key).sort()).toEqual(['claude', 'opencode']);
    expect(askPaths.view('e057')).toMatchObject({ runId: 'run-1', pa: 'claude', selection: 'chosen', stepId: 'answer-1' });
  });

  it('a random pick sends NO primary and answers with no voice yet (the engine picks; the relay fills `pa` from path.started)', async () => {
    opened('e057', ['claude', 'opencode']);
    const first = await send({ text: 'Q1' });
    expect(first.statusCode).toBe(202);
    expect((first.json() as { seats: string[] }).seats).toEqual([]);
    expect(launched[0]!['primary']).toBeUndefined();
    expect(askPaths.view('e057')).toMatchObject({ pa: null, selection: 'random' });
  });

  it('a second message while the PA is still answering is 409 turn_in_flight and sends nothing; once the path waits at its turn gate, the message CONTINUES the path: propose_plan(answer-2) then confirm_gate(Approve)', async () => {
    opened('e057', ['claude', 'opencode'], 'claude');
    const first = await send({ text: 'Q1' });
    const turn1 = (first.json() as { turnId: string }).turnId;
    runStatus = 'executing';
    const busy = await send({ text: 'Q2 too soon' });
    expect(busy.statusCode).toBe(409);
    const body = busy.json() as { code: string; error: string; chatId: string; runId: string };
    expect(body.code).toBe('turn_in_flight');
    expect(body.chatId).toBe('e057');
    expect(body.runId).toBe('run-1');
    expect(body.error).toMatch(/claude is still answering the previous message/);
    expect(proposed, 'nothing reached the engine').toHaveLength(0);
    runStatus = 'awaiting_human';
    const next = await send({ text: 'Q2: and the evidence?' });
    expect(next.statusCode).toBe(202);
    const nb = next.json() as { turnId: string; runId: string; stepId: string };
    expect(nb.runId).toBe('run-1');
    expect(nb.stepId).toBe('answer-2');
    expect(nb.turnId).not.toBe(turn1);
    expect(proposed).toEqual([
      {
        runId: 'run-1',
        plan: { steps: [{ catalog: 'understand', id: 'answer-2', gate: { human_confirm: { unconditional: true } }, budget_secs: 600, instructions: 'Q2: and the evidence?' }] },
        requestId: nb.turnId,
      },
    ]);
    expect(approved).toEqual(['run-1']);
    expect(launched, 'one path per chat').toHaveLength(1);
  });

  it('DELETE /chats/:id cancels the path and drops the chat; a chat this daemon did not open is 409, not a fresh fan-out', async () => {
    opened('e057', ['claude']);
    await send({ text: 'Q1' });
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/chats/e057' })).statusCode).toBe(200);
    expect(cancelled).toEqual(['run-1']);
    const after = await send({ text: 'Q1 again' });
    expect(after.statusCode).toBe(409);
    expect((after.json() as { error: string }).error).toMatch(/not open on this daemon/);
    expect(launched, 'nothing launched for a closed chat').toHaveLength(1);
  });

  it('codex on #808 (1): two CONCURRENT continuations → exactly one proposal + approval; the loser is 409 turn_in_flight (the reservation spans status read → proposal → approval)', async () => {
    opened('e057', ['claude'], 'claude');
    await send({ text: 'Q1' });
    let release: () => void = () => undefined;
    holdPropose = { promise: new Promise<void>((r) => { release = r; }), release: () => release() };
    const a = send({ text: 'Q2-a' });
    const b = send({ text: 'Q2-b' });
    await new Promise((r) => setTimeout(r, 20));
    holdPropose.release();
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([202, 409]);
    expect(proposed, 'ONE continuation reached the engine').toHaveLength(1);
    expect(approved, 'and ONE approval (a launch is not approved — it has no gate yet)').toEqual(['run-1']);
    const loser = ra.statusCode === 409 ? ra : rb;
    expect(loser.json()).toMatchObject({ code: 'turn_in_flight', runId: 'run-1' });
    // The reservation is released with the reply: a third message continues.
    expect((await send({ text: 'Q3' })).statusCode).toBe(202);
    expect(proposed).toHaveLength(2);
  });

  it('codex on #808 (2): DELETE while the first message is still LAUNCHING — the launch resolves to a run nobody owns: cancelled, the message is 409, no path survives', async () => {
    opened('e057', ['claude'], 'claude');
    let release: () => void = () => undefined;
    holdLaunch = { promise: new Promise<void>((r) => { release = r; }), release: () => release() };
    const first = send({ text: 'Q1' });
    await new Promise((r) => setTimeout(r, 20));
    expect(launched).toHaveLength(1);
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/chats/e057' })).statusCode).toBe(200);
    expect(cancelled, 'nothing to cancel yet — the run id is not known').toEqual([]);
    // The id is reopened meanwhile (a newer chat must not inherit the orphan run).
    opened('e057', ['claude'], 'claude');
    holdLaunch.release();
    const res = await first;
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toMatch(/closed while its path was launching/);
    expect(cancelled, 'the orphan run was cancelled').toEqual(['run-1']);
    expect(askPaths.view('e057'), 'the newcomer has no path').toBeUndefined();
    expect(turns.inFlight('e057')).toBeNull();
  });

  it('codex on #808 r2 (1): a request of an OLD generation cannot free the newcomer\'s reservation — the lease is the generation', async () => {
    opened('e057', ['claude'], 'claude');
    holdFor.set('A-refuse-me', gate());
    holdFor.set('B', gate());
    const a = send({ text: 'A-refuse-me' }); // generation 1, parked
    await new Promise((r) => setTimeout(r, 20));
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/chats/e057' })).statusCode).toBe(200);
    opened('e057', ['claude'], 'claude'); // generation 2
    const b = send({ text: 'B' }); // parked, holds generation 2's reservation
    await new Promise((r) => setTimeout(r, 20));
    holdFor.get('A-refuse-me')!.release(); // A is refused by the engine: its catch releases ITS lease only
    expect((await a).statusCode).toBe(400);
    const c = await send({ text: 'C' });
    expect(c.statusCode, 'B still holds the chat').toBe(409);
    expect((c.json() as { code: string }).code).toBe('turn_in_flight');
    holdFor.get('B')!.release();
    expect((await b).statusCode).toBe(202);
    expect(askPaths.view('e057')).toMatchObject({ runId: 'run-2' });
    expect(launched.map((l) => (l['plan'] as { steps: Array<{ instructions: string }> }).steps[0]!.instructions)).toEqual(['A-refuse-me', 'B']);
  });

  it('codex on #808 r3 (2): a continuation parked on its status read while the chat is closed and its id reopened lands NOTHING on the newcomer', async () => {
    opened('e057', ['claude'], 'claude');
    await send({ text: 'Q1' });
    holdStatus = gate();
    const q2 = send({ text: 'Q2' }); // generation 1, parked on sessionsDetail
    await new Promise((r) => setTimeout(r, 20));
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/chats/e057' })).statusCode).toBe(200);
    opened('e057', ['claude'], 'claude'); // generation 2
    holdStatus.release();
    const res = await q2;
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toMatch(/closed while the message was in flight/);
    expect(proposed, 'no proposal reached the engine for the cancelled run').toHaveLength(0);
    expect(askPaths.get('e057')!.steps, 'the newcomer\'s record is untouched').toEqual([]);
    expect(transcripts.read('e057').filter((r) => r.kind === 'user' && r.text === 'Q2')).toEqual([]);
    // The newcomer launches as usual.
    expect((await send({ text: 'Q1 again' })).statusCode).toBe(202);
    expect(askPaths.view('e057')).toMatchObject({ runId: 'run-2', stepId: 'answer-1' });
  });

  it('codex on #808 r3 (4): a re-seat while the FIRST message is launching is 409 turn_in_flight — the launch roster is already captured', async () => {
    opened('e057', ['claude'], 'claude');
    holdLaunch = gate();
    const first = send({ text: 'Q1' });
    await new Promise((r) => setTimeout(r, 20));
    const reseat = await app.inject({ method: 'POST', url: '/api/v1/chats/e057/seats', payload: { clis: ['opencode'] } });
    expect(reseat.statusCode).toBe(409);
    expect(reseat.json()).toMatchObject({ code: 'turn_in_flight' });
    expect(askPaths.get('e057')!.eligible).toEqual(['claude']);
    holdLaunch.release();
    expect((await first).statusCode).toBe(202);
  });

  it('codex on #808 r5 (1): a second DELETE while the first is still settling JOINS it — one fold, both 200, the id stays held until the fold frees it', async () => {
    opened('e057', ['claude'], 'claude');
    await send({ text: 'Q1' });
    const fold = gate();
    closeChat.mockImplementationOnce(() => fold.promise);
    const d1 = app.inject({ method: 'DELETE', url: '/api/v1/chats/e057' });
    await new Promise((r) => setTimeout(r, 20));
    const d2 = await app.inject({ method: 'DELETE', url: '/api/v1/chats/e057' });
    expect(d2.statusCode, 'the second DELETE answers at once').toBe(200);
    expect(closeChat, 'and runs no second fold').toHaveBeenCalledTimes(1);
    expect(typeof closeChat.mock.calls[0]![2], 'the fold is handed the hold ticket').toBe('number');
    fold.release();
    expect((await d1).statusCode).toBe(200);
    expect(cancelled).toEqual(['run-1']);
  });

  it('codex on #808 r4 (1): DELETE AWAITS the server\'s close fold (the decision recorder settles under the chat\'s own project) before it answers', async () => {
    opened('e057', ['claude'], 'claude');
    await send({ text: 'Q1' });
    const fold = gate();
    closeChat.mockImplementationOnce(() => fold.promise);
    let answered = false;
    const del = app.inject({ method: 'DELETE', url: '/api/v1/chats/e057' }).then((r) => { answered = true; return r; });
    await new Promise((r) => setTimeout(r, 20));
    expect(closeChat).toHaveBeenCalledTimes(1);
    expect(answered, 'not before the fold settled').toBe(false);
    fold.release();
    expect((await del).statusCode).toBe(200);
    expect(cancelled).toEqual(['run-1']);
  });

  it('codex on #808 r2 (2): DELETE folds the close BEFORE it awaits the cancel — nothing of the closed chat lands after an await', async () => {
    opened('e057', ['claude'], 'claude');
    await send({ text: 'Q1' });
    holdCancel = gate();
    const del = app.inject({ method: 'DELETE', url: '/api/v1/chats/e057' });
    await new Promise((r) => setTimeout(r, 20));
    expect(closeChat, 'the fold ran while the cancel is still pending').toHaveBeenCalledTimes(1);
    expect(cancelled).toEqual([]);
    holdCancel.release();
    expect((await del).statusCode).toBe(200);
    expect(cancelled).toEqual(['run-1']);
    expect(closeChat).toHaveBeenCalledTimes(1);
  });

  it('codex on #808 r2 (6): a re-seat after the path launched is 409 — the roster the run holds cannot be changed; before it, the seat is admitted', async () => {
    opened('e057', ['claude'], 'claude');
    await send({ text: 'Q1' });
    const after = await app.inject({ method: 'POST', url: '/api/v1/chats/e057/seats', payload: { clis: ['opencode'] } });
    expect(after.statusCode).toBe(409);
    expect(after.json()).toMatchObject({ runId: 'run-1' });
    expect((after.json() as { error: string }).error).toMatch(/seats are fixed/);
    expect(askPaths.get('e057')!.eligible).toEqual(['claude']);
  });

  it('codex on #808 r2 (7+8): a refused continuation does not consume a fresh rule; the accepted retry carries it in the step and the transcript shows the system row', async () => {
    opened('e057', ['claude'], 'claude');
    await send({ text: 'Q1' }); // seeds what the seats were told (no rules yet)
    rulesNow = [{ id: 'R1', statement: 'Cite the file for every claim', severity: 'high', targets: {} }];
    runStatus = 'executing';
    const refused = await send({ text: 'Q2' });
    expect(refused.statusCode).toBe(409);
    runStatus = 'awaiting_human';
    const ok = await send({ text: 'Q2' });
    expect(ok.statusCode).toBe(202);
    const step = (proposed[0]!.plan as { steps: Array<{ instructions: string }> }).steps[0]!;
    expect(step.instructions, 'the fresh rule rides the accepted step').toMatch(/\[rule:R1\][\s\S]*Q2$/);
    const rows = transcripts.read('e057');
    const system = rows.find((r) => r.kind === 'system');
    expect(system?.text, 'the injected words are on the record').toMatch(/\[rule:R1\]/);
    // Told once: a third message carries no preface.
    expect((await send({ text: 'Q3' })).statusCode).toBe(202);
    expect((proposed[1]!.plan as { steps: Array<{ instructions: string }> }).steps[0]!.instructions).toBe('Q3');
  });

  it('codex on #808 r2 (9): a transcript write that throws AFTER the engine accepted the turn is logged, not a 400 that retracts the turn', async () => {
    opened('e057', ['claude'], 'claude');
    const spy = vi.spyOn(transcripts, 'appendUser').mockImplementationOnce(() => { throw new Error('ENOSPC'); });
    const res = await send({ text: 'Q1' });
    expect(res.statusCode).toBe(202);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(turns.inFlight('e057', ['claude'])!.busy, 'the turn stands').toEqual(['claude']);
    expect(askPaths.view('e057')).toMatchObject({ runId: 'run-1' });
  });

  it('codex on #808 (5+7): DELETE closes through the server\'s fold (the synthetic chatClosed frame); GET /chats lists this daemon\'s paths beside the engine pool', async () => {
    opened('e057', ['claude'], 'claude');
    await send({ text: 'Q1' });
    const list = await app.inject({ method: 'GET', url: '/api/v1/chats' });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { chats: { chatId: string; seats: string[] }[] }).chats).toEqual([
      { chatId: 'e057', seats: ['claude'], idleSecs: null },
      { chatId: 'pool-only', seats: ['claude'], idleSecs: 3 },
    ]);
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/chats/e057' })).statusCode).toBe(200);
    expect(closeChat).toHaveBeenCalledTimes(1);
    expect(closeChat.mock.calls[0]![0]).toMatchObject({ type: 'chatClosed', chat: 'e057', reason: 'closed' });
    expect(closeChat.mock.calls[0]![1], 'the path run whose retention hold the fold releases').toBe('run-1');
    expect((await app.inject({ method: 'GET', url: '/api/v1/chats' })).json()).toEqual({ chats: [{ chatId: 'pool-only', seats: ['claude'], idleSecs: 3 }] });
  });

  it('F-E2E-041: two CONCURRENT first messages → exactly one launch; the loser is 409 turn_in_flight; a delta during the launch is already stamped with the winner\'s turn', async () => {
    opened('e057', ['claude'], 'claude');
    let release: () => void = () => undefined;
    holdLaunch = { promise: new Promise<void>((r) => { release = r; }), release: () => release() };
    const a = send({ text: 'Q-a' });
    const b = send({ text: 'Q-b' });
    await new Promise((r) => setTimeout(r, 20));
    expect(launched.length, 'only ONE launch reached the engine').toBe(1);
    const early = turns.decorate({ type: 'chatDelta', chat: 'e057', cliKey: 'claude', text: 'thinking…' } as CoreEvent);
    expect(typeof early['turn_id']).toBe('string');
    holdLaunch.release();
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([202, 409]);
    const accepted = ra.statusCode === 202 ? ra : rb;
    expect(early['turn_id']).toBe((accepted.json() as { turnId: string }).turnId);
  });

  it('a launch the engine refuses retracts its reservation (the next send is not refused for it); a chat with no eligible seat is 409', async () => {
    opened('none', []);
    const empty = await send({ text: 'nobody home' }, 'none');
    expect(empty.statusCode).toBe(409);
    expect((empty.json() as { error: string }).error).toMatch(/no eligible seat/);
    expect(launched, 'nothing reached the engine with no seat').toHaveLength(0);
    opened('e057', ['claude'], 'claude');
    const refused = await send({ text: 'refuse-me' });
    expect(refused.statusCode).toBe(400);
    expect(turns.inFlight('e057'), 'a refused launch leaves no turn behind').toBeNull();
    expect(askPaths.view('e057'), 'and no path').toBeUndefined();
    expect((await send({ text: 'ok' })).statusCode).toBe(202);
    expect(turns.inFlight('e057', ['claude'])!.busy).toEqual(['claude']);
  });

  it('DES-L5 (D-13): the transcript — the user turn, then the PA\'s stamped reply in order with usage on GET /chats/:id.messages; an unstamped reply is not persisted; the drop clears the file', async () => {
    opened('e057', ['claude', 'opencode'], 'claude');
    const first = await send({ text: 'Q1: what does the estate index?' });
    const turnId = (first.json() as { turnId: string }).turnId;
    stamp({ type: 'chatDelta', chat: 'e057', cliKey: 'claude', text: 'code, ' } as CoreEvent);
    stamp({
      type: 'chatReply', chat: 'e057', cliKey: 'claude', text: 'code, memory and knowledge', ok: true,
      usage: { inputTokens: 120, outputTokens: 8, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null },
    } as CoreEvent);
    // A frame from a seat that is not the PA's turn is unstamped and not persisted (the reviewer's
    // findings and a helper's answers ride the team rows, never the reply channel).
    stamp({ type: 'chatReply', chat: 'e057', cliKey: 'opencode', text: 'late', ok: true } as CoreEvent);
    const detail = await app.inject({ method: 'GET', url: '/api/v1/chats/e057' });
    expect(detail.statusCode).toBe(200);
    const d = detail.json() as { messages: Array<Record<string, unknown>>; path: { runId: string; pa: string } };
    expect(d.path).toMatchObject({ runId: 'run-1', pa: 'claude', selection: 'chosen', stepId: 'answer-1' });
    expect(d.messages.map((m) => [m['kind'], m['turnId'], m['cliKey'] ?? null])).toEqual([
      ['user', turnId, null],
      ['seat', turnId, 'claude'],
    ]);
    expect(d.messages[0]).toMatchObject({ text: 'Q1: what does the estate index?', seats: ['claude'] });
    expect(d.messages[1]).toMatchObject({ ok: true, usage: { inputTokens: 120, outputTokens: 8, costUsd: null } });
    for (const m of d.messages) expect(typeof m['at']).toBe('number');
    if (process.platform !== 'win32') {
      expect(statSync(join(transcriptDir, 'chats')).mode & 0o777).toBe(0o700);
      expect(statSync(join(transcriptDir, 'chats', 'e057.jsonl')).mode & 0o777).toBe(0o600);
    }
    transcripts.drop('e057');
    expect(readdirSync(join(transcriptDir, 'chats'))).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/v1/chats/e057' })).json()).toMatchObject({ messages: [] });
  });
});
