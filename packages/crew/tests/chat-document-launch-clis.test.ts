// crew#1611: exercise the production CreateLauncher.clisJsonFor through the server and draft seam,
// all the way to the engine-bound launch input. The proposal stub never sees this launch.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ArtifactProposal, ChatMessagesResponse, ChatProposalView, HealthResponse } from 'wicked-crew-api-types';

import { createServer } from '../src/api/server.js';
import { proposalRunId } from '../src/api/chat-proposals.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, LaunchRunInput, SessionView } from '../src/core/types.js';
import { ensureProjectInteractiveRoot } from '../src/interactive/bridge-root.js';
import { crewStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import { removeScratch } from './setup/scratch.js';
import { withRunViews } from './support/run-views.js';

describe('chat document launch roster (production server, crew#1611)', () => {
  const previousStateHome = crewStateHome();
  const launches: LaunchRunInput[] = [];
  const listeners = new Set<(event: CoreEvent) => void>();
  const createdDocs: string[] = [];
  let scratch: string;
  let app: FastifyInstance | undefined;
  let bridge: FastifyInstance | undefined;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'chat-document-launch-clis-'));
    const home = join(scratch, 'state-home');
    mkdirSync(home);
    setCrewStateHome(home);
    vi.stubEnv('WICKED_CREW_SYSTEM_SETTINGS', join(scratch, 'settings.json'));
    vi.stubEnv('WICKED_INTERACTIVE_ROOT', join(home, 'interactive', 'docs'));
    writeFileSync(process.env['WICKED_CREW_SYSTEM_SETTINGS']!, '{}');

    // Only interactive's document-storage service is a fixture: the production bridge pool adopts
    // this local server, so Go still runs createDocInProcess, CreateLauncher and launchBoundDraft.
    // No wicked-interactive subprocess or npm download is needed.
    const root = ensureProjectInteractiveRoot('default', undefined);
    mkdirSync(root, { recursive: true });
    bridge = Fastify();
    bridge.get('/api/health', async () => ({ ok: true, root }));
    bridge.post<{ Body: { name: string } }>('/api/docs', async (req, reply) => {
      const name = req.body.name;
      const dir = join(root, name);
      mkdirSync(dir);
      writeFileSync(join(dir, 'versions.json'), JSON.stringify({ head: 0, versions: [] }));
      createdDocs.push(name);
      return reply.code(201).send({ name, head: 0, generating: true });
    });
    await bridge.listen({ port: 0, host: '127.0.0.1' });
    const address = bridge.server.address();
    if (address === null || typeof address === 'string') throw new Error('bridge has no TCP address');
    writeFileSync(join(root, '.wi-serve.json'), JSON.stringify({
      port: address.port, host: '127.0.0.1', pid: process.pid, startedAt: new Date().toISOString(), version: '0.16.2',
    }));

    const adapter = withRunViews({
      dbPath: join(home, 'core.db'),
      projectsSupported: () => true,
      getSettings: async () => ({}),
      ping: async () => 'ok',
      onLaunch: () => () => undefined,
      onEvent: (fn: (event: CoreEvent) => void) => {
        listeners.add(fn);
        return () => { listeners.delete(fn); };
      },
      listRepos: async () => [],
      projectList: async () => [],
      projectMembers: async () => [],
      sessions: async () => launches.map((input) => input.sessionId!),
      sessionsDetail: async () => launches.map((input) => ({
        session: { id: input.sessionId, status: 'awaiting_human', repo_ref: null, problem: input.problem, workflow_id: input.workflow ?? 'ask', extra_write_roots: [] },
        units: [],
      })) as unknown as SessionView[],
      launchRun: async (input: LaunchRunInput) => {
        const id = input.sessionId ?? `chat-run-${launches.length + 1}`;
        launches.push({ ...input, sessionId: id });
        return id;
      },
      workOutput: async () => '',
      runEvents: async () => [],
      getWorkflow: () => undefined,
      listPresets: async () => [{ name: 'interactive-draft', scope: 'global', steps: [{ id: 'write' }, { id: 'review' }, { id: 'check' }], created_by: 'builtin', updated_at: 1 }],
      proposePlan: async () => ({ ok: true }),
      confirmGate: async () => 'awaiting_human',
      cancelRun: async () => 'cancelled',
      chatClose: async () => undefined,
      chatList: async () => [],
      onboardedRepoOf: () => undefined,
    } as unknown as CoreAdapter);

    app = await createServer(adapter, {
      auth: { mode: 'off' },
      auditPath: join(scratch, 'audit.log'),
      evalStoreRoot: join(scratch, 'evals'),
      seats: { signedIn: () => true },
      chatArtifactsStub: false,
      projectEvents: { disabled: true },
      interactiveWsRelay: { disabled: true },
      stallWatchdog: { enabled: false },
      skills: { disabled: true },
      // Same arming shape as stub-engine-bus-seams.test.ts: setup/bus-double.ts supplies
      // the engine-bus calls for this test's private SQLite file. The draft seam itself is real.
      interactiveDraftEvents: {
        enabled: true,
        dbPath: join(scratch, 'bus.db'),
        ledgerPath: join(scratch, 'draft-ledger.json'),
        draftDir: join(scratch, 'drafts'),
        pollIntervalMs: 60_000,
      },
    });
    await app!.ready();
    const health = (await app!.inject({ method: 'GET', url: '/api/v1/health' })).json() as HealthResponse;
    expect(health.capabilities?.chatArtifacts).toMatchObject({ create: true });
    expect(health.capabilities?.chatArtifacts).not.toHaveProperty('stub', true);
  }, 150_000);

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await bridge?.close();
      vi.unstubAllEnvs();
      setCrewStateHome(previousStateHome);
      if (scratch !== undefined) removeScratch(scratch);
    }
  });

  it.each([
    { label: 'includes OpenCode when picked', helpers: ['claude', 'opencode'] },
    { label: 'excludes OpenCode when unpicked', helpers: ['claude', 'codex'] },
  ])('$label in the engine-bound document roster', async ({ helpers }) => {
    const chatId = `doc-clis-${helpers[1]}`;
    const opened = await app!.inject({ method: 'POST', url: '/api/v1/chats', payload: { chatId, clis: ['claude'] } });
    expect(opened.statusCode, opened.body).toBe(201);
    const sent = await app!.inject({ method: 'POST', url: `/api/v1/chats/${chatId}/messages`, payload: { text: 'Make a deck on coverage' } });
    expect(sent.statusCode, sent.body).toBe(202);
    for (const fn of listeners) fn({
      type: 'chatReply', chat: chatId, cliKey: 'claude', ok: true,
      text: 'I can make that.\n\n```wicked-make\n' + JSON.stringify({ entry: 'presentation', title: 'Coverage', sources: ['chat'] }) + '\n```\n',
    } as unknown as CoreEvent);

    let proposal: ArtifactProposal | undefined;
    await vi.waitFor(async () => {
      const response = await app!.inject({ method: 'GET', url: `/api/v1/chats/${chatId}/messages` });
      const records = (response.json() as ChatMessagesResponse).messages;
      const record = records.filter((r) => r.kind === 'proposal').at(-1);
      proposal = record?.kind === 'proposal' ? record.proposal : undefined;
      expect(proposal).toBeDefined();
    });
    expect(proposal).toMatchObject({ kind: 'create', blocked: null });
    // The real registry's opt-in seat is selected only by the person's card edit.
    expect(proposal!.helpers?.seats).not.toContain('opencode');
    const before = launches.length;
    const docsBefore = createdDocs.length;
    const go = await app!.inject({
      method: 'POST', url: `/api/v1/chats/${chatId}/proposals/${encodeURIComponent(proposal!.pid)}`,
      payload: { decision: 'go', edits: { helpers } },
    });
    expect(go.statusCode, go.body).toBe(200);
    const runId = proposalRunId(proposal!.pid);
    expect((go.json() as { view: ChatProposalView }).view).toMatchObject({
      state: 'decided', decision: 'go', result: { runId, stub: false },
    });
    expect(createdDocs).toHaveLength(docsBefore + 1);
    expect(launches).toHaveLength(before + 1);
    const documentLaunch = launches.find((input) => input.sessionId === runId);
    expect(documentLaunch).toMatchObject({ workflow: 'interactive-draft' });
    const roster = JSON.parse(documentLaunch!.clisJson!) as Array<{ key: string }>;
    const keys = roster.map((seat) => seat.key);
    expect(keys).toEqual(helpers);
    // crew#1751: the card's writer (its first helper) leads the draft, so the other helper is the distinct checker.
    expect(documentLaunch!.primary).toBe(helpers[0]);
    if (helpers.includes('opencode')) expect(keys).toContain('opencode');
    else expect(keys).not.toContain('opencode');
  });
});
