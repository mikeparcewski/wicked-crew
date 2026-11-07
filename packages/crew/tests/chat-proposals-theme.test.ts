// DES-CHAT-ARTIFACTS-001 §9 / §15.2 (slice A7): a theme proposal's Go starts no run. Its launcher is the real
// ThemeLauncher; the harness is the A2 accept harness (tests/chat-proposals-accept.test.ts).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { Actor, ArtifactProposal, ChatTranscriptRecord, CoreEvent, SessionView } from '../src/core/types.js';
import { CATALOG_SEEDS } from '../src/workflow-catalog/catalog-data.js';
import {
  ChatProposals,
  LaunchOnceRegistry,
  type ChatProposalDeps,
  type ProposalChat,
  type ProposalDispatch,
  type ProposalDispatcher,
} from '../src/api/chat-proposals.js';
import { ThemeLauncher } from '../src/api/proposal-theme.js';

const ME: Actor = { id: 'maria', kind: 'human', trust: 'operator' };
const ROOT = mkdtempSync(join(tmpdir(), 'chat-proposals-theme-'));
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
  attachments: Array<{ id: string; name: string }>;
  auditDetails: Array<Record<string, unknown>>;
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
    attachments: [],
    auditDetails: [],
  };
  const registry = new LaunchOnceRegistry();
  for (const k of ['create', 'refine', 'demo'] as const) registry.register(k, r.launcher);
  registry.register('theme', new ThemeLauncher());
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
    attachments: () => r.attachments,
    workflowSteps: async () => 3,
    runCostUsd: async (v) => (v.session.id.startsWith('costed') ? 0.5 + Number(v.session.id.slice(-1)) / 10 : null),
    registry,
    broadcast: (f) => r.frames.push(f),
    audit: (event) => r.audits.push(event),
    now: () => 1_000,
  };
  r.svc = new ChatProposals({ ...deps, audit: (event, _actor, detail) => { r.audits.push(event); r.auditDetails.push(detail as Record<string, unknown>); } });
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

describe('theme proposals (A7)', () => {
  const block = { theme: { name: 'Calm night', patch: { theme: 'wicked-dark', accent_h: 210, accent_s: 14, accent_l: 70, ambient: false } } };

  it('Go records the applied delta and starts nothing; a repeat answers the record', async () => {
    const r = rig();
    const t = chatWith(r, 'c1', { projectId: 'mikes', words: 'a calmer dark theme' });
    const p = (await propose(r, 'c1', t, block))!;
    expect(p).toMatchObject({ kind: 'theme', helpers: null, blocked: null, theme: { changes: ['theme', 'accent_h', 'accent_s', 'accent_l', 'ambient'] } });
    // Studio applied the accumulated delta (one key the person moved on the Theme page): Go carries it.
    const edits = { name: 'Calm night', patch: { theme: 'wicked-dark', accent_h: 200, ambient: false } };
    const go = await r.svc.decide('c1', p.pid, { decision: 'go', edits }, ME, 'i1');
    expect(go.code, JSON.stringify(go.body)).toBe(200);
    expect(go.body).toMatchObject({ view: { state: 'decided', decision: 'go', result: { stub: false, adopted: false, artifactRef: null }, proposal: { theme: { patch: edits.patch, changes: ['theme', 'accent_h', 'ambient'] } } } });
    expect(kinds(r, 'c1')).toStrictEqual(['proposal', 'proposal_accepting', 'proposal_decided']);
    expect(r.launcher.launched).toHaveLength(0);
    expect(r.audits.at(-1)).toBe('chat.proposal.accepted');
    expect(r.auditDetails.at(-1)).toMatchObject({ kind: 'theme', edits });
    const again = await r.svc.decide('c1', p.pid, { decision: 'go', edits }, ME, 'i1');
    expect(again.code).toBe(200);
    expect(kinds(r, 'c1')).toStrictEqual(['proposal', 'proposal_accepting', 'proposal_decided']);
  });

  it('a theme is no job: a live run filed under the chat does not refuse it (a document still does)', async () => {
    const r = rig();
    const t = chatWith(r, 'c1');
    const p = (await propose(r, 'c1', t, block))!;
    r.runs = [run('busy-run', { status: 'executing' })];
    r.chatOfRun.set('busy-run', 'c1');
    expect((await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1')).code).toBe(200);
    // ...and an applied theme never makes the chat busy for its next job.
    r.runs = [];
    r.launcher.stayLive = true;
    const t2 = chatWith(r, 'c1');
    const doc = (await propose(r, 'c1', t2, { entry: 'presentation', title: 'x' }))!;
    expect((await r.svc.decide('c1', doc.pid, { decision: 'go' }, ME, 'i1')).code).toBe(200);
    expect(r.launcher.launched).toHaveLength(1);
  });

  it('an edit that is not a theme patch studio can apply is refused, recording nothing', async () => {
    const r = rig();
    const t = chatWith(r, 'c1');
    const p = (await propose(r, 'c1', t, block))!;
    for (const patch of [{}, { logo_url: 'http://x' }, { accent_h: 999 }]) {
      const out = await r.svc.decide('c1', p.pid, { decision: 'go', edits: { patch } as never }, ME, 'i1');
      expect(out.code).toBe(400);
    }
    expect((await r.svc.decide('c1', p.pid, { decision: 'go', edits: { helpers: ['claude', 'codex'] } }, ME, 'i1')).code).toBe(400);
    expect(kinds(r, 'c1')).toStrictEqual(['proposal']);
  });

  it('the launcher refuses anything but a theme', async () => {
    const l = new ThemeLauncher();
    const identity = { artifactRef: null, runId: 'x' };
    await expect(l.launch({ kind: 'create', pid: 'c:t', chatId: 'c', actor: ME, identity, resolution: { kind: 'create' } as never })).rejects.toThrow(/only a theme/);
    await expect(l.launch({ kind: 'theme', pid: 'c:t', chatId: 'c', actor: ME, identity, resolution: { kind: 'theme' } as never })).rejects.toThrow(/only a theme/);
    expect(await l.find()).toBe(false);
    expect(await l.live()).toBe(false);
  });
});
