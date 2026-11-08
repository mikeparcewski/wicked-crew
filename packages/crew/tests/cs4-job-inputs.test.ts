import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { Actor, ArtifactProposal, ChatTranscriptRecord, ProposalRevisionEdits } from '../src/core/types.js';
import type { CardSeedV2 } from '../src/workflow-catalog/seeds-v2.js';
import { INPUT_KINDS_V2, inputsOf, servedState } from '../src/workflow-catalog/build-v2.js';
import { CATALOG_SEEDS } from '../src/workflow-catalog/catalog-data.js';
import { ChatProposals, LaunchOnceRegistry, RevisionEditsSchema, type ChatProposalDeps, type ProposalChat, type ProposalDispatch } from '../src/api/chat-proposals.js';
import { projectSources } from '../src/api/run-sources.js';
import { factsOf, inputLines, jobInputsOfProposal, mergeRevision, resolveJob, type JobContext } from '../src/api/chat-jobs.js';

// CS8 owns the real seeds. Exercise the real resolver with cards that already take the CS4 inputs.
vi.mock('../src/workflow-catalog/catalog-data-v2.js', async (original) => {
  const actual = await original<typeof import('../src/workflow-catalog/catalog-data-v2.js')>();
  const card = (id: string, inputs: string[]): CardSeedV2 => ({
    id, title: id, category: 'investigate', release: '1.0', inputs, delivers: 'report',
    launch: { kind: 'run', workflow: 'cs4-fixture' }, command: `/${id}`, aliases: [],
  });
  return { ...actual, CATALOG_V2_CARDS: [
    card('documents-job', ['intent', 'documents', 'sources?']),
    card('optional-documents', ['intent', 'documents?']),
    card('research', ['intent', 'sources']),
    card('competitive', ['intent', 'sources']),
    card('plain-job', ['intent']),
  ] };
});

const ROOT = mkdtempSync(join(tmpdir(), 'cs4-job-inputs-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const ME: Actor = { id: 'maria', kind: 'human', trust: 'operator' };
const served = { ...servedState({ defs: [], presets: [{ name: 'cs4-fixture', created_by: 'builtin', steps: [] } as never], entries: [] }), rev: 'cs4' };
type Source = NonNullable<JobContext['jobSources']>[number];
const WEB: Source = { id: 'web', label: 'the web', web: true };
const SUPPORT: Source = { id: 'support-pg', label: 'support-pg' };

function rig(sources: Source[] | undefined = [WEB, SUPPORT], webReason?: string) {
  const records: ChatTranscriptRecord[] = [];
  const files = [{ id: 'first', name: 'first.txt', bytes: 10 }, { id: 'second', name: 'second.pdf', bytes: 10 }];
  let chat: ProposalChat | null = { projectId: 'project-a', repos: [], lead: 'claude', seats: ['claude'], analysis: false };
  const launches: ProposalDispatch[] = [];
  const registry = new LaunchOnceRegistry();
  registry.register('job', { find: async () => false, launch: async (d) => { launches.push(d); } });
  let request = 0;
  const deps: ChatProposalDeps = {
    flags: () => ({ context: true, proposals: true, create: true, refine: false, theme: false, demo: false }),
    catalog: CATALOG_SEEDS, records: () => [...records], append: (_id, record) => { records.push(record); return true; },
    instanceOf: () => 'instance', projectOf: () => chat?.projectId ?? null, chat: () => chat,
    rosterEligible: () => [{ key: 'claude', name: 'Claude' }, { key: 'codex', name: 'Codex' }],
    runs: async () => [], chatOfRun: () => undefined, isAskPath: () => false,
    docsRoot: async (project) => join(ROOT, project), projectName: async (id) => id,
    attachments: (id) => id === 'chat' ? files : [], workflowSteps: async () => 1, runCostUsd: async () => null,
    registry, jobs: () => true, acceptsJobs: () => true, served: async () => served,
    ...(sources !== undefined ? { jobSources: async () => sources } : {}),
    ...(webReason !== undefined ? { webReason: async () => webReason } : {}),
    reshapeReject: async () => null,
    broadcast: () => undefined, audit: () => undefined,
  };
  const svc = new ChatProposals(deps);
  const pick = async (card = 'documents-job') => {
    const result = await svc.propose('chat', { card, source: 'pick', requestId: `pick-${++request}`, words: 'read these documents' }, ME, 'instance');
    expect(result.code).toBe(201);
    return (result.body['view'] as { proposal: ArtifactProposal }).proposal;
  };
  const swap = async (p: ArtifactProposal, edits: ProposalRevisionEdits) => {
    const result = await svc.propose('chat', { revises: p.pid, edits, source: 'swap', requestId: `swap-${++request}` }, ME, 'instance');
    expect(result.code).toBe(201);
    return (result.body['view'] as { proposal: ArtifactProposal }).proposal;
  };
  return { svc, files, records, launches, deps, pick, swap, end: () => { chat = null; } };
}

const token = (p: ArtifactProposal, kind: 'documents' | 'sources') => p.sentence!.tokens.find((t) => t.kind === kind)!;

const reshapeRequest = (p: ArtifactProposal, edits: ProposalRevisionEdits = {}) => ({
  pid: `${p.pid}:reshape`, oldRunId: 'held-run', parentPid: p.pid, facts: factsOf(p), edits,
  reducedAssurance: false, relaunch: { deliver: 'pr' as const }, request: { id: 'reshape', digest: 'reshape' }, confirmLoss: [],
});

async function seatRevision(r: ReturnType<typeof rig>, p: ArtifactProposal, edits: ProposalRevisionEdits) {
  r.svc.onReply({ chat: 'chat', cliKey: 'claude', turnId: 'turn', ok: true, blocks: [JSON.stringify({ revises: p.pid, edits })] });
  await r.svc.settled();
  const record = r.records.filter((rec) => rec.kind === 'proposal').at(-1);
  if (record?.kind !== 'proposal') throw new Error('missing proposal');
  expect(record.proposal.pid).toBe('chat:turn');
  return record.proposal;
}

function doc(project: string, name: string) {
  const dir = join(ROOT, project, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '_v1.html'), '<p>evidence</p>');
  writeFileSync(join(dir, 'versions.json'), JSON.stringify({ head: 1, versions: [{ version: 1 }] }));
}

function binding(r: ReturnType<typeof rig>, docs: string[] = [], open?: string) {
  r.records.push({ at: 1, turnId: 'turn', kind: 'user', text: 'read these documents', owner: true, seats: ['claude'] });
  r.records.push({ at: 1, turnId: 'turn', kind: 'context', runs: [], refused: [], page: false, named: { runs: [], docs },
    ...(open !== undefined ? { artifact: { ref: open, title: 'Open document', kind: 'doc', viewed: 1, head: 1, projectId: 'project-a', copies: [], anchors: [] } } : {}) });
}

describe('CS4 input grammar and catalog support', () => {
  it('advertises documents and sources with their own kinds and labels', () => {
    expect(INPUT_KINDS_V2).toEqual(expect.arrayContaining(['documents', 'sources']));
    expect(inputsOf(['documents', 'sources?'])).toEqual([
      { id: 'documents', label: 'Documents', kind: 'documents', required: true },
      { id: 'sources', label: 'Sources', kind: 'sources', required: false },
    ]);
  });

  it('accepts both strict arms and an empty source pick', () => {
    expect(RevisionEditsSchema.safeParse({ inputs: { documents: { kind: 'documents', tokens: ['attachment:first'] }, sources: { kind: 'sources', ids: [] } } }).success).toBe(true);
  });

  it.each([
    { kind: 'documents', tokens: [] },
    { kind: 'documents', tokens: [''] },
    { kind: 'documents', tokens: ['x'.repeat(301)] },
    { kind: 'documents', tokens: Array(21).fill('attachment:first') },
    { kind: 'documents', tokens: ['attachment:first'], extra: true },
    { kind: 'sources', ids: [''] },
    { kind: 'sources', ids: ['x'.repeat(101)] },
    { kind: 'sources', ids: Array(21).fill('web') },
    { kind: 'sources', ids: [], extra: true },
  ])('rejects invalid lengths or extra fields: %j', (value) => {
    expect(RevisionEditsSchema.safeParse({ inputs: { [value.kind]: value } }).success).toBe(false);
  });
});

describe('CS4 job document authorisation and filling', () => {
  it('fills both attachments in order, counts the ok files, and places the token in the sentence', async () => {
    const r = rig();
    const p = await r.pick();
    expect(token(p, 'documents')).toMatchObject({ label: '2 documents', documents: [
      { token: 'attachment:first', status: 'ok' }, { token: 'attachment:second', status: 'ok' },
    ] });
    expect(p.sentence!.text).toContain('reading {documents} and {sources}');
    expect(p.sentence!.ask).toBe('Start?');
    expect(p.inputs!['documents']).toEqual({ kind: 'documents', tokens: ['attachment:first', 'attachment:second'] });
  });

  it('fills a job proposed by a seat block through the same authorisation path', async () => {
    const r = rig();
    binding(r);
    const p = await r.svc.resolveDetected({ chatId: 'chat', turnId: 'turn', seat: 'claude', records: r.records,
      block: { op: 'entry', entry: 'documents-job', confidence: 0.95, sources: [], repos: [] } });
    expect(p).not.toBeNull();
    expect(token(p!, 'documents')).toMatchObject({ label: '2 documents', documents: [
      { token: 'attachment:first', status: 'ok' }, { token: 'attachment:second', status: 'ok' },
    ] });
  });

  it('fills attachments followed by named documents and the open artifact, capped at 20', async () => {
    const r = rig();
    const refs = Array.from({ length: 20 }, (_, i) => `project-a/doc-${i}`);
    for (let i = 0; i < 20; i++) doc('project-a', `doc-${i}`);
    binding(r, refs.slice(0, 17), refs[17]);
    const p = await r.pick();
    expect(token(p, 'documents').label).toBe('20 documents');
    expect(jobInputsOfProposal(p).documents).toEqual(['attachment:first', 'attachment:second', ...refs.slice(0, 18).map((ref) => `doc:${ref}`)]);
    const capped = rig();
    binding(capped, refs);
    expect(jobInputsOfProposal(await capped.pick()).documents).toHaveLength(20);
  });

  it('strikes a foreign attachment and an unnamed document before looking it up', async () => {
    const r = rig();
    const rootRead = vi.spyOn(r.deps, 'docsRoot');
    expect(await r.svc.authorizeDocuments('chat', ['attachment:other-chat', 'doc:project-a/private'])).toMatchObject([
      { status: 'struck', reason: 'not a file attached to this chat' },
      { status: 'struck', reason: 'not open or named in this chat' },
    ]);
    expect(rootRead).not.toHaveBeenCalled();
  });

  it('strikes a named document outside the project, and a missing document', async () => {
    const r = rig();
    binding(r, ['project-b/elsewhere', 'project-a/gone']);
    expect(await r.svc.authorizeDocuments('chat', ['doc:project-b/elsewhere', 'doc:project-a/gone'])).toMatchObject([
      { status: 'struck', reason: "not in this chat's project" }, { status: 'struck', reason: 'no such document' },
    ]);
  });

  it('rejects every other token kind, deduplicates, and strikes all tokens after the chat ends', async () => {
    const r = rig();
    const tokens = ['chat', 'message:turn', 'run:01234567', 'page', 'url:https://example.com', 'chat'];
    expect(await r.svc.authorizeDocuments('chat', tokens)).toEqual(tokens.slice(0, -1).map((token) => ({ token, label: token, status: 'struck', reason: 'a job reads files and documents only' })));
    r.end();
    expect(await r.svc.authorizeDocuments('chat', ['attachment:first', 'attachment:first', 'doc:project-a/doc-1'])).toMatchObject([
      { token: 'attachment:first', status: 'struck', reason: 'the chat has ended' },
      { token: 'doc:project-a/doc-1', status: 'struck', reason: 'the chat has ended' },
    ]);
  });

  it('turns the only struck required document into the one question and holds Go', async () => {
    const r = rig();
    const p = await r.swap(await r.pick(), { inputs: { documents: { kind: 'documents', tokens: ['attachment:gone'] } } });
    expect(token(p, 'documents').label).toBe('0 documents');
    expect(p.needs!.find((n) => n.id === 'documents')!.status).toBe('missing');
    expect(p.question).toMatchObject({ kind: 'missing', text: 'Which documents? not a file attached to this chat' });
    expect(p.sentence!.ask).toBe(p.question!.text);
    expect((await r.svc.decide('chat', p.pid, { decision: 'go' }, ME, 'instance')).code).toBe(409);
    expect(r.launches).toHaveLength(0);
  });

  it('asks for absent required documents and permits an absent optional list', async () => {
    const r = rig();
    r.files.length = 0;
    expect((await r.pick()).question!.text).toBe('Which documents?');
    const optional = await r.pick('optional-documents');
    expect(optional.question).toBeNull();
    expect(optional.sentence!.ask).toBe('Start?');
  });

  it('admits 5 MiB for jobs while create keeps the 512 KB cap; jobs still reject over 10 MiB', async () => {
    const r = rig();
    r.files[0]!.bytes = 5 * 1024 * 1024;
    expect(await r.svc.authorizeDocuments('chat', ['attachment:first'])).toMatchObject([{ status: 'ok' }]);
    const created = await r.svc.resolve({ chatId: 'chat', turnId: 'turn', seat: 'claude', records: r.records,
      block: { op: 'entry', entry: 'document', sources: ['attachment:first'], repos: [] } });
    expect(created!.sources).toMatchObject([{ status: 'struck', reason: "too large for a document's sources (over 512 KB)" }]);
    r.files[0]!.bytes = 10 * 1024 * 1024;
    expect(await r.svc.authorizeDocuments('chat', ['attachment:first'])).toMatchObject([{ status: 'ok' }]);
    r.files[0]!.bytes++;
    expect(await r.svc.authorizeDocuments('chat', ['attachment:first'])).toMatchObject([{ status: 'struck', reason: 'too large for a job document (over 10 MB)' }]);
  });

  it('authorises all 20 job tokens rather than the create path limit of 12', async () => {
    const r = rig();
    for (let i = 2; i < 20; i++) r.files.push({ id: `file-${i}`, name: `${i}.txt`, bytes: 10 });
    const docs = await r.svc.authorizeDocuments('chat', r.files.map((a) => `attachment:${a.id}`));
    expect(docs).toHaveLength(20);
    expect(docs.every((s) => s.status === 'ok')).toBe(true);
  });

  it.each([false, true])('caps authorization itself at 20 tokens (chat ended: %s)', async (ended) => {
    const r = rig();
    if (ended) r.end();
    const tokens = Array.from({ length: 21 }, (_, i) => `attachment:file-${i}`);
    expect((await r.svc.authorizeDocuments('chat', tokens)).map((s) => s.token)).toEqual(tokens.slice(0, 20));
  });

  it('uses the earlier seat turn binding even when a later turn names the document', async () => {
    const r = rig();
    const first = await r.pick();
    binding(r);
    await r.svc.holdForMessage('chat', 'turn');
    doc('project-a', 'later-only');
    r.records.push({ at: 2, turnId: 'later', kind: 'user', text: 'read doc:project-a/later-only', owner: true, seats: ['claude'] });
    r.records.push({ at: 2, turnId: 'later', kind: 'context', runs: [], refused: [], page: false, named: { runs: [], docs: ['project-a/later-only'] } });
    const rootRead = vi.spyOn(r.deps, 'docsRoot');
    const p = await seatRevision(r, first, { inputs: { documents: { kind: 'documents', tokens: ['doc:project-a/later-only'] } } });
    expect(token(p, 'documents').documents).toMatchObject([{ status: 'struck', reason: 'not open or named in this chat' }]);
    expect(rootRead).not.toHaveBeenCalled();
    // The public launch-time API deliberately uses the latest binding.
    expect(await r.svc.authorizeDocuments('chat', ['doc:project-a/later-only'])).toMatchObject([{ status: 'ok' }]);
  });

  it('uses the supplied records snapshot rather than rereading a later binding', async () => {
    const r = rig();
    const first = await r.pick();
    binding(r);
    await r.svc.holdForMessage('chat', 'turn');
    doc('project-a', 'snapshot-only');
    const live = r.records.find((rec) => rec.kind === 'context');
    if (live?.kind !== 'context') throw new Error('missing binding');
    // reviseLocked has captured its records before awaiting jobSources; live records change while it waits.
    r.deps.jobSources = async () => {
      r.records[r.records.indexOf(live)] = { ...live, named: { runs: [], docs: ['project-a/snapshot-only'] } };
      return [WEB, SUPPORT];
    };
    const p = await seatRevision(r, first, { inputs: { documents: { kind: 'documents', tokens: ['doc:project-a/snapshot-only'] } } });
    expect(token(p, 'documents').documents).toMatchObject([{ status: 'struck', reason: 'not open or named in this chat' }]);
  });

  it.each(['go', 'revision', 'refresh', 'reshape'] as const)('persists an empty fill and never adds later attachments during %s', async (path) => {
    const r = rig();
    r.files.length = 0;
    const p = await r.pick('optional-documents');
    expect(p.inputs!['documents']).toEqual({ kind: 'documents', tokens: [] });
    r.files.push({ id: 'later', name: 'later.txt', bytes: 10 });
    let rebuilt: ArtifactProposal;
    if (path === 'revision') rebuilt = await r.swap(p, { detail: { add: ['cite each finding'] } });
    else {
      if (path === 'refresh') r.deps.served = async () => ({ ...served, rev: 'changed' });
      const result = path === 'reshape'
        ? await r.svc.reshape('chat', reshapeRequest(p), ME, 'instance')
        : await r.svc.decide('chat', p.pid, { decision: 'go', edits: { seats: ['codex'] } }, ME, 'instance');
      expect(result.code).toBe(path === 'refresh' ? 409 : 200);
      if (path === 'refresh') expect(result.body['code']).toBe('catalog_changed');
      rebuilt = (result.body['view'] as { proposal: ArtifactProposal }).proposal;
    }
    expect(jobInputsOfProposal(rebuilt).documents).toEqual([]);
    expect(token(rebuilt, 'documents').documents).toEqual([]);
    if (path === 'go' || path === 'reshape') expect(jobInputsOfProposal(r.launches[0]!.resolution).documents).toEqual([]);
  });

  it('fills on a card change that newly takes documents', async () => {
    const r = rig();
    const plain = await r.pick('plain-job');
    const p = await r.swap(plain, { card: 'optional-documents' });
    expect(jobInputsOfProposal(p).documents).toEqual(['attachment:first', 'attachment:second']);
  });

  it.each(['go', 'revision', 'refresh', 'reshape'] as const)('never fills a pre-existing proposal without stored document inputs during %s', async (path) => {
    const r = rig();
    r.files.length = 0;
    const p = await r.pick('optional-documents');
    // Proposals stored by the previous capture code did not persist empty fills.
    delete p.inputs!['documents'];
    r.files.push({ id: 'later', name: 'later.txt', bytes: 10 });
    if (path === 'revision') {
      expect(jobInputsOfProposal(await r.swap(p, { detail: { add: ['cite each finding'] } })).documents).toEqual([]);
      return;
    }
    if (path === 'refresh') r.deps.served = async () => ({ ...served, rev: 'changed' });
    const result = path === 'reshape'
      ? await r.svc.reshape('chat', reshapeRequest(p), ME, 'instance')
      : await r.svc.decide('chat', p.pid, { decision: 'go', edits: { seats: ['codex'] } }, ME, 'instance');
    expect(result.code).toBe(path === 'refresh' ? 409 : 200);
    expect(jobInputsOfProposal((result.body['view'] as { proposal: ArtifactProposal }).proposal).documents).toEqual([]);
    if (path === 'go' || path === 'reshape') expect(jobInputsOfProposal(r.launches[0]!.resolution).documents).toEqual([]);
  });

  it('never fills from live attachments when reshaping held facts without a parent record', async () => {
    const r = rig();
    r.files.length = 0;
    const p = await r.pick('optional-documents');
    delete p.inputs!['documents'];
    const request = { ...reshapeRequest(p), parentPid: null };
    r.records.length = 0;
    r.files.push({ id: 'later', name: 'later.txt', bytes: 10 });
    const result = await r.svc.reshape('chat', request, ME, 'instance');
    expect(result.code).toBe(200);
    expect(jobInputsOfProposal(r.launches[0]!.resolution).documents).toEqual([]);
  });

  it.each([false, true])('refuses Go before accepting when a shown ok attachment disappears (edits: %s)', async (edits) => {
    const r = rig();
    const p = await r.pick();
    r.files.pop();
    const result = await r.svc.decide('chat', p.pid, { decision: 'go', ...(edits ? { edits: { seats: ['codex'] } } : {}) }, ME, 'instance');
    expect(result).toMatchObject({ code: 409, body: { code: 'source_gone' } });
    expect(r.launches).toEqual([]);
    expect(r.records.some((rec) => rec.kind === 'proposal_accepting')).toBe(false);
  });

  it.each(['documents-job', 'optional-documents'])('refuses a struck token in Go edits for %s', async (card) => {
    const r = rig();
    const p = await r.pick(card);
    const result = await r.svc.decide('chat', p.pid, { decision: 'go', edits: { inputs: { documents: { kind: 'documents', tokens: ['attachment:first', 'attachment:gone'] } } } }, ME, 'instance');
    expect(result).toMatchObject({ code: 400, body: { code: 'edits_invalid', error: 'attachment gone cannot be used (not a file attached to this chat)' } });
    expect(r.launches).toEqual([]);
    expect(r.records.some((rec) => rec.kind === 'proposal_accepting')).toBe(false);
  });

  it('refuses Go when a shown attachment becomes too large rather than merely checking its presence', async () => {
    const r = rig();
    const p = await r.pick();
    r.files[1]!.bytes = 10 * 1024 * 1024 + 1;
    const result = await r.svc.decide('chat', p.pid, { decision: 'go' }, ME, 'instance');
    expect(result).toMatchObject({ code: 409, body: { code: 'source_gone' } });
    expect(r.launches).toEqual([]);
    expect(r.records.some((rec) => rec.kind === 'proposal_accepting')).toBe(false);
  });

  it('refuses Go when a shown named document disappears', async () => {
    const r = rig();
    binding(r, ['project-a/removed-before-go']);
    doc('project-a', 'removed-before-go');
    const p = await r.pick();
    expect(token(p, 'documents').documents!.at(-1)!.status).toBe('ok');
    rmSync(join(ROOT, 'project-a', 'removed-before-go'), { recursive: true });
    const result = await r.svc.decide('chat', p.pid, { decision: 'go' }, ME, 'instance');
    expect(result).toMatchObject({ code: 409, body: { code: 'source_gone' } });
    expect(r.launches).toEqual([]);
    expect(r.records.some((rec) => rec.kind === 'proposal_accepting')).toBe(false);
  });

  it.each([false, true])('refuses reshape before rejecting the held plan for gone documents (explicit edit: %s)', async (edited) => {
    const r = rig();
    const p = await r.pick();
    const reject = vi.spyOn(r.deps, 'reshapeReject');
    r.files.pop();
    const result = await r.svc.reshape('chat', reshapeRequest(p, edited ? { inputs: { documents: { kind: 'documents', tokens: ['attachment:first', 'attachment:second'] } } } : {}), ME, 'instance');
    expect(result).toMatchObject({ code: edited ? 400 : 409, body: { code: edited ? 'edits_invalid' : 'source_gone' } });
    expect(reject).not.toHaveBeenCalled();
    expect(r.launches).toEqual([]);
    expect(r.records.some((rec) => rec.kind === 'proposal_accepting')).toBe(false);
  });

  it.each(['go', 'reshape'] as const)('refuses %s if an ok file is downgraded while the proposal rebuilds', async (path) => {
    const r = rig();
    binding(r, ['project-a/preflight']);
    doc('project-a', 'preflight');
    const p = await r.pick();
    const root = r.deps.docsRoot;
    // The file disappears as preflight finishes checking the last document. The rebuild then sees it as struck.
    const rootRead = vi.spyOn(r.deps, 'docsRoot').mockImplementation(async (projectId) => {
      if (rootRead.mock.calls.length === 2) r.files.pop();
      return root(projectId);
    });
    const reject = vi.spyOn(r.deps, 'reshapeReject');
    const result = path === 'go'
      ? await r.svc.decide('chat', p.pid, { decision: 'go', edits: { seats: ['codex'] } }, ME, 'instance')
      : await r.svc.reshape('chat', reshapeRequest(p), ME, 'instance');
    expect(result).toMatchObject({ code: 409, body: { code: 'source_gone' } });
    expect(reject).not.toHaveBeenCalled();
    expect(r.launches).toEqual([]);
    expect(r.records.some((rec) => rec.kind === 'proposal_accepting')).toBe(false);
  });

  it('replaces a list through a typed correction and reauthorises it on the next resolution', async () => {
    const r = rig();
    const first = await r.pick();
    r.records.push({ at: 2, kind: 'user', turnId: 'correction', owner: true, text: 'only use the second document', seats: ['claude'] });
    await r.svc.holdForMessage('chat', 'correction');
    r.svc.onReply({ chat: 'chat', cliKey: 'claude', turnId: 'correction', ok: true, blocks: [JSON.stringify({ revises: first.pid, edits: { inputs: { documents: { kind: 'documents', tokens: ['attachment:second'] } } } })] });
    await r.svc.settled();
    const corrected = r.records.filter((rec) => rec.kind === 'proposal').at(-1)!;
    expect(corrected.kind).toBe('proposal');
    if (corrected.kind !== 'proposal') throw new Error('missing proposal');
    expect(jobInputsOfProposal(corrected.proposal).documents).toEqual(['attachment:second']);
    r.files.pop();
    const refreshed = await r.swap(corrected.proposal, { detail: { add: ['cite each finding'] } });
    expect(token(refreshed, 'documents').documents![0]).toMatchObject({ status: 'struck', reason: 'not a file attached to this chat' });
    expect(refreshed.question!.text).toContain('Which documents?');
  });
});

describe('CS4 source picks and launch inputs', () => {
  it.each(['pick', 'go', 'revision', 'refresh', 'reshape'] as const)('keeps source-free jobs available during a source failure on %s', async (path) => {
    const r = rig();
    const p = path === 'pick' ? null : await r.pick('plain-job');
    const sources = vi.fn(async () => { throw new Error('source registry unavailable'); });
    r.deps.jobSources = sources;
    if (path === 'refresh') r.deps.served = async () => ({ ...served, rev: 'changed' });
    const result = p === null
      ? await r.svc.propose('chat', { card: 'plain-job', source: 'pick', requestId: 'source-free', words: 'read the repo' }, ME, 'instance')
      : path === 'revision'
        ? await r.svc.propose('chat', { revises: p.pid, edits: { detail: { add: ['cite findings'] } }, source: 'swap', requestId: 'source-free' }, ME, 'instance')
        : path === 'reshape'
          ? await r.svc.reshape('chat', reshapeRequest(p), ME, 'instance')
          : await r.svc.decide('chat', p.pid, { decision: 'go' }, ME, 'instance');
    expect(result.code).toBe(path === 'pick' || path === 'revision' ? 201 : path === 'refresh' ? 409 : 200);
    if (path === 'refresh') expect(result.body['code']).toBe('catalog_changed');
    expect(sources).not.toHaveBeenCalled();
    if (path === 'go' || path === 'reshape') expect(r.launches).toHaveLength(1);
  });

  it('loads sources when a revision newly takes them and skips them when it stops taking them', async () => {
    const r = rig();
    const sources = vi.spyOn(r.deps, 'jobSources');
    const plain = await r.pick('plain-job');
    expect(sources).not.toHaveBeenCalled();
    const research = await r.swap(plain, { card: 'research', inputs: { sources: { kind: 'sources', ids: ['support-pg'] } } });
    expect(sources).toHaveBeenCalledWith('project-a');
    expect(jobInputsOfProposal(research).sources).toEqual(['support-pg']);
    sources.mockClear().mockRejectedValue(new Error('source registry unavailable'));
    const revised = await r.swap(research, { card: 'plain-job' });
    expect(revised.shape!.card).toBe('plain-job');
    expect(sources).not.toHaveBeenCalled();
  });

  it.each(['research', 'competitive'])('%s defaults to the registered web id carried through projectSources', async (card) => {
    const choices = await projectSources('project-a', { sources: async () => [{ id: 'web' }, { id: 'z-search', web: true }] });
    const p = await rig(choices).pick(card);
    expect(jobInputsOfProposal(p)).toEqual({ documents: [], sources: ['z-search'] });
    expect(token(p, 'sources').sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'z-search', picked: true }), expect.objectContaining({ id: 'web', picked: false }),
    ]));
  });

  it.each(['research', 'competitive'])('%s never defaults to an ordinary source literally named web', async (card) => {
    const p = await rig([{ id: 'web', label: 'web' }]).pick(card);
    expect(jobInputsOfProposal(p).sources).toEqual([]);
    expect(p.sentence!.notes).toContain("the web can't be read: not available on this daemon");
  });

  it('says the web source is set up for another project, not that the daemon lacks it (e2e-1105 CJ3)', async () => {
    const p = await rig([SUPPORT], 'the web source is set up for project Mikes only').pick('research');
    expect(jobInputsOfProposal(p).sources).toEqual([]);
    expect(p.sentence!.notes).toContain("the web can't be read: the web source is set up for project Mikes only");
    expect(p.sentence!.notes.join(' ')).not.toContain('not available on this daemon');
  });

  it('explicitly clears documents when reshaping to a card without documents', async () => {
    const r = rig();
    const p = await r.pick();
    expect(jobInputsOfProposal(p).documents).toEqual(['attachment:first', 'attachment:second']);
    const result = await r.svc.reshape('chat', reshapeRequest(p, { card: 'plain-job' }), ME, 'instance');
    expect(result.code).toBe(200);
    const launched = r.launches[0]!.resolution;
    expect(launched.sentence!.tokens.some((t) => t.kind === 'documents')).toBe(false);
    expect(jobInputsOfProposal(launched)).toEqual({ documents: [] });
  });

  it('explicitly clears documents when an optional card has no ok tokens', async () => {
    const r = rig();
    r.files.length = 0;
    const optional = await r.pick('optional-documents');
    expect(jobInputsOfProposal(optional)).toEqual({ documents: [] });
    const struck = await r.swap(optional, { inputs: { documents: { kind: 'documents', tokens: ['attachment:gone'] } } });
    expect(token(struck, 'documents').documents).toMatchObject([{ status: 'struck' }]);
    expect(jobInputsOfProposal(struck)).toEqual({ documents: [] });
  });

  it.each(['research', 'competitive'])('%s defaults to the web only when pickable', async (card) => {
    const p = await rig().pick(card);
    expect(token(p, 'sources')).toMatchObject({ label: 'the web', sources: [{ id: 'web', picked: true }, { id: 'support-pg', picked: false }] });
    expect(jobInputsOfProposal(p)).toEqual({ documents: [], sources: ['web'] });
    const blocked = await rig([{ ...WEB, reason: 'agents cannot query it' }, SUPPORT]).pick(card);
    expect(token(blocked, 'sources').label).toBe('no sources');
    expect(blocked.sentence!.notes).toContain("the web can't be read: agents cannot query it");
    expect(token(blocked, 'sources').sources![0]).toMatchObject({ id: 'web', picked: false, reason: 'agents cannot query it' });
    expect(jobInputsOfProposal(blocked)).toEqual({ documents: [], sources: [] });
    expect(blocked.question).toBeNull();
  });

  it('shows the absent dependency as no sources on this daemon', async () => {
    const r = rig();
    delete r.deps.jobSources;
    const p = await r.pick('research');
    expect(token(p, 'sources')).toMatchObject({ label: 'no sources on this daemon', sources: [] });
    expect(jobInputsOfProposal(p)).toEqual({ documents: [], sources: [] });
  });

  it('replaces rather than appends the pick and accepts an empty pick', async () => {
    const r = rig();
    const p = await r.swap(await r.pick('research'), { inputs: { sources: { kind: 'sources', ids: ['support-pg'] } } });
    expect(token(p, 'sources').label).toBe('support-pg');
    expect(jobInputsOfProposal(p)).toEqual({ documents: [], sources: ['support-pg'] });
    const both = await r.swap(p, { inputs: { sources: { kind: 'sources', ids: ['web', 'support-pg'] } } });
    expect(token(both, 'sources').label).toBe('the web and support-pg');
    const empty = await r.swap(both, { inputs: { sources: { kind: 'sources', ids: [] } } });
    expect(token(empty, 'sources').label).toBe('no sources');
    expect(empty.question).toBeNull();
    expect(empty.sentence!.ask).toBe('Start?');
  });

  it.each([
    { id: 'off-pg', reason: 'agents cannot query it' },
    { id: 'unknown', reason: 'not available on this daemon' },
  ])('refuses $id, keeps the pick, and applies the other edit', async ({ id, reason }) => {
    const r = rig([WEB, SUPPORT, { id: 'off-pg', label: 'off-pg', reason: 'agents cannot query it' }]);
    const p = await r.swap(await r.pick('research'), { inputs: { sources: { kind: 'sources', ids: ['support-pg', id] } }, detail: { add: ['compare pricing'] } });
    expect(jobInputsOfProposal(p).sources).toEqual(['web']);
    expect(p.details).toEqual(['compare pricing']);
    expect(p.sentence!.notes).toContain(`Not changed: the sources stay the web; ${id} can't be picked: ${reason}`);
  });

  it('keeps a stored pick for launch validation when its switch changes during a revision', async () => {
    const web = { ...WEB };
    const r = rig([web, SUPPORT]);
    const first = await r.pick('research');
    web.reason = 'agents cannot query it';
    const p = await r.swap(first, { inputs: { sources: { kind: 'sources', ids: ['web'] } }, detail: { add: ['compare pricing'] } });
    expect(jobInputsOfProposal(p).sources).toEqual(['web']);
    expect(token(p, 'sources').sources![0]).toMatchObject({ picked: true, reason: 'agents cannot query it' });
    expect(p.sentence!.notes).toContain("Not changed: the sources stay the web; web can't be picked: agents cannot query it");
  });

  it('uses the same registered labels for source needs and sentence tokens', async () => {
    const r = rig([WEB, { id: 'pg', label: 'support-pg' }]);
    const p = await r.swap(await r.pick('research'), { inputs: { sources: { kind: 'sources', ids: ['pg'] } } });
    expect(p.needs!.find((n) => n.id === 'sources')!.value).toBe(token(p, 'sources').label);
    expect(token(p, 'sources').label).toBe('support-pg');
  });

  it('caps the source need value at 200 characters', async () => {
    const sources = ['a', 'b', 'c'].map((letter) => ({ id: letter.repeat(100), label: letter.repeat(100) }));
    const r = rig(sources);
    const p = await r.swap(await r.pick('research'), { inputs: { sources: { kind: 'sources', ids: sources.map((s) => s.id) } } });
    expect(token(p, 'sources').label.length).toBeGreaterThan(200);
    expect(p.needs!.find((n) => n.id === 'sources')!.value).toBe(token(p, 'sources').label.slice(0, 200));
  });

  it('tracks a refused source edit even when its value equals the stored pick', async () => {
    const web = { ...WEB };
    const r = rig([web, SUPPORT]);
    const p = await r.pick('research');
    web.reason = 'agents cannot query it';
    const edits: ProposalRevisionEdits = { card: 'competitive', inputs: { sources: { kind: 'sources', ids: ['web'] } } };
    const merged = mergeRevision(p, edits, { chat: r.deps.chat('chat')!, served, roster: r.deps.rosterEligible(), jobSources: [web, SUPPORT] });
    expect(merged.facts.inputs['sources']).toEqual(edits.inputs!['sources']);
    expect(merged.refusedInputs).toEqual(['sources']);
  });

  it('refuses reshape when a refused source edit equals the stored pick', async () => {
    const web = { ...WEB };
    const r = rig([web, SUPPORT]);
    const p = await r.pick('research');
    web.reason = 'agents cannot query it';
    const edits: ProposalRevisionEdits = { card: 'competitive', inputs: { sources: { kind: 'sources', ids: ['web'] } } };
    const reject = vi.spyOn(r.deps, 'reshapeReject');
    const result = await r.svc.reshape('chat', reshapeRequest(p, edits), ME, 'instance');
    expect(result).toMatchObject({ code: 400, body: { code: 'edits_invalid' } });
    expect(reject).not.toHaveBeenCalled();
    expect(r.launches).toEqual([]);
    expect(r.records.some((rec) => rec.kind === 'proposal_accepting')).toBe(false);
  });

  it.each(['pick', 'go', 'reshape'] as const)('refuses unavailable job sources on %s rather than treating them as empty', async (path) => {
    const r = rig();
    const p = path === 'pick' ? null : await r.pick('research');
    r.deps.jobSources = async () => { throw new Error('source registry unavailable'); };
    const reject = vi.spyOn(r.deps, 'reshapeReject');
    const result = p === null
      ? await r.svc.propose('chat', { card: 'research', source: 'pick', requestId: 'unavailable', words: 'compare options' }, ME, 'instance')
      : path === 'go'
        ? await r.svc.decide('chat', p.pid, { decision: 'go' }, ME, 'instance')
        : await r.svc.reshape('chat', reshapeRequest(p), ME, 'instance');
    expect(result).toMatchObject({ code: 409, body: { code: 'sources_unavailable', error: 'source registry unavailable' } });
    expect(reject).not.toHaveBeenCalled();
    expect(r.launches).toEqual([]);
  });

  it('applies a typed source correction and forwards Go edits as launch fields', async () => {
    const r = rig();
    const first = await r.pick('research');
    r.records.push({ at: 2, kind: 'user', turnId: 'correct', owner: true, text: "don't use the web; use support-pg", seats: ['claude'] });
    await r.svc.holdForMessage('chat', 'correct');
    r.svc.onReply({ chat: 'chat', cliKey: 'claude', turnId: 'correct', ok: true, blocks: [JSON.stringify({ revises: first.pid, edits: { inputs: { sources: { kind: 'sources', ids: ['support-pg'] } } } })] });
    await r.svc.settled();
    const corrected = r.records.filter((rec) => rec.kind === 'proposal').at(-1)!;
    if (corrected.kind !== 'proposal') throw new Error('missing proposal');
    expect(jobInputsOfProposal(corrected.proposal)).toEqual({ documents: [], sources: ['support-pg'] });
    const result = await r.svc.decide('chat', corrected.proposal.pid, { decision: 'go', edits: { inputs: { sources: { kind: 'sources', ids: [] } } } }, ME, 'instance');
    expect(result.code).toBe(200);
    expect(jobInputsOfProposal(r.launches[0]!.resolution)).toEqual({ documents: [], sources: [] });
  });

  it('keeps these inputs out of prose, launches only ok tokens, and clears documents for cards that do not take them', async () => {
    const r = rig();
    const p = await r.swap(await r.pick(), { inputs: {
      documents: { kind: 'documents', tokens: ['attachment:first', 'attachment:gone'] },
      sources: { kind: 'sources', ids: ['support-pg'] },
    } });
    expect(jobInputsOfProposal(p)).toEqual({ documents: ['attachment:first'], sources: ['support-pg'] });
    expect(inputLines({ ...p, inputs: { ...p.inputs, note: { kind: 'text', value: 'keep this line' } } })).toEqual(['note: keep this line']);
    const plain = await r.pick('plain-job');
    expect(jobInputsOfProposal({ ...plain, inputs: p.inputs! })).toEqual({ documents: [] });
    expect(plain.sentence!.text).not.toContain('reading');
    expect(jobInputsOfProposal({ ...p, inputs: {} })).toEqual({ documents: ['attachment:first'], sources: [] });
  });

  it('keeps the documents and source pick through factsOf, reshape re-resolution and a retry', async () => {
    const r = rig();
    const p = await r.swap(await r.pick(), { inputs: { documents: { kind: 'documents', tokens: ['attachment:second'] }, sources: { kind: 'sources', ids: ['support-pg'] } } });
    const facts = factsOf(p);
    expect(facts.inputs).toEqual(p.inputs);
    const ctx: JobContext = { chatId: 'chat', pid: 'reshaped', turnId: null, seat: 'person', chat: r.deps.chat('chat')!, served, roster: r.deps.rosterEligible(), projectLabel: 'project-a', revises: p.pid, lineage: p.lineage!, notes: [], jobSources: [WEB, SUPPORT], documents: await r.svc.authorizeDocuments('chat', ['attachment:second']) };
    expect(jobInputsOfProposal(resolveJob(facts, ctx))).toEqual({ documents: ['attachment:second'], sources: ['support-pg'] });
    const go = await r.svc.decide('chat', p.pid, { decision: 'go' }, ME, 'instance');
    expect(go.code).toBe(200);
    const request = { pid: 'reshaped', oldRunId: r.launches[0]!.identity.runId, parentPid: p.pid, facts, edits: {}, reducedAssurance: false, relaunch: { deliver: 'pr' as const }, request: { id: 'reshape', digest: 'reshape' }, confirmLoss: [] };
    const reshape = await r.svc.reshape('chat', request, ME, 'instance');
    expect(reshape.code).toBe(200);
    expect(jobInputsOfProposal(r.launches.at(-1)!.resolution)).toEqual({ documents: ['attachment:second'], sources: ['support-pg'] });
    const retry = await r.svc.reshape('chat', request, ME, 'instance');
    expect(retry.code).toBe(200);
    expect(r.launches).toHaveLength(2);
    expect(jobInputsOfProposal((retry.body['view'] as { proposal: ArtifactProposal }).proposal)).toEqual({ documents: ['attachment:second'], sources: ['support-pg'] });
  });
});
