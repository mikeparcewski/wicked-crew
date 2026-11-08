// DES-CATALOG-002 CS4: POST /runs takes a job's documents and its source pick.
//   - documents: every token authorised again at launch (the chat's own rules), staged whole in the run's own folder,
//     mounted READ-ONLY (never a write root), and named in the brief; a refused token is a 400 and nothing launches;
//   - sources: checked against the project's sources and their switches, recorded before the engine is called; a
//     retry that sends none keeps the earlier run's pick.
// Fastify inject() with a mock adapter: no engine.

import Fastify, { type FastifyInstance } from 'fastify';
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
import { ChatProposals } from '../src/api/chat-proposals.js';
import { RunSourcePicks } from '../src/api/run-sources.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { LaunchRunInput, ProposalSource } from '../src/core/types.js';
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
