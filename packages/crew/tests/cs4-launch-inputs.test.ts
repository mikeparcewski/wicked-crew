// DES-CATALOG-002 CS4: POST /runs takes a job's documents and its source pick.
//   - documents: every token authorised again at launch (the chat's own rules), staged whole in the run's own folder,
//     mounted READ-ONLY (never a write root), and named in the brief; a refused token is a 400 and nothing launches;
//   - sources: checked against the project's sources and their switches, recorded before the engine is called; a
//     retry that sends none keeps the earlier run's pick.
// Fastify inject() with a mock adapter: no engine.

import Fastify, { type FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { AuditLog } from '../src/api/audit.js';
import { ChatAttachmentStore } from '../src/api/chat-attachments.js';
import { ChatProposals, LaunchOnceRegistry } from '../src/api/chat-proposals.js';
import { RunSourcePicks } from '../src/api/run-sources.js';
import { jobInputsOfProposal } from '../src/api/chat-jobs.js';
import { CATALOG_SEEDS } from '../src/workflow-catalog/catalog-data.js';
import { servedState } from '../src/workflow-catalog/build-v2.js';
import { CoreAdapter } from '../src/core/adapter.js';
import type { ArtifactProposal, ChatTranscriptRecord, LaunchRunInput, ProposalSource } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

/** The sources the fake gate answers: web (agents on) and support-pg (agents off). */
const SOURCES: Array<{ id: string; label: string; reason?: string }> = [
  { id: 'web', label: 'the web' },
  { id: 'support-pg', label: 'support-pg', reason: "agents can't query it" },
];
vi.mock('../src/api/run-sources.js', async (original) => {
  const actual = await original<typeof import('../src/api/run-sources.js')>();
  return {
    ...actual,
    // The real check over a fixed list: what this test pins is the route's use of it, not the gate's projection.
    checkSourcePick: async (_projectId: string | null, ids: readonly string[]) => {
      const refused = [...new Set(ids)].flatMap((id) => {
        const s = SOURCES.find((x) => x.id === id);
        return s === undefined ? [{ id, reason: 'no source of that name in this project' }] : s.reason !== undefined ? [{ id, reason: s.reason }] : [];
      });
      return refused.length > 0 ? { ok: false as const, refused } : { ok: true as const, ids: [...new Set(ids)] };
    },
    projectSources: async () => SOURCES,
    runSourcesDeps: () => ({}) as never,
  };
});

describe('POST /runs: a job’s documents and source pick (CS4)', () => {
  let app: FastifyInstance;
  let launchRun: Mock;
  let scratch: string;
  let docsRoot: string;
  let picks: RunSourcePicks;
  let attachments: ChatAttachmentStore;
  let known: string[];
  let authorize: ReturnType<typeof vi.spyOn>;
  const CHAT = 'chat-1';

  beforeEach(async () => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'cs4-launch-')));
    docsRoot = join(scratch, 'run-documents');
    picks = new RunSourcePicks(join(scratch, 'mcp', 'run-source-picks.json'));
    attachments = new ChatAttachmentStore({ dir: join(scratch, 'attachments') });
    known = [];
    launchRun = vi.fn(async (input: LaunchRunInput) => {
      known.push(input.sessionId);
      return input.sessionId;
    });
    // The chat's own rules are slice B's (unit-tested there); here an attachment of this chat is ok, any other struck.
    authorize = vi.spyOn(ChatProposals.prototype, 'authorizeDocuments').mockImplementation(async (chatId: string, tokens: readonly string[]) =>
      tokens.map((token): ProposalSource => {
        const id = token.startsWith('attachment:') ? token.slice('attachment:'.length) : '';
        return chatId === CHAT && attachments.list(CHAT).some((a) => a.id === id)
          ? { token, label: id, status: 'ok' }
          : { token, label: token, status: 'struck', reason: 'not a file attached to this chat' };
      }),
    );
    app = Fastify({ logger: false });
    registerRoutes(
      app,
      {
        launchRun,
        ping: async () => 'ok',
        getSettings: async () => ({}),
        sessionsDetail: vi.fn().mockResolvedValue([]),
        sessions: vi.fn(async () => known),
        listWorkflows: () => [],
        listRepos: vi.fn().mockResolvedValue([]),
        projectMembers: vi.fn().mockResolvedValue([]),
        projectMemberAttach: vi.fn(),
        projectMemberDetach: vi.fn(),
      } as unknown as CoreAdapter,
      new GateCache(),
      new ElicitationCache(),
      { bus: null, index: new MembershipIndex(), log: () => undefined },
      { audit: AuditLog.noop(), authMode: 'off' },
      {
        callEstateTool: vi.fn() as (t: string, a: Record<string, unknown>) => Promise<unknown>,
        chatAttachments: attachments,
        runDocumentsRoot: docsRoot,
        runSourcePicks: picks,
        dataGate: {} as never,
      },
    );
    await app.ready();
  });
  afterEach(async () => {
    authorize.mockRestore();
    await app.close();
    removeScratch(scratch);
  });

  const attach = (name: string, text: string): string =>
    attachments.add(CHAT, [{ filename: name, declaredType: 'text/plain', data: Buffer.from(text, 'utf8') }])[0]!.id;
  const launch = (body: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'Due diligence on these', ...body } });

  /** Real catalog and proposal fill, with the same attachment store the launch route reads. */
  async function propose(card: string, option?: string): Promise<ArtifactProposal> {
    const catalog = new CoreAdapter({ dbPath: join(scratch, 'catalog.db'), stub: true });
    let served;
    try {
      await catalog.loadBuiltinCatalog(() => undefined);
      served = { ...servedState({ defs: catalog.listWorkflows(), presets: await catalog.listPresets(), entries: await catalog.catalog() }), rev: 'test' };
    } finally {
      catalog.close();
    }
    const records: ChatTranscriptRecord[] = [];
    const svc = new ChatProposals({
      flags: () => ({ context: true, proposals: true, create: false, refine: false, theme: false, demo: false }),
      catalog: CATALOG_SEEDS, records: () => records,
      append: (_id, record) => { records.push(record); return true; },
      instanceOf: () => 'instance', projectOf: () => null,
      chat: () => ({ projectId: null, repos: [{ id: 'repo', name: 'repo' }], lead: 'claude', seats: ['claude'], analysis: false }),
      rosterEligible: () => ['claude', 'codex', 'pi'].map((key) => ({ key, name: key })),
      runs: async () => [], chatOfRun: () => undefined, isAskPath: () => false,
      docsRoot: async () => null, projectName: async () => null,
      attachments: (id) => attachments.list(id), workflowSteps: async () => 3, runCostUsd: async () => null,
      registry: new LaunchOnceRegistry(), jobs: () => true, served: async () => served,
      reshapeReject: async () => null, broadcast: () => undefined, audit: () => undefined,
    });
    const result = await svc.propose(CHAT, { card, ...(option !== undefined ? { option } : {}), source: 'pick', requestId: 'pick', words: 'Implement the attached specification' },
      { id: 'operator', kind: 'human', trust: 'operator' }, 'instance');
    expect(result.code).toBe(201);
    return (result.body['view'] as { proposal: ArtifactProposal }).proposal;
  }

  it.each([
    { card: 'feature', option: undefined, workflow: 'feature' },
    { card: 'document', option: 'repo-docs', workflow: 'docs' },
  ])('$card $option carries a full Unicode Markdown attachment from proposal to launch', async ({ card, option, workflow }) => {
    const text = Array.from({ length: 1400 }, (_, i) => `## Rule ${i} → café\nImplement this requirement.\n`).join('');
    const uploaded = Buffer.from(text, 'utf8');
    expect(text.length).toBeGreaterThan(40_000);
    const id = attachments.add(CHAT, [{ filename: 'spec.md', declaredType: 'text/markdown', data: uploaded }])[0]!.id;
    const proposal = await propose(card, option);
    expect(proposal.needs).toContainEqual(expect.objectContaining({ id: 'documents', required: false, status: 'met' }));
    expect(proposal.sentence!.tokens.find((t) => t.kind === 'documents')).toMatchObject({
      label: '1 document', documents: [{ token: `attachment:${id}`, status: 'ok' }],
    });
    expect(jobInputsOfProposal(proposal).documents).toEqual([`attachment:${id}`]);
    expect(proposal.question).toBeNull();
    const res = await launch({ chatId: CHAT, workflow, ...jobInputsOfProposal(proposal) });
    expect(res.statusCode).toBe(201);
    const input = launchRun.mock.calls[0]![0] as LaunchRunInput;
    const root = join(docsRoot, input.sessionId);
    const manifest = JSON.parse(readFileSync(join(root, 'records', 'MANIFEST.json'), 'utf8')) as { files: Array<{ token: string; file: string }> };
    expect(manifest.files).toHaveLength(1);
    const file = manifest.files[0]!;
    expect(file.token).toBe(`attachment:${id}`);
    const path = join(root, 'records', file.file);
    const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    expect(hash(readFileSync(path))).toBe(hash(uploaded));
    expect(statSync(path).size).toBe(uploaded.length);
    expect(statSync(path).mode & 0o222).toBe(0);
    expect(input.extraReadRoots).toContain(root);
    expect(input.extraWriteRoots ?? []).not.toContain(root);
    expect(input.problem).toContain('THE DOCUMENTS of this job');
    expect(input.problem).toContain(join(root, 'records'));
    expect(input.problem).toContain(file.file);
  });

  it('a feature without attachments asks no documents question and shows no documents token', async () => {
    const proposal = await propose('feature');
    expect(proposal.needs).toContainEqual(expect.objectContaining({ id: 'documents', required: false }));
    expect(proposal.question).toBeNull();
    expect(proposal.sentence!.tokens.some((t) => t.kind === 'documents')).toBe(false);
    expect(proposal.sentence!.text).not.toContain('{documents}');
    expect(jobInputsOfProposal(proposal).documents).toEqual([]);
  });

  it('a feature launched outside a chat has its original brief and no document roots', async () => {
    const res = await launch({ workflow: 'feature', problem: 'Add a setting' });
    expect(res.statusCode).toBe(201);
    const input = launchRun.mock.calls[0]![0] as LaunchRunInput;
    expect(input.problem).toBe('Add a setting');
    expect(input.extraReadRoots ?? []).toEqual([]);
    expect(authorize).not.toHaveBeenCalled();
  });

  it('stages two attachments read-only, mounts the folder as a read root only, and names it in the brief', async () => {
    const a = attach('terms.txt', 'Term: 24 months\n');
    const b = attach('prices.txt', 'Rate: 120/h\n');
    const res = await launch({ chatId: CHAT, documents: [`attachment:${a}`, `attachment:${b}`] });
    expect(res.statusCode).toBe(201);
    const input = launchRun.mock.calls[0]![0] as LaunchRunInput;
    const root = join(docsRoot, input.sessionId);
    // The run can read its documents and can never write there: a read root, and not a write root.
    expect(input.extraReadRoots).toContain(root);
    expect(input.extraWriteRoots ?? []).not.toContain(root);
    expect((input.extraWriteRoots ?? []).some((w) => root.startsWith(w) || w.startsWith(root))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(root, 'records', 'MANIFEST.json'), 'utf8')) as { files: Array<{ token: string; file: string }> };
    expect(manifest.files.map((f) => f.token).sort()).toEqual([`attachment:${a}`, `attachment:${b}`].sort());
    for (const f of manifest.files) expect(statSync(join(root, 'records', f.file)).mode & 0o222).toBe(0);
    expect(input.problem).toContain(join(root, 'records'));
    // Re-authorised at launch with the chat's rules.
    expect(authorize).toHaveBeenCalledWith(CHAT, [`attachment:${a}`, `attachment:${b}`]);
  });

  it("refuses a token another chat's rules strike (an attachment of another chat), and launches nothing", async () => {
    const mine = attach('mine.txt', 'x\n');
    const res = await launch({ chatId: CHAT, documents: [`attachment:${mine}`, 'attachment:someone-elses'] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'documents_refused' });
    expect(res.json().error).toContain('not a file attached to this chat');
    expect(launchRun).not.toHaveBeenCalled();
  });

  it('refuses documents without the chat they were named in', async () => {
    const res = await launch({ documents: ['attachment:x'] });
    expect(res.statusCode).toBe(400);
    expect(launchRun).not.toHaveBeenCalled();
  });

  it('a retry that sends no documents stages the earlier run’s documents again, authorised again, in its own folder', async () => {
    const a = attach('terms.txt', 'Term: 24 months\n');
    expect((await launch({ chatId: CHAT, documents: [`attachment:${a}`] })).statusCode).toBe(201);
    const first = (launchRun.mock.calls[0]![0] as LaunchRunInput).sessionId;
    authorize.mockClear();
    expect((await launch({ retryOf: first })).statusCode).toBe(201);
    const second = launchRun.mock.calls[1]![0] as LaunchRunInput;
    // Never the earlier folder mounted as it is: the tokens are authorised against the earlier run's chat again.
    expect(authorize).toHaveBeenCalledWith(CHAT, [`attachment:${a}`]);
    expect(second.extraReadRoots).toContain(join(docsRoot, second.sessionId));
    expect(second.extraReadRoots ?? []).not.toContain(join(docsRoot, first));
  });

  it('a retry whose documents are no longer the chat’s is refused, and launches nothing', async () => {
    const a = attach('terms.txt', 'Term: 24 months\n');
    expect((await launch({ chatId: CHAT, documents: [`attachment:${a}`] })).statusCode).toBe(201);
    const first = (launchRun.mock.calls[0]![0] as LaunchRunInput).sessionId;
    attachments.removeChat(CHAT);
    const res = await launch({ retryOf: first });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'documents_refused' });
    expect(launchRun).toHaveBeenCalledTimes(1);
  });

  it('documents: [] is none: no chat needed, and a retry with [] inherits nothing', async () => {
    expect((await launch({ documents: [] })).statusCode).toBe(201);
    const a = attach('terms.txt', 'x\n');
    expect((await launch({ chatId: CHAT, documents: [`attachment:${a}`] })).statusCode).toBe(201);
    const withDocs = (launchRun.mock.calls[1]![0] as LaunchRunInput).sessionId;
    expect((await launch({ retryOf: withDocs, documents: [] })).statusCode).toBe(201);
    expect((launchRun.mock.calls[2]![0] as LaunchRunInput).extraReadRoots ?? []).toEqual([]);
  });

  it("refuses documents for a run filed in another project than the chat's", async () => {
    const a = attach('terms.txt', 'x\n');
    const res = await launch({ chatId: CHAT, documents: [`attachment:${a}`], projectId: 'other-project' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'documents_refused' });
    expect(res.json().error).toContain("the chat's project");
    expect(launchRun).not.toHaveBeenCalled();
  });

  it('records the pick before the engine is called, and a retry keeps it', async () => {
    let atLaunch: string[] | null = null;
    launchRun.mockImplementationOnce(async (input: LaunchRunInput) => {
      atLaunch = picks.get(input.sessionId);
      known.push(input.sessionId);
      return input.sessionId;
    });
    expect((await launch({ sources: ['web'] })).statusCode).toBe(201);
    const first = (launchRun.mock.calls[0]![0] as LaunchRunInput).sessionId;
    expect(atLaunch).toEqual(['web']);
    expect((await launch({ retryOf: first })).statusCode).toBe(201);
    const second = (launchRun.mock.calls[1]![0] as LaunchRunInput).sessionId;
    expect(new RunSourcePicks(join(scratch, 'mcp', 'run-source-picks.json')).get(second)).toEqual(['web']);
  });

  it('an empty pick is a pick (none), not "no pick"', async () => {
    expect((await launch({ sources: [] })).statusCode).toBe(201);
    expect(picks.get((launchRun.mock.calls[0]![0] as LaunchRunInput).sessionId)).toEqual([]);
  });

  it('checks an inherited pick again: a retry whose picked source was switched off since is refused', async () => {
    SOURCES[0] = { id: 'web', label: 'the web' };
    expect((await launch({ sources: ['web'] })).statusCode).toBe(201);
    const first = (launchRun.mock.calls[0]![0] as LaunchRunInput).sessionId;
    SOURCES[0] = { id: 'web', label: 'the web', reason: "agents can't query it" };
    try {
      const res = await launch({ retryOf: first });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'sources_refused' });
      expect(launchRun).toHaveBeenCalledTimes(1);
    } finally {
      SOURCES[0] = { id: 'web', label: 'the web' };
    }
  });

  it('refuses a pick of a switched-off source, and launches nothing', async () => {
    const res = await launch({ sources: ['web', 'support-pg'] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'sources_refused' });
    expect(res.json().error).toContain('support-pg');
    expect(launchRun).not.toHaveBeenCalled();
  });
});
