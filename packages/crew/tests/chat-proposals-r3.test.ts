// DES-CHAT-ARTIFACTS-001 A2 (xreview r3): the real cost rule, torn-tail appends in all three stores, the history
// instance nonce, the parsed-value host-path rewrite (bounded), and a proposal id longer than Fastify's default limit.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { ChatTranscriptRecord, SessionView } from '../src/core/types.js';
import { ChatTranscriptStore } from '../src/api/chat-transcripts.js';
import { ChatHistoryStore } from '../src/api/chat-history.js';
import { proposalRunId, RecordingStubDispatcher, runCostFromEvents } from '../src/api/chat-proposals.js';

const ROOT = mkdtempSync(join(tmpdir(), 'chat-proposals-r3-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const view = (units: Array<{ ord: number; cli: string | null; tool?: boolean }>): SessionView => ({
  session: { id: 'r1', status: 'completed' },
  units: units.map((u) => ({ id: `r1:${u.ord}`, ord: u.ord, assigned_cli: u.cli, status: 'done', ...(u.tool === true ? { routing: { method: 'tool' } } : {}) })),
}) as unknown as SessionView;

describe('the cost rule (runCostFromEvents)', () => {
  const units = view([{ ord: 1, cli: 'claude' }, { ord: 2, cli: 'codex' }, { ord: 3, cli: 'bash', tool: true }]);
  it('sums every agent step when every dispatched attempt reported a price (a tool step is no agent’s)', () => {
    expect(runCostFromEvents(units, [
      { type: 'unitDispatched', ord: 1, attempt: 0 }, { type: 'cliUsage', ord: 1, attempt: 0, costUsd: 0.25 },
      { type: 'unitDispatched', ord: 2, attempt: 0 }, { type: 'cliUsage', ord: 2, attempt: 0, costUsd: 0.5 },
      { type: 'unitDispatched', ord: 3, attempt: 0 },
    ])).toBeCloseTo(0.75);
  });
  it('a priced attempt hiding an unpriced (silent) retry, an explicit null cost, or a step with no price is unknown', () => {
    expect(runCostFromEvents(units, [
      { type: 'unitDispatched', ord: 1, attempt: 0 }, { type: 'cliUsage', ord: 1, attempt: 0, costUsd: 0.25 },
      { type: 'unitDispatched', ord: 1, attempt: 1 },
      { type: 'unitDispatched', ord: 2, attempt: 0 }, { type: 'cliUsage', ord: 2, attempt: 0, costUsd: 0.5 },
    ])).toBeNull();
    expect(runCostFromEvents(units, [{ type: 'cliUsage', ord: 1, costUsd: 0.25 }, { type: 'cliUsage', ord: 2, costUsd: null }])).toBeNull();
    expect(runCostFromEvents(units, [{ type: 'cliUsage', ord: 1, costUsd: 0.25 }])).toBeNull();
    expect(runCostFromEvents(units, [{ type: 'cliUsage', ord: 1, costUsd: 0.25 }, { type: 'cliUsage', ord: 2, costUsd: Number.NaN }])).toBeNull();
  });
  it('a unit whose durable attempt counter is past the priced attempts (a log that lost a retry) is unknown', () => {
    const retried = view([{ ord: 1, cli: 'claude' }]);
    (retried.units[0] as unknown as { last_attempt: number }).last_attempt = 1;
    expect(runCostFromEvents(retried, [{ type: 'unitDispatched', ord: 1, attempt: 0 }, { type: 'cliUsage', ord: 1, attempt: 0, costUsd: 0.25 }])).toBeNull();
    expect(runCostFromEvents(retried, [
      { type: 'unitDispatched', ord: 1, attempt: 0 }, { type: 'cliUsage', ord: 1, attempt: 0, costUsd: 0.25 },
      { type: 'unitDispatched', ord: 1, attempt: 1 }, { type: 'cliUsage', ord: 1, attempt: 1, costUsd: 0.5 },
    ])).toBeCloseTo(0.75);
    // A lost MIDDLE attempt (0 and 2 priced, 1 gone) is unknown too.
    (retried.units[0] as unknown as { last_attempt: number }).last_attempt = 2;
    expect(runCostFromEvents(retried, [
      { type: 'unitDispatched', ord: 1, attempt: 0 }, { type: 'cliUsage', ord: 1, attempt: 0, costUsd: 0.25 },
      { type: 'unitDispatched', ord: 1, attempt: 2 }, { type: 'cliUsage', ord: 1, attempt: 2, costUsd: 0.5 },
    ])).toBeNull();
  });
});

describe('a torn tail never swallows the next record', () => {
  it('live transcript, kept history and the stub dispatch file', async () => {
    const dir = join(ROOT, 'chats');
    const transcripts = new ChatTranscriptStore({ dir });
    transcripts.appendUser('c1', 't1', 'hi', ['claude']);
    appendFileSync(join(dir, 'c1.jsonl'), '{"at":1,"turnId":"t1","kind":"seat"'); // a crash mid-append
    const rec: ChatTranscriptRecord = { at: 2, turnId: 't1', kind: 'proposal_decided', pid: 'c1:t1', actor: 'm', decision: 'not_now', result: null };
    expect(transcripts.appendProposalRecord('c1', rec)).toBe(true);
    expect(transcripts.read('c1').map((r) => r.kind)).toStrictEqual(['user', 'proposal_decided']);

    const history = new ChatHistoryStore(transcripts, null, { dir: join(dir, "history") });
    history.opened('c2', { cli: 'claude', actorId: null });
    transcripts.appendUser('c2', 't1', 'hi', ['claude']);
    history.closed('c2');
    appendFileSync(join(dir, 'history', 'c2.jsonl'), '{"torn":');
    expect(history.appendKept('c2', rec)).toBe(true);
    expect(history.messages('c2')?.map((r) => r.kind)).toStrictEqual(['user', 'proposal_decided']);

    const file = join(ROOT, 'stub', 'dispatches.ndjson');
    const stub = new RecordingStubDispatcher(file);
    const identity = { artifactRef: null, runId: proposalRunId('c1:t1') };
    await stub.launch({ kind: 'theme', pid: 'c1:t0', chatId: 'c1', actor: { id: 'm', kind: 'human', trust: 'operator' }, identity: { artifactRef: null, runId: 'x' }, resolution: { what: { title: 't' } } as never });
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"torn":`);
    await stub.launch({ kind: 'theme', pid: 'c1:t1', chatId: 'c1', actor: { id: 'm', kind: 'human', trust: 'operator' }, identity, resolution: { what: { title: 't' } } as never });
    expect(await stub.find(identity)).toBe(true);
    expect(stub.rows().map((r) => r.pid)).toStrictEqual(['c1:t0', 'c1:t1']);
  });
});

describe('the history instance', () => {
  it('two openings of one id in the same millisecond are different instances; the archived alias keeps its own', () => {
    const transcripts = new ChatTranscriptStore({ dir: join(ROOT, 'inst') });
    const history = new ChatHistoryStore(transcripts, null, { dir: join(ROOT, 'inst', 'history'), now: () => 1000 });
    history.opened('c9', { cli: 'claude', actorId: null, projectId: 'mikes' });
    const first = history.stateOf('c9')!;
    expect(first.projectId).toBe('mikes');
    history.closed('c9');
    history.opened('c9', { cli: 'claude', actorId: null });
    const second = history.stateOf('c9')!;
    expect(second.instance).not.toBe(first.instance);
    expect(history.stateOf('c9--1000')?.instance).toBe(first.instance);
  });
});

describe('host paths inside a block', () => {
  it('are rewritten on the parsed values (quoted roots stay valid JSON); a deep or huge body is left as written', () => {
    const store = new ChatTranscriptStore({ dir: join(ROOT, 'paths') });
    store.registerRoots('c1', [{ absRoot: '/srv/repos/al"pha', name: 'al"pha' }]);
    const block = JSON.stringify({ entry: 'presentation', brief: 'see /srv/repos/al"pha/src/x.ts', sources: ['chat'], nested: [{ a: '/srv/repos/al"pha/y' }] });
    store.rewriteEvent({ type: 'chatReply', chat: 'c1', cliKey: 'claude', text: `ok\n\`\`\`wicked-make\n${block}\n\`\`\``, ok: true } as never);
    const [body] = store.takeMakeBlocks('c1', 'claude');
    const parsed = JSON.parse(body!) as { brief: string; nested: Array<{ a: string }> };
    expect(parsed.brief).not.toContain('/srv/repos');
    expect(parsed.nested[0]!.a).not.toContain('/srv/repos');
    // An otherwise valid block padded past the bounds (deep junk, or a huge body) is DROPPED, never passed on unrewritten.
    const deepJunk = JSON.stringify({ entry: 'presentation', title: '/srv/repos/al"pha/secret', junk: JSON.parse(`${'['.repeat(20)}1${']'.repeat(20)}`) });
    store.rewriteEvent({ type: 'chatReply', chat: 'c1', cliKey: 'claude', text: `ok\n\`\`\`wicked-make\n${deepJunk}\n\`\`\``, ok: true } as never);
    expect(store.takeMakeBlocks('c1', 'claude')).toStrictEqual([]);
    const huge = `{"entry":"presentation","title":"/srv/repos/al\\"pha/s"${' '.repeat(70 * 1024)}}`;
    store.rewriteEvent({ type: 'chatReply', chat: 'c1', cliKey: 'claude', text: `ok\n\`\`\`wicked-make\n${huge}\n\`\`\``, ok: true } as never);
    expect(store.takeMakeBlocks('c1', 'claude')).toStrictEqual([]);
  });

  it('a reply with many blocks is cut in bounded work: 16 blocks at most, the rest hidden', async () => {
    const { splitMakeBlocks } = await import('../src/decisions/chat-recorder.js');
    const many = `prose\n${Array.from({ length: 40 }, (_, i) => `\`\`\`wicked-make\n{"n":${i}}\n\`\`\`\ntail ${i}`).join('\n')}`;
    const out = splitMakeBlocks(many);
    expect(out.blocks).toHaveLength(16);
    expect(out.truncated).toBe(true);
    expect(out.text).not.toContain('wicked-make');
    expect(out.text).not.toContain('tail 39');
  });
});
