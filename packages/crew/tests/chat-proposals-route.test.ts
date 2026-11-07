// DES-CHAT-ARTIFACTS-001 §4 (slice A2) through the REAL server assembly over a fake engine: a seat's reply with a
// `wicked-make` block becomes a crew-resolved `proposal` record (sources authorized and struck, helpers, the block
// never shown), and `POST /chats/:id/proposals/:pid` is the only way it starts anything — a person and the chat's owner
// only, adopt-first under one lock, exactly one stub dispatch for a double click, a lost response and two tabs. The
// production configuration advertises `proposals` with every operation off: seats are told nothing and no card is made.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ArtifactProposal, ChatMessagesResponse, ChatProposalView, ChatTranscriptRecord, HealthResponse } from 'wicked-crew-api-types';

import { createServer } from '../src/api/server.js';
import { tokenHash } from '../src/api/auth.js';
import { ensureProjectInteractiveRoot } from '../src/interactive/bridge-root.js';
import { crewStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, LaunchRunInput, SessionView } from '../src/core/types.js';
import { proposalRunId } from '../src/api/chat-proposals.js';
import { removeScratch } from './setup/scratch.js';

const armedStateHome = crewStateHome();
const RUN_A = '29bbbfb1-1111-4000-8000-000000000001';
const RUN_B = '679ca85b-2222-4000-8000-000000000002';
const RUN_OTHER = '0bad0bad-4444-4000-8000-000000000004';
const DECK = '<html><head><title>Coverage deck</title></head><body><section class="wi-slide" data-wid="section-0"><h2 data-wid="h">Intro</h2></section></body></html>';

function runView(id: string): SessionView {
  return {
    session: { id, workflow_id: 'wf', problem: `measure ${id}`, status: 'cancelled', repo_ref: null, clis: [], unit_ix: 0, attempt: 0, workdir: null, extra_write_roots: [], archived_at: null, archive_note: null, entity_mode: 'none', collection_scope: null, human_confirm: 'none' },
    units: [{ id: `${id}:u1`, session_id: id, ord: 1, description: 'measure', stage: 'build', assigned_cli: 'codex', status: 'done', denial_reason: null }],
  } as unknown as SessionView;
}

describe('chat proposals (server, A2)', () => {
  let scratch: string;
  let home: string;
  let stub: FastifyInstance;
  let authed: FastifyInstance;
  let prod: FastifyInstance;
  const launches: LaunchRunInput[] = [];
  const pathRuns: string[] = [];

  const makeAdapter = (mine: Array<(e: CoreEvent) => void>): CoreAdapter => ({
    dbPath: join(home, 'core.db'),
    projectsSupported: () => true,
    getSettings: async () => ({}),
    ping: async () => 'ok',
    onLaunch: (): (() => void) => () => undefined,
    onEvent: (fn: (e: CoreEvent) => void): (() => void) => {
      mine.push(fn);
      return () => undefined;
    },
    listRepos: async () => [{ id: 'r-crew', name: 'wicked-crew', root_path: join(scratch, 'repo-crew'), default_branch: 'main', registered_at: 1 }],
    projectGet: async (id: string) => (['mikes', 'other'].includes(id) ? { id, name: id === 'mikes' ? 'Mikes' : 'Other', status: 'active', description: null, scope: `project:${id}`, created_at: 1, updated_at: 1 } : null),
    projectList: async () => [{ id: 'mikes' }, { id: 'other' }],
    projectMembers: async (id: string) =>
      id === 'mikes' ? [{ member_kind: 'crew.run', member_ref: RUN_A }, { member_kind: 'crew.repo', member_ref: 'r-crew' }] : id === 'other' ? [{ member_kind: 'crew.run', member_ref: RUN_OTHER }] : [],
    projectMemberAttach: async () => ({ member: { id: 'm1', attached_at: 1 }, created: false }),
    projectMemberDetach: async () => true,
    launchRun: async (input: LaunchRunInput) => {
      launches.push(input);
      const id = `path-run-${launches.length}`;
      pathRuns.push(id);
      return id;
    },
    sessionsDetail: async () => [
      ...pathRuns.map((id) => ({ session: { id, status: 'awaiting_human', repo_ref: null, problem: 'chat', workflow_id: 'ask', extra_write_roots: [] }, units: [] })),
      runView(RUN_A),
      runView(RUN_B),
      runView(RUN_OTHER),
      // A3: a chat proposal's attempt that failed (its retry is the path, never a cursor resume).
      { ...runView('bound-failed'), session: { ...runView('bound-failed').session, status: 'failed' } },
    ],
    workOutput: async () => 'Coverage moved.',
    runEvents: async () => [],
    getWorkflow: () => undefined,
    listPresets: async () => [{ name: 'interactive-draft', scope: 'global', steps: [{ id: 'write' }, { id: 'review' }, { id: 'check' }], created_by: 'builtin', updated_at: 1 }],
    proposePlan: async () => ({ ok: true }),
    confirmGate: async () => 'awaiting_human',
    cancelRun: async () => 'cancelled',
    chatClose: async () => undefined,
    chatList: async () => [],
    onboardedRepoOf: () => undefined,
  }) as unknown as CoreAdapter;

  const stubListeners: Array<(e: CoreEvent) => void> = [];
  const authedListeners: Array<(e: CoreEvent) => void> = [];
  const prodListeners: Array<(e: CoreEvent) => void> = [];

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'chat-proposals-route-'));
    home = join(scratch, 'state-home');
    mkdirSync(home);
    mkdirSync(join(scratch, 'repo-crew'));
    setCrewStateHome(home);
    // A3: two chat-made documents' bindings, as a previous daemon left them: one attempt failed, one launched and not
    // yet landed (its run is not on this engine: the boot reconcile leaves it to the card's Go again).
    const bindings = join(home, 'chats', 'doc-bindings');
    mkdirSync(bindings, { recursive: true });
    const bind = (doc: string, attempt: Record<string, unknown>) => writeFileSync(join(bindings, `_unfiled__${doc}.json`), JSON.stringify({
      ref: `_unfiled/${doc}`, mount: '_unfiled', doc, projectId: null, owner: 'local', chatId: 'gone-chat', chatInstance: 'i0', scopeProject: null,
      proposalId: 'gone-chat:t1', cutoffTurnId: 't1', repos: [], graphDb: null, packet: {}, tokens: {}, attempts: [{ pid: 'gone-chat:t1', base: 0, at: 1, ...attempt }], createdAt: 1,
    }));
    bind('failed-doc', { runId: 'bound-failed', launchedAt: 2, outcome: { kind: 'failed', reason: 'the run failed', at: 3 }, published: true });
    bind('drafting-doc', { runId: 'bound-drafting', launchedAt: 2 });
    const tokens = join(scratch, 'tokens.json');
    writeFileSync(tokens, JSON.stringify({
      tokens: [
        { sha256: tokenHash('owner-token'), actor: { id: 'maria', kind: 'human', trust: 'operator' } },
        { sha256: tokenHash('other-token'), actor: { id: 'sam', kind: 'human', trust: 'operator' } },
        { sha256: tokenHash('agent-token'), actor: { id: 'worker', kind: 'agent', trust: 'operator' } },
      ],
    }));
    const opts = {
      seats: { signedIn: () => true },
      evalStoreRoot: join(scratch, 'evals'),
      projectEvents: { disabled: true },
      interactiveWsRelay: { disabled: true },
      stallWatchdog: { enabled: false },
      skills: { disabled: true },
    } as const;
    stub = await createServer(makeAdapter(stubListeners), { ...opts, chatArtifactsStub: true, auth: { mode: 'off' }, auditPath: join(scratch, 'audit.log') });
    await stub.ready();
    authed = await createServer(makeAdapter(authedListeners), { ...opts, chatArtifactsStub: true, auth: { mode: 'required', tokensPath: tokens }, auditPath: join(scratch, 'audit-authed.log') });
    await authed.ready();
    prod = await createServer(makeAdapter(prodListeners), { ...opts, chatArtifactsStub: false, auth: { mode: 'off' }, auditPath: join(scratch, 'audit-prod.log') });
    await prod.ready();
    const mikes = ensureProjectInteractiveRoot('mikes', undefined, process.env, home);
    mkdirSync(join(mikes, 'coverage-deck'), { recursive: true });
    writeFileSync(join(mikes, 'coverage-deck', '_v1.html'), DECK);
    writeFileSync(join(mikes, 'coverage-deck', 'versions.json'), JSON.stringify({ head: 1, versions: [{ version: 1 }] }));
  }, 150_000);

  afterAll(async () => {
    await stub.close();
    await authed.close();
    await prod.close();
    setCrewStateHome(armedStateHome);
    removeScratch(scratch);
  });

  const auth = (token?: string) => (token !== undefined ? { headers: { authorization: `Bearer ${token}` } } : {});
  const open = (a: FastifyInstance, body: Record<string, unknown>, token?: string) => a.inject({ method: 'POST', url: '/api/v1/chats', payload: body, ...auth(token) });
  const send = (a: FastifyInstance, chatId: string, body: Record<string, unknown>, token?: string) =>
    a.inject({ method: 'POST', url: `/api/v1/chats/${chatId}/messages`, payload: body, ...auth(token) });
  const decide = (a: FastifyInstance, chatId: string, pid: string, body: Record<string, unknown>, token?: string) =>
    a.inject({ method: 'POST', url: `/api/v1/chats/${chatId}/proposals/${encodeURIComponent(pid)}`, payload: body, ...auth(token) });
  const records = async (a: FastifyInstance, chatId: string, token?: string): Promise<ChatTranscriptRecord[]> =>
    ((await a.inject({ method: 'GET', url: `/api/v1/chats/${chatId}/messages`, ...auth(token) })).json() as ChatMessagesResponse).messages;
  const reply = (ls: Array<(e: CoreEvent) => void>, chat: string, text: string): void => {
    for (const fn of ls) fn({ type: 'chatReply', chat, cliKey: 'claude', text, ok: true } as unknown as CoreEvent);
  };
  const proposalOf = async (a: FastifyInstance, chatId: string, token?: string): Promise<ArtifactProposal> => {
    for (let i = 0; i < 100; i += 1) {
      const p = (await records(a, chatId, token)).filter((r) => r.kind === 'proposal').at(-1);
      if (p !== undefined && p.kind === 'proposal') return p.proposal;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no proposal in ${chatId}`);
  };
  const stubRows = (): Array<{ pid: string; runId: string }> => {
    const f = join(home, 'chats', 'proposal-stub', 'dispatches.ndjson');
    return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)) : [];
  };
  const make = (block: Record<string, unknown>): string => `I can make that.\n\n\`\`\`wicked-make\n${JSON.stringify(block)}\n\`\`\`\n`;

  /** Open a chat in `projectId` (or none), send `text` (optionally with the deck open), and reply with `block`. */
  const turn = async (
    a: FastifyInstance,
    ls: Array<(e: CoreEvent) => void>,
    chatId: string,
    text: string,
    block: Record<string, unknown> | null,
    o: { projectId?: string; open?: boolean; token?: string } = {},
  ): Promise<string> => {
    expect((await open(a, { chatId, clis: ['claude'], ...(o.projectId !== undefined ? { projectId: o.projectId } : {}) }, o.token)).statusCode).toBe(201);
    const sent = await send(a, chatId, { text, ...(o.open === true ? { context: { artifact: { ref: 'mikes/coverage-deck', version: 1 } } } : {}) }, o.token);
    expect(sent.statusCode, sent.body).toBe(202);
    reply(ls, chatId, block === null ? 'Run 29bbbfb1 measured 23% to 61%.' : make(block));
    return (sent.json() as { turnId: string }).turnId;
  };

  it('A3: a chat proposal\'s failed run is never resumed from its cursor, and a document still being drafted is not retired', async () => {
    const resume = await stub.inject({ method: 'POST', url: '/api/v1/runs/bound-failed/resume' });
    expect(resume.statusCode).toBe(409);
    expect(resume.json()).toMatchObject({ recovery: 'retry', error: expect.stringMatching(/Try again/) });
    const del = await stub.inject({ method: 'DELETE', url: '/api/v1/projects/default/interactive/docs/drafting-doc' });
    expect(del.statusCode).toBe(409);
    expect(del.json()).toMatchObject({ code: 'document_busy', document_id: 'drafting-doc' });
    // The failed attempt's run record is published at boot (its audit entry was missing): the DTO says why it failed.
    const runs = (await stub.inject({ method: 'GET', url: '/api/v1/runs' })).json() as { runs: Array<{ session: { id: string; landing_failed?: { reason: string } } }> };
    expect(runs.runs.find((r) => r.session.id === 'bound-failed')?.session.landing_failed?.reason).toBe('the run failed');
  });

  it('advertises proposals, and in the test configuration every operation with the stub', async () => {
    // A route set with no draft seam (no `launchBoundDraft`): `create` has no real launcher, so production keeps it off
    // and the test configuration stubs it with the rest (A3: `stubOps` names the stubbed kinds).
    expect(((await prod.inject({ method: 'GET', url: '/api/v1/health' })).json() as HealthResponse).capabilities?.chatArtifacts)
      .toEqual({ context: true, proposals: true, create: false, refine: false, theme: false, demo: false });
    expect(((await stub.inject({ method: 'GET', url: '/api/v1/health' })).json() as HealthResponse).capabilities?.chatArtifacts)
      .toEqual({ context: true, proposals: true, create: true, refine: true, theme: true, demo: true, stub: true, stubOps: ['create', 'refine', 'theme', 'demo'] });
  });

  it('production: the seat is told nothing about making, and a block is cut from the reply but makes no card', async () => {
    await turn(prod, prodListeners, 'prod-1', 'Make a 5-slide deck on coverage', { entry: 'presentation', title: 'Coverage', sources: ['chat'] });
    const instructions = (launches.at(-1)!.plan as unknown as { steps: Array<{ instructions: string }> }).steps[0]!.instructions;
    expect(instructions).not.toContain('wicked-make');
    expect(instructions).not.toContain('What this chat can make now');
    // DES-CATALOG-002 §2.3 (u): job proposals are on and this client declared no `accepts: ['job']`: today's flow, with
    // the job commands offered beside it (this chat has no repository, so no PLAN+ line), and nothing about making.
    expect(instructions).toContain('type `<its command>` to start it');
    expect(instructions).not.toMatch(/^\s*PLAN\+ \{/mu);
    await new Promise((r) => setTimeout(r, 100));
    const recs = await records(prod, 'prod-1');
    expect(recs.filter((r) => r.kind === 'proposal')).toEqual([]);
    const seat = recs.find((r) => r.kind === 'seat');
    expect(seat !== undefined && seat.kind === 'seat' ? seat.text : null).toBe('I can make that.');
  });

  it('(DES-CATALOG-002 Lane D) POST /workflows/catalog/detect: a person\'s route, advertised, failing closed without a catalog', async () => {
    const url = '/api/v1/workflows/catalog/detect';
    expect(((await authed.inject({ method: 'GET', url: '/api/v1/health', ...auth('owner-token') })).json() as HealthResponse).capabilities?.detectShape).toBe(true);
    const agent = await authed.inject({ method: 'POST', url, payload: { text: 'fix the login bug please now' }, ...auth('agent-token') });
    expect(agent.statusCode).toBe(403);
    expect(agent.json()).toMatchObject({ code: 'detect_refused' });
    expect((await authed.inject({ method: 'POST', url, payload: { text: '  ' }, ...auth('owner-token') })).statusCode).toBe(400);
    expect((await authed.inject({ method: 'POST', url, payload: { text: 'x', extra: 1 }, ...auth('owner-token') })).statusCode).toBe(400);
    // This harness's engine serves no phase catalog: detection fails closed (it never guesses against a catalog it
    // could not read). The service's answers are covered in tests/detect-service.test.ts.
    const words = await authed.inject({ method: 'POST', url, payload: { text: 'modernize the legacy .NET Framework monolith into microservices on Kubernetes', seat: false }, ...auth('owner-token') });
    expect(words.statusCode, words.body).toBe(503);
    expect(words.json()).toMatchObject({ code: 'catalog_unavailable' });
  });

  it('(Lane D) a reshape names its plan version whole: ord and planRev together, or neither', async () => {
    const out = await authed.inject({ method: 'POST', url: '/api/v1/runs/some-run/reshape', payload: { card: 'bug', requestId: 'r1', planRev: 2 }, ...auth('owner-token') });
    expect(out.statusCode).toBe(400);
    expect(out.body).toMatch(/together/u);
  });

  it('an information-only reply makes no proposal', async () => {
    await turn(stub, stubListeners, 'info-1', 'What did run 29bbbfb1 measure?', null);
    const instructions = (launches.at(-1)!.plan as unknown as { steps: Array<{ instructions: string }> }).steps[0]!.instructions;
    expect(instructions).toContain('```wicked-make');
    // The per-message digest rides after the person's words.
    expect(instructions.indexOf('### What this chat can make now (crew)')).toBeGreaterThan(instructions.indexOf('What did run 29bbbfb1 measure?'));
    await new Promise((r) => setTimeout(r, 100));
    expect((await records(stub, 'info-1')).filter((r) => r.kind === 'proposal')).toEqual([]);
  });

  it('a make ask: crew resolves the card — named run kept, unnamed run and another project’s run struck, helpers, filing', async () => {
    const turnId = await turn(stub, stubListeners, 'make-1', 'Write a release note from runs 29bbbfb1 and 0bad0bad', {
      entry: 'document-static', title: 'Release note', brief: 'what changed',
      sources: ['chat', 'run:29bbbfb1', 'run:679ca85b', 'run:0bad0bad', 'doc:mikes/coverage-deck', 'run:ffffffff', 'nonsense'],
      repos: ['wicked-crew'],
    }, { projectId: 'mikes' });
    const p = await proposalOf(stub, 'make-1');
    expect(p).toMatchObject({
      pid: `make-1:${turnId}`, kind: 'create', seat: 'claude', blocked: null,
      what: { entry: 'document-static', title: 'Release note', label: 'Document · Release note' },
      repos: ['wicked-crew'],
      filedIn: { projectId: 'mikes', label: 'Mikes' },
      stops: 'Stops for you if the check fails. The plan or an escalation may also ask.',
    });
    expect(p.sources).toEqual([
      { token: 'chat', label: 'this conversation', status: 'ok' },
      { token: `run:${RUN_A}`, label: 'run 29bbbfb1 · stopped', status: 'ok', projectId: 'mikes' },
      // Not named: struck as the seat wrote it, without looking it up (nothing of an unnamed run is disclosed).
      { token: 'run:679ca85b', label: 'run 679ca85b', status: 'struck', reason: 'not named in this chat' },
      // Named by the person, but refused by A1's scope check (another project): never in `named`, so struck.
      { token: 'run:0bad0bad', label: 'run 0bad0bad', status: 'struck', reason: 'not named in this chat' },
      { token: 'doc:mikes/coverage-deck', label: 'coverage deck', status: 'struck', reason: 'not open or named in this chat', projectId: 'mikes' },
      { token: 'run:ffffffff', label: 'run ffffffff', status: 'struck', reason: 'not named in this chat' },
      { token: 'nonsense', label: 'nonsense', status: 'struck', reason: 'not a source studio knows' },
    ]);
    expect(p.helpers?.seats).toHaveLength(2);
    expect(p.helpers?.seats[0]).toBe('claude');
    expect(p.helpers?.label).toMatch(/: one writes, the other checks$/);
    expect(p.time?.label).toContain('About 10–20 min');
    expect(p.time?.label).toContain('3 steps');
    // The reply the person sees carries no block.
    const seat = (await records(stub, 'make-1')).find((r) => r.kind === 'seat');
    expect(seat !== undefined && seat.kind === 'seat' ? seat.text : null).toBe('I can make that.');
  });

  it('the open artifact counts as named; a repo outside the scope or an unknown entry blocks Go with the reason', async () => {
    await turn(stub, stubListeners, 'make-2', 'Turn this deck into a web page', { entry: 'document-interactive', sources: ['doc:mikes/coverage-deck'], repos: ['some-other-repo'] }, { projectId: 'mikes', open: true });
    const p = await proposalOf(stub, 'make-2');
    expect(p.sources).toEqual([{ token: 'doc:mikes/coverage-deck', label: 'Coverage deck v1', status: 'ok', projectId: 'mikes' }]);
    expect(p.blocked).toBe("some-other-repo isn't in this chat's scope");
    const pid = p.pid;
    const go = await decide(stub, 'make-2', pid, { decision: 'go' });
    expect(go.statusCode).toBe(409);
    expect(go.json()).toMatchObject({ code: 'proposal_blocked', error: "some-other-repo isn't in this chat's scope" });
    await turn(stub, stubListeners, 'make-3', 'Make me a spreadsheet', { entry: 'spreadsheet', title: 'x' });
    expect((await proposalOf(stub, 'make-3')).blocked).toBe('studio has no job called “spreadsheet”');
  });

  it('a refine of the open deck records its base; a demo address must come from the person', async () => {
    await turn(stub, stubListeners, 'refine-1', 'Make slide 1 a timeline', { refine: 'mikes/coverage-deck', ask: 'a timeline', touches: ['h'] }, { projectId: 'mikes', open: true });
    expect(await proposalOf(stub, 'refine-1')).toMatchObject({ kind: 'refine', target: { ref: 'mikes/coverage-deck', title: 'Coverage deck', base: 1 }, touches: ['h'], blocked: null });
    await turn(stub, stubListeners, 'demo-1', 'Make a demo video of the requirements view', { entry: 'demo-video', url: 'http://localhost:5173/req', audience: 'engineers', show: 'the view' });
    expect((await proposalOf(stub, 'demo-1')).blocked).toBe('The app address must come from you: say it in the chat');
    await turn(stub, stubListeners, 'theme-1', 'A calmer dark theme', { theme: { name: 'Calm night', patch: { theme: 'wicked-dark', accent_h: 210, ambient: false } } });
    expect(await proposalOf(stub, 'theme-1')).toMatchObject({ kind: 'theme', theme: { changes: ['theme', 'accent_h', 'ambient'] }, helpers: null, blocked: null });
  });

  it('Go: a double click, two tabs and a lost response give ONE stub dispatch, recorded accepting then decided', async () => {
    await turn(stub, stubListeners, 'go-1', 'Make a deck on coverage', { entry: 'presentation', title: 'Coverage', sources: ['chat'] });
    const p = await proposalOf(stub, 'go-1');
    const before = stubRows().length;
    const [a, b, c] = await Promise.all([0, 1, 2].map(() => decide(stub, 'go-1', p.pid, { decision: 'go' })));
    for (const r of [a!, b!, c!]) expect(r.statusCode, r.body).toBe(200);
    const views = [a!, b!, c!].map((r) => (r.json() as { view: ChatProposalView }).view);
    expect(new Set(views.map((v) => v.result?.runId))).toEqual(new Set([proposalRunId(p.pid)]));
    expect(views.every((v) => v.state === 'decided' && v.decision === 'go' && v.result?.stub === true)).toBe(true);
    // The lost response: the retry answers the stored result.
    const retry = await decide(stub, 'go-1', p.pid, { decision: 'go' });
    expect(retry.statusCode).toBe(200);
    expect(stubRows().length - before).toBe(1);
    expect(stubRows().at(-1)).toMatchObject({ pid: p.pid, runId: proposalRunId(p.pid) });
    const kinds = (await records(stub, 'go-1')).map((r) => r.kind).filter((k) => k.startsWith('proposal'));
    expect(kinds).toEqual(['proposal', 'proposal_accepting', 'proposal_decided']);
    // A Not now after Go is refused with the decision.
    expect((await decide(stub, 'go-1', p.pid, { decision: 'not_now' })).json()).toMatchObject({ code: 'proposal_decided' });
    // The audit keeps what was accepted (its appends are asynchronous: read until the line lands).
    let audit = '';
    for (let i = 0; i < 50 && !audit.includes('chat.proposal.accepted'); i += 1) {
      await new Promise((r) => setTimeout(r, 40));
      audit = existsSync(join(scratch, 'audit.log')) ? readFileSync(join(scratch, 'audit.log'), 'utf8') : '';
    }
    expect(audit).toContain('chat.proposal.accepted');
  });

  it('a newer proposal supersedes the open one; Not now records the decline and runs no other check', async () => {
    await turn(stub, stubListeners, 'sup-1', 'Make a deck', { entry: 'presentation', title: 'First', sources: ['chat'] });
    const first = await proposalOf(stub, 'sup-1');
    // A newer turn's proposal (written as the resolver writes it).
    const second = { ...first, pid: 'sup-1:t-newer', turnId: 't-newer', what: { ...first.what, title: 'Second' } };
    appendFileSync(join(home, 'chats', 'sup-1.jsonl'), `${JSON.stringify({ at: Date.now(), turnId: 't-newer', kind: 'proposal', proposal: second })}\n`);
    const stale = await decide(stub, 'sup-1', first.pid, { decision: 'go' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'proposal_superseded' });
    // Not now records the decline (the busy and state cases are in chat-proposals-accept.test.ts).
    const declined = await decide(stub, 'sup-1', second.pid, { decision: 'not_now' });
    expect(declined.statusCode).toBe(200);
    expect((declined.json() as { view: ChatProposalView }).view).toMatchObject({ state: 'decided', decision: 'not_now', result: null });
  });

  it('an interrupted Go (accepting, no run) launches once on Go again; accepting with its run is adopted', async () => {
    await turn(stub, stubListeners, 'acc-1', 'Make a deck', { entry: 'presentation', title: 'Acc', sources: ['chat'] });
    const p = await proposalOf(stub, 'acc-1');
    const identity = { artifactRef: `_unfiled/acc-x`, runId: proposalRunId(p.pid) };
    appendFileSync(join(home, 'chats', 'acc-1.jsonl'), `${JSON.stringify({ at: Date.now(), turnId: p.turnId, kind: 'proposal_accepting', pid: p.pid, actor: 'local', edits: null, resolution: p, identity })}\n`);
    const before = stubRows().length;
    const go = await decide(stub, 'acc-1', p.pid, { decision: 'go' });
    expect(go.statusCode, go.body).toBe(200);
    expect((go.json() as { view: ChatProposalView }).view.result).toMatchObject({ runId: identity.runId, artifactRef: '_unfiled/acc-x', adopted: false });
    expect(stubRows().length - before).toBe(1);

    // Crash after the launch and before the decision: the run is found and adopted, nothing starts again.
    await turn(stub, stubListeners, 'acc-2', 'Make a deck', { entry: 'presentation', title: 'Acc2', sources: ['chat'] });
    const q = await proposalOf(stub, 'acc-2');
    const id2 = { artifactRef: '_unfiled/acc-y', runId: proposalRunId(q.pid) };
    appendFileSync(join(home, 'chats', 'acc-2.jsonl'), `${JSON.stringify({ at: Date.now(), turnId: q.turnId, kind: 'proposal_accepting', pid: q.pid, actor: 'local', edits: null, resolution: q, identity: id2 })}\n`);
    appendFileSync(join(home, 'chats', 'proposal-stub', 'dispatches.ndjson'), `${JSON.stringify({ at: Date.now(), kind: 'create', pid: q.pid, chatId: 'acc-2', runId: id2.runId, artifactRef: id2.artifactRef, actor: 'local', title: 'Acc2' })}\n`);
    const n = stubRows().length;
    const adopted = await decide(stub, 'acc-2', q.pid, { decision: 'go' });
    expect(adopted.statusCode).toBe(200);
    expect((adopted.json() as { view: ChatProposalView }).view.result).toMatchObject({ adopted: true });
    expect(stubRows().length).toBe(n);
  });

  it('A5: a change says the sources it cannot use yet instead of showing them as used', async () => {
    await turn(stub, stubListeners, 'src-1', `Use run ${RUN_A} to fix slide 1`, { refine: 'mikes/coverage-deck', ask: 'fix slide 1', sources: [`run:${RUN_A}`] }, { projectId: 'mikes', open: true });
    const p = await proposalOf(stub, 'src-1');
    expect(p.sources.every((s) => s.status === 'struck')).toBe(true);
    expect(p.sources[0]?.reason).toContain('a change works from the document and your words');
  });

  it('A5: only the person releases a protected edit, and only one the card shows (an unknown id is refused)', async () => {
    await turn(stub, stubListeners, 'allow-1', 'Retitle slide 1', { refine: 'mikes/coverage-deck', ask: 'retitle', touches: ['h'] }, { projectId: 'mikes', open: true });
    const p = await proposalOf(stub, 'allow-1');
    const refused = await decide(stub, 'allow-1', p.pid, { decision: 'go', edits: { allow: ['text:h#00000000'] } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ code: 'edits_invalid', error: 'only edits shown on this card can be let change; check the card again' });
  });

  it('a refine whose document moved re-resolves instead of starting', async () => {
    await turn(stub, stubListeners, 'moved-1', 'Retitle slide 1', { refine: 'mikes/coverage-deck', ask: 'retitle' }, { projectId: 'mikes', open: true });
    const p = await proposalOf(stub, 'moved-1');
    const mikes = ensureProjectInteractiveRoot('mikes', undefined, process.env, home);
    writeFileSync(join(mikes, 'coverage-deck', '_v2.html'), DECK);
    writeFileSync(join(mikes, 'coverage-deck', 'versions.json'), JSON.stringify({ head: 2, versions: [{ version: 1 }, { version: 2 }] }));
    const before = stubRows().length;
    try {
      const go = await decide(stub, 'moved-1', p.pid, { decision: 'go' });
      expect(go.statusCode).toBe(409);
      expect(go.json()).toMatchObject({ code: 'proposal_reresolved', view: { state: 'open', proposal: { target: { base: 2 } } } });
      expect(stubRows().length).toBe(before);
      // The next Go uses the new base.
      expect((await decide(stub, 'moved-1', p.pid, { decision: 'go' })).statusCode).toBe(200);
      expect(stubRows().length - before).toBe(1);
    } finally {
      writeFileSync(join(mikes, 'coverage-deck', 'versions.json'), JSON.stringify({ head: 1, versions: [{ version: 1 }] }));
    }
  });

  it('edits are re-checked: a person-added source is scope-checked, helpers stay two distinct seats, out-of-slice fields are refused', async () => {
    await turn(stub, stubListeners, 'edit-1', 'Make a deck', { entry: 'presentation', title: 'Edit', sources: ['chat'] }, { projectId: 'mikes' });
    const p = await proposalOf(stub, 'edit-1');
    expect((await decide(stub, 'edit-1', p.pid, { decision: 'go', edits: { helpers: ['claude', 'claude'] } })).json()).toMatchObject({ code: 'edits_invalid' });
    expect((await decide(stub, 'edit-1', p.pid, { decision: 'go', edits: { project: 'other' } })).json()).toMatchObject({ code: 'edits_invalid' });
    expect((await decide(stub, 'edit-1', p.pid, { decision: 'go', edits: { title: '' } })).json()).toMatchObject({ code: 'edits_invalid' });
    // Added by the person now: named by them, but still checked against the chat's project — and said back, never dropped.
    const refused = await decide(stub, 'edit-1', p.pid, { decision: 'go', edits: { title: 'Edited', sources: ['chat', `run:${RUN_OTHER}`] } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ code: 'edits_invalid', error: "run 0bad0bad: not in this chat's project" });
    const go = await decide(stub, 'edit-1', p.pid, { decision: 'go', edits: { title: 'Edited', sources: ['chat', `run:${RUN_A}`] } });
    expect(go.statusCode, go.body).toBe(200);
    const resolution = (await records(stub, 'edit-1')).find((r) => r.kind === 'proposal_accepting');
    expect(resolution !== undefined && resolution.kind === 'proposal_accepting' ? resolution.resolution : null).toMatchObject({
      what: { title: 'Edited', label: 'Slides · Edited' },
      sources: [{ token: 'chat', status: 'ok' }, { token: `run:${RUN_A}`, status: 'ok', projectId: 'mikes' }],
    });
  });

  it('only a person and only the chat’s owner: a worker gets 403 even on an accepting proposal; another person 404', async () => {
    await turn(authed, authedListeners, 'own-1', 'Make a deck', { entry: 'presentation', title: 'Own', sources: ['chat'] }, { token: 'owner-token' });
    const p = await proposalOf(authed, 'own-1', 'owner-token');
    appendFileSync(join(home, 'chats', 'own-1.jsonl'), `${JSON.stringify({ at: Date.now(), turnId: p.turnId, kind: 'proposal_accepting', pid: p.pid, actor: 'maria', edits: null, resolution: p, identity: { artifactRef: '_unfiled/own-x', runId: proposalRunId(p.pid) } })}\n`);
    const before = stubRows().length;
    for (const decision of ['go', 'not_now']) {
      const worker = await decide(authed, 'own-1', p.pid, { decision }, 'agent-token');
      expect(worker.statusCode).toBe(403);
      expect(worker.json()).toMatchObject({ code: 'proposal_refused' });
    }
    expect((await decide(authed, 'own-1', p.pid, { decision: 'go' }, 'other-token')).statusCode).toBe(404);
    expect(stubRows().length).toBe(before);
    expect((await decide(authed, 'own-1', p.pid, { decision: 'go' }, 'owner-token')).statusCode).toBe(200);
    expect(stubRows().length - before).toBe(1);
  });

  it('an ended chat’s open proposal stays answerable from its card (records go to the kept copy)', async () => {
    await turn(stub, stubListeners, 'closed-1', 'Make a deck', { entry: 'presentation', title: 'Closed', sources: ['chat'] });
    const p = await proposalOf(stub, 'closed-1');
    expect((await stub.inject({ method: 'POST', url: '/api/v1/chats/closed-1/close' })).statusCode).toBe(200);
    const go = await decide(stub, 'closed-1', p.pid, { decision: 'go' });
    expect(go.statusCode, go.body).toBe(200);
    const kinds = (await records(stub, 'closed-1')).map((r) => r.kind).filter((k) => k.startsWith('proposal'));
    expect(kinds).toEqual(['proposal', 'proposal_accepting', 'proposal_decided']);
  });

  it('a 64-character chat id makes a proposal id past Fastify’s default limit, and it is still answered', async () => {
    const long = `c${'x'.repeat(63)}`;
    await turn(stub, stubListeners, long, 'Make a deck', { entry: 'presentation', title: 'Long', sources: ['chat'] });
    const p = await proposalOf(stub, long);
    expect(p.pid.length).toBeGreaterThan(100);
    expect((await decide(stub, long, p.pid, { decision: 'not_now' })).statusCode).toBe(200);
  });

  it('refuses an unknown proposal, a bad body, and an unknown chat', async () => {
    await turn(stub, stubListeners, 'bad-1', 'hi', null);
    expect((await decide(stub, 'bad-1', 'bad-1:nope', { decision: 'go' })).statusCode).toBe(404);
    expect((await decide(stub, 'bad-1', 'bad-1:nope', { decision: 'maybe' })).statusCode).toBe(400);
    expect((await decide(stub, 'no-such-chat', 'x', { decision: 'go' })).statusCode).toBe(404);
  });
});
