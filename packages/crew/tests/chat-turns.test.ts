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

  beforeEach(async () => {
    launched = [];
    proposed = [];
    approved = [];
    cancelled = [];
    runStatus = 'awaiting_human';
    holdLaunch = null;
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
          if (holdLaunch !== null) await holdLaunch.promise;
          if ((input['plan'] as { steps: Array<{ instructions: string }> }).steps[0]!.instructions === 'refuse-me') {
            throw new Error('engine refused this launch');
          }
          return `run-${launched.length}`;
        },
        sessionsDetail: async () => [{ session: { id: 'run-1', status: runStatus }, units: [] }],
        proposePlan: async (runId: string, plan: unknown, requestId: string) => {
          proposed.push({ runId, plan, requestId });
          return { ok: true };
        },
        confirmGate: async (runId: string) => {
          approved.push(runId);
          return 'awaiting_human';
        },
        cancelRun: async (runId: string) => {
          cancelled.push(runId);
          return 'cancelled';
        },
      } as unknown as CoreAdapter,
      new GateCache(),
      new ElicitationCache(),
      undefined,
      undefined,
      { chatTurns: turns, chatTranscripts: transcripts, askPaths, signedIn: () => null },
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
