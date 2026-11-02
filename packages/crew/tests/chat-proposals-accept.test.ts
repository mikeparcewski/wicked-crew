// DES-CHAT-ARTIFACTS-001 §4.2-§4.3 (slice A2): the resolver and the accept flow over in-memory deps — the cases the
// server harness cannot stage (a live job filed under the chat, a document being revised, a launcher that fails or
// stays live, a chat id reused mid-accept, a slow resolution). Every refusal is checked to record and start nothing.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { Actor, ArtifactProposal, ChatTranscriptRecord, CoreEvent, SessionView } from '../src/core/types.js';
import { CATALOG_SEEDS } from '../src/workflow-catalog/catalog-data.js';
import {
  ChatProposals,
  foldProposals,
  LaunchOnceRegistry,
  proposalRunId,
  type ChatProposalDeps,
  type ProposalChat,
  type ProposalDispatch,
  type ProposalDispatcher,
} from '../src/api/chat-proposals.js';
import { splitMakeBlocks } from '../src/decisions/chat-recorder.js';

const ME: Actor = { id: 'maria', kind: 'human', trust: 'operator' };
const ROOT = mkdtempSync(join(tmpdir(), 'chat-proposals-accept-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function doc(project: string, name: string, head: number): void {
  const dir = join(ROOT, project, name);
  mkdirSync(dir, { recursive: true });
  for (let v = 1; v <= head; v += 1) writeFileSync(join(dir, `_v${v}.html`), `<h1>v${v}</h1>`);
  writeFileSync(join(dir, 'versions.json'), JSON.stringify({ head, versions: Array.from({ length: head }, (_, i) => ({ version: i + 1 })) }));
}

function run(id: string, o: { status?: string; project?: string | null; doc?: string | null; workflow?: string; created?: number; ended?: number } = {}): SessionView {
  return {
    session: { id, status: o.status ?? 'cancelled', project_id: o.project ?? null, document_id: o.doc ?? null, run_identity: { name: o.workflow ?? 'wf' }, workflow_id: o.workflow ?? 'wf', created_at: o.created, ended_at: o.ended },
    units: [{ id: `${id}:u1`, ord: 1, assigned_cli: 'codex', status: 'done' }],
  } as unknown as SessionView;
}

/** A launcher whose runs can stay live, fail, or be slow. */
class FakeLauncher implements ProposalDispatcher {
  launched: ProposalDispatch[] = [];
  live_ = new Set<string>();
  fail: string | null = null;
  stayLive = false;
  async find(identity: { runId: string }): Promise<boolean> { return this.launched.some((d) => d.identity.runId === identity.runId); }
  async launch(d: ProposalDispatch): Promise<void> {
    if (this.fail !== null) throw new Error(this.fail);
    this.launched.push(d);
    if (this.stayLive) this.live_.add(d.identity.runId);
  }
  async live(runId: string): Promise<boolean> { return this.live_.has(runId); }
}

interface Rig {
  svc: ChatProposals;
  records: Map<string, ChatTranscriptRecord[]>;
  instances: Map<string, string>;
  chats: Map<string, ProposalChat>;
  runs: SessionView[];
  chatOfRun: Map<string, string>;
  launcher: FakeLauncher;
  frames: CoreEvent[];
  audits: string[];
  docsRootCalls: string[];
  roster: Array<{ key: string; name: string }>;
  hold: { runs: Promise<void> | null };
}

function rig(): Rig {
  const r: Rig = {
    svc: null as unknown as ChatProposals,
    records: new Map(),
    instances: new Map(),
    chats: new Map(),
    runs: [],
    chatOfRun: new Map(),
    launcher: new FakeLauncher(),
    frames: [],
    audits: [],
    docsRootCalls: [],
    roster: [{ key: 'claude', name: 'Claude Code' }, { key: 'codex', name: 'Codex' }],
    hold: { runs: null },
  };
  const registry = new LaunchOnceRegistry();
  for (const k of ['create', 'refine', 'theme', 'demo'] as const) registry.register(k, r.launcher);
  const deps: ChatProposalDeps = {
    flags: () => ({ context: true, proposals: true, create: true, refine: true, theme: true, demo: true }),
    catalog: CATALOG_SEEDS,
    records: (c) => [...(r.records.get(c) ?? [])],
    append: (c, rec) => {
      const list = r.records.get(c);
      if (list === undefined) return false;
      list.push(rec);
      return true;
    },
    instanceOf: (c) => r.instances.get(c) ?? null,
    projectOf: (c) => r.chats.get(c)?.projectId ?? null,
    chat: (c) => r.chats.get(c) ?? null,
    rosterEligible: () => r.roster,
    runs: async () => {
      if (r.hold.runs !== null) await r.hold.runs;
      return r.runs;
    },
    chatOfRun: (id) => r.chatOfRun.get(id),
    isAskPath: () => false,
    docsRoot: async (projectId) => {
      r.docsRootCalls.push(projectId);
      return ['mikes', 'other', 'default'].includes(projectId) ? join(ROOT, projectId === 'default' ? '_unfiled' : projectId) : null;
    },
    projectName: async (p) => (p === 'mikes' ? 'Mikes' : null),
    attachments: () => [],
    workflowSteps: async () => 3,
    runCostUsd: async (v) => (v.session.id.startsWith('costed') ? 0.5 + Number(v.session.id.slice(-1)) / 10 : null),
    registry,
    broadcast: (f) => r.frames.push(f),
    audit: (event) => r.audits.push(event),
    now: () => 1_000,
  };
  r.svc = new ChatProposals(deps);
  return r;
}

/** A chat with one owner turn (and a context record naming runs/docs) — returns the turn id. */
function chatWith(r: Rig, chatId: string, o: { projectId?: string | null; words?: string; namedRuns?: string[]; namedDocs?: string[]; open?: string; owner?: boolean; analysis?: boolean } = {}): string {
  const turnId = `t${(r.records.get(chatId)?.length ?? 0) + 1}`;
  if (!r.records.has(chatId)) r.records.set(chatId, []);
  if (!r.instances.has(chatId)) r.instances.set(chatId, 'i1');
  r.chats.set(chatId, { projectId: o.projectId ?? null, repos: [{ id: 'r-crew', name: 'wicked-crew' }], lead: 'claude', seats: ['claude'], analysis: o.analysis === true });
  const list = r.records.get(chatId)!;
  list.push({ at: 1, turnId, kind: 'user', text: o.words ?? 'make it', seats: ['claude'], ...(o.owner === false ? {} : { owner: true as const }) });
  list.push({
    at: 1, turnId, kind: 'context', runs: [], refused: [], page: false,
    named: { runs: o.namedRuns ?? [], docs: o.namedDocs ?? [] },
    ...(o.open !== undefined ? { artifact: { ref: o.open, title: 'Coverage deck', kind: 'slides', viewed: 1, head: 1, projectId: null, copies: [], anchors: [] } } : {}),
  });
  list.push({ at: 2, turnId, kind: 'seat', cliKey: 'claude', text: 'answer', ok: true, usage: null });
  return turnId;
}

async function propose(r: Rig, chatId: string, turnId: string, block: Record<string, unknown>): Promise<ArtifactProposal | null> {
  r.svc.onReply({ chat: chatId, cliKey: 'claude', turnId, ok: true, blocks: [JSON.stringify(block)] });
  await r.svc.settled();
  const p = [...(r.records.get(chatId) ?? [])].reverse().find((x) => x.kind === 'proposal' && x.proposal.pid === `${chatId}:${turnId}`);
  return p !== undefined && p.kind === 'proposal' ? p.proposal : null;
}

const kinds = (r: Rig, chatId: string): string[] => (r.records.get(chatId) ?? []).map((x) => x.kind).filter((k) => k.startsWith('proposal'));

beforeEach(() => {
  doc('mikes', 'coverage-deck', 2);
  doc('other', 'their-deck', 1);
});

describe('the resolver', () => {
  it('a refine of an unnamed or out-of-scope document is blocked before anything of it is read, and carries no target', async () => {
    const r = rig();
    const t = chatWith(r, 'c1', { projectId: 'mikes' });
    const p = await propose(r, 'c1', t, { refine: 'other/their-deck', ask: 'x' });
    expect(p?.blocked).toBe('their deck · not open or named in this chat');
    expect(p?.target).toBeUndefined();
    expect(r.docsRootCalls).not.toContain('other');
    const t2 = chatWith(r, 'c2', { projectId: 'mikes', namedDocs: ['other/their-deck'] });
    const q = await propose(r, 'c2', t2, { refine: 'other/their-deck', ask: 'x' });
    expect(q?.blocked).toBe("their deck · not in this chat's project");
    expect(r.docsRootCalls).not.toContain('other');
  });

  it('a document the person typed by its ref counts as named; words from another sender do not', async () => {
    const r = rig();
    const t = chatWith(r, 'c1', { words: 'Change mikes/coverage-deck: slide 1 as a timeline' });
    expect(await propose(r, 'c1', t, { refine: 'mikes/coverage-deck', ask: 'timeline' })).toMatchObject({ blocked: null, target: { base: 2 } });
    const t2 = chatWith(r, 'c2', { words: 'Change mikes/coverage-deck please', owner: false });
    expect((await propose(r, 'c2', t2, { refine: 'mikes/coverage-deck', ask: 'x' }))?.blocked).toMatch(/not open or named/);
    // A longer name or path is not the document: nothing of it is read.
    for (const words of ['see mikes/coverage-deck-2', 'see mikes/coverage-deck/notes', 'see mikes/coverage-deck.html', 'see mikes/coverage-deck_x']) {
      const id = `p-${words.length}-${words.at(-1)}`;
      const t3 = chatWith(r, id, { words });
      expect((await propose(r, id, t3, { refine: 'mikes/coverage-deck', ask: 'x' }))?.blocked, words).toMatch(/not open or named/);
    }
    // Sentence punctuation after the ref is still the ref.
    const t4 = chatWith(r, 'c4', { words: 'Please change mikes/coverage-deck.' });
    expect((await propose(r, 'c4', t4, { refine: 'mikes/coverage-deck', ask: 'x' }))?.blocked).toBeNull();
  });

  it('a demo address must be one the person gave, whole: a prefix, a substring or a query-string URL is not', async () => {
    const r = rig();
    const words = 'Record a demo of http://192.168.1.100:8080/app and https://app.local/auth?redirect=https://evil.example/phish please.';
    for (const [url, ok] of [['http://192.168.1.100:8080/app', true], ['http://192.168.1.10', false], ['https://evil.example/phish', false], ['https://app.local/auth?redirect=https://evil.example/phish', true]] as const) {
      const id = `d-${url.length}`;
      const t = chatWith(r, id, { words });
      const p = await propose(r, id, t, { entry: 'demo-video', url, audience: 'eng', show: 'x' });
      expect(p?.blocked === null, url).toBe(ok);
    }
    // An agent's message carrying the address does not make it the person's.
    const t = chatWith(r, 'agent-said', { words: 'http://localhost:3000', owner: false });
    expect((await propose(r, 'agent-said', t, { entry: 'demo-video', url: 'http://localhost:3000' }))?.blocked).toBe('The app address must come from you: say it in the chat');
  });

  it('an analysis chat proposes nothing; one card per turn (a second seat never replaces it)', async () => {
    const r = rig();
    const t = chatWith(r, 'a1', { analysis: true });
    expect(await propose(r, 'a1', t, { entry: 'presentation' })).toBeNull();
    const t2 = chatWith(r, 'c1');
    await propose(r, 'c1', t2, { entry: 'presentation', title: 'First' });
    r.svc.onReply({ chat: 'c1', cliKey: 'codex', turnId: t2, ok: true, blocks: [JSON.stringify({ entry: 'presentation', title: 'Second' })] });
    await r.svc.settled();
    const ps = (r.records.get('c1') ?? []).filter((x) => x.kind === 'proposal');
    expect(ps).toHaveLength(1);
    expect(ps[0]!.kind === 'proposal' && ps[0]!.proposal.what.title).toBe('First');
  });

  it('a late reply to an earlier turn never takes the chat back from a newer turn’s card', async () => {
    const r = rig();
    const t1 = chatWith(r, 'c1');
    const t2 = chatWith(r, 'c1');
    await propose(r, 'c1', t2, { entry: 'presentation', title: 'Newer' });
    r.svc.onReply({ chat: 'c1', cliKey: 'codex', turnId: t1, ok: true, blocks: [JSON.stringify({ entry: 'presentation', title: 'Late' })] });
    await r.svc.settled();
    const f = foldProposals(r.records.get('c1')!);
    expect([...f.keys()]).toStrictEqual([`c1:${t2}`]);
    expect(f.get(`c1:${t2}`)?.state).toBe('open');
  });

  it('resolutions publish in reply order: a slow older one never supersedes a newer one', async () => {
    const r = rig();
    const t1 = chatWith(r, 'c1');
    const t2 = chatWith(r, 'c1');
    let release!: () => void;
    r.hold.runs = new Promise<void>((res) => { release = res; });
    r.svc.onReply({ chat: 'c1', cliKey: 'claude', turnId: t1, ok: true, blocks: [JSON.stringify({ entry: 'presentation', title: 'Older' })] });
    r.svc.onReply({ chat: 'c1', cliKey: 'claude', turnId: t2, ok: true, blocks: [JSON.stringify({ theme: { name: 'Newer', patch: { ambient: true } } })] });
    await new Promise((res) => setTimeout(res, 10));
    r.hold.runs = null;
    release();
    await r.svc.settled();
    const f = foldProposals(r.records.get('c1')!);
    expect(f.get(`c1:${t1}`)?.state).toBe('superseded');
    expect(f.get(`c1:${t2}`)?.state).toBe('open');
  });

  it('time and cost: the median over completed runs; dollars only from 3 runs whose every step reported a cost', async () => {
    const r = rig();
    r.runs = [
      run('costed-1', { status: 'completed', workflow: 'interactive-draft', created: 0, ended: 600 }),
      run('costed-2', { status: 'completed', workflow: 'interactive-draft', created: 0, ended: 540 }),
      run('plain-3', { status: 'completed', workflow: 'interactive-draft', created: 0, ended: 480 }),
      run('failed-4', { status: 'failed', workflow: 'interactive-draft', created: 0, ended: 60 }),
    ];
    const t = chatWith(r, 'c1');
    const two = await propose(r, 'c1', t, { entry: 'document-static', title: 'x' });
    expect(two?.time).toMatchObject({ minutes: [10, 20], steps: 3, median: { runs: 3, minutes: 9, costUsd: null, costRuns: 2 } });
    expect(two?.time?.label).toBe('About 10–20 min · 3 steps · median of 3 past documents here: 9 min');
    r.runs.push(run('costed-5', { status: 'completed', workflow: 'interactive-draft', created: 0, ended: 420 }));
    const t2 = chatWith(r, 'c2');
    expect((await propose(r, 'c2', t2, { entry: 'document-static', title: 'x' }))?.time?.median).toMatchObject({ runs: 4, costUsd: 0.7, costRuns: 3 });
  });

  it('message: names the earlier answer; two spellings of one run are one chip; the frame carries the chat’s project', async () => {
    const r = rig();
    r.runs = [run('29bbbfb1-1111-4000-8000-000000000001', { project: 'mikes' })];
    const t = chatWith(r, 'c1', { projectId: 'mikes', namedRuns: ['29bbbfb1-1111-4000-8000-000000000001'] });
    const p = await propose(r, 'c1', t, { entry: 'document-static', sources: [`message:${t}`, 'run:29bbbfb1', 'run:29BBBFB1-1111-4000-8000-000000000001'] });
    expect(p?.sources.map((s) => [s.token, s.label.replace(/ at \d\d:\d\d$/, ''), s.status])).toStrictEqual([
      [`message:${t}`, "claude's answer", 'ok'],
      ['run:29bbbfb1-1111-4000-8000-000000000001', 'run 29bbbfb1 · stopped', 'ok'],
    ]);
    expect(r.frames.at(-1)).toMatchObject({ type: 'chatProposal', chat: 'c1', project_id: 'mikes', record: { kind: 'proposal' } });
  });
});

describe('the accept flow', () => {
  it('a live job filed under the chat refuses Go (nothing recorded, nothing started); Not now still records', async () => {
    const r = rig();
    const t = chatWith(r, 'c1');
    const p = (await propose(r, 'c1', t, { entry: 'presentation', title: 'x' }))!;
    r.runs = [run('busy-run', { status: 'executing' })];
    r.chatOfRun.set('busy-run', 'c1');
    const go = await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1');
    expect(go).toMatchObject({ code: 409, body: { code: 'chat_busy' } });
    expect(kinds(r, 'c1')).toStrictEqual(['proposal']);
    expect(r.launcher.launched).toHaveLength(0);
    expect((await r.svc.decide('c1', p.pid, { decision: 'not_now' }, ME, 'i1')).code).toBe(200);
    expect(kinds(r, 'c1')).toStrictEqual(['proposal', 'proposal_decided']);
  });

  it('a document being revised refuses a refine of it: document_busy', async () => {
    const r = rig();
    const t = chatWith(r, 'c1', { open: 'mikes/coverage-deck' });
    const p = (await propose(r, 'c1', t, { refine: 'mikes/coverage-deck', ask: 'x' }))!;
    r.runs = [run('revising', { status: 'executing', project: 'mikes', doc: 'coverage-deck' })];
    expect(await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1')).toMatchObject({ code: 409, body: { code: 'document_busy' } });
    expect(r.launcher.launched).toHaveLength(0);
  });

  it('two proposals of one chat answered at once start ONE job (the chat lock spans the busy check and the launch)', async () => {
    const r = rig();
    r.launcher.stayLive = true;
    const t1 = chatWith(r, 'c1');
    const p1 = (await propose(r, 'c1', t1, { entry: 'presentation', title: 'one' }))!;
    // An interrupted Go on p1 (accepting, no run), then a newer proposal p2.
    r.records.get('c1')!.push({ at: 3, turnId: t1, kind: 'proposal_accepting', pid: p1.pid, actor: 'maria', edits: null, resolution: p1, identity: { artifactRef: '_unfiled/one', runId: proposalRunId(p1.pid) } });
    const t2 = chatWith(r, 'c1');
    const p2 = (await propose(r, 'c1', t2, { entry: 'presentation', title: 'two' }))!;
    const [a, b] = await Promise.all([r.svc.decide('c1', p1.pid, { decision: 'go' }, ME, 'i1'), r.svc.decide('c1', p2.pid, { decision: 'go' }, ME, 'i1')]);
    expect([a.code, b.code].sort()).toStrictEqual([200, 409]);
    expect([a, b].find((x) => x.code === 409)?.body).toMatchObject({ code: 'chat_busy' });
    expect(r.launcher.launched).toHaveLength(1);
  });

  it('a refine whose head moved while the busy check waited re-resolves instead of starting', async () => {
    const r = rig();
    const t = chatWith(r, 'c1', { open: 'mikes/coverage-deck' });
    const p = (await propose(r, 'c1', t, { refine: 'mikes/coverage-deck', ask: 'x' }))!;
    let release!: () => void;
    r.hold.runs = new Promise<void>((res) => { release = res; });
    const pending = r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1');
    await new Promise((res) => setTimeout(res, 10));
    doc('mikes', 'coverage-deck', 3); // a hand edit lands meanwhile
    r.hold.runs = null;
    release();
    expect(await pending).toMatchObject({ code: 409, body: { code: 'proposal_reresolved', view: { proposal: { target: { base: 3 } } } } });
    expect(r.launcher.launched).toHaveLength(0);
  });

  it('a source that moved project, a helper that signed out, or a gone project refuses Go', async () => {
    const r = rig();
    r.runs = [run('29bbbfb1-aaaa', { project: 'mikes' })];
    const t = chatWith(r, 'c1', { projectId: 'mikes', namedRuns: ['29bbbfb1-aaaa'] });
    const p = (await propose(r, 'c1', t, { entry: 'presentation', sources: ['run:29bbbfb1-aaaa'] }))!;
    expect(p.sources[0]?.status).toBe('ok');
    r.runs = [run('29bbbfb1-aaaa', { project: 'other' })];
    expect((await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1')).body).toMatchObject({ code: 'source_gone', error: 'run 29bbbfb1 · stopped moved to another project since this was proposed' });
    r.runs = [run('29bbbfb1-aaaa', { project: 'mikes' })];
    r.roster = [{ key: 'claude', name: 'Claude Code' }];
    expect((await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1')).body).toMatchObject({ code: 'helper_unavailable', error: "codex can't work now; pick another helper" });
    expect(r.launcher.launched).toHaveLength(0);
    expect(kinds(r, 'c1')).toStrictEqual(['proposal']);
  });

  it('a missing second helper is lifted by choosing two; the decided card shows what was accepted', async () => {
    const r = rig();
    r.roster = [{ key: 'claude', name: 'Claude Code' }];
    const t = chatWith(r, 'c1');
    const p = (await propose(r, 'c1', t, { entry: 'presentation', title: 'Original' }))!;
    expect(p.blocked).toBe('Needs a second helper to check it');
    expect((await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1')).body).toMatchObject({ code: 'proposal_blocked' });
    r.roster = [{ key: 'claude', name: 'Claude Code' }, { key: 'pi', name: 'Pi' }];
    const go = await r.svc.decide('c1', p.pid, { decision: 'go', edits: { helpers: ['claude', 'pi'], title: 'Edited' } }, ME, 'i1');
    expect(go.code).toBe(200);
    expect(go.body).toMatchObject({ view: { state: 'decided', proposal: { what: { title: 'Edited' }, helpers: { seats: ['claude', 'pi'] }, blocked: null } } });
    // A retry answers the same, edited card.
    expect((await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1')).body).toMatchObject({ view: { proposal: { what: { title: 'Edited' } } } });
  });

  it('two chats refining one document at once start ONE revision (the document lock and its live run)', async () => {
    const r = rig();
    r.launcher.stayLive = true;
    const ta = chatWith(r, 'ca', { open: 'mikes/coverage-deck' });
    const tb = chatWith(r, 'cb', { open: 'mikes/coverage-deck' });
    const pa = (await propose(r, 'ca', ta, { refine: 'mikes/coverage-deck', ask: 'a' }))!;
    const pb = (await propose(r, 'cb', tb, { refine: 'mikes/coverage-deck', ask: 'b' }))!;
    const [a, b] = await Promise.all([r.svc.decide('ca', pa.pid, { decision: 'go' }, ME, 'i1'), r.svc.decide('cb', pb.pid, { decision: 'go' }, ME, 'i1')]);
    expect([a.code, b.code].sort()).toStrictEqual([200, 409]);
    expect([a, b].find((x) => x.code === 409)?.body).toMatchObject({ code: 'document_busy' });
    expect(r.launcher.launched).toHaveLength(1);
  });

  it('an interrupted Go whose helper signed out resumes with two working helpers chosen now (and nothing else changed)', async () => {
    const r = rig();
    const t = chatWith(r, 'c1');
    const p = (await propose(r, 'c1', t, { entry: 'presentation', title: 'Keep' }))!;
    r.records.get('c1')!.push({ at: 3, turnId: t, kind: 'proposal_accepting', pid: p.pid, actor: 'maria', edits: null, resolution: p, identity: { artifactRef: '_unfiled/keep', runId: proposalRunId(p.pid) } });
    r.roster = [{ key: 'claude', name: 'Claude Code' }, { key: 'pi', name: 'Pi' }];
    expect((await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1')).body).toMatchObject({ code: 'helper_unavailable' });
    expect((await r.svc.decide('c1', p.pid, { decision: 'go', edits: { title: 'Changed' } }, ME, 'i1')).body).toMatchObject({ code: 'edits_invalid' });
    const go = await r.svc.decide('c1', p.pid, { decision: 'go', edits: { helpers: ['claude', 'pi'] } }, ME, 'i1');
    expect(go.code).toBe(200);
    expect(go.body).toMatchObject({ view: { proposal: { what: { title: 'Keep' }, helpers: { seats: ['claude', 'pi'] } } } });
    expect(r.launcher.launched[0]?.identity.runId).toBe(proposalRunId(p.pid));
  });

  it('a stub dispatch found after a crash is adopted and recorded as a stub', async () => {
    const r = rig();
    const t = chatWith(r, 'c1');
    const p = (await propose(r, 'c1', t, { entry: 'presentation' }))!;
    const identity = { artifactRef: '_unfiled/x', runId: proposalRunId(p.pid) };
    r.records.get('c1')!.push({ at: 3, turnId: t, kind: 'proposal_accepting', pid: p.pid, actor: 'maria', edits: null, resolution: p, identity });
    // The launcher already has it, and is the test configuration's stub.
    Object.assign(r.launcher, { stub: true });
    r.launcher.launched.push({ kind: 'create', pid: p.pid, chatId: 'c1', actor: ME, identity, resolution: p });
    const go = await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1');
    expect(go.body).toMatchObject({ view: { state: 'decided', result: { adopted: true, stub: true } } });
    const decided = r.records.get('c1')!.find((x) => x.kind === 'proposal_decided');
    expect(decided).toMatchObject({ result: { adopted: true, stub: true } });
    expect(r.launcher.launched).toHaveLength(1);
  });

  it('a failed launch keeps accepting (with the view); Go again starts it once; a crash-adopted stub stays a stub', async () => {
    const r = rig();
    const t = chatWith(r, 'c1');
    const p = (await propose(r, 'c1', t, { entry: 'presentation' }))!;
    r.launcher.fail = 'engine down';
    const failed = await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1');
    expect(failed).toMatchObject({ code: 502, body: { code: 'launch_failed', view: { state: 'accepting' } } });
    r.launcher.fail = null;
    expect((await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1')).code).toBe(200);
    expect(r.launcher.launched).toHaveLength(1);
    // Adoption reports the launcher's stub flag.
    const stubReg = new LaunchOnceRegistry();
    const stub: ProposalDispatcher = { stub: true, find: async () => true, launch: async () => undefined };
    stubReg.register('create', stub);
    expect(await stubReg.find('create', { artifactRef: null, runId: 'x' })).toStrictEqual({ stub: true });
  });

  it('a chat closed and its id reused mid-accept: nothing is recorded on the new chat and nothing starts', async () => {
    const r = rig();
    const t = chatWith(r, 'c1');
    const p = (await propose(r, 'c1', t, { entry: 'presentation' }))!;
    let release!: () => void;
    r.hold.runs = new Promise<void>((res) => { release = res; });
    const pending = r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1');
    await new Promise((res) => setTimeout(res, 10));
    // The id is reused: a new instance with its own (empty) transcript.
    r.instances.set('c1', 'i2');
    r.records.set('c1', []);
    r.hold.runs = null;
    release();
    expect(await pending).toMatchObject({ code: 409, body: { code: 'chat_gone' } });
    expect(r.records.get('c1')).toStrictEqual([]);
    expect(r.launcher.launched).toHaveLength(0);
  });
});

describe('the fence', () => {
  it('another opening is not a close: nothing of a block is left in the reply', () => {
    const text = 'I can make that.\n```wicked-make\n{"entry":"broken"\n```wicked-make\n{"entry":"presentation"}\n```\nDone.';
    const out = splitMakeBlocks(text);
    expect(out.text).toBe('I can make that.\nDone.');
    expect(out.text).not.toContain('presentation');
    // The first opening's body runs to the one real close: one (unparseable) block, nothing truncated.
    expect(out.blocks).toHaveLength(1);
    expect(out.truncated).toBe(false);
  });

  it('a decisions block left open never eats a make block: neither shows', async () => {
    const { splitDecisionsBlock } = await import('../src/decisions/chat-recorder.js');
    const text = 'Sure.\n```wicked-decisions\n{"items":[]\n```wicked-make\n{"entry":"presentation"}\n```\n';
    const d = splitDecisionsBlock(text);
    expect(d.text).toBe('Sure.');
    expect(splitMakeBlocks(d.text).text).toBe('Sure.');
  });
});

describe('the fold (r2)', () => {
  it('an older proposal re-resolved after a newer one exists is superseded, never re-opened over it', () => {
    const p = (pid: string): ArtifactProposal => ({ pid, chatId: 'c1', turnId: pid.split(':')[1]!, kind: 'refine', seat: 'claude', what: { entry: null, title: 'D', label: 'Change · D', outcome: null }, brief: null, reason: null, sources: [], repos: [], helpers: null, time: null, stops: null, filedIn: { projectId: null, label: 'x' }, blocked: null });
    const f = foldProposals([
      { at: 1, turnId: 't1', kind: 'proposal', proposal: p('c1:t1') },
      { at: 2, turnId: 't1', kind: 'proposal_accepting', pid: 'c1:t1', actor: 'm', edits: null, resolution: p('c1:t1'), identity: { artifactRef: null, runId: 'r' } },
      { at: 3, turnId: 't2', kind: 'proposal', proposal: p('c1:t2') },
      { at: 4, turnId: 't1', kind: 'proposal', proposal: p('c1:t1') },
    ]);
    expect(f.get('c1:t1')?.state).toBe('superseded');
    expect(f.get('c1:t2')?.state).toBe('open');
  });
});
