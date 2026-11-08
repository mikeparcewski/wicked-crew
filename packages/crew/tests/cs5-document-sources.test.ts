/** Sourced creates must promise and launch the same documents their packet can stage. */
import { mkdirSync, mkdtempSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as attachments from '../src/api/chat-attachments.js';
import * as beneath from '../src/api/beneath.js';
import type { Actor, ArtifactProposal, ChatTranscriptRecord, Preset } from '../src/core/types.js';
import { ChatProposals, LaunchOnceRegistry, type ChatProposalDeps } from '../src/api/chat-proposals.js';
import { CreateLauncher } from '../src/interactive/proposal-create.js';
import { DocBindingStore } from '../src/interactive/doc-binding.js';
import { servedState } from '../src/workflow-catalog/build-v2.js';
import { buildSourcePacket, documentPathPlan, packetDirOf, type PacketDeps, type PacketInput, type SourcePacket } from '../src/interactive/source-packet.js';
import { CATALOG_SEEDS } from '../src/workflow-catalog/catalog-data.js';

// Observe byte reads separately from readBeneath's descriptor-size check.
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, readSync: vi.fn(actual.readSync) };
});

const ROOT = mkdtempSync(join(tmpdir(), 'cs5-document-sources-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const ME: Actor = { id: 'person', kind: 'human', trust: 'operator' };
// An engine that serves the sourced draft (CS5 core): without it Respond and Rework offer no Start (CS8, below).
const SOURCED = { name: 'interactive-draft-sourced', created_by: 'builtin', scope: 'global', steps: [] } as unknown as Preset;
const served = { ...servedState({ defs: [], presets: [SOURCED], entries: [] }), rev: 'cs5' };

function rig(opts: { served?: typeof served } = {}) {
  const records: ChatTranscriptRecord[] = [];
  const dir = mkdtempSync(join(ROOT, 'attachments-'));
  writeFileSync(join(dir, 'a1'), 'ask bytes');
  writeFileSync(join(dir, 'a2'), 'materials');
  const files = [{ id: 'a1', name: 'ask.txt', bytes: 10 }, { id: 'a2', name: 'materials.txt', bytes: 10 }];
  const chat = { projectId: 'project-a', repos: [], lead: 'claude', seats: ['claude'], analysis: false };
  let instance = 'instance';
  const launches: Array<{ resolution: ArtifactProposal }> = [];
  const packets: SourcePacket[] = [];
  let onCreate = () => {};
  const registry = new LaunchOnceRegistry();
  const packetDeps: PacketDeps = {
    runs: async () => [], brief: async () => { throw new Error('no runs'); },
    docsRoot: async (project) => join(ROOT, project),
    attachment: (_chat, id) => {
      const file = files.find((f) => f.id === id);
      return file === undefined ? null : { name: file.name, path: join(dir, id) };
    },
  };
  registry.register('create', new CreateLauncher({
    bindings: new DocBindingStore(join(dir, 'bindings')),
    runExists: async () => false, docsRoot: packetDeps.docsRoot,
    createDoc: async (project, body) => {
      const draftDir = join(ROOT, project, String(body['name']));
      mkdirSync(draftDir, { recursive: true });
      writeFileSync(join(draftDir, 'versions.json'), JSON.stringify({ kind: 'doc', head: 0, versions: [{ version: 0 }] }));
      onCreate();
      return { status: 200, body: {} };
    },
    launchBound: async (spec) => {
      const accepted = records.find((rec) => rec.kind === 'proposal_accepting' && rec.pid === spec.proposalId);
      if (accepted?.kind !== 'proposal_accepting') throw new Error('launch without acceptance');
      launches.push({ resolution: accepted.resolution });
      packets.push(spec.packet);
    },
    records: () => records, instanceOf: () => instance, chatIdOf: () => 'chat',
    repos: async () => [], graphFor: async () => null,
    clisJsonFor: () => '[{"key":"claude"},{"key":"codex"}]', styleOf: () => 'doc', packetDeps,
  }));
  const deps: ChatProposalDeps = {
    flags: () => ({ context: true, proposals: true, create: true, refine: false, theme: false, demo: false }),
    catalog: CATALOG_SEEDS, records: () => [...records], append: (_id, record) => { records.push(record); return true; },
    instanceOf: () => instance, projectOf: () => chat.projectId, chat: () => chat,
    rosterEligible: () => [{ key: 'claude', name: 'Claude' }, { key: 'codex', name: 'Codex' }],
    runs: async () => [], chatOfRun: () => undefined, isAskPath: () => false,
    docsRoot: async (project) => join(ROOT, project), projectName: async (id) => id,
    attachments: () => files, workflowSteps: async () => 1, runCostUsd: async () => null,
    registry, jobs: () => true, acceptsJobs: () => true, served: async () => opts.served ?? served,
    broadcast: () => undefined, audit: () => undefined,
  };
  const svc = new ChatProposals(deps);
  let request = 0;
  const pick = async (card = 'respond') => {
    const result = await svc.propose('chat', { card, source: 'pick', requestId: `${dir.slice(dir.lastIndexOf('/') + 1)}-${request++}`, words: 'Write from these materials' }, ME, 'instance');
    expect(result.code).toBe(201);
    return (result.body['view'] as { proposal: ArtifactProposal }).proposal;
  };
  const packet = (resolution: ArtifactProposal, held?: PacketInput['held']) => buildSourcePacket({
    runId: 'run-packet', chatId: 'chat', pid: resolution.pid, cutoffTurnId: resolution.turnId ?? 'turn',
    resolution, records, ...(held !== undefined ? { held } : {}),
  }, packetDeps);
  const attach = (id: string, name: string, bytes: Buffer) => {
    files.splice(0, files.length, ...files.filter((f) => f.id !== id), { id, name, bytes: bytes.length });
    writeFileSync(join(dir, id), bytes);
  };
  return { svc, deps, packetDeps, registry, records, files, chat, launches, pick, packet, packets, attach, replaceBytes: (id: string, bytes: Buffer) => writeFileSync(join(dir, id), bytes), duringCreate: (fn: () => void) => { onCreate = fn; }, reuse: () => { instance = 'replacement'; } };
}

function bind(r: ReturnType<typeof rig>, refs: string[]) {
  r.records.push({ at: 1, turnId: 'turn', kind: 'user', owner: true, text: 'Use these documents', seats: ['claude'] });
  r.records.push({ at: 1, turnId: 'turn', kind: 'context', runs: [], refused: [], page: false, named: { runs: [], docs: refs } });
}

function doc(name: string, head = 1) {
  const dir = join(ROOT, 'project-a', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `_v${head}.html`), `<p>Evidence v${head}</p>`);
  writeFileSync(join(dir, 'versions.json'), JSON.stringify({ head, versions: [{ version: head }] }));
}

const sources = (p: ArtifactProposal) => p.sources.map((s) => s.token);
const documents = (p: ArtifactProposal) => p.sentence!.tokens.find((t) => t.kind === 'documents')!;

describe('CS8: Respond and Rework on an engine without the sourced draft', () => {
  it.each(['respond', 'rework'])('%s says why and offers no Start; Go creates nothing', async (card) => {
    const r = rig({ served: { ...servedState({ defs: [], presets: [], entries: [] }), rev: 'cs5' } });
    let created = 0;
    r.duringCreate(() => { created += 1; });
    const p = await r.pick(card);
    expect(p.blocked).toMatch(/interactive-draft-sourced/u);
    expect(p.sentence!.ask).toBeNull();
    expect((await r.svc.decide('chat', p.pid, { decision: 'go' }, ME, 'instance')).code).not.toBe(200);
    expect(r.launches).toEqual([]);
    expect(created).toBe(0);
  });

  it('puts the kind line before the person\'s words, so a long request never cuts it', async () => {
    const r = rig();
    const p = await r.pick('respond');
    expect(p.brief ?? '').toMatch(/^Kind: respond-rfp\.\n\nWrite from these materials/u);
  });
});

describe('CS5 document input sources', () => {
  it.each(['respond', 'rework'])('%s fills two attachments, displays their count and launches chat plus both sources', async (card) => {
    const r = rig();
    const p = await r.pick(card);
    expect(p.kind).toBe('create');
    expect(sources(p)).toEqual(['chat', 'attachment:a1', 'attachment:a2']);
    expect(documents(p)).toMatchObject({ label: '2 documents', documents: [
      { token: 'attachment:a1', status: 'ok' }, { token: 'attachment:a2', status: 'ok' },
    ] });
    expect(p.sentence!.text).toContain('reading {documents}');
    expect(p.inputs!['documents']).toEqual({ kind: 'documents', tokens: ['attachment:a1', 'attachment:a2'] });
    expect(p.needs).toContainEqual(expect.objectContaining({ id: 'documents', required: true, status: 'met' }));
    expect(p.question).toBeNull();
    expect(p.sentence!.ask).toBe('Start?');
    expect((await r.svc.decide('chat', p.pid, { decision: 'go' }, ME, 'instance')).code).toBe(200);
    expect(sources(r.launches[0]!.resolution)).toEqual(sources(p));
  });

  it('asks one question for absent required documents and Start waits', async () => {
    const r = rig();
    r.files.length = 0;
    const p = await r.pick();
    expect(p.question).toEqual({ kind: 'missing', text: 'Which documents?', choices: [] });
    expect(p.sentence!.ask).toBe('Which documents?');
    expect(documents(p).label).toBe('0 documents');
    expect(p.needs).toContainEqual(expect.objectContaining({ id: 'documents', status: 'missing' }));
    expect(p.inputs!['documents']).toEqual({ kind: 'documents', tokens: [] });
    // A later upload must not release the question or become an unseen source on Go.
    r.files.push({ id: 'later', name: 'later.txt', bytes: 10 });
    expect(await r.svc.decide('chat', p.pid, { decision: 'go' }, ME, 'instance')).toMatchObject({ code: 409, body: { code: 'proposal_blocked', error: p.question!.text } });
    expect(r.launches).toEqual([]);
  });

  it('fills named documents after attachments, but a struck token never reaches sources', async () => {
    const r = rig();
    doc('supported');
    bind(r, ['project-a/supported', 'project-b/private']);
    const p = await r.pick();
    expect(sources(p)).toEqual(['chat', 'attachment:a1', 'attachment:a2', 'doc:project-a/supported']);
    expect(documents(p)).toMatchObject({ label: '3 documents', documents: [
      { token: 'attachment:a1', status: 'ok' }, { token: 'attachment:a2', status: 'ok' },
      { token: 'doc:project-a/supported', label: 'supported v1', status: 'ok' },
      { token: 'doc:project-b/private', status: 'struck', reason: "not in this chat's project" },
    ] });
    expect((await r.svc.decide('chat', p.pid, { decision: 'go' }, ME, 'instance')).code).toBe(200);
    expect(sources(r.launches[0]!.resolution)).toEqual(sources(p));
  });

  it('asks for documents when every required document is struck and launches nothing', async () => {
    const r = rig();
    r.files.length = 0;
    bind(r, ['project-b/private']);
    const p = await r.pick();
    expect(sources(p)).toEqual(['chat']);
    expect(p.question).toEqual({ kind: 'missing', text: "Which documents? not in this chat's project", choices: [] });
    expect(p.sentence!.ask).toBe(p.question!.text);
    expect((await r.svc.decide('chat', p.pid, { decision: 'go' }, ME, 'instance')).code).toBe(409);
    expect(r.launches).toEqual([]);
  });

  it('re-authorizes document scope at Go and refuses the failing token by name', async () => {
    const r = rig();
    r.files.length = 0;
    doc('scope-check');
    bind(r, ['project-a/scope-check']);
    const p = await r.pick();
    r.chat.projectId = 'project-b';
    expect(await r.svc.decide('chat', p.pid, { decision: 'go' }, ME, 'instance')).toMatchObject({
      code: 409, body: { code: 'source_gone', error: "scope check cannot be used (not in this chat's project)" },
    });
    expect(r.launches).toEqual([]);
    expect(r.records.some((rec) => rec.kind === 'proposal_accepting')).toBe(false);
  });

  it('re-authorizes changed attachment limits at Go', async () => {
    const r = rig();
    const p = await r.pick();
    r.replaceBytes('a1', Buffer.alloc(5 * 1024 * 1024, 0x61));
    expect(await r.svc.decide('chat', p.pid, { decision: 'go' }, ME, 'instance')).toMatchObject({
      code: 409, body: { code: 'source_gone', error: 'ask.txt cannot be used (over 512 KB, the most a document draft reads per file)' },
    });
    expect(r.launches).toEqual([]);
  });

  it('refuses launch if a promised document changes between Go authorization and staging', async () => {
    const r = rig();
    const p = await r.pick();
    r.duringCreate(() => r.replaceBytes('a1', Buffer.alloc(5 * 1024 * 1024, 0x61)));
    const result = await r.svc.decide('chat', p.pid, { decision: 'go' }, ME, 'instance');
    expect(result.code).toBe(502);
    expect(JSON.stringify(result.body)).toContain('attachment:a1 cannot be used (over 512 KB');
    expect(r.launches).toEqual([]);
  });

  it('refuses Go after the chat instance is reused', async () => {
    const r = rig();
    const p = await r.pick();
    r.reuse();
    expect(await r.svc.decide('chat', p.pid, { decision: 'go' }, ME, 'instance')).toMatchObject({ code: 409, body: { code: 'chat_gone' } });
    expect(r.launches).toEqual([]);
  });

  it('strikes a 5 MB text attachment before Start and holds the required question', async () => {
    const r = rig();
    r.files.length = 0;
    r.attach('large', 'large.txt', Buffer.alloc(5 * 1024 * 1024, 0x61));
    const p = await r.pick();
    const reason = 'over 512 KB, the most a document draft reads per file';
    expect(documents(p).documents).toEqual([{ token: 'attachment:large', label: 'large.txt', status: 'struck', reason }]);
    expect(p.question?.text).toBe(`Which documents? ${reason}`);
    expect(p.sentence!.ask).toBe(p.question!.text);
    expect((await r.svc.decide('chat', p.pid, { decision: 'go' }, ME, 'instance')).code).toBe(409);
    expect(r.launches).toEqual([]);
    expect((await r.packet(p)).canonical.some((f) => f.name.includes('large'))).toBe(false);
    const stale = { ...p, sources: [{ token: 'attachment:large', label: 'large.txt', status: 'ok' as const }],
      sentence: { ...p.sentence!, tokens: p.sentence!.tokens.map((t) => t.kind === 'documents' ? { ...t, documents: t.documents!.map((d) => ({ ...d, status: 'ok' as const })) } : t) } };
    expect((await r.packet(stale)).struck).toContainEqual({ token: 'attachment:large', reason });
  });

  it.each([[2048, 'evidence.pdf'], [300, 'evidence.pdf'], [2048, 'evidence.pdf ']] as const)('stages the citable derivative of a %i KB pdf named %s and only includes a fitting original', async (kb, name) => {
    const r = rig();
    r.files.length = 0;
    const body = Buffer.from('%PDF-1.4\nstream\nBT (Evidence from page one) Tj ET\nendstream\n%%EOF\n', 'latin1');
    r.attach('pdf', name, Buffer.concat([body, Buffer.alloc(kb * 1024 - body.length, 0x20)]));
    r.records.push({ at: 1, turnId: 'turn', kind: 'user', owner: true, text: 'Use this PDF', seats: ['claude'], attachments: [{ id: 'pdf', chatId: 'chat', name: 'evidence.pdf', mediaType: 'application/pdf', kind: 'pdf', bytes: kb * 1024, sha256: 'x', createdAt: '' }] });
    const p = await r.pick();
    expect(documents(p).documents).toEqual([{ token: 'attachment:pdf', label: name, status: 'ok' }]);
    expect(p.question).toBeNull();
    const packet = await r.packet(p);
    const derivative = packet.canonical.find((f) => f.name === 'attachment-pdf-evidence.pdf.txt')!;
    expect(derivative.bytes.toString()).toContain('Evidence from page one');
    expect(packetDirOf(derivative.name)).toBe('records');
    expect(packet.manifest.files.find((f) => f.token === 'attachment:pdf')!.files.map((f) => f.file)).toContain('records/attachment-pdf-evidence.pdf.txt');
    expect(packet.canonical.some((f) => f.name === 'attachment-pdf-evidence.pdf')).toBe(kb <= 512);
    expect(packet.struck).not.toContainEqual(expect.objectContaining({ token: 'attachment:pdf' }));
    if (kb > 512) expect(packet.manifest.files.find((f) => f.token === 'attachment:pdf')!.note).toContain('only its extracted text');
    expect((await r.svc.decide('chat', p.pid, { decision: 'go' }, ME, 'instance')).code).toBe(200);
    expect(r.packets[0]!.canonical.map((f) => f.name)).toContain('attachment-pdf-evidence.pdf.txt');
  });

  it.each([
    ['scan', Buffer.from('%PDF-1.4\nstream\nno operators here\nendstream\n%%EOF\n'), 'no extractable text (a scan?)'],
    ['cut', Buffer.from(`%PDF-1.4\nstream\nBT (${'A'.repeat(512 * 1024)}) Tj ET\nendstream\n%%EOF\n`), 'its text is over 512 KB'],
  ] as const)('strikes a %s pdf and asks the required question', async (_kind, bytes, reason) => {
    const r = rig();
    r.files.length = 0;
    r.attach('pdf', 'evidence.pdf', bytes);
    r.records.push({ at: 1, turnId: 'turn', kind: 'user', owner: true, text: 'Use this PDF', seats: ['claude'], attachments: [{ id: 'pdf', chatId: 'chat', name: 'evidence.pdf', mediaType: 'application/pdf', kind: 'pdf', bytes: bytes.length, sha256: 'x', createdAt: '' }] });
    const p = await r.pick();
    expect(documents(p).documents).toEqual([{ token: 'attachment:pdf', label: 'evidence.pdf', status: 'struck', reason }]);
    expect(p.question?.text).toBe(`Which documents? ${reason}`);
    expect((await r.svc.decide('chat', p.pid, { decision: 'go' }, ME, 'instance')).code).toBe(409);
    expect((await r.packet(p)).canonical.some((f) => f.name.includes('evidence.pdf'))).toBe(false);
    const stale = { ...p, sources: [{ token: 'attachment:pdf', label: 'evidence.pdf', status: 'ok' as const }],
      sentence: { ...p.sentence!, tokens: p.sentence!.tokens.map((t) => t.kind === 'documents' ? { ...t, documents: t.documents!.map((d) => ({ ...d, status: 'ok' as const })) } : t) } };
    expect((await r.packet(stale)).struck).toContainEqual({ token: 'attachment:pdf', reason });
  });

  it('strikes the third 400 KB file in person order for the packet budget', async () => {
    const r = rig();
    r.files.length = 0;
    for (const id of ['first', 'second', 'third']) r.attach(id, `${id}.txt`, Buffer.alloc(400 * 1024, 0x61));
    const p = await r.pick();
    expect(documents(p).documents!.map((d) => [d.token, d.status, d.reason])).toEqual([
      ['attachment:first', 'ok', undefined], ['attachment:second', 'ok', undefined],
      ['attachment:third', 'struck', 'the documents together pass 1024 KB'],
    ]);
    r.records.push({ at: 1, turnId: 'turn', kind: 'user', owner: true, text: 'context words.\n'.repeat(20 * 1024), seats: ['claude'] });
    const packet = await r.packet(p);
    expect(packet.canonical.filter((f) => f.name.startsWith('attachment-')).map((f) => f.name)).toEqual(['attachment-first-first.txt', 'attachment-second-second.txt']);
    const stale = { ...p, sources: p.sources.concat({ token: 'attachment:third', label: 'third.txt', status: 'ok' as const }),
      sentence: { ...p.sentence!, tokens: p.sentence!.tokens.map((t) => t.kind === 'documents' ? { ...t, documents: t.documents!.map((d) => ({ ...d, status: 'ok' as const })) } : t) } };
    expect((await r.packet(stale)).struck).toContainEqual({ token: 'attachment:third', reason: 'the documents together pass 1024 KB' });
  });

  it('does not stage a document struck by the effective source scope', async () => {
    const r = rig();
    const p = await r.pick();
    const scoped = { ...p, sources: p.sources.map((s) => s.token === 'attachment:a1' ? { ...s, status: 'struck' as const, reason: 'outside the target project' } : s) };
    const packet = await r.packet(scoped);
    expect(packet.struck).toContainEqual({ token: 'attachment:a1', reason: 'outside the target project' });
    expect(packet.canonical.some((f) => f.name === 'attachment-a1-ask.txt')).toBe(false);
  });

  it.each(['changed', 'over-cap', 'deleted'])('keeps canonical document bytes on retry after the live attachment is %s, without a lookup', async (change) => {
    const r = rig();
    const p = await r.pick();
    expect((await r.svc.decide('chat', p.pid, { decision: 'go' }, ME, 'instance')).code).toBe(200);
    const first = r.packets[0]!;
    if (change === 'deleted') rmSync(r.packetDeps.attachment('chat', 'a1')!.path);
    else r.replaceBytes('a1', change === 'over-cap' ? Buffer.alloc(5 * 1024 * 1024, 0x61) : Buffer.from('changed bytes'));
    const lookup = vi.spyOn(r.packetDeps, 'attachment');
    const accepted = r.records.find((rec) => rec.kind === 'proposal_accepting')!;
    if (accepted.kind !== 'proposal_accepting') throw new Error('no accepted resolution');
    // Re-enter the real dispatcher with its saved binding, as recovery after a launch failure does.
    await r.registry.launchOnce({ kind: 'create',
      chatId: 'chat', pid: p.pid, actor: ME, identity: r.svc.identityOf(p), resolution: accepted.resolution,
    });
    const retry = r.packets[1]!;
    expect(retry.struck).toEqual(first.struck);
    expect(retry.canonical).toEqual(first.canonical);
    expect(retry.canonical.find((f) => f.name === 'attachment-a1-ask.txt')!.bytes.toString()).toBe('ask bytes');
    expect(lookup).not.toHaveBeenCalled();
    lookup.mockRestore();
  });

  it.each(['canonical.pdf', 'canonical.pdf.txt'])('keeps the text-only PDF disclosure accurate on canonical retry for %s without the live original', async (name) => {
    const r = rig();
    r.files.length = 0;
    r.attach('pdf', name, name.endsWith('.pdf') ? Buffer.concat([
      Buffer.from('%PDF-1.4\nstream\nBT (Canonical evidence) Tj ET\nendstream\n%%EOF\n'), Buffer.alloc(1024 * 1024, 0x20),
    ]) : Buffer.from('An ordinary text attachment, not a derivative.'));
    const p = await r.pick();
    expect((await r.svc.decide('chat', p.pid, { decision: 'go' }, ME, 'instance')).code).toBe(200);
    rmSync(r.packetDeps.attachment('chat', 'pdf')!.path);
    const first = r.packets[0]!;
    const retry = await r.packet(p, { tokens: first.tokens, bytes: (name) => first.canonical.find((f) => f.name === name)!.bytes });
    const entry = retry.manifest.files.find((f) => f.token === 'attachment:pdf')!;
    if (name.endsWith('.pdf')) expect(entry.note).toContain('only its extracted text is staged');
    else expect(entry.note).toBeUndefined();
    expect(entry).toEqual(first.manifest.files.find((f) => f.token === 'attachment:pdf'));
  });

  it.each([['text', 'large.txt', 5 * 1024 * 1024, 512 * 1024], ['pdf', 'large.pdf', 10 * 1024 * 1024 + 1, 10 * 1024 * 1024]] as const)(
    'rejects over-cap %s from descriptor size without reading bytes, even with stale metadata', async (_kind, name, size, cap) => {
      const r = rig();
      r.files.length = 0;
      r.attach('large', name, Buffer.alloc(size, 0x20));
      r.files[0]!.bytes = 1;
      const read = vi.spyOn(beneath, 'readBeneath');
      vi.mocked(readSync).mockClear();
      const p = await r.pick();
      expect(documents(p).documents![0]!.status).toBe('struck');
      expect(read).toHaveBeenCalledWith(expect.any(String), 'large', cap);
      expect(read.mock.results.find((_, i) => read.mock.calls[i]![1] === 'large')!.type).toBe('throw');
      expect(readSync).not.toHaveBeenCalled();
      read.mockRestore();
    },
  );

  it('caps doc version reads at 512 KB before reading the HTML bytes', async () => {
    const r = rig();
    r.files.length = 0;
    doc('oversized-version');
    writeFileSync(join(ROOT, 'project-a', 'oversized-version', '_v1.html'), Buffer.alloc(1024 * 1024, 0x61));
    bind(r, ['project-a/oversized-version']);
    const read = vi.spyOn(beneath, 'readBeneath');
    vi.mocked(readSync).mockClear();
    const p = await r.pick();
    expect(documents(p).documents![0]!.status).toBe('struck');
    expect(read).toHaveBeenCalledWith(expect.any(String), 'oversized-version/_v1.html', 512 * 1024);
    expect(vi.mocked(readSync).mock.calls.some((call) => (call[1] as Buffer).byteLength > 512 * 1024)).toBe(false);
    read.mockRestore();
  });

  it('reuses PDF extraction on unchanged proposal rebuilds and invalidates same-size changed bytes', async () => {
    const r = rig();
    r.files.length = 0;
    const pdf = (text: string) => Buffer.from(`%PDF-1.4\nstream\nBT (${text}) Tj ET\nendstream\n%%EOF\n`);
    r.attach('cache', 'cache.pdf', pdf('original cache evidence'));
    const extract = vi.spyOn(attachments, 'extractPdfText');
    const first = await r.pick();
    const second = await r.pick();
    expect(second.pid).not.toBe(first.pid);
    expect(documents(second).documents).toEqual(documents(first).documents);
    expect(extract).toHaveBeenCalledTimes(1);
    r.replaceBytes('cache', pdf('modified cache evidence'));
    const third = await r.pick();
    expect(documents(third).documents![0]!.status).toBe('ok');
    expect(extract).toHaveBeenCalledTimes(2);
    // Go and staging must see current bytes even when the content hash matches the proposal's.
    expect((await r.svc.decide('chat', third.pid, { decision: 'go' }, ME, 'instance')).code).toBe(200);
    expect(extract).toHaveBeenCalledTimes(4);
    expect(r.packets[0]!.canonical.find((f) => f.name.endsWith('.pdf.txt'))!.bytes.toString()).toContain('modified cache evidence');
    extract.mockRestore();
  });

  it('bounds the proposal cache at 64 entries and refreshes recently used entries', async () => {
    const r = rig();
    r.files.length = 0;
    const extract = vi.spyOn(attachments, 'extractPdfText');
    const plan = (id: string) => documentPathPlan([`attachment:${id}`], 'cache-lru-chat', r.packetDeps, { cache: true });
    for (let n = 0; n < 64; n++) {
      const id = `lru-${n}`;
      r.attach(id, `${id}.pdf`, Buffer.from(`%PDF-1.4\nstream\nBT (LRU evidence ${n}) Tj ET\nendstream\n%%EOF\n`));
      expect((await plan(id))[0]!.status).toBe('ok');
    }
    expect(extract).toHaveBeenCalledTimes(64);
    await plan('lru-0');
    expect(extract).toHaveBeenCalledTimes(64);
    r.attach('extra', 'extra.pdf', Buffer.from('%PDF-1.4\nstream\nBT (LRU overflow) Tj ET\nendstream\n%%EOF\n'));
    await plan('extra');
    await plan('lru-0');
    expect(extract).toHaveBeenCalledTimes(65);
    await plan('lru-1');
    expect(extract).toHaveBeenCalledTimes(66);
    extract.mockRestore();
  });

  it.each(['document', 'communicate'])('Q9: ordinary %s keeps exactly chat sources and its original sentence', async (card) => {
    const r = rig();
    const p = await r.pick(card);
    expect(sources(p)).toEqual(['chat']);
    expect(p.inputs).toBeUndefined();
    expect(p.needs).toBeUndefined();
    expect(p.sentence).toMatchObject({
      text: "I'll make {kind} from this conversation, filed in project-a, checked by {checks}.",
      tokens: [{ id: 'kind' }, { id: 'checks' }], ask: 'Start?',
    });
    expect((await r.svc.decide('chat', p.pid, { decision: 'go' }, ME, 'instance')).code).toBe(200);
    expect(sources(r.launches[0]!.resolution)).toEqual(['chat']);
  });
});
