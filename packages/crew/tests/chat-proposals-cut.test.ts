// crew#1814 / studio#1140 (a): a chat changes the demo video open in it. The seat's `cut` block becomes a card crew
// resolved; only Go posts its frozen ops to the video tool's recut, once. The video tool is a fake that answers with
// the exact bodies wicked-interactive's routes answered (tests/fixtures/demo-cut/routes-0.17.0.json, `_source`), and the
// harness is the A2 accept harness (tests/chat-proposals-theme.test.ts) with the real CutLauncher.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { Actor, ArtifactProposal, ChatTranscriptRecord, SessionView } from '../src/core/types.js';
import { CATALOG_SEEDS } from '../src/workflow-catalog/catalog-data.js';
import {
  ChatProposals,
  LaunchOnceRegistry,
  parseMakeBlock,
  proposalRunId,
  type ChatProposalDeps,
  type ProposalChat,
  type ProposalDispatch,
  type ProposalDispatcher,
} from '../src/api/chat-proposals.js';
import { CutLauncher, refusalWords } from '../src/api/proposal-cut.js';
import { CUT_OLD_TOOL, type CutBridgeCall } from '../src/api/cut-read.js';
import { chatMakeDigest, chatMakeLines } from '../src/api/chat-scope.js';

type Answer = { method: string; path: string; body?: Record<string, unknown>; status: number; answer: Record<string, unknown> };
const ROUTES = JSON.parse(readFileSync(new URL('./fixtures/demo-cut/routes-0.17.0.json', import.meta.url), 'utf8')) as Record<string, Answer>;
const DOC = 'demo-8e0ffbece431';
const REF = `mikes/${DOC}`;

const ME: Actor = { id: 'maria', kind: 'human', trust: 'operator' };
const ROOT = mkdtempSync(join(tmpdir(), 'chat-proposals-cut-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/** The document on disk as the video tool leaves it: its manifest (crew reads the head there) and its marker. */
function videoDoc(head: number): void {
  const dir = join(ROOT, 'mikes', DOC);
  mkdirSync(dir, { recursive: true });
  for (let v = 0; v <= head; v += 1) writeFileSync(join(dir, `_v${v}.html`), `<h1>v${v}</h1>`);
  writeFileSync(join(dir, 'versions.json'), JSON.stringify({ head, versions: Array.from({ length: head + 1 }, (_, v) => ({ version: v, ...(v > 0 ? { kind: 'demo' } : {}) })) }));
  writeFileSync(join(dir, 'demo-cut.json'), readFileSync(new URL('./fixtures/demo-cut/demo-cut.json', import.meta.url), 'utf8'));
}

/**
 * The project's video tool. GET cut answers version 1 (then 2 once a recut landed) as interactive did; the request read
 * answers 404, 202 or the echo; a recut checks `expect_head` and answers as interactive did. `next` overrides the next
 * recut's answer (a refusal, a lost connection).
 */
class FakeVideoTool {
  head = 1;
  calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  made = new Map<string, number>();
  pending = new Set<string>();
  next: Answer | 'lose' | 'hold' | null = null;
  old = false;
  /** An older tool that ignores `?request_id` and answers the whole cut (only the request read). */
  oldFind = false;
  /** A render that was submitted and has not committed: lands when {@link commitHeld} runs. */
  held: string | null = null;
  commitHeld(): void {
    const id = this.held!;
    this.held = null;
    this.pending.delete(id);
    this.made.set(id, 2);
    this.head = 2;
    videoDoc(2);
  }
  call: CutBridgeCall = async (method, path, body) => {
    this.calls.push({ method, path, ...(body !== undefined ? { body } : {}) });
    const base = `/d/${DOC}/api/demo`;
    if (method === 'GET' && path === `${base}/cut`) {
      const a = this.head === 1 ? ROUTES['cut-v1']! : ROUTES['cut-v2']!;
      return { status: a.status, body: this.old ? { ...a.answer, head: undefined } : { ...a.answer, head: this.head } };
    }
    const q = path.startsWith(`${base}/cut?request_id=`) ? decodeURIComponent(path.slice(`${base}/cut?request_id=`.length)) : null;
    if (method === 'GET' && q !== null) {
      if (this.old || this.oldFind) return { status: 200, body: { ...ROUTES['cut-v1']!.answer } };
      // As interactive's route: a committed request first, then one still queued or rendering.
      const v = this.made.get(q);
      if (v !== undefined) return { status: 200, body: { request_id: q, version: v } };
      if (this.pending.has(q)) return { status: 202, body: { request_id: q, pending: true } };
      return { status: 404, body: ROUTES['find-before']!.answer };
    }
    if (method === 'POST' && path === `${base}/recut`) {
      const next = this.next;
      this.next = null;
      if (next === 'hold') {
        // Submitted, still rendering, and the caller's connection is lost before the answer.
        this.held = String(body!['request_id']);
        this.pending.add(this.held);
        throw new Error('fetch failed');
      }
      if (next === 'lose') {
        // The render lands, the answer is lost on the way back.
        this.made.set(String(body!['request_id']), 2);
        this.head = 2;
        videoDoc(2);
        throw new Error('fetch failed');
      }
      if (next !== null) return { status: next.status, body: next.answer };
      const id = String(body!['request_id']);
      if (this.made.has(id)) return { status: 200, body: { ...ROUTES['replay']!.answer, version: this.made.get(id)! } };
      if (body!['expect_head'] !== this.head) return { status: 409, body: { error: 'head_moved', head: this.head } };
      this.head = 2;
      this.made.set(id, 2);
      videoDoc(2);
      return { status: ROUTES['recut']!.status, body: ROUTES['recut']!.answer };
    }
    return { status: 404, body: { error: 'not_found' } };
  };
  get recuts(): Array<Record<string, unknown>> {
    return this.calls.filter((c) => c.method === 'POST').map((c) => c.body!);
  }
}

class NoRuns implements ProposalDispatcher {
  launched: ProposalDispatch[] = [];
  async find(): Promise<boolean> { return false; }
  async launch(d: ProposalDispatch): Promise<void> { this.launched.push(d); }
  async live(): Promise<boolean> { return true; }
}

interface Rig {
  svc: ChatProposals;
  records: Map<string, ChatTranscriptRecord[]>;
  chats: Map<string, ProposalChat>;
  runs: SessionView[];
  chatOfRun: Map<string, string>;
  tool: FakeVideoTool;
  jobs: NoRuns;
  accepts: boolean;
  audits: string[];
}

function rig(o: { flag?: boolean; from?: Rig; bridge?: (projectId: string) => Promise<CutBridgeCall | null> } = {}): Rig {
  // `from`: the same transcript and video tool, a new daemon (its proposal service and registry made again).
  const r: Rig = { svc: null as unknown as ChatProposals, records: o.from?.records ?? new Map(), chats: o.from?.chats ?? new Map(), runs: [], chatOfRun: new Map(), tool: o.from?.tool ?? new FakeVideoTool(), jobs: new NoRuns(), accepts: true, audits: [] };
  const bridgeFor = o.bridge ?? (async (projectId: string): Promise<CutBridgeCall | null> => (projectId === 'mikes' ? r.tool.call : null));
  const registry = new LaunchOnceRegistry();
  for (const k of ['create', 'refine', 'demo'] as const) registry.register(k, r.jobs);
  registry.register('cut', new CutLauncher({ bridgeFor }));
  const deps: ChatProposalDeps = {
    flags: () => ({ context: true, instructions: true, proposals: true, create: true, refine: true, theme: true, demo: true, cut: o.flag !== false }),
    catalog: CATALOG_SEEDS,
    records: (c) => [...(r.records.get(c) ?? [])],
    append: (c, rec) => {
      const list = r.records.get(c);
      if (list === undefined) return false;
      list.push(rec);
      return true;
    },
    instanceOf: () => 'i1',
    projectOf: (c) => r.chats.get(c)?.projectId ?? null,
    chat: (c) => r.chats.get(c) ?? null,
    rosterEligible: () => [{ key: 'claude', name: 'Claude Code' }],
    runs: async () => r.runs,
    chatOfRun: (id) => r.chatOfRun.get(id),
    isAskPath: () => false,
    docsRoot: async (projectId) => (projectId === 'mikes' ? join(ROOT, 'mikes') : null),
    projectName: async (p) => (p === 'mikes' ? 'Mikes' : null),
    attachments: () => [],
    workflowSteps: async () => 3,
    runCostUsd: async () => null,
    registry,
    broadcast: () => undefined,
    audit: (event) => r.audits.push(event),
    now: () => 1_000,
    acceptsCut: () => r.accepts,
    cut: { bridgeFor },
  };
  r.svc = new ChatProposals(deps);
  return r;
}

/** A turn of the person's, with the video open at `viewed` of `head` — returns the turn id. */
function turn(r: Rig, chatId: string, o: { viewed?: number; head?: number; open?: string | null } = {}): string {
  if (!r.records.has(chatId)) r.records.set(chatId, []);
  r.chats.set(chatId, { projectId: 'mikes', repos: [], lead: 'claude', seats: ['claude'], analysis: false });
  const list = r.records.get(chatId)!;
  const turnId = `t${list.length + 1}`;
  list.push({ at: 1, turnId, kind: 'user', text: 'drop the setup chapter and open on sign in', seats: ['claude'], owner: true });
  const open = o.open === undefined ? REF : o.open;
  list.push({
    at: 1, turnId, kind: 'context', runs: [], refused: [], page: false, named: { runs: [], docs: [] },
    ...(open !== null ? { artifact: { ref: open, title: 'Demo', kind: 'demo video', viewed: o.viewed ?? 1, head: o.head ?? 1, projectId: 'mikes', copies: [], anchors: [] } } : {}),
  });
  list.push({ at: 2, turnId, kind: 'seat', cliKey: 'claude', text: 'Here is the change.', ok: true, usage: null });
  return turnId;
}

async function propose(r: Rig, chatId: string, turnId: string, block: Record<string, unknown>): Promise<ArtifactProposal | null> {
  r.svc.onReply({ chat: chatId, cliKey: 'claude', turnId, ok: true, blocks: [JSON.stringify(block)] });
  await r.svc.settled();
  const p = [...(r.records.get(chatId) ?? [])].reverse().find((x) => x.kind === 'proposal' && x.proposal.pid === `${chatId}:${turnId}`);
  return p !== undefined && p.kind === 'proposal' ? p.proposal : null;
}

const kinds = (r: Rig, chatId: string): string[] => (r.records.get(chatId) ?? []).map((x) => x.kind).filter((k) => k.startsWith('proposal'));

/** The ops of the real recut the fixture made (drop, move, say). */
const OPS = ROUTES['recut']!.body!['ops'] as Array<Record<string, unknown>>;
const block = (ops: Array<Record<string, unknown>> = OPS, ref = REF): Record<string, unknown> => ({ cut: { ref, ops }, reason: 'They asked to skip setup.' });

beforeEach(() => {
  rmSync(join(ROOT, 'mikes'), { recursive: true, force: true });
  videoDoc(1);
});

describe('cut proposals (crew#1814)', () => {
  it('the journey: a card in crew\'s words, Go posts the frozen ops once with the head and the Go\'s id, the new version is the result', async () => {
    const r = rig();
    const t = turn(r, 'c1');
    const p = (await propose(r, 'c1', t, block()))!;
    expect(p).toMatchObject({
      kind: 'cut', blocked: null, helpers: null,
      what: { title: 'Demo of http://127.0.0.1:5173/', label: 'Change the video · Demo of http://127.0.0.1:5173/', outcome: 'A new version of the video. Earlier versions stay in Versions.' },
      target: { ref: REF, base: 1 },
      cut: { ops: OPS },
    });
    expect(p.cut!.changes[0]).toBe('Drop “Setup” (Undo brings it back)');
    expect(p.cut!.changes[1]).toBe('Move “Sign in” to the start');
    expect(p.cut!.changes[2]).toMatch(/^Caption of “Sign in” → “/u);
    expect(r.tool.recuts).toEqual([]);
    const go = await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1');
    expect(go.code, JSON.stringify(go.body)).toBe(200);
    expect(go.body).toMatchObject({ view: { state: 'decided', decision: 'go', result: { version: 2, adopted: false } } });
    expect(r.tool.recuts).toEqual([{ expect_head: 1, ops: OPS, request_id: proposalRunId(p.pid) }]);
    expect(kinds(r, 'c1')).toStrictEqual(['proposal', 'proposal_accepting', 'proposal_decided']);
    expect(r.jobs.launched).toEqual([]);
    // Go again answers the decision; nothing is posted twice.
    expect((await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1')).code).toBe(200);
    expect(r.tool.recuts).toHaveLength(1);
  });

  it('a lost answer: Go again finds the version the first Go made, never posts again', async () => {
    const r = rig();
    const p = (await propose(r, 'c1', turn(r, 'c1'), block()))!;
    r.tool.next = 'lose';
    const first = await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1');
    expect(first.code).toBe(502);
    expect(JSON.stringify(first.body)).toContain('Go again checks whether it finished');
    // The video moved (to the version this Go made): an accepting Go is not refused for it.
    const again = await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1');
    expect(again.code, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ view: { state: 'decided', result: { version: 2, adopted: true } } });
    expect(r.tool.recuts).toHaveLength(1);
  });

  it('a daemon that lost its answer mid-render, and restarted: Go again is pending (202) until the render commits, then adopts it', async () => {
    const before = rig();
    const p = (await propose(before, 'c1', turn(before, 'c1'), block()))!;
    before.tool.next = 'hold';
    expect((await before.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1')).code).toBe(502);
    // A new daemon: the same transcript (its accepting record) and the same video tool, nothing in memory.
    const r = rig({ from: before });
    const busy = await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1');
    expect(busy.code).toBe(409);
    expect(busy.body).toMatchObject({ code: 'cut_pending', error: 'Still making the new version. It shows here when it is done.' });
    expect(kinds(r, 'c1')).toStrictEqual(['proposal', 'proposal_accepting']);
    r.tool.commitHeld();
    const again = await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1');
    expect(again.code, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ view: { state: 'decided', result: { version: 2, adopted: true } } });
    expect(r.tool.recuts).toHaveLength(1);
  });

  it('an older video tool that ignores the request read is never taken as having made the change', async () => {
    const r = rig();
    const p = (await propose(r, 'c1', turn(r, 'c1'), block()))!;
    expect(p.blocked).toBeNull();
    r.tool.oldFind = true;
    const go = await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1');
    expect(go.code).toBe(502);
    expect(JSON.stringify(go.body)).toContain("This computer's video tool is older than this studio needs.");
    expect(r.tool.recuts).toEqual([]);
    const again = await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1');
    expect(again.code).toBe(502);
    expect(again.body).not.toMatchObject({ view: { state: 'decided' } });
    expect(r.tool.recuts).toEqual([]);
  });

  it('a video tool that will not start blocks the card with why (the card is never dropped)', async () => {
    const r = rig({ bridge: async () => { throw new Error('the bridge on port 4100 is 0.16.2'); } });
    const p = (await propose(r, 'c1', turn(r, 'c1'), block()))!;
    expect(p.blocked).toBe("The video tool isn't running here: the bridge on port 4100 is 0.16.2");
  });

  it('the seat is told the cut block exists only where the client draws it', () => {
    const r = rig();
    turn(r, 'c1');
    expect(r.svc.digest('c1', true, { cut: true }).cut).toBe(true);
    expect(r.svc.digest('c1', true, { cut: false }).cut).toBeUndefined();
    r.accepts = false;
    expect(r.svc.digest('c1', true).cut).toBeUndefined();
    const lines = chatMakeDigest({ create: false, refine: true, theme: true, demo: false, entries: [], jobs: 'cards', cut: true });
    expect(lines).toContain("a change to the demo video open here (the `cut` block, as crew's note on the video says)");
    expect(chatMakeLines({ create: false, refine: true, theme: true, demo: false, entries: [], jobs: 'cards', cut: true }).join('\n')).toContain('A `cut` block only for a change to the demo video open in the turn');
    expect(chatMakeLines({ create: false, refine: true, theme: true, demo: false, entries: [], cut: true }).join('\n')).toContain('(or `cut`, only for a change to the demo video open in the turn');
  });

  it('a video that changed since the card blocks it at Go, and nothing is posted', async () => {
    const r = rig();
    const p = (await propose(r, 'c1', turn(r, 'c1'), block()))!;
    videoDoc(2);
    const go = await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1');
    expect(go.code).toBe(409);
    expect(go.body).toMatchObject({ code: 'cut_moved', error: 'The video changed since this was proposed (now version 2). Ask again to change the new version.' });
    expect(r.tool.recuts).toEqual([]);
    expect([...(r.records.get('c1') ?? [])].filter((x) => x.kind === 'proposal').at(-1)).toMatchObject({ proposal: { blocked: expect.stringContaining('The video changed') } });
    // The card stays blocked.
    expect((await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1')).code).toBe(409);
  });

  it('the video tool\'s own head check at Go (a hand edit landed in between) blocks the card with its words', async () => {
    const r = rig();
    const p = (await propose(r, 'c1', turn(r, 'c1'), block()))!;
    r.tool.next = { ...ROUTES['stale']!, answer: ROUTES['stale']!.answer };
    const go = await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1');
    expect(go.code).toBe(409);
    expect(go.body).toMatchObject({ code: 'cut_moved', error: 'The video changed since this was proposed (now version 2). Ask again to change the new version.' });
    expect(kinds(r, 'c1')).toStrictEqual(['proposal', 'proposal_accepting', 'proposal']);
  });

  it('the video tool\'s refusal of one op says which change and why, and blocks the card', async () => {
    const r = rig();
    const ops = ROUTES['refused-dropped']!.body!['ops'] as Array<Record<string, unknown>>;
    const p = (await propose(r, 'c1', turn(r, 'c1'), block(ops)))!;
    expect(p.blocked).toBeNull();
    r.tool.next = ROUTES['refused-dropped']!;
    const go = await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1');
    expect(go.code).toBe(422);
    expect(go.body).toMatchObject({ code: 'cut_refused', error: 'Change 2 (Move “Welcome” to after “Setup”) can\'t be made: it names a chapter an earlier change drops. Nothing changed. Ask again.' });
    r.tool.next = null;
    const trim = (await propose(r, 'c1', turn(r, 'c1'), block(ROUTES['refused-trim']!.body!['ops'] as Array<Record<string, unknown>>)))!;
    r.tool.next = ROUTES['refused-trim']!;
    expect((await r.svc.decide('c1', trim.pid, { decision: 'go' }, ME, 'i1')).body).toMatchObject({ code: 'cut_refused', error: expect.stringContaining('a trim has to stay inside the chapter’s recording') });
  });

  it('a card crew can tell is wrong is blocked before Go: not the open video, an earlier version, an unknown chapter, a long name, an older tool', async () => {
    const r = rig();
    expect((await propose(r, 'c1', turn(r, 'c1', { open: null }), block()))!.blocked).toBe(`“${DOC}” isn't the video open here.`);
    expect((await propose(r, 'c1', turn(r, 'c1', { viewed: 1, head: 2 }), block()))!.blocked).toBe('They\'re looking at version 1. Only the latest (version 2) can be changed: open it and ask again.');
    expect((await propose(r, 'c1', turn(r, 'c1'), block([{ op: 'chapter-drop', chapter: 'intro' }])))!.blocked).toBe('There\'s no chapter “intro” in this video.');
    expect((await propose(r, 'c1', turn(r, 'c1'), block([{ op: 'chapter-rename', chapter: 'setup', title: 'x'.repeat(81) }])))!.blocked).toBe('A chapter name is one line of 1 to 80 characters.');
    expect((await propose(r, 'c1', turn(r, 'c1'), block([{ op: 'chapter-say', chapter: 'setup', say: 'one\ntwo' }])))!.blocked).toBe('A caption is one line of at most 2000 characters.');
    r.tool.old = true;
    expect((await propose(r, 'c1', turn(r, 'c1'), block()))!.blocked).toBe(CUT_OLD_TOOL);
    r.tool.old = false;
    // The head moved between the person's message and the card.
    r.tool.head = 2;
    expect((await propose(r, 'c1', turn(r, 'c1'), block()))!.blocked).toBe('The video changed while I was answering (now version 2). Ask again to change the new version.');
    // A blocked card never posts.
    expect(r.tool.recuts).toEqual([]);
  });

  it('no card for a client that does not draw it, or a daemon that does not advertise it', async () => {
    const r = rig();
    r.accepts = false;
    expect(await propose(r, 'c1', turn(r, 'c1'), block())).toBeNull();
    const off = rig({ flag: false });
    expect(await propose(off, 'c1', turn(off, 'c1'), block())).toBeNull();
  });

  it('the block is strict: an unknown op or key, no ops, more than 20, or text past the parse cap gives no card', () => {
    const ok = parseMakeBlock(JSON.stringify(block()));
    expect(ok).toMatchObject({ op: 'cut', cut: { ref: REF } });
    for (const bad of [
      block([{ op: 'chapter-explode', chapter: 'setup' }]),
      block([{ op: 'chapter-drop', chapter: 'setup', extra: 1 }]),
      block([]),
      block(Array.from({ length: 21 }, () => ({ op: 'chapter-drop', chapter: 'setup' }))),
      block([{ op: 'chapter-say', chapter: 'setup', say: 'x'.repeat(4001) }]),
      block(OPS, '../etc'),
      { cut: { ref: REF, ops: OPS }, refine: REF, ask: 'x' },
    ]) expect(parseMakeBlock(JSON.stringify(bad)), JSON.stringify(bad).slice(0, 80)).toBeNull();
  });

  it('a cut card takes no edits, and a live job of the chat never holds it up', async () => {
    const r = rig();
    const p = (await propose(r, 'c1', turn(r, 'c1'), block()))!;
    expect((await r.svc.decide('c1', p.pid, { decision: 'go', edits: { helpers: ['claude'] } }, ME, 'i1')).code).toBe(400);
    r.runs = [{ session: { id: 'busy', status: 'executing', project_id: 'mikes', document_id: null, run_identity: { name: 'wf' }, workflow_id: 'wf' }, units: [] } as unknown as SessionView];
    r.chatOfRun.set('busy', 'c1');
    expect((await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1')).code).toBe(200);
  });

  it('a deleted video blocks the card at Go', async () => {
    const r = rig();
    const p = (await propose(r, 'c1', turn(r, 'c1'), block()))!;
    rmSync(join(ROOT, 'mikes', DOC), { recursive: true, force: true });
    const go = await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1');
    expect(go.code).toBe(409);
    expect(go.body).toMatchObject({ code: 'cut_gone' });
    expect(r.tool.recuts).toEqual([]);
  });

  it('refusal words for every reason the video tool gives', () => {
    const ops = [{ op: 'chapter-drop' as const, chapter: 'a' }];
    const words = (reason: string | undefined) => refusalWords('ops.0.chapter', reason, ops, ['Drop “A”']);
    expect(words('unknown')).toBe("Change 1 (Drop “A”) can't be made: it names a chapter this video doesn't have. Nothing changed. Ask again.");
    for (const [reason, said] of [['self', "can't move after itself"], ['last_chapter', 'one chapter has to stay'], ['too_short', 'at least 0.5 s'], ['format', 'isn’t written the way'], ['unsupported', "doesn't know that change"], [undefined, 'refused it']] as const) {
      expect(words(reason)).toContain(said);
    }
    expect(refusalWords('ops', 'format', ops, [])).toMatch(/^A change can't be made/u);
  });
});
