// DES-L5 (D-13 / BC-33): the chat transcript at rest — one append-only JSONL per LIVE chat under the
// state home, 0700/0600, written only from turn-stamped frames, dropped with the chat, cleared at
// boot. The store's own contract; the route + frame-hook composition is pinned in chat-turns.test.ts.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CHAT_ID } from '../src/api/chat-scope.js';
import { CHAT_TRANSCRIPTS_DIRNAME, ChatTranscriptStore, defaultChatTranscriptsDir } from '../src/api/chat-transcripts.js';
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
