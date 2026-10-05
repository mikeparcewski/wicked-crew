// DC-S4b — the studio chat recorder (DES-decision-capture §4.3.3 + DOC-4 pair framing): the seat's
// fenced `wicked-decisions` block is stripped from the reply before persist and broadcast, the
// recorder is chosen deterministically from the turn's audience, quotes are matched against the
// SAME turn's operator words, other seats' blocks become votes, and the operator's words are
// recorded even when no seat posted a block (the deterministic derivation needs no model).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuditLog } from '../src/api/audit.js';
import { ChatTranscriptStore } from '../src/api/chat-transcripts.js';
import type { Actor, CoreEvent } from '../src/core/types.js';
import {
  ChatDecisionRecorder,
  DECISIONS_FENCE,
  DecisionFenceFilter,
  parseDecisionsBlock,
  splitDecisionsBlock,
} from '../src/decisions/chat-recorder.js';
import { DecisionService } from '../src/decisions/land.js';
import { DecisionLedger } from '../src/decisions/ledger.js';

const HUMAN: Actor = { id: 'op', kind: 'human', trust: 'operator' };
const AGENT: Actor = { id: 'worker', kind: 'agent', trust: 'operator' };

const scratches: string[] = [];
afterEach(() => {
  for (const s of scratches.splice(0)) rmSync(s, { recursive: true, force: true });
});

function block(items: unknown[]): string {
  return `${DECISIONS_FENCE}\n${JSON.stringify({ items })}\n\`\`\``;
}

function harness(opts: { mode?: 'off' | 'ledger' | 'on'; authMode?: 'off' | 'required'; staleAfterMs?: number } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'chat-recorder-'));
  scratches.push(scratch);
  const ledger = new DecisionLedger(join(scratch, 'decisions'));
  const transcripts = new ChatTranscriptStore({ dir: join(scratch, 'chats') });
  let now = 1_000_000;
  const service = new DecisionService({
    ledger,
    mode: opts.mode ?? 'ledger',
    authMode: opts.authMode ?? 'off',
    estateTool: vi.fn(async () => ({})),
    adapter: {
      projectRulesSupported: () => true,
      considerRules: vi.fn(async () => ({ in_force: [], set_aside: [] })),
      listConformanceRules: vi.fn(async () => []),
      upsertConformanceRule: vi.fn(async () => undefined),
      readConformanceRule: vi.fn(async () => null),
      retireConformanceRule: vi.fn(async () => undefined),
    } as never,
    audit: { append: vi.fn(async () => undefined) } as unknown as AuditLog,
    now: () => now,
  });
  const frames: CoreEvent[] = [];
  const logs: string[] = [];
  const recorder = new ChatDecisionRecorder({
    service,
    transcripts,
    broadcast: (f) => frames.push(f),
    projectOf: (chat) => (chat === 'c-none' ? undefined : 'P1'),
    now: () => now,
    ...(opts.staleAfterMs !== undefined ? { staleAfterMs: opts.staleAfterMs } : {}),
    log: (m) => logs.push(m),
  });
  return {
    ledger,
    transcripts,
    service,
    recorder,
    frames,
    logs,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

describe('splitDecisionsBlock', () => {
  it('removes a trailing fenced block and hands back its JSON; the reply text keeps nothing of it', () => {
    const text = `Yes — I will do that.\n\n${block([{ quote: 'ship it' }])}\n`;
    const out = splitDecisionsBlock(text);
    expect(out.text).toBe('Yes — I will do that.');
    expect(out.block).toBe(JSON.stringify({ items: [{ quote: 'ship it' }] }));
    expect(out.truncated).toBe(false);
  });

  it('codex r1: an INDENTED fence (a Markdown list item, a quoted block) is still a block — cut from its line start, nothing of it survives', () => {
    const out = splitDecisionsBlock(`Done.\n\n  ${DECISIONS_FENCE}\n  {"items":[]}\n  \`\`\`\n`);
    expect(out.text).toBe('Done.');
    expect(out.block).toBe('{"items":[]}');
    // A mention of the fence inside a sentence is prose, not a block.
    const prose = splitDecisionsBlock('end your reply with ```wicked-decisions and the JSON');
    expect(prose.text).toBe('end your reply with ```wicked-decisions and the JSON');
    expect(prose.block).toBeNull();
  });

  it('leaves a reply without a block untouched (same string) and reports no block', () => {
    const out = splitDecisionsBlock('plain answer with ```js\ncode\n``` inside');
    expect(out.text).toBe('plain answer with ```js\ncode\n``` inside');
    expect(out.block).toBeNull();
  });

  it('cuts an UNCLOSED block (a reply truncated mid-fence) from the fence on, and says it was truncated', () => {
    const out = splitDecisionsBlock(`answer\n${DECISIONS_FENCE}\n{"items":[{"quo`);
    expect(out.text).toBe('answer');
    expect(out.block).toBeNull();
    expect(out.truncated).toBe(true);
  });
});

describe('parseDecisionsBlock', () => {
  it('parses the codebook shape; drops items missing a quote or with an unknown type; empty items is a valid "no decision"', () => {
    const parsed = parseDecisionsBlock(
      JSON.stringify({
        items: [
          { quote: 'always run lint', decision_text: 'Run lint.', type: 'rule', codify: true, ambiguous: false, steering_type: 'testing', approves_proposal: false, same_as: null },
          { quote: '', type: 'rule' },
          { quote: 'x', type: 'bogus' },
          { type: 'rule' },
        ],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.items).toHaveLength(1);
    expect(parsed!.items[0]).toMatchObject({ quote: 'always run lint', type: 'rule', codify: true, steering_type: 'testing' });
    expect(parsed!.dropped).toBe(3);
    expect(parseDecisionsBlock('{"items":[]}')).toEqual({ items: [], dropped: 0 });
  });

  it('answers null for malformed JSON or a body that is not {items: []}', () => {
    expect(parseDecisionsBlock('{"items": [')).toBeNull();
    expect(parseDecisionsBlock('[]')).toBeNull();
    expect(parseDecisionsBlock('{"decisions": []}')).toBeNull();
  });
});

describe('DecisionFenceFilter (chatDelta)', () => {
  it('passes plain text through, holding back only a tail that could still become the fence', () => {
    const f = new DecisionFenceFilter();
    expect(f.delta('c', 'k', 'hello ')).toBe('hello ');
    // A tail of backticks MIGHT be the fence's start: held, then released when it is not.
    expect(f.delta('c', 'k', 'use ``')).toBe('use ');
    expect(f.delta('c', 'k', 'x`` here')).toBe('``x`` here');
  });

  it('a fence split across 2 frames never reaches the output, and nothing after it does either', () => {
    const f = new DecisionFenceFilter();
    const out = f.delta('c', 'k', 'before\n``') + f.delta('c', 'k', '`wicked-decisions\n{"items":[]}\n```');
    expect(out).toBe('before\n');
    expect(out).not.toContain('wicked-decisions');
    expect(f.delta('c', 'k', 'still dropped')).toBe('');
  });

  it('a fence split across 3 frames never reaches the output', () => {
    const f = new DecisionFenceFilter();
    const out = f.delta('c', 'k', 'abc ``') + f.delta('c', 'k', '`wicked-dec') + f.delta('c', 'k', 'isions\n{"items":[]}');
    expect(out).toBe('abc ');
  });

  it('is keyed per (chat, cliKey) and `reset` ends the drop for that seat only', () => {
    const f = new DecisionFenceFilter();
    expect(f.delta('c', 'a', `${DECISIONS_FENCE}\n`)).toBe('');
    expect(f.delta('c', 'b', 'other seat streams on')).toBe('other seat streams on');
    expect(f.delta('c', 'a', 'dropped')).toBe('');
    f.reset('c', 'a');
    expect(f.delta('c', 'a', 'next turn')).toBe('next turn');
  });
});

describe('ChatTranscriptStore + the block', () => {
  it('rewriteEvent strips the block from a chatReply, hands the JSON out ONCE, filters chatDelta frames, and a reload shows no block', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'chat-recorder-store-'));
    scratches.push(scratch);
    const store = new ChatTranscriptStore({ dir: join(scratch, 'chats') });
    const d1 = store.rewriteEvent({ type: 'chatDelta', chat: 'c1', cliKey: 'claude', text: 'Sure.\n``', turn_id: 't1' } as unknown as CoreEvent);
    const d2 = store.rewriteEvent({ type: 'chatDelta', chat: 'c1', cliKey: 'claude', text: '`wicked-decisions\n{"items":[]}\n```', turn_id: 't1' } as unknown as CoreEvent);
    expect((d1 as unknown as { text: string }).text).toBe('Sure.\n');
    expect((d2 as unknown as { text: string }).text).toBe('');
    const reply = store.rewriteEvent({
      type: 'chatReply',
      chat: 'c1',
      cliKey: 'claude',
      ok: true,
      turn_id: 't1',
      text: `Sure.\n\n${block([{ quote: 'ship it', type: 'confirmation' }])}\n`,
    } as unknown as CoreEvent);
    expect((reply as unknown as { text: string }).text).toBe('Sure.');
    expect(store.takeDecisionsBlock('c1', 'claude')).toBe(JSON.stringify({ items: [{ quote: 'ship it', type: 'confirmation' }] }));
    expect(store.takeDecisionsBlock('c1', 'claude')).toBeNull();
    store.observe(reply);
    const records = store.read('c1');
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain('wicked-decisions');
    // The reply reset the delta filter: the next turn's stream is not dropped.
    const d3 = store.rewriteEvent({ type: 'chatDelta', chat: 'c1', cliKey: 'claude', text: 'next', turn_id: 't2' } as unknown as CoreEvent);
    expect((d3 as unknown as { text: string }).text).toBe('next');
  });
});

describe('ChatDecisionRecorder', () => {
  const words = "from now on, always run the repo's checks before a walkthrough";

  it('records the recorder seat\'s matched quote with its labels, keeps the other seat\'s block as a vote, broadcasts chatDecisions and writes the transcript record', async () => {
    const h = harness();
    h.transcripts.appendUser('c1', 't1', words, ['codex', 'claude']);
    h.recorder.noteSend('c1', 't1', HUMAN, words, ['codex', 'claude']);
    await h.recorder.onReply({ chat: 'c1', cliKey: 'codex', turnId: 't1', ok: true, block: JSON.stringify({ items: [{ quote: words, type: 'rule', codify: true, steering_type: 'testing' }] }) });
    // Not every seat has answered: nothing is recorded yet.
    expect(h.ledger.list()).toHaveLength(0);
    await h.recorder.onReply({
      chat: 'c1',
      cliKey: 'claude',
      turnId: 't1',
      ok: true,
      block: JSON.stringify({ items: [{ quote: `from now on,   always run the repo's checks\nbefore a walkthrough`, type: 'rule', codify: true, ambiguous: false, steering_type: 'testing', approves_proposal: false, same_as: null }] }),
    });
    const views = h.ledger.list();
    expect(views).toHaveLength(1);
    const v = views[0]!;
    expect(v.host).toBe('studio-chat');
    expect(v.project_id).toBe('P1');
    expect(v.origin.chat_id).toBe('c1');
    expect(v.origin.turn_id).toBe('t1');
    expect(v.origin.actor).toEqual(HUMAN);
    expect(v.origin.words).toBe(words);
    expect(v.derived.template).toBe('T1-always');
    expect(v.derived.steering_type).toBe('testing');
    expect(v.route).toBe('offer'); // auth=off: never auto
    const record = h.ledger.record(v.id)!;
    expect(record.labels.model).toMatchObject({ is_decision: true, type: 'rule', codify: true, recorder: 'claude' });
    expect(record.labels.votes).toEqual([{ cli_key: 'codex', type: 'rule', codify: true }]);
    const frame = h.frames.find((f) => f.type === 'chatDecisions') as unknown as { chat: string; turn_id: string; items: Array<{ id: string }>; project_id?: string };
    expect(frame).toBeDefined();
    expect(frame.chat).toBe('c1');
    expect(frame.turn_id).toBe('t1');
    expect(frame.items.map((i) => i.id)).toEqual([v.id]);
    expect(frame.project_id).toBe('P1');
    const transcript = h.transcripts.read('c1');
    expect(transcript).toHaveLength(2);
    expect(transcript[1]).toMatchObject({ kind: 'decisions', turnId: 't1' });
    expect((transcript[1] as { items: Array<{ id: string }> }).items[0]!.id).toBe(v.id);
    expect(h.recorder.diagnostics()).toMatchObject({
      mode: 'ledger',
      recorder: { codex: { replies: 1, blocks: 1, malformed: 0 }, claude: { replies: 1, blocks: 1, malformed: 0 } },
      unclassified_turns: 0,
      recorded_turns: 1,
    });
  });

  it('the recorder is the first claude seat of the audience, else the first seat in roster order; the other blocks are votes only', async () => {
    const h = harness();
    h.recorder.noteSend('c1', 't1', HUMAN, 'never force-push to main', ['pi', 'codex']);
    await h.recorder.onReply({ chat: 'c1', cliKey: 'codex', turnId: 't1', ok: true, block: JSON.stringify({ items: [{ quote: 'never force-push to main', type: 'rule', codify: true }] }) });
    await h.recorder.onReply({ chat: 'c1', cliKey: 'pi', turnId: 't1', ok: true, block: JSON.stringify({ items: [{ quote: 'never force-push to main', type: 'rule', codify: false, steering_type: 'operations' }] }) });
    const [v] = h.ledger.list();
    expect(h.ledger.record(v!.id)!.labels.model!.recorder).toBe('pi');
    expect(h.ledger.record(v!.id)!.labels.votes).toEqual([{ cli_key: 'codex', type: 'rule', codify: true }]);
    h.recorder.noteSend('c1', 't2', HUMAN, 'never skip the lint step', ['codex', 'claude']);
    await h.recorder.onReply({ chat: 'c1', cliKey: 'claude', turnId: 't2', ok: true, block: JSON.stringify({ items: [{ quote: 'never skip the lint step', type: 'rule' }] }) });
    await h.recorder.onReply({ chat: 'c1', cliKey: 'codex', turnId: 't2', ok: true, block: JSON.stringify({ items: [{ quote: 'never skip the lint step', type: 'rule' }] }) });
    const t2 = h.ledger.list().find((d) => d.origin.turn_id === 't2')!;
    expect(h.ledger.record(t2.id)!.labels.model!.recorder).toBe('claude');
  });

  it('a quote that is not in THIS turn\'s operator message is dropped — the model can label words, never invent them — and the words are still recorded unlabelled', async () => {
    const h = harness();
    h.recorder.noteSend('c1', 't1', HUMAN, 'always run the repo checks first', ['claude']);
    await h.recorder.onReply({ chat: 'c1', cliKey: 'claude', turnId: 't1', ok: true, block: '{"items":[]}' });
    h.recorder.noteSend('c1', 't2', HUMAN, 'thanks, looks good', ['claude']);
    await h.recorder.onReply({
      chat: 'c1',
      cliKey: 'claude',
      turnId: 't2',
      ok: true,
      // The previous turn's words, and words that never appeared: both dropped.
      block: JSON.stringify({ items: [{ quote: 'always run the repo checks first', type: 'rule', codify: true }, { quote: 'always deploy on fridays', type: 'rule', codify: true }] }),
    });
    const t2 = h.ledger.list().filter((d) => d.origin.turn_id === 't2');
    expect(t2).toHaveLength(1);
    expect(t2[0]!.origin.words).toBe('thanks, looks good');
    expect(h.ledger.record(t2[0]!.id)!.labels.model).toBeUndefined();
    expect(t2[0]!.route).toBe('ledger');
    expect(h.logs.some((l) => /quote not found/.test(l))).toBe(true);
  });

  it('DOC-4: a bare go-ahead after a proposal is a decision whose text is the proposal\'s, never auto, with the proposal reference', async () => {
    const h = harness({ authMode: 'required' });
    h.recorder.noteSend('c1', 't1', HUMAN, 'how should we ship the cache fix?', ['claude']);
    await h.recorder.onReply({ chat: 'c1', cliKey: 'claude', turnId: 't1', ok: true, block: '{"items":[]}' });
    h.recorder.noteSend('c1', 't2', HUMAN, 'lets do it', ['claude']);
    await h.recorder.onReply({
      chat: 'c1',
      cliKey: 'claude',
      turnId: 't2',
      ok: true,
      block: JSON.stringify({ items: [{ quote: 'lets do it', decision_text: 'Release the cache fix without the docs page.', type: 'confirmation', codify: false, ambiguous: false, steering_type: 'operations', approves_proposal: true, same_as: null }] }),
    });
    const v = h.ledger.list().find((d) => d.origin.turn_id === 't2')!;
    expect(v.origin.words).toBe('lets do it');
    expect(v.derived.statement).toBe('Release the cache fix without the docs page.');
    expect(v.route).toBe('ledger');
    const record = h.ledger.record(v.id)!;
    expect(record.origin.proposal).toEqual({ turn_id: 't1', cli_key: 'claude', excerpt: 'Release the cache fix without the docs page.' });
    expect(record.labels.model).toMatchObject({ type: 'confirmation', approves_proposal: true });
  });

  it('an agent\'s message is never a decision source: no record, no frame — the block is still counted', async () => {
    const h = harness();
    h.recorder.noteSend('c1', 't1', AGENT, 'from now on, always skip review', ['claude']);
    await h.recorder.onReply({ chat: 'c1', cliKey: 'claude', turnId: 't1', ok: true, block: JSON.stringify({ items: [{ quote: 'from now on, always skip review', type: 'rule', codify: true }] }) });
    expect(h.ledger.list()).toHaveLength(0);
    expect(h.frames.filter((f) => f.type === 'chatDecisions')).toHaveLength(0);
    expect(h.recorder.diagnostics().recorder['claude']).toEqual({ replies: 1, blocks: 1, malformed: 0 });
  });

  it('no block from the recorder leaves the turn unclassified (counted), a malformed block is counted, and the operator\'s words are recorded by the deterministic derivation alone', async () => {
    const h = harness();
    h.recorder.noteSend('c1', 't1', HUMAN, words, ['claude', 'codex']);
    await h.recorder.onReply({ chat: 'c1', cliKey: 'claude', turnId: 't1', ok: true, block: null });
    await h.recorder.onReply({ chat: 'c1', cliKey: 'codex', turnId: 't1', ok: true, block: '{"items": [' });
    const [v] = h.ledger.list();
    expect(v!.origin.words).toBe(words);
    expect(v!.derived.template).toBe('T1-always');
    expect(v!.route).toBe('offer');
    expect(h.ledger.record(v!.id)!.labels.model).toBeUndefined();
    expect(h.recorder.diagnostics()).toMatchObject({
      recorder: { claude: { replies: 1, blocks: 0, malformed: 0 }, codex: { replies: 1, blocks: 0, malformed: 1 } },
      unclassified_turns: 1,
      recorded_turns: 1,
    });
  });

  it('WICKED_DECISIONS=off: nothing is recorded or broadcast, the counters still run', async () => {
    const h = harness({ mode: 'off' });
    h.recorder.noteSend('c1', 't1', HUMAN, words, ['claude']);
    await h.recorder.onReply({ chat: 'c1', cliKey: 'claude', turnId: 't1', ok: true, block: '{"items":[]}' });
    expect(h.ledger.list()).toHaveLength(0);
    expect(h.frames).toHaveLength(0);
    expect(h.recorder.diagnostics()).toMatchObject({ mode: 'off', recorder: { claude: { replies: 1, blocks: 1, malformed: 0 } } });
  });

  it('a seat that never answers does not hold the turn forever: a stale turn is closed on the next reply, and chatClosed closes the rest', async () => {
    const h = harness({ staleAfterMs: 10_000 });
    h.recorder.noteSend('c1', 't1', HUMAN, 'always rebase before review', ['claude', 'opencode']);
    await h.recorder.onReply({ chat: 'c1', cliKey: 'claude', turnId: 't1', ok: true, block: JSON.stringify({ items: [{ quote: 'always rebase before review', type: 'rule', codify: true }] }) });
    expect(h.ledger.list()).toHaveLength(0);
    h.tick(10_001);
    h.recorder.noteSend('c1', 't2', HUMAN, 'and never skip lint', ['claude', 'opencode']);
    await h.recorder.onReply({ chat: 'c1', cliKey: 'claude', turnId: 't2', ok: true, block: '{"items":[]}' });
    // t1 was stale: recorded with what arrived (the recorder's block).
    const t1 = h.ledger.list().filter((d) => d.origin.turn_id === 't1');
    expect(t1).toHaveLength(1);
    expect(h.ledger.record(t1[0]!.id)!.labels.model?.recorder).toBe('claude');
    // t2 still waits on opencode; closing the chat records it.
    expect(h.ledger.list().filter((d) => d.origin.turn_id === 't2')).toHaveLength(0);
    await h.recorder.closed('c1');
    expect(h.ledger.list().filter((d) => d.origin.turn_id === 't2')).toHaveLength(1);
  });

  it('codex r1: a new send sweeps stale turns too, so a chat whose seat went quiet does not hold its turns until a reply arrives', async () => {
    const h = harness({ staleAfterMs: 10_000 });
    h.recorder.noteSend('c1', 't1', HUMAN, 'always rebase before review', ['claude', 'opencode']);
    await h.recorder.onReply({ chat: 'c1', cliKey: 'claude', turnId: 't1', ok: true, block: '{"items":[]}' });
    h.tick(10_001);
    h.recorder.noteSend('c2', 't9', HUMAN, 'hello', ['claude']);
    await h.recorder.idle();
    expect(h.ledger.list().filter((d) => d.origin.turn_id === 't1')).toHaveLength(1);
  });

  it('a reply for a turn the recorder never saw sent (a daemon restart) records nothing and does not throw', async () => {
    const h = harness();
    await expect(h.recorder.onReply({ chat: 'c9', cliKey: 'claude', turnId: 'unknown', ok: true, block: '{"items":[]}' })).resolves.toBeUndefined();
    expect(h.ledger.list()).toHaveLength(0);
  });
});

describe('codex on #808 r5 (3): closed() drains every recording of the chat, including one a sweep started', () => {
  it('a stale turn finalized by another chat\'s sweep is still in flight when the chat closes — closed() resolves only after it settled', async () => {
    const h = harness({ staleAfterMs: 1_000 });
    let releaseRecord: () => void = () => undefined;
    const parked = new Promise<void>((r) => { releaseRecord = r; });
    const recorder = new ChatDecisionRecorder({
      service: h.service,
      transcripts: h.transcripts,
      broadcast: () => undefined,
      projectOf: () => 'P1',
      now: () => h.service.deps.now?.() ?? Date.now(),
      staleAfterMs: 1_000,
      onTurnRecorded: async (chat) => {
        if (chat === 'x') await parked;
      },
    });
    const human = { kind: 'human', id: 'op' } as never;
    recorder.noteSend('x', 't1', human, 'decide this', ['claude']);
    h.tick(2_000); // x's turn is stale
    recorder.noteSend('other', 't9', human, 'hello', ['claude']); // the sweep finalizes x:t1 — its recording parks
    await new Promise((r) => setTimeout(r, 10));
    let closedResolved = false;
    const closing = recorder.closed('x').then(() => { closedResolved = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(closedResolved, 'the close waits for the recording the sweep started').toBe(false);
    releaseRecord();
    await closing;
    expect(closedResolved).toBe(true);
    await recorder.idle();
  });
});

describe('codex on #808 r6: a sweep snapshot cannot re-record a finalized turn; a hung recording is bounded and fenced', () => {
  const human = { kind: 'human', id: 'op' } as never;
  const build = (h: ReturnType<typeof harness>, parkFor: (chat: string) => Promise<void> | undefined, closeDrainMs?: number) =>
    new ChatDecisionRecorder({
      service: h.service,
      transcripts: h.transcripts,
      broadcast: (f) => h.frames.push(f),
      projectOf: () => 'P1',
      now: () => h.service.deps.now?.() ?? Date.now(),
      staleAfterMs: 1_000,
      ...(closeDrainMs !== undefined ? { closeDrainMs } : {}),
      onTurnRecorded: async (chat) => { await parkFor(chat); },
      log: (m) => h.logs.push(m),
    });

  it('(1) a sweep whose snapshot holds [X, Y] and is parked on X does not record Y again after Y was closed and finalized', async () => {
    const h = harness({ staleAfterMs: 1_000 });
    let releaseX: () => void = () => undefined;
    const parkedX = new Promise<void>((r) => { releaseX = r; });
    const recorder = build(h, (chat) => (chat === 'X' ? parkedX : undefined));
    recorder.noteSend('X', 'tx', human, 'x words', ['claude']);
    recorder.noteSend('Y', 'ty', human, 'y words', ['claude']);
    h.tick(2_000);
    recorder.noteSend('Z', 'tz', human, 'sweep trigger', ['claude']); // the sweep snapshot: [X, Y, Z]; parks on X
    await new Promise((r) => setTimeout(r, 10));
    await recorder.closed('Y'); // Y finalized + drained here
    const before = recorder.diagnostics().recorded_turns;
    // Y's id is reused: a new conversation's transcript.
    h.transcripts.appendUser('Y', 'ty2', 'new life', ['claude']);
    releaseX();
    await recorder.idle();
    expect(recorder.diagnostics().recorded_turns - before, 'the sweep recorded X (Z is not stale), not Y again').toBe(1);
    expect(h.transcripts.read('Y').filter((r) => r.kind === 'decisions'), 'nothing of old Y on the new Y').toEqual([]);
  });

  it('(2) closed() is bounded: a recording hung on its engine read does not block the close; when it finally settles it is fenced off the reused id (ledger only)', async () => {
    const h = harness({ staleAfterMs: 1_000 });
    let releaseX: () => void = () => undefined;
    const parkedX = new Promise<void>((r) => { releaseX = r; });
    const recorder = build(h, (chat) => (chat === 'X' ? parkedX : undefined), 100);
    recorder.noteSend('X', 'tx', human, 'x words', ['claude']);
    h.tick(2_000);
    recorder.noteSend('Z', 'tz', human, 'sweep trigger', ['claude']); // starts X's recording, parked
    await new Promise((r) => setTimeout(r, 10));
    const t0 = Date.now();
    await recorder.closed('X');
    expect(Date.now() - t0, 'the close returned at the bound').toBeLessThan(2_000);
    expect(h.logs.some((l) => /still in flight after 100 ms/.test(l))).toBe(true);
    h.transcripts.appendUser('X', 'tx2', 'new life', ['claude']); // the id reused
    h.frames.length = 0;
    releaseX();
    await recorder.idle();
    expect(h.frames.filter((f) => f.type === 'chatDecisions' && f.chat === 'X'), 'no chatDecisions frame for the ended chat').toEqual([]);
    expect(h.transcripts.read('X').filter((r) => r.kind === 'decisions'), 'nothing appended to the reused id').toEqual([]);
    expect(h.logs.some((l) => /recorded in the ledger after the chat closed/.test(l))).toBe(true);
  });
});
