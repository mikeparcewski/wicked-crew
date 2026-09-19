// DES-L5 (D-13 / BC-33): the chat transcript at rest — one append-only JSONL per LIVE chat under the
// state home, 0700/0600, written only from turn-stamped frames, dropped with the chat, cleared at
// boot (orphans only; retained transcripts survive). The store's own contract; the route + frame-hook
// composition is pinned in chat-turns.test.ts.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CHAT_ID } from '../src/api/chat-scope.js';
import { CHAT_TRANSCRIPTS_DIRNAME, ChatTranscriptStore, defaultChatTranscriptsDir, rewriteHostPaths } from '../src/api/chat-transcripts.js';
import type { CoreEvent } from '../src/core/types.js';
import { crewStateHome } from '../src/projects/state-home.js';

let scratch: string;
let dir: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'chat-transcripts-unit-'));
  dir = join(scratch, 'chats');
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('ChatTranscriptStore', () => {
  it('lives under the state home as `chats` (the registry entry) unless a dir is injected', () => {
    expect(CHAT_TRANSCRIPTS_DIRNAME).toBe('chats');
    expect(defaultChatTranscriptsDir()).toBe(join(crewStateHome(), 'chats'));
    expect(new ChatTranscriptStore({ dir }).directory).toBe(dir);
  });

  it('appends user and STAMPED seat records in order (0700 dir, 0600 file); reads them back; a torn line is skipped', () => {
    let now = 1_000;
    const store = new ChatTranscriptStore({ dir, now: () => now });
    store.appendUser('c1', 't1', 'hello', ['claude', 'pi']);
    now = 1_500;
    store.observe({ type: 'chatReply', chat: 'c1', cliKey: 'claude', text: 'hi', ok: true, turn_id: 't1', usage: { inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.01 } } as unknown as CoreEvent);
    now = 1_600;
    // A bridge that emits no usage (pi, agy) → `usage: null`; a malformed usage object → null fields, never NaN.
    store.observe({ type: 'chatReply', chat: 'c1', cliKey: 'pi', text: 'yo', ok: false, turn_id: 't1', usage: null } as unknown as CoreEvent);
    expect(store.read('c1')).toEqual([
      { at: 1_000, turnId: 't1', kind: 'user', text: 'hello', seats: ['claude', 'pi'] },
      { at: 1_500, turnId: 't1', kind: 'seat', cliKey: 'claude', text: 'hi', ok: true, usage: { inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.01 } },
      { at: 1_600, turnId: 't1', kind: 'seat', cliKey: 'pi', text: 'yo', ok: false, usage: null },
    ]);
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, 'c1.jsonl')).mode & 0o777).toBe(0o600);
    }
    // A crash mid-append leaves a torn last line: the rest of the record still reads.
    writeFileSync(join(dir, 'c1.jsonl'), `${readFileSync(join(dir, 'c1.jsonl'), 'utf8')}{"at":9,"turn`);
    expect(store.read('c1')).toHaveLength(3);
  });

  it('persists ONLY frames a live turn stamped: an unstamped chatReply, a chatDelta and other events write nothing', () => {
    const store = new ChatTranscriptStore({ dir });
    store.observe({ type: 'chatReply', chat: 'c1', cliKey: 'claude', text: 'straggler', ok: true } as CoreEvent);
    store.observe({ type: 'chatDelta', chat: 'c1', cliKey: 'claude', text: 'x', turn_id: 't1' } as unknown as CoreEvent);
    store.observe({ type: 'chatSessionFailed', chat: 'c1', cliKey: 'claude', reason: 'r', turn_id: 't1' } as unknown as CoreEvent);
    store.observe({ type: 'sessionCompleted', session: 'r1' } as CoreEvent);
    expect(existsSync(dir), 'no file was created — the directory is not even made').toBe(false);
    expect(store.read('c1')).toEqual([]);
  });

  it('the file name passes the scratch root\'s CHAT_ID guard — a separator-bearing id names no path and reads []', () => {
    const store = new ChatTranscriptStore({ dir });
    for (const bad of ['../etc', 'a/b', 'a b', '', 'x\\y']) {
      expect(CHAT_ID.test(bad)).toBe(false);
      store.appendUser(bad, 't', 'x', []);
      expect(store.read(bad)).toEqual([]);
    }
    expect(existsSync(dir)).toBe(false);
    store.appendUser('ok.id_1-2', 't', 'x', []);
    expect(readdirSync(dir)).toEqual(['ok.id_1-2.jsonl']);
  });

  it('drop removes ONE chat\'s file (idempotent); clearAll removes every file (boot — every one is an orphan)', () => {
    const store = new ChatTranscriptStore({ dir });
    store.appendUser('c1', 't', 'a', ['claude']);
    store.appendUser('c2', 't', 'b', ['claude']);
    store.drop('c1');
    store.drop('c1');
    store.drop('never-existed');
    expect(readdirSync(dir)).toEqual(['c2.jsonl']);
    expect(store.read('c1')).toEqual([]);
    store.clearAll();
    expect(existsSync(dir)).toBe(false);
    store.clearAll(); // idempotent on a missing dir
    // Writable again after the clear.
    store.appendUser('c3', 't', 'c', []);
    expect(store.read('c3')).toHaveLength(1);
  });
});

describe('rewriteHostPaths (crew#618)', () => {
  it('replaces absolute root prefixes with repo-name/ prefixes, longest root first', () => {
    const repos = [
      { absRoot: '/srv/repos/alpha', name: 'alpha' },
      { absRoot: '/srv/repos/alpha-extra', name: 'alpha-extra' },
    ];
    // Longer root matched first: /srv/repos/alpha-extra/src before /srv/repos/alpha/src.
    expect(rewriteHostPaths('/srv/repos/alpha-extra/src/x.ts', repos)).toBe('alpha-extra/src/x.ts');
    expect(rewriteHostPaths('/srv/repos/alpha/src/y.ts', repos)).toBe('alpha/src/y.ts');
  });

  it('replaces multiple occurrences and leaves text without host paths unchanged', () => {
    const repos = [{ absRoot: '/srv/repos/alpha', name: 'alpha' }];
    const text = 'See /srv/repos/alpha/a.ts and /srv/repos/alpha/b.ts. No match: /other/c.ts.';
    expect(rewriteHostPaths(text, repos)).toBe('See alpha/a.ts and alpha/b.ts. No match: /other/c.ts.');
  });

  it('returns text unchanged when repos is empty', () => {
    expect(rewriteHostPaths('/srv/repos/alpha/src/x.ts', [])).toBe('/srv/repos/alpha/src/x.ts');
  });
});

describe('ChatTranscriptStore.registerRoots + observe (crew#618)', () => {
  it('rewrites absolute host paths in stored seat replies using registered roots', () => {
    const store = new ChatTranscriptStore({ dir });
    store.registerRoots('c1', [{ absRoot: '/srv/repos/alpha', name: 'alpha' }]);
    store.observe({ type: 'chatReply', chat: 'c1', cliKey: 'claude', text: 'See /srv/repos/alpha/src/foo.ts for details.', ok: true, turn_id: 't1' } as unknown as CoreEvent);
    const recs = store.read('c1');
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ kind: 'seat', text: 'See alpha/src/foo.ts for details.' });
  });

  it('leaves replies unchanged when no roots are registered', () => {
    const store = new ChatTranscriptStore({ dir });
    store.observe({ type: 'chatReply', chat: 'c2', cliKey: 'pi', text: '/srv/repos/alpha/src/bar.ts', ok: true, turn_id: 't1' } as unknown as CoreEvent);
    const recs = store.read('c2');
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ kind: 'seat', text: '/srv/repos/alpha/src/bar.ts' });
  });

  it('drop clears the roots so subsequent stamped replies are stored verbatim (no rewriting)', () => {
    const store = new ChatTranscriptStore({ dir });
    store.appendUser('c1', 't1', 'hello', ['claude']);
    store.registerRoots('c1', [{ absRoot: '/srv/repos/alpha', name: 'alpha' }]);
    store.drop('c1');
    // After drop, the file is gone and roots are cleared. A straggler that carries a turn_id
    // (which in production chatTurns.decorate() would not stamp after chatClosed) recreates the
    // file but is stored VERBATIM — the root-rewriting map has been cleared by drop().
    store.observe({ type: 'chatReply', chat: 'c1', cliKey: 'claude', text: '/srv/repos/alpha/foo.ts', ok: true, turn_id: 't1' } as unknown as CoreEvent);
    const recs = store.read('c1');
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ text: '/srv/repos/alpha/foo.ts' });
  });
});

// Inline re-implementation of the server.ts retention maps to test the three-way invariant
// (chatClosed-while-live, terminal-while-chat-open, terminal-after-close) without a full server.
function makeRetention() {
  const chatRetained = new Map<string, Set<string>>();
  const runToChat = new Map<string, string>();
  function linkChatRun(chatId: string, runId: string) {
    runToChat.set(runId, chatId);
    const ex = chatRetained.get(chatId);
    if (ex !== undefined) ex.add(runId);
    else chatRetained.set(chatId, new Set([runId]));
  }
  function onChatClosed(chatId: string, store: ChatTranscriptStore) {
    const retaining = chatRetained.get(chatId);
    if (retaining === undefined || retaining.size === 0) store.drop(chatId);
  }
  function onRunTerminal(runId: string, chatScopeHas: (id: string) => boolean, store: ChatTranscriptStore) {
    const linkedChat = runToChat.get(runId);
    if (linkedChat === undefined) return;
    runToChat.delete(runId);
    const retaining = chatRetained.get(linkedChat);
    if (retaining !== undefined) {
      retaining.delete(runId);
      if (retaining.size === 0) {
        chatRetained.delete(linkedChat);
        if (!chatScopeHas(linkedChat)) store.drop(linkedChat);
      }
    }
  }
  return { linkChatRun, onChatClosed, onRunTerminal, chatRetained };
}

describe('crew#619 — chatClosed retention and terminal-release drop', () => {
  it('chatClosed with a live run: transcript is retained; run terminal: transcript is dropped', () => {
    const store = new ChatTranscriptStore({ dir });
    const { linkChatRun, onChatClosed, onRunTerminal } = makeRetention();
    store.appendUser('chat1', 't1', 'hi', ['claude']);

    linkChatRun('chat1', 'run-a');
    // chatClosed fires (idle-TTL / operator DELETE) while run is still live
    onChatClosed('chat1', store);
    expect(store.read('chat1')).toHaveLength(1); // retained: run still live

    // run terminates; chat is already gone from scopes
    onRunTerminal('run-a', () => false, store);
    expect(store.read('chat1')).toEqual([]); // dropped: run terminal + chat gone
  });

  it('run terminates while chat is still open: transcript is NOT dropped (chat owns it)', () => {
    const store = new ChatTranscriptStore({ dir });
    const { linkChatRun, onRunTerminal } = makeRetention();
    store.appendUser('chat2', 't1', 'hi', ['claude']);

    linkChatRun('chat2', 'run-b');
    onRunTerminal('run-b', (id) => id === 'chat2', store); // chat still in scopes
    expect(store.read('chat2')).toHaveLength(1); // not dropped: chat is still live
  });

  it('clearOrphaned preserves retained chatIds and removes others', () => {
    const store = new ChatTranscriptStore({ dir });
    store.appendUser('kept', 't1', 'a', []);
    store.appendUser('orphan', 't1', 'b', []);
    store.clearOrphaned(new Set(['kept']));
    expect(store.read('kept')).toHaveLength(1);
    expect(store.read('orphan')).toEqual([]);
  });
});
