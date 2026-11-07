// DES-CHAT-ARTIFACTS-001 §5.1/§6.3/§14 (slice A1), through the REAL server assembly over a fake engine: the
// capability, the strict `context` field, the per-turn block in the instructions the seat gets, the copies and briefs
// the seat can actually read inside its run's read roots, the `context` transcript record, the owner check, and
// `POST /chats {seedFromArtifact}`. The fake seat reads every absolute path its instructions name, and refuses one
// outside the run's read roots — the bytes a real seat could reach.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ChatMessagesResponse, HealthResponse } from 'wicked-crew-api-types';

import { createServer } from '../src/api/server.js';
import { beneathTestHooks } from '../src/api/beneath.js';
import { tokenHash } from '../src/api/auth.js';
import { ensureProjectInteractiveRoot } from '../src/interactive/bridge-root.js';
import { crewStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, LaunchRunInput, SessionView } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

const armedStateHome = crewStateHome();
const DECK = `<html><head><title>Coverage deck</title></head><body>
<section class="wi-slide" data-wid="section-0" data-slide-id="a"><h2 data-wid="slide-0-heading-1">Intro</h2></section>
<section class="wi-slide" data-wid="section-1" data-slide-id="b"><h2 data-wid="slide-1-heading-1">Runs</h2></section>
<section class="wi-slide" data-wid="section-2" data-slide-id="c"><h2 data-wid="slide-2-heading-1">Change</h2></section>
<section class="wi-slide" data-wid="section-3" data-slide-id="d"><h2 data-wid="slide-3-heading-1">Timeline</h2><p data-wid="slide-3-paragraph-1">23% to 61% in 29bbbfb1</p></section>
</body></html>`;
const RUN_A = '29bbbfb1-1111-4000-8000-000000000001';
const RUN_OTHER = '0bad0bad-4444-4000-8000-000000000004';

function runView(id: string, projectOutput: string): SessionView {
  return {
    session: { id, workflow_id: 'wf', problem: `measure ${projectOutput}`, status: 'completed', repo_ref: null, clis: [], unit_ix: 0, attempt: 0, workdir: null, extra_write_roots: [], archived_at: null, archive_note: null, entity_mode: 'none', collection_scope: null, human_confirm: 'none' },
    units: [{ id: `${id}:u1`, session_id: id, ord: 1, description: 'measure', stage: 'build', assigned_cli: 'codex', status: 'done', denial_reason: null }],
  } as unknown as SessionView;
}

describe('chat sees artifacts and runs (server, A1)', () => {
  let scratch: string;
  let home: string;
  let app: FastifyInstance;
  let authed: FastifyInstance;
  const launches: LaunchRunInput[] = [];
  const seatRead = new Map<string, string>();
  const outputs = new Map<string, string>([[`${RUN_A}:u1`, 'Coverage moved from 23% to 61%.'], [`${RUN_OTHER}:u1`, 'OTHER PROJECT 99%']]);
  const pathRuns: string[] = [];
  /** When set, every unit-output read waits for it: a message's context is still being prepared. */
  let holdOutputs: Promise<void> | null = null;
  /** Resolved when an output read reaches the hold (the preparation is provably inside its await). */
  let entered: (() => void) | null = null;
  let repos: Array<{ id: string; name: string; root_path: string; default_branch: string; registered_at: number }> = [];

  const makeAdapter = (): CoreAdapter => ({
    dbPath: join(home, 'core.db'),
    projectsSupported: () => true,
    getSettings: async () => ({}),
    ping: async () => 'ok',
    onLaunch: (): (() => void) => () => undefined,
    onEvent: (): (() => void) => () => undefined,
    listRepos: async () => repos,
    projectGet: async (id: string) => (['mikes', 'other'].includes(id) ? { id, name: id, status: 'active', description: null, scope: `project:${id}`, created_at: 1, updated_at: 1 } : null),
    projectList: async () => [{ id: 'mikes' }, { id: 'other' }],
    // The runs' projects come from their `crew.run` memberships (the index the run DTO's `project_id` reads).
    projectMembers: async (id: string) =>
      id === 'mikes'
        ? [{ member_kind: 'crew.run', member_ref: RUN_A }, ...repos.map((r) => ({ member_kind: 'crew.repo', member_ref: r.id }))]
        : id === 'other' ? [{ member_kind: 'crew.run', member_ref: RUN_OTHER }] : [],
    projectMemberAttach: async () => ({ member: { id: 'm1', attached_at: 1 }, created: false }),
    projectMemberDetach: async () => true,
    // The fake seat: reads each absolute path its instructions name, from inside the run's read roots only.
    launchRun: async (input: LaunchRunInput) => {
      launches.push(input);
      const step = (input.plan as unknown as { steps: Array<{ instructions: string }> }).steps[0]!;
      const roots = input.extraReadRoots ?? [];
      for (const m of step.instructions.matchAll(/(\/\S+\.(?:html|md))\b/g)) {
        const path = m[1]!;
        if (!roots.some((r) => path.startsWith(`${r}/`))) continue; // a repo path in the statement, not a turn file
        seatRead.set(path, readFileSync(path, 'utf8'));
      }
      const id = `path-run-${launches.length}`;
      pathRuns.push(id);
      return id;
    },
    sessionsDetail: async () => [
      ...pathRuns.map((id) => ({ session: { id, status: 'awaiting_human', repo_ref: null, problem: 'chat', workflow_id: 'ask', extra_write_roots: [] }, units: [] })),
      runView(RUN_A, 'mikes'),
      runView(RUN_OTHER, 'other'),
    ],
    workOutput: async (unitId: string) => {
      if (holdOutputs !== null) {
        entered?.();
        await holdOutputs;
      }
      return outputs.get(unitId) ?? null;
    },
    proposePlan: async () => ({ ok: true }),
    confirmGate: async () => 'awaiting_human',
    cancelRun: async () => 'cancelled',
    chatClose: async () => undefined,
    chatList: async () => [],
    onboardedRepoOf: () => undefined,
    // crew#1412: the requirements read of the one mapped repository (`r-req`); any other has none.
    getRequirementsGraphForRepo: async (id: string) => {
      if (id !== 'r-req') return { graph: null, coverage: null };
      const cov = { real_pct: 100, min_pct: 80, behavior_bearing: 3, real: 3, placeholders: 0, unmapped: 0, not_product: 5 };
      const req = (title: string, statement: string) => ({ title, status: 'active', business_rules: [{ id: 'RULE-1', statement, confidence: 0.9 }] });
      return {
        graph: { metadata: { coverage: cov }, domains: { src: { requirements: { 'REQ-001': req('clamp', 'clamp holds n in [lo, hi]'), 'REQ-002': req('mean', 'mean is the sum over the count'), 'REQ-003': req('sum', 'sum includes every element') } } } },
        coverage: cov,
        rows: { src: { 'REQ-001': { real: true, uncounted: null, code_mismatch: null }, 'REQ-002': { real: true, uncounted: null, code_mismatch: 'inherits sum’s skip' }, 'REQ-003': { real: true, uncounted: null, code_mismatch: 'the loop starts at index 1' } } },
        build: { generation: 1, coverage: cov },
        code: { built_from: { commit: '8cc32aabde358bf81042ed116623a51c0ef03a96', at: null, basis: 'build' }, head: '1111111111111111111111111111111111111111', commits_behind: 1 },
        target: { repo: null, daemon: 80 },
      };
    },
  }) as unknown as CoreAdapter;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'chat-artifacts-route-'));
    home = join(scratch, 'state-home');
    mkdirSync(home);
    setCrewStateHome(home);
    const tokens = join(scratch, 'tokens.json');
    writeFileSync(tokens, JSON.stringify({
      tokens: [
        { sha256: tokenHash('owner-token'), actor: { id: 'maria', kind: 'human', trust: 'operator' } },
        { sha256: tokenHash('other-token'), actor: { id: 'sam', kind: 'human', trust: 'operator' } },
        { sha256: tokenHash('agent-token'), actor: { id: 'ci', kind: 'agent', trust: 'operator' } },
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
    app = await createServer(makeAdapter(), { ...opts, auth: { mode: 'off' }, auditPath: join(scratch, 'audit.log') });
    await app.ready();
    authed = await createServer(makeAdapter(), { ...opts, auth: { mode: 'required', tokensPath: tokens }, auditPath: join(scratch, 'audit-authed.log') });
    await authed.ready();
    const mikes = ensureProjectInteractiveRoot('mikes', undefined, process.env, home);
    const deck = join(mikes, 'coverage-deck');
    mkdirSync(deck, { recursive: true });
    writeFileSync(join(deck, '_v1.html'), DECK);
    writeFileSync(join(deck, '_v2.html'), DECK.replace('Intro', 'Introduction'));
    writeFileSync(join(deck, 'versions.json'), JSON.stringify({ head: 2, versions: [{ version: 1, html_file: '_v1.html' }, { version: 2, html_file: '_v2.html' }] }));
    const other = ensureProjectInteractiveRoot('other', undefined, process.env, home);
    mkdirSync(join(other, 'their-deck'), { recursive: true });
    writeFileSync(join(other, 'their-deck', '_v1.html'), '<h1>THEIRS</h1>');
    writeFileSync(join(other, 'their-deck', 'versions.json'), JSON.stringify({ head: 1, versions: [{ version: 1 }] }));
    const unfiled = ensureProjectInteractiveRoot(undefined, undefined, process.env, home);
    mkdirSync(join(unfiled, 'release-note'), { recursive: true });
    writeFileSync(join(unfiled, 'release-note', '_v1.html'), '<h1>Release note</h1>');
    writeFileSync(join(unfiled, 'release-note', 'versions.json'), JSON.stringify({ head: 1, versions: [{ version: 1 }] }));
    writeFileSync(join(unfiled, 'release-note', 'crew-grounding.json'), JSON.stringify({ project_id: 'default', repo_refs: ['r-crew'], recorded_at: new Date().toISOString() }));
  }, 150_000);

  afterAll(async () => {
    await app.close();
    await authed.close();
    setCrewStateHome(armedStateHome);
    removeScratch(scratch);
  });

  const open = async (a: FastifyInstance, body: Record<string, unknown>, token?: string) =>
    a.inject({ method: 'POST', url: '/api/v1/chats', payload: body, ...(token !== undefined ? { headers: { authorization: `Bearer ${token}` } } : {}) });
  const send = async (a: FastifyInstance, chatId: string, body: Record<string, unknown>, token?: string) =>
    a.inject({ method: 'POST', url: `/api/v1/chats/${chatId}/messages`, payload: body, ...(token !== undefined ? { headers: { authorization: `Bearer ${token}` } } : {}) });

  it('advertises chatArtifacts with context (and A2 proposals) on, every operation off', async () => {
    const health = (await app.inject({ method: 'GET', url: '/api/v1/health' })).json() as HealthResponse;
    expect(health.capabilities?.chatArtifacts).toEqual({ context: true, proposals: true, create: false, refine: false, theme: false, demo: false });
  });

  it('a platform that cannot open beneath a root still chats: no turn read roots, the artifact refused with the reason, a seed answers 501', async () => {
    beneathTestHooks.mode = 'unsupported';
    try {
      const before = launches.length;
      expect((await open(app, { chatId: 'unsup-1', projectId: 'mikes', clis: ['claude'] })).statusCode).toBe(201);
      const res = await send(app, 'unsup-1', { text: 'what is this?', context: { artifact: { ref: 'mikes/coverage-deck', version: 1 } } });
      expect(res.statusCode).toBe(202);
      expect(launches.length).toBe(before + 1);
      const input = launches.at(-1)!;
      expect((input.extraReadRoots ?? []).some((r) => r.endsWith('/open') || r.endsWith('/context'))).toBe(false);
      const msgs = (await app.inject({ method: 'GET', url: '/api/v1/chats/unsup-1/messages' })).json() as ChatMessagesResponse;
      expect(msgs.messages.find((m) => m.kind === 'context')).toMatchObject({ refused: [{ token: 'doc:mikes/coverage-deck', reason: expect.stringMatching(/cannot read files without following links/) }] });
      const seed = await open(app, { chatId: 'unsup-2', clis: ['claude'], seedFromArtifact: 'mikes/coverage-deck' });
      expect(seed.statusCode).toBe(501);
      expect(seed.json()).toMatchObject({ code: 'seed_unsupported' });
    } finally {
      delete beneathTestHooks.mode;
    }
  });

  it('a document at version 0 is a document: context at version 0 is sent and copied, and a chat can be seeded from it (crew#1273)', async () => {
    const mikes = ensureProjectInteractiveRoot('mikes', undefined, process.env, home);
    mkdirSync(join(mikes, 'first-draft'), { recursive: true });
    writeFileSync(join(mikes, 'first-draft', '_v0.html'), '<h1>No draft yet</h1><p>first</p>');
    writeFileSync(join(mikes, 'first-draft', 'versions.json'), JSON.stringify({ head: 0, versions: [{ version: 0, html_file: '_v0.html' }] }));
    const opened = await open(app, { chatId: 'v0-1', projectId: 'mikes', clis: ['claude'] });
    expect(opened.statusCode).toBe(201);
    const res = await send(app, 'v0-1', { text: 'what is this?', context: { artifact: { ref: 'mikes/first-draft', version: 0 } } });
    expect(res.statusCode).toBe(202);
    const msgs = (await app.inject({ method: 'GET', url: '/api/v1/chats/v0-1/messages' })).json() as ChatMessagesResponse;
    expect(msgs.messages.find((m) => m.kind === 'context')).toMatchObject({ artifact: { ref: 'mikes/first-draft', viewed: 0, head: 0, copies: ['open/mikes__first-draft-v0.html'] } });
    const seeded = await open(app, { chatId: 'v0-2', projectId: 'mikes', clis: ['claude'], seedFromArtifact: 'mikes/first-draft' });
    expect(seeded.statusCode).toBe(201);
  });

  it('refuses a context that is not the contract: unknown keys, a bad ref, too many anchors', async () => {
    const before = launches.length;
    const opened = await open(app, { chatId: 'strict-1', projectId: 'mikes', clis: ['claude'] });
    expect(opened.statusCode).toBe(201);
    for (const context of [
      { artifact: { ref: 'mikes/coverage-deck', version: 1 }, extra: true },
      { artifact: { ref: '../etc/passwd', version: 1 } },
      { artifact: { ref: 'mikes/coverage-deck', version: -1 } },
      { artifact: { ref: 'mikes/coverage-deck', version: 1, anchors: Array.from({ length: 17 }, (_, i) => `a${i}`) } },
      { artifact: { ref: 'mikes/coverage-deck', version: 1, anchors: ['bad wid'] } },
    ]) {
      const res = await send(app, 'strict-1', { text: 'hi', context });
      expect(res.statusCode, JSON.stringify(context)).toBe(400);
    }
    expect(launches).toHaveLength(before);
  });

  it('hands the seat the open deck (both versions), the outline and the named run, inside its read roots, and records the turn', async () => {
    const opened = await open(app, { chatId: 'deck-1', projectId: 'mikes', clis: ['claude'] });
    expect(opened.statusCode).toBe(201);
    const res = await send(app, 'deck-1', {
      text: 'What does slide 4 say, and what did run 29bbbfb1 measure?',
      context: { artifact: { ref: 'mikes/coverage-deck', version: 1, anchors: ['slide-3-heading-1'] }, page: 'where: Made (/projects/mikes/made)' },
    });
    expect(res.statusCode).toBe(202);
    const input = launches.at(-1)!;
    const instructions = (input.plan as unknown as { steps: Array<{ instructions: string }> }).steps[0]!.instructions;
    expect(instructions).toContain('What does slide 4 say, and what did run 29bbbfb1 measure?');
    expect(instructions).toMatch(/Slide 4 \[data-wid section-3\]: Timeline 23% to 61% in 29bbbfb1/);
    expect(instructions).toContain('Coverage moved from 23% to 61%.');
    expect(instructions).toContain("Studio's summary of the page they are on");
    // The seat is handed real paths (a container sees a read root only at its canonical path).
    const cwd = realpathSync(JSON.parse(opened.body).scope.cwd as string);
    expect(input.extraReadRoots).toEqual(expect.arrayContaining([join(cwd, 'open'), join(cwd, 'context')]));
    // The seat could read each turn file it was handed.
    expect(seatRead.get(join(cwd, 'open', 'mikes__coverage-deck-v1.html'))).toBe(DECK);
    expect(seatRead.get(join(cwd, 'open', 'mikes__coverage-deck-v2.html'))).toContain('Introduction');
    const brief = [...seatRead.keys()].find((k) => k.startsWith(join(cwd, 'context', `run-${RUN_A}-`)));
    expect(brief).toMatch(/-[0-9a-f]{8}\.md$/);
    expect(seatRead.get(brief!)).toContain('Coverage moved from 23% to 61%.');
    // The transcript: the person's words only, then what the turn was given.
    const msgs = (await app.inject({ method: 'GET', url: '/api/v1/chats/deck-1/messages' })).json() as ChatMessagesResponse;
    const user = msgs.messages.find((m) => m.kind === 'user');
    expect(user && 'text' in user ? user.text : null).toBe('What does slide 4 say, and what did run 29bbbfb1 measure?');
    const ctx = msgs.messages.find((m) => m.kind === 'context');
    expect(ctx).toMatchObject({
      kind: 'context',
      turnId: user?.turnId,
      artifact: { ref: 'mikes/coverage-deck', viewed: 1, head: 2, copies: ['open/mikes__coverage-deck-v1.html', 'open/mikes__coverage-deck-v2.html'], anchors: ['slide-3-heading-1'] },
      runs: [{ id: RUN_A, status: 'completed', brief: expect.stringMatching(new RegExp(`^context/run-${RUN_A}-[0-9a-f]{8}\\.md$`)) }],
      refused: [],
      page: true,
    });
  });

  it('a repo chat’s seat reads the repository’s requirements map: REQ ids, statements, mismatches, STALE (crew#1412)', async () => {
    const root = join(scratch, 'repo-req');
    mkdirSync(join(root, '.codegraph'), { recursive: true });
    writeFileSync(join(root, '.codegraph', 'estate.db'), '');
    repos = [{ id: 'r-req', name: 'reqgraph-tm', root_path: root, default_branch: 'main', registered_at: 1, code_graph_db: join(root, '.codegraph', 'estate.db') } as (typeof repos)[number]];
    try {
      const opened = await open(app, { chatId: 'req-1', clis: ['claude'], repoRefs: ['r-req'] });
      expect(opened.statusCode).toBe(201);
      const res = await send(app, 'req-1', { text: 'What does reqgraph-tm require, and which requirements does its code not meet?' });
      expect(res.statusCode).toBe(202);
      const input = launches.at(-1)!;
      const instructions = (input.plan as unknown as { steps: Array<{ instructions: string }> }).steps[0]!.instructions;
      expect(instructions).toContain('### Requirements maps');
      const cwd = realpathSync(JSON.parse(opened.body).scope.cwd as string);
      expect(input.extraReadRoots).toEqual(expect.arrayContaining([join(cwd, 'requirements')]));
      // The seat could read the map it was handed, inside its read roots.
      const map = [...seatRead.keys()].find((k) => k.startsWith(join(cwd, 'requirements', 'r-req.')));
      expect(map).toMatch(/\.[0-9a-f]{12}\.md$/);
      const text = seatRead.get(map!)!;
      for (const id of ['REQ-001', 'REQ-002', 'REQ-003']) expect(text).toContain(id);
      expect(text).toContain('Code does not meet it: the loop starts at index 1');
      expect(text).toContain('Code does not meet it: inherits sum’s skip');
      expect(text).toContain('STALE');
    } finally {
      repos = [];
    }
  });

  it('refuses another project’s run and document in a project chat: nothing of them reaches the seat', async () => {
    expect((await open(app, { chatId: 'scope-1', projectId: 'mikes', clis: ['claude'] })).statusCode).toBe(201);
    const res = await send(app, 'scope-1', { text: 'Summarise run 0bad0bad', context: { artifact: { ref: 'other/their-deck', version: 1 } } });
    expect(res.statusCode).toBe(202);
    const instructions = (launches.at(-1)!.plan as unknown as { steps: Array<{ instructions: string }> }).steps[0]!.instructions;
    expect(instructions).not.toContain('OTHER PROJECT 99%');
    expect(instructions).not.toContain('THEIRS');
    expect(instructions).toContain(`run:${RUN_OTHER}: it is in project other, not in this chat's project (mikes)`);
    expect(instructions).toContain("doc:other/their-deck: it is not in this chat's project (mikes)");
  });

  it('a message whose chat is closed and reopened while its context is prepared writes nothing into the new chat', async () => {
    const first = await open(app, { chatId: 'race-1', projectId: 'mikes', clis: ['claude'] });
    expect(first.statusCode).toBe(201);
    const cwd = JSON.parse(first.body).scope.cwd as string;
    let release!: () => void;
    holdOutputs = new Promise<void>((r) => { release = r; });
    const before = launches.length;
    const reached = new Promise<void>((r) => { entered = r; });
    const sent = send(app, 'race-1', { text: 'what did run 29bbbfb1 measure?', context: { artifact: { ref: 'mikes/coverage-deck', version: 1 } } });
    // The message is now waiting on the run's output, inside its preparation.
    await reached;
    entered = null;
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/chats/race-1' })).statusCode).toBe(200);
    let reopened = await open(app, { chatId: 'race-1', projectId: 'mikes', clis: ['claude'] });
    for (let i = 0; i < 40 && reopened.statusCode === 409; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      reopened = await open(app, { chatId: 'race-1', projectId: 'mikes', clis: ['claude'] });
    }
    expect(reopened.statusCode).toBe(201);
    holdOutputs = null;
    release();
    const res = await sent;
    expect(res.statusCode).toBe(409);
    expect(launches.length).toBe(before);
    // The new chat's scratch root holds its own statement and nothing the old message prepared.
    expect(readdirSync(cwd).filter((n) => n === 'open' || n === 'context').flatMap((d) => readdirSync(join(cwd, d)))).toEqual([]);
  });

  it('refuses context from someone who does not own the chat, and from an agent; the owner is served', async () => {
    expect((await open(authed, { chatId: 'own-1', clis: ['claude'] }, 'owner-token')).statusCode).toBe(201);
    const ctx = { artifact: { ref: 'mikes/coverage-deck', version: 2 } };
    const before = launches.length;
    const other = await send(authed, 'own-1', { text: 'what is this?', context: ctx }, 'other-token');
    expect(other.statusCode).toBe(403);
    expect(other.json()).toMatchObject({ code: 'chat_context_refused' });
    const agent = await send(authed, 'own-1', { text: 'what is this?', context: ctx }, 'agent-token');
    expect(agent.statusCode).toBe(403);
    expect(launches.length).toBe(before);
    const owner = await send(authed, 'own-1', { text: 'what is this?', context: ctx }, 'owner-token');
    expect(owner.statusCode).toBe(202);
    expect((launches.at(-1)!.plan as unknown as { steps: Array<{ instructions: string }> }).steps[0]!.instructions).toContain('Coverage deck');
  });

  it('seeds an Ask-about-this chat from the document’s binding, and refuses a seed outside the chat’s project', async () => {
    repos = [{ id: 'r-crew', name: 'wicked-crew', root_path: join(scratch, 'repo-crew'), default_branch: 'main', registered_at: 1 }];
    mkdirSync(join(scratch, 'repo-crew'), { recursive: true });
    const seeded = await open(app, { chatId: 'seed-1', clis: ['claude'], seedFromArtifact: '_unfiled/release-note' });
    expect(seeded.statusCode).toBe(201);
    expect(JSON.parse(seeded.body).scope.repos.map((r: { id: string }) => r.id)).toEqual(['r-crew']);
    const missing = await open(app, { chatId: 'seed-2', clis: ['claude'], seedFromArtifact: 'mikes/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'seed_not_found' });
    const wrongProject = await open(app, { chatId: 'seed-3', projectId: 'mikes', clis: ['claude'], seedFromArtifact: 'other/their-deck' });
    expect(wrongProject.statusCode).toBe(400);
    expect(wrongProject.json()).toMatchObject({ code: 'seed_out_of_scope' });
    const sameProject = await open(app, { chatId: 'seed-4', projectId: 'mikes', clis: ['claude'], seedFromArtifact: 'mikes/coverage-deck' });
    expect(sameProject.statusCode).toBe(201);
    const bad = await open(app, { chatId: 'seed-5', clis: ['claude'], seedFromArtifact: '../x/y' });
    expect(bad.statusCode).toBe(400);
    // Scope before any read: another project's document is refused for the project chat whether or not it exists.
    const missingElsewhere = await open(app, { chatId: 'seed-6', projectId: 'mikes', clis: ['claude'], seedFromArtifact: 'other/no-such-doc' });
    expect(missingElsewhere.statusCode).toBe(400);
    expect(missingElsewhere.json()).toMatchObject({ code: 'seed_out_of_scope' });
    repos = [];
  });

  it('seeds from the repositories the draft was grounded on, opens a seed over the copy cap, and refuses an agent', async () => {
    const unfiled = ensureProjectInteractiveRoot(undefined, undefined, process.env, home);
    repos = [{ id: 'r-alpha', name: 'alpha', root_path: join(scratch, 'repo-alpha'), default_branch: 'main', registered_at: 1 }];
    mkdirSync(repos[0]!.root_path, { recursive: true });
    mkdirSync(join(unfiled, 'inferred'), { recursive: true });
    writeFileSync(join(unfiled, 'inferred', '_v1.html'), `<h1>big</h1>${'x'.repeat(2 * 1024 * 1024 + 10)}`);
    writeFileSync(join(unfiled, 'inferred', 'versions.json'), JSON.stringify({ head: 1, versions: [{ version: 1 }] }));
    // The create named no repository; the draft launch inferred one from the brief.
    writeFileSync(join(unfiled, 'inferred', 'crew-grounding.json'), JSON.stringify({ project_id: 'default', repo_refs: [], grounding: { repo_refs: ['r-alpha'], source: 'brief', skipped: [], member_count: 0 }, recorded_at: new Date().toISOString() }));
    const seeded = await open(app, { chatId: 'seed-g1', clis: ['claude'], seedFromArtifact: '_unfiled/inferred', scopeKind: 'repos' });
    expect(seeded.statusCode).toBe(201);
    expect(JSON.parse(seeded.body).scope.repos.map((r: { id: string }) => r.id)).toEqual(['r-alpha']);
    expect((await open(authed, { chatId: 'seed-g2', clis: ['claude'], seedFromArtifact: '_unfiled/inferred' }, 'agent-token')).json()).toMatchObject({ code: 'seed_refused' });
    expect((await open(app, { chatId: 'seed-g3', clis: ['claude'], seedFromArtifact: '' })).json()).toMatchObject({ code: 'seed_invalid' });
    repos = [];
  });

  it('a seed keeps the repositories the draft was grounded on: an inferred one outside the project is refused, too many or an unreadable binding is said', async () => {
    const mikes = ensureProjectInteractiveRoot('mikes', undefined, process.env, home);
    repos = [{ id: 'r-in', name: 'alpha', root_path: join(scratch, 'repo-in'), default_branch: 'main', registered_at: 1 }];
    mkdirSync(repos[0]!.root_path, { recursive: true });
    const doc = (name: string, sidecar: unknown): void => {
      mkdirSync(join(mikes, name), { recursive: true });
      writeFileSync(join(mikes, name, '_v1.html'), '<h1>x</h1>');
      writeFileSync(join(mikes, name, 'versions.json'), JSON.stringify({ head: 1, versions: [{ version: 1 }] }));
      writeFileSync(join(mikes, name, 'crew-grounding.json'), JSON.stringify(sidecar));
    };
    // Inferred from the brief (the create named none): one of them has since left the project.
    doc('inferred-out', { project_id: 'mikes', repo_refs: [], grounding: { repo_refs: ['r-in', 'r-gone'], source: 'brief', skipped: [], member_count: 2 } });
    expect((await open(app, { chatId: 'seed-i1', projectId: 'mikes', clis: ['claude'], seedFromArtifact: 'mikes/inferred-out' })).json()).toMatchObject({ code: 'seed_out_of_scope' });
    doc('too-wide', { project_id: 'mikes', repo_refs: [], grounding: { repo_refs: Array.from({ length: 33 }, (_, i) => `r-${i}`), source: 'brief', skipped: [], member_count: 33 } });
    expect((await open(app, { chatId: 'seed-i2', clis: ['claude'], seedFromArtifact: 'mikes/too-wide' })).json()).toMatchObject({ code: 'seed_too_many_repos' });
    // Where the binding does not become the chat's list, its width does not matter.
    expect((await open(app, { chatId: 'seed-i2b', clis: ['claude'], scopeKind: 'everything', seedFromArtifact: 'mikes/too-wide' })).statusCode).toBe(201);
    expect((await open(app, { chatId: 'seed-i2c', clis: ['claude'], repoRefs: ['r-in'], seedFromArtifact: 'mikes/too-wide' })).statusCode).toBe(201);
    doc('garbled', { project_id: 'mikes', repo_refs: 'r-in' });
    const garbled = await open(app, { chatId: 'seed-i3', projectId: 'mikes', clis: ['claude'], seedFromArtifact: 'mikes/garbled' });
    expect(garbled.statusCode).toBe(409);
    expect(garbled.json()).toMatchObject({ code: 'seed_binding_unreadable' });
    repos = [];
  });

  it('seeds a project chat with the document’s own repositories, and refuses one made about a repository outside the project', async () => {
    const mikes = ensureProjectInteractiveRoot('mikes', undefined, process.env, home);
    repos = [
      { id: 'r-in', name: 'alpha', root_path: join(scratch, 'repo-in'), default_branch: 'main', registered_at: 1 },
      { id: 'r-in-2', name: 'beta', root_path: join(scratch, 'repo-in-2'), default_branch: 'main', registered_at: 1 },
    ];
    for (const r of repos) mkdirSync(r.root_path, { recursive: true });
    for (const [doc, bound] of [['bound-in', ['r-in']], ['bound-out', ['r-elsewhere']]] as const) {
      mkdirSync(join(mikes, doc), { recursive: true });
      writeFileSync(join(mikes, doc, '_v1.html'), '<h1>x</h1>');
      writeFileSync(join(mikes, doc, 'versions.json'), JSON.stringify({ head: 1, versions: [{ version: 1 }] }));
      writeFileSync(join(mikes, doc, 'crew-grounding.json'), JSON.stringify({ project_id: 'mikes', repo_refs: bound, recorded_at: new Date().toISOString() }));
    }
    const inside = await open(app, { chatId: 'seed-p1', projectId: 'mikes', clis: ['claude'], seedFromArtifact: 'mikes/bound-in' });
    expect(inside.statusCode).toBe(201);
    expect(JSON.parse(inside.body).scope.repos.map((r: { id: string }) => r.id)).toEqual(['r-in']);
    const outside = await open(app, { chatId: 'seed-p2', projectId: 'mikes', clis: ['claude'], seedFromArtifact: 'mikes/bound-out' });
    expect(outside.statusCode).toBe(400);
    expect(outside.json()).toMatchObject({ code: 'seed_out_of_scope' });
    repos = [];
  });
});

// The fake engine emits nothing; keep the type import honest.
export type { CoreEvent };
