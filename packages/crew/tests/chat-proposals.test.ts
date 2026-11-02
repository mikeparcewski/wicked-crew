// DES-CHAT-ARTIFACTS-001 §4 (slice A2), the pure parts: the `wicked-make` fence never reaches a reader (reply and
// stream), the block grammar (last valid wins, exactly one operation), the proposal fold (supersede, re-resolve,
// accepting, decided), the derived identity, the launch-once registry, and what the seat is told per message.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ArtifactProposal, ChatTranscriptRecord } from '../src/core/types.js';
import { DecisionFenceFilter, splitMakeBlocks } from '../src/decisions/chat-recorder.js';
import { ChatTranscriptStore } from '../src/api/chat-transcripts.js';
import { chatMakeLines, chatScopeStatement, chatWorkRequestLines, type MakeDigest } from '../src/api/chat-scope.js';
import {
  foldProposals,
  LaunchOnceRegistry,
  lastValidBlock,
  parseMakeBlock,
  proposalDocName,
  proposalRunId,
  RecordingStubDispatcher,
} from '../src/api/chat-proposals.js';

const BLOCK = '{"entry":"presentation","title":"Domain coverage","brief":"for new engineers","sources":["chat"],"repos":[],"reason":"asked"}';

describe('the wicked-make fence (A2)', () => {
  it('cuts every block from a reply, keeps the prose, and hands the bodies over in order', () => {
    const text = `I can make that deck.\n\n\`\`\`wicked-make\n{"theme":{"name":"x","patch":{"ambient":true}}}\n\`\`\`\nAnd then:\n\`\`\`wicked-make\n${BLOCK}\n\`\`\`\n`;
    const out = splitMakeBlocks(text);
    expect(out.text).toBe('I can make that deck.\n\nAnd then:');
    expect(out.blocks).toEqual(['{"theme":{"name":"x","patch":{"ambient":true}}}', BLOCK]);
    expect(out.truncated).toBe(false);
  });

  it('a mention inside a sentence is prose; an unterminated block is removed from its line on', () => {
    expect(splitMakeBlocks('use a ```wicked-make block').blocks).toEqual([]);
    const cut = splitMakeBlocks(`Sure.\n\`\`\`wicked-make\n{"entry":"presentation"`);
    expect(cut).toEqual({ text: 'Sure.', blocks: [], truncated: true });
  });

  it('the reply the transcript stores and broadcasts carries no block, and the resolver gets it once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'make-fence-'));
    try {
      const store = new ChatTranscriptStore({ dir });
      const reply = { type: 'chatReply', chat: 'c1', cliKey: 'claude', text: `Here is the plan.\n\`\`\`wicked-make\n${BLOCK}\n\`\`\`\n\`\`\`wicked-decisions\n{"items":[]}\n\`\`\``, ok: true, turn_id: 't1' };
      const out = store.rewriteEvent(reply as never) as unknown as { text: string };
      expect(out.text).toBe('Here is the plan.');
      expect(store.takeMakeBlocks('c1', 'claude')).toEqual([BLOCK]);
      expect(store.takeMakeBlocks('c1', 'claude')).toEqual([]);
      expect(store.takeDecisionsBlock('c1', 'claude')).toBe('{"items":[]}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the stream holds a split fence back and drops from a make fence on, like the decisions fence', () => {
    const f = new DecisionFenceFilter();
    expect(f.delta('c', 'claude', 'Sure. ``')).toBe('Sure. ');
    expect(f.delta('c', 'claude', '`wicked-ma')).toBe('');
    expect(f.delta('c', 'claude', 'ke\n{"entry":"x"}')).toBe('');
    expect(f.delta('c', 'claude', 'more')).toBe('');
    f.reset('c', 'claude');
    // A tail that turns out not to be a fence is released.
    expect(f.delta('c', 'claude', 'a ``')).toBe('a ');
    expect(f.delta('c', 'claude', 'code``')).toBe('``code'); // its own trailing `` could start a fence: held again
    expect(f.delta('c', 'claude', ' done')).toBe('`` done');
  });
});

describe('the block grammar', () => {
  it('takes exactly one of entry, refine and theme, and the last valid block wins', () => {
    expect(parseMakeBlock(BLOCK)).toMatchObject({ op: 'entry', entry: 'presentation', sources: ['chat'] });
    expect(parseMakeBlock('{"refine":"mikes/deck","ask":"timeline"}')).toMatchObject({ op: 'refine', touches: [], sources: [] });
    expect(parseMakeBlock('{"theme":{"name":"Calm","patch":{"accent_h":210,"ambient":false}}}')).toMatchObject({ op: 'theme' });
    expect(parseMakeBlock('{"entry":"presentation","refine":"mikes/deck","ask":"x"}')).toBeNull();
    expect(parseMakeBlock('{"theme":{"name":"Calm","patch":{}}}')).toBeNull();
    expect(parseMakeBlock('{"theme":{"name":"Calm","patch":{"accent_h":999}}}')).toBeNull();
    expect(parseMakeBlock('{"theme":{"name":"Calm","patch":{"logo_url":"http://x"}}}')).toBeNull();
    expect(parseMakeBlock('not json')).toBeNull();
    expect(lastValidBlock([BLOCK, '{"broken":'])).toMatchObject({ entry: 'presentation' });
    expect(lastValidBlock(['{"refine":"mikes/deck","ask":"a"}', BLOCK])).toMatchObject({ op: 'entry' });
    expect(lastValidBlock(['nope'])).toBeNull();
  });
});

const proposal = (pid: string, extra: Partial<ArtifactProposal> = {}): ArtifactProposal => ({
  pid, chatId: 'c1', turnId: pid.split(':')[1] ?? null, kind: 'create', seat: 'claude',
  what: { entry: 'presentation', title: 'Deck', label: 'Slides · Deck', outcome: null },
  brief: null, reason: null, sources: [], repos: [], helpers: null, time: null, stops: null,
  filedIn: { projectId: null, label: 'Not in a project · this chat' }, blocked: null, ...extra,
});

describe('the proposal fold', () => {
  it('a newer proposal supersedes the open one; an answered one stays answered', () => {
    const records: ChatTranscriptRecord[] = [
      { at: 1, turnId: 't1', kind: 'proposal', proposal: proposal('c1:t1') },
      { at: 2, turnId: 't2', kind: 'proposal', proposal: proposal('c1:t2') },
      { at: 3, turnId: 't2', kind: 'proposal_decided', pid: 'c1:t2', actor: 'local', decision: 'not_now', result: null },
      { at: 4, turnId: 't3', kind: 'proposal', proposal: proposal('c1:t3') },
    ];
    const f = foldProposals(records);
    expect(f.get('c1:t1')?.state).toBe('superseded');
    expect(f.get('c1:t2')).toMatchObject({ state: 'decided', decision: 'not_now', decidedAt: 3 });
    expect(f.get('c1:t3')?.state).toBe('open');
  });

  it('the same pid again replaces it (a re-resolution), re-opening an interrupted accepting one', () => {
    const identity = { artifactRef: '_unfiled/deck-1', runId: proposalRunId('c1:t1') };
    const records: ChatTranscriptRecord[] = [
      { at: 1, turnId: 't1', kind: 'proposal', proposal: proposal('c1:t1', { kind: 'refine', target: { ref: 'mikes/deck', title: 'Deck', base: 3 } }) },
      { at: 2, turnId: 't1', kind: 'proposal_accepting', pid: 'c1:t1', actor: 'local', edits: null, resolution: proposal('c1:t1'), identity },
    ];
    expect(foldProposals(records).get('c1:t1')?.state).toBe('accepting');
    records.push({ at: 3, turnId: 't1', kind: 'proposal', proposal: proposal('c1:t1', { kind: 'refine', target: { ref: 'mikes/deck', title: 'Deck', base: 4 } }) });
    const again = foldProposals(records).get('c1:t1')!;
    expect(again.state).toBe('open');
    expect(again.proposal.target?.base).toBe(4);
  });
});

describe('identity and launching once', () => {
  it('the run id is a stable RFC 4122 v5 UUID of the pid; the document name is a valid, stable slug', () => {
    const a = proposalRunId('c1:t1');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(proposalRunId('c1:t1')).toBe(a);
    expect(proposalRunId('c1:t2')).not.toBe(a);
    const name = proposalDocName('c1:t1', 'Release note: wicked-crew requirements, 61% → 80%!');
    expect(name).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
    expect(name.startsWith('release-note-wicked-crew-requirements-61-80-')).toBe(true);
    expect(proposalDocName('c1:t1', '  ')).toMatch(/^doc-[0-9a-f]{8}$/);
  });

  it('concurrent launches of one identity start it once; a retry adopts it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'launch-once-'));
    try {
      const stub = new RecordingStubDispatcher(join(dir, 'stub.jsonl'));
      const reg = new LaunchOnceRegistry();
      reg.register('create', stub);
      const identity = { artifactRef: '_unfiled/deck-1', runId: proposalRunId('c1:t1') };
      const d = { kind: 'create' as const, pid: 'c1:t1', chatId: 'c1', actor: { id: 'local', kind: 'human' as const, trust: 'operator' as const }, identity, resolution: proposal('c1:t1') };
      const [a, b] = await Promise.all([reg.launchOnce(d), reg.launchOnce(d)]);
      expect([a.adopted, b.adopted].sort()).toEqual([false, true]);
      expect((await reg.launchOnce(d)).adopted).toBe(true);
      expect(stub.rows()).toHaveLength(1);
      expect(stub.rows()[0]).toMatchObject({ pid: 'c1:t1', runId: identity.runId, artifactRef: '_unfiled/deck-1', actor: 'local' });
      expect(a.stub).toBe(true);
      await expect(reg.launchOnce({ ...d, kind: 'theme' })).rejects.toThrow(/nothing can start a theme/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('what the seat is told (per message, advertised operations only)', () => {
  const none: MakeDigest = { create: false, refine: false, theme: false, demo: false, entries: [] };
  const all: MakeDigest = {
    create: true, refine: true, theme: true, demo: true,
    entries: [
      { id: 'presentation', title: 'Presentation', kind: 'document', outcome: '16:9 slides.' },
      { id: 'demo-video', title: 'Demo video', kind: 'demo', outcome: 'A video.' },
    ],
  };
  const scope = { kind: 'everything' as const, repos: [] };

  it('with nothing advertised the wording is today’s: no block, documents are work', () => {
    const lines = chatWorkRequestLines(scope, { make: none }).join('\n');
    expect(lines).not.toContain('wicked-make');
    expect(lines).toContain('write code or docs');
    expect(lines).toBe(chatWorkRequestLines(scope).join('\n'));
  });

  it('with every operation on: the block for each, the entries, the no-block cases, and documents are no longer refused', () => {
    const lines = chatWorkRequestLines(scope, { make: all }).join('\n');
    for (const want of ['```wicked-make', '"entry":"<id>"', '"refine":"<mount>/<doc>"', '"theme":{', '"entry":"demo-video"', '`presentation`: Presentation', 'Revise it, Make something new, and Just tell me', 'nearest thing it can make', 'never say this chat is read-only']) {
      expect(lines).toContain(want);
    }
    expect(lines).not.toContain('write code or docs');
    expect(lines).toContain('asks for work on code');
  });

  it('only the advertised operations are described', () => {
    const lines = chatMakeLines({ ...none, theme: true }).join('\n');
    expect(lines).toContain('"theme":{');
    expect(lines).not.toContain('"refine"');
    expect(lines).not.toContain('"entry"');
  });

  it('an analysis chat proposes nothing', () => {
    expect(chatWorkRequestLines(scope, { analysis: true, make: all }).join('\n')).not.toContain('wicked-make');
  });

  it('the statement every answer step carries includes the rules', () => {
    const st = chatScopeStatement('c1', { kind: 'everything', repos: [], dangling: [], graph: { bound: false, reason: 'none', repoLabel: null }, cwd: '/tmp/x' } as never, undefined, { make: all });
    expect(st).toContain('## Making documents, slides, pages and demos');
  });
});
