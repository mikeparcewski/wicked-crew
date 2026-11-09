// crew-0182: a chat seat proposes adding a git repository to a project; crew resolves the card and the person's Go takes
// the POST /repos path (register, attach, onboard). Harness: the A7 theme harness (tests/chat-proposals-theme.test.ts).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { Actor, ArtifactProposal, ChatTranscriptRecord, CoreEvent, RepoEntry, SessionView } from '../src/core/types.js';
import { CATALOG_SEEDS } from '../src/workflow-catalog/catalog-data.js';
import {
  ChatProposals,
  LaunchOnceRegistry,
  parseMakeBlock,
  type ChatProposalDeps,
  type ProposalChat,
  type ProposalDispatch,
  type ProposalDispatcher,
} from '../src/api/chat-proposals.js';
import { ThemeLauncher } from '../src/api/proposal-theme.js';
import { matchProject, OnboardLauncher, probeGitUrl, probeVerdict, readGitUrl, withoutCredentials } from '../src/api/proposal-onboard.js';
import { chatMakeDigest, chatScopeStatement, daemonGroundingLines } from '../src/api/chat-scope.js';

const ME: Actor = { id: 'maria', kind: 'human', trust: 'operator' };
const ROOT = mkdtempSync(join(tmpdir(), 'chat-proposals-onboard-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

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
  onboardOn: boolean;
  acceptsOnboard: boolean;
  projects: Array<{ id: string; name: string }>;
  repos: RepoEntry[];
  members: Map<string, string[]>;
  origins: Map<string, string>;
  probed: string[];
  probeAnswer: string | null;
  sessions: string[];
  registered: Array<{ data: Record<string, unknown>; ctx: { actor: Actor; runId: string } }>;
  registerAnswer: { status: number; body: Record<string, unknown> };
  attached: Array<{ projectId: string; repoId: string; actor: string }>;
  occupants: Map<string, string>;
  filed: Array<{ projectId: string; runId: string }>;
  daemonRefusal: string | null;
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
    onboardOn: true,
    acceptsOnboard: true,
    projects: [{ id: 'proj_labs', name: 'Wicked Labs' }, { id: 'proj_ops', name: 'Ops' }],
    repos: [],
    members: new Map(),
    origins: new Map(),
    probed: [],
    probeAnswer: null,
    sessions: [],
    registered: [],
    registerAnswer: { status: 201, body: { onboardRunId: 'x', projectAttached: true } },
    attached: [],
    occupants: new Map(),
    filed: [],
    daemonRefusal: null,
  };
  const registry = new LaunchOnceRegistry();
  for (const k of ['create', 'refine', 'demo'] as const) registry.register(k, r.launcher);
  registry.register('theme', new ThemeLauncher());
  registry.register('onboard', new OnboardLauncher({
    sessions: async () => r.sessions,
    repos: async () => r.repos,
    projectRepoRefs: async (id) => r.members.get(id) ?? [],
    occupant: async (name) => r.occupants.get(name) ?? null,
    checkoutOf: (name) => `~/.wicked/repos/${name}`,
    register: async (data, ctx) => {
      r.registered.push({ data, ctx });
      const a = r.registerAnswer;
      // As POST /repos does: the repo is registered on a 201 (its folder cloned), a run exists only when onboarding
      // started, and the repo joins the project only when crew says it attached.
      if (a.status === 201) {
        if (!r.repos.some((x) => x.name === data.name)) r.repos.push(repo(data.name));
        r.occupants.set(data.name, data.gitUrl);
        if (typeof a.body['onboardRunId'] === 'string') r.sessions.push(ctx.runId);
        if (a.body['projectAttached'] === true && data.projectId !== undefined) r.members.set(data.projectId, [...(r.members.get(data.projectId) ?? []), data.name]);
      }
      return a;
    },
    attach: async (projectId, repoId, actor) => {
      r.attached.push({ projectId, repoId, actor: actor.id });
      r.members.set(projectId, [...(r.members.get(projectId) ?? []), repoId]);
    },
    fileRun: async (projectId, runId) => { r.filed.push({ projectId, runId }); },
  }));
  const deps: ChatProposalDeps = {
    flags: () => ({ context: true, proposals: true, create: true, refine: true, theme: true, demo: true, onboard: r.onboardOn }),
    acceptsOnboard: () => r.acceptsOnboard,
    onboard: {
      projects: async () => r.projects,
      repos: async () => r.repos,
      projectRepoRefs: async (id) => r.members.get(id) ?? [],
      originOf: async (root) => r.origins.get(root) ?? null,
      probe: async (url) => { r.probed.push(url); return r.probeAnswer; },
      checkoutOf: (name) => `~/.wicked/repos/${name}`,
      occupant: async (name) => r.occupants.get(name) ?? null,
      onboardRefusal: async () => r.daemonRefusal,
    },
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


const URL = 'https://github.com/mikeparcewski/wicked-studio.git';
const SENTENCE = 'Want to onboard https://github.com/mikeparcewski/wicked-studio.git into the wicked labs project';
const repo = (id: string, o: Partial<RepoEntry> = {}): RepoEntry => ({ id, name: id, root_path: `/srv/${id}`, default_branch: 'main', registered_at: 1, ...o });

describe('git addresses', () => {
  it('reads https, ssh and scp spellings to one key and a name', () => {
    expect(readGitUrl(URL)).toEqual({ ok: true, url: URL, key: 'github.com/mikeparcewski/wicked-studio', name: 'wicked-studio' });
    expect(readGitUrl('git@github.com:mikeparcewski/wicked-studio.git')).toMatchObject({ ok: true, key: 'github.com/mikeparcewski/wicked-studio', name: 'wicked-studio' });
    expect(readGitUrl('ssh://git@GitHub.com/mikeparcewski/Wicked-Studio/')).toMatchObject({ ok: true, key: 'github.com/mikeparcewski/wicked-studio', name: 'Wicked-Studio' });
    // Elsewhere the path's case and a non-git ssh user name a different repository (review r1).
    expect(readGitUrl('https://git.example.com/Team/Repo.git')).toMatchObject({ ok: true, key: 'https://git.example.com/Team/Repo.git' });
    expect(readGitUrl('alice@host.example:repo.git')).toMatchObject({ ok: true, key: 'scp://alice@host.example:repo.git', name: 'repo' });
    expect(readGitUrl('bob@host.example:repo.git')).toMatchObject({ ok: true, key: 'scp://bob@host.example:repo.git' });
    // An scp path is relative to the user's home, an ssh:// one absolute: two repositories off GitHub (review r2); the
    // transport and a non-lower-case suffix are kept too (review r3).
    expect(readGitUrl('ssh://bob@host.example/repo.git')).toMatchObject({ ok: true, key: 'ssh://bob@host.example/repo.git' });
    expect(readGitUrl('https://host.example/repo.git')).toMatchObject({ ok: true, key: 'https://host.example/repo.git', name: 'repo' });
    expect(readGitUrl('https://host.example/app.GIT')).toMatchObject({ ok: true, key: 'https://host.example/app.GIT' });
    // Off the known hosts `/repo` and `/repo.git`, an explicit `git@` and an omitted user, are different (review r4).
    expect(readGitUrl('https://host.example/repo').ok && readGitUrl('https://host.example/repo.git').ok).toBe(true);
    expect((readGitUrl('https://host.example/repo') as { key: string }).key).not.toBe((readGitUrl('https://host.example/repo.git') as { key: string }).key);
    expect((readGitUrl('ssh://host.example/repo.git') as { key: string }).key).not.toBe((readGitUrl('ssh://git@host.example/repo.git') as { key: string }).key);
    // On GitHub they are one repository.
    expect((readGitUrl('ssh://github.com/o/r') as { key: string }).key).toBe((readGitUrl('git@github.com:o/r.git') as { key: string }).key);
  });

  it.each([
    ['/srv/code/app', /not a git address/],
    ['file:///srv/app', /file address/],
    ['ext::sh -c touch% /tmp/pwned', /spaces/],
    ['http://github.com/a/b', /plain http/],
    ['https://user:tok@github.com/a/b.git', /user name or token/],
    ['https://github.com/', /no repository path/],
    ['git@github.com:a/../b', /no repository path/],
    ['https://github.com/a/b%ZZ', /broken %-escape/],
    ['-oProxyCommand=x@host:a/b', /not a git address/],
    ['git@-host:a/b', /not a git address/],
    ['https://DOMAIN\\alice:fixture-secret@host.example/o/r.git', /backslash/],
  ])('refuses %s', (raw, why) => {
    const r = readGitUrl(raw);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toMatch(why);
  });

  it('probes with no prompt and only https or ssh, whatever insteadOf rewrites', async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
    const exec = (async (_f: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => { calls.push({ args, env: opts?.env }); return { stdout: '', stderr: '' }; }) as never;
    expect(await probeGitUrl(URL, exec)).toBeNull();
    expect(calls[0]!.args).toEqual(['ls-remote', '--exit-code', '--', URL, 'HEAD']);
    expect(calls[0]!.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:ssh' });
  });

  it('says a private or missing repository plainly', () => {
    expect(probeVerdict("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toMatch(/private or doesn't exist.*gh auth login/);
    expect(probeVerdict('ssh: Could not resolve hostname nope: nodename nor servname provided')).toMatch(/can't reach that host/);
  });

  it('matches a project by id or by name, ignoring case and spacing', () => {
    const ps = [{ id: 'proj_labs', name: 'Wicked Labs' }, { id: 'p2', name: 'Ops' }];
    expect(matchProject(ps, 'wicked  labs')).toEqual({ one: ps[0] });
    expect(matchProject(ps, 'p2')).toEqual({ one: ps[1] });
    expect(matchProject(ps, 'labs')).toEqual({ none: true });
    expect(matchProject([...ps, { id: 'p3', name: 'wicked labs' }], 'Wicked Labs')).toMatchObject({ many: [{ id: 'proj_labs' }, { id: 'p3' }] });
  });
});

describe('the chat statement names what exists here', () => {
  const grounding = { projects: [{ id: 'proj_labs', name: 'Wicked Labs', repos: [] }], repos: [], onboard: true };

  it('lists the projects by name and id, and the onboard block for a client that draws the card', () => {
    const text = daemonGroundingLines(grounding).join('\n');
    expect(text).toContain('**Wicked Labs** (`proj_labs`): no repositories yet');
    expect(text).toContain('Registered repositories: none yet.');
    expect(text).toContain('"wicked labs" is the project named "Wicked Labs"');
    expect(text).toContain('{"onboard":{"url":');
    expect(text).toMatch(/do NOT say\s+this chat can't do it/);
  });

  it('never hands a seat a token from a registered origin, and says how many projects it left out', () => {
    const text = daemonGroundingLines({
      projects: Array.from({ length: 42 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, repos: [] })),
      repos: [{ id: 'r', name: 'r', gitUrl: 'https://me:ghp_secret123@github.com/o/r.git' }],
      onboard: true,
    }).join('\n');
    expect(text).not.toContain('ghp_secret123');
    expect(text).toContain('**r** (`r`): https://github.com/o/r.git');
    expect(text).toContain('- and 2 more projects');
  });

  it('points to studio\'s Add a repository for a client that does not', () => {
    const text = daemonGroundingLines({ ...grounding, onboard: false }).join('\n');
    expect(text).not.toContain('{"onboard"');
    expect(text).toContain('Repositories → Add a repository');
  });

  it('the per-message digest allows the onboard block wherever the statement asks for it (review r2)', () => {
    const cards = chatMakeDigest({ create: false, refine: true, theme: true, demo: false, entries: [], jobs: 'cards', onboard: true });
    expect(cards).toContain('adding a git repository to a project (the `onboard` block');
    const prose = chatMakeDigest({ create: false, refine: false, theme: false, demo: false, entries: [], onboard: true });
    expect(prose).toContain('a git repository added to a project (the `onboard` block');
    expect(chatMakeDigest({ create: false, refine: true, theme: true, demo: false, entries: [], jobs: 'cards' })).not.toContain('onboard');
  });

  it('rides the scope statement (not in an analysis)', () => {
    const scope = { kind: 'everything', repos: [], dangling: [], cwd: '/tmp/x', graph: { bound: false, reason: 'no repositories' } } as never;
    expect(chatScopeStatement('c1', scope, undefined, { daemon: grounding })).toContain('## Projects and repositories on this daemon');
    expect(chatScopeStatement('c1', scope, undefined, { daemon: grounding, analysis: true })).not.toContain('## Adding a repository');
  });
});

describe('onboard proposals', () => {
  const block = { onboard: { url: URL, project: 'wicked labs' }, reason: 'add the studio repo' };

  it('the operator\'s sentence: a card for the repository in Wicked Labs; Go registers, attaches and onboards', async () => {
    const r = rig();
    const t = chatWith(r, 'c1', { words: SENTENCE });
    const p = (await propose(r, 'c1', t, block))!;
    expect(p).toMatchObject({
      kind: 'onboard', blocked: null, helpers: null, time: null,
      what: { label: 'Add a repository · wicked-studio' },
      filedIn: { projectId: 'proj_labs', label: 'Wicked Labs' },
      onboard: { url: URL, name: 'wicked-studio', checkout: '~/.wicked/repos/wicked-studio', projectId: 'proj_labs', projectName: 'Wicked Labs', existing: null },
    });
    expect(r.probed).toEqual([URL]);
    const go = await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1');
    expect(go.code, JSON.stringify(go.body)).toBe(200);
    expect(r.registered).toHaveLength(1);
    expect(r.registered[0]!.data).toEqual({ name: 'wicked-studio', gitUrl: URL, projectId: 'proj_labs', channel: 'studio' });
    // The onboarding run is the proposal's own identity: a Go again adopts it, never registers twice.
    const runId = r.registered[0]!.ctx.runId;
    expect(go.body).toMatchObject({ view: { state: 'decided', decision: 'go', result: { runId, adopted: false } } });
    expect(r.registered[0]!.ctx.actor.id).toBe('maria');
    expect(kinds(r, 'c1')).toStrictEqual(['proposal', 'proposal_accepting', 'proposal_decided']);
    expect((await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1')).code).toBe(200);
    expect(r.registered).toHaveLength(1);
  });

  it('Not now registers nothing', async () => {
    const r = rig();
    const t = chatWith(r, 'c1', { words: SENTENCE });
    const p = (await propose(r, 'c1', t, block))!;
    expect((await r.svc.decide('c1', p.pid, { decision: 'not_now' }, ME, 'i1')).code).toBe(200);
    expect(r.registered).toHaveLength(0);
    expect(r.attached).toHaveLength(0);
    expect(kinds(r, 'c1')).toStrictEqual(['proposal', 'proposal_decided']);
  });

  it('no project named: the chat\'s own project; a name that matches none or several blocks Go, naming the projects', async () => {
    const r = rig();
    const t1 = chatWith(r, 'c1', { projectId: 'proj_ops' });
    expect(await propose(r, 'c1', t1, { onboard: { url: URL } })).toMatchObject({ blocked: null, onboard: { projectId: 'proj_ops' } });
    const t2 = chatWith(r, 'c2');
    expect(await propose(r, 'c2', t2, { onboard: { url: URL, project: 'labs' } })).toMatchObject({
      blocked: expect.stringMatching(/no project has the name given \(projects here: Wicked Labs, Ops\)\. Create it on Projects → New project/),
    });
    r.projects.push({ id: 'proj_labs2', name: 'WICKED LABS' });
    const t3 = chatWith(r, 'c3');
    expect(await propose(r, 'c3', t3, block)).toMatchObject({ blocked: expect.stringMatching(/more than one project has the name given/) });
    const blocked = (await propose(r, 'c3', chatWith(r, 'c3'), block))!;
    expect((await r.svc.decide('c3', blocked.pid, { decision: 'go' }, ME, 'i1')).code).toBe(409);
    expect(r.registered).toHaveLength(0);
  });

  it('a bad address or an unreadable repository blocks Go with the reason; nothing is probed for a bad address', async () => {
    const r = rig();
    expect(await propose(r, 'c1', chatWith(r, 'c1'), { onboard: { url: 'file:///srv/x', project: 'Ops' } })).toMatchObject({ blocked: expect.stringMatching(/file address/) });
    expect(r.probed).toEqual([]);
    r.probeAnswer = "this computer's git can't read it: the repository is private or doesn't exist.";
    expect(await propose(r, 'c2', chatWith(r, 'c2'), block)).toMatchObject({ blocked: expect.stringMatching(/private or doesn't exist/) });
  });

  it('an already-registered repository is added to the project only (no clone, no second onboarding)', async () => {
    const r = rig();
    r.repos = [repo('wicked-studio', { git_url: 'git@github.com:mikeparcewski/wicked-studio.git' })];
    const p = (await propose(r, 'c1', chatWith(r, 'c1'), block))!;
    expect(p).toMatchObject({ blocked: null, what: { label: 'Add to a project · wicked-studio' }, onboard: { existing: { id: 'wicked-studio', name: 'wicked-studio' }, checkout: null } });
    expect(r.probed).toEqual([]);
    expect((await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1')).code).toBe(200);
    expect(r.attached).toEqual([{ projectId: 'proj_labs', repoId: 'wicked-studio', actor: 'maria' }]);
    expect(r.registered).toHaveLength(0);
    // Already a member: nothing to add.
    r.members.set('proj_labs', ['wicked-studio']);
    expect(await propose(r, 'c2', chatWith(r, 'c2'), block)).toMatchObject({ blocked: 'wicked-studio is already in Wicked Labs; nothing to add' });
  });

  it('a folder registration is the same repository when its origin is the address; a different one blocks', async () => {
    const r = rig();
    r.repos = [repo('wicked-studio')];
    expect(await propose(r, 'c1', chatWith(r, 'c1'), block)).toMatchObject({ blocked: expect.stringMatching(/a different repository is already registered as “wicked-studio”/) });
    r.origins.set('/srv/wicked-studio', 'https://github.com/mikeparcewski/wicked-studio');
    expect(await propose(r, 'c2', chatWith(r, 'c2'), block)).toMatchObject({ blocked: null, onboard: { existing: { id: 'wicked-studio' } } });
  });

  it('the digest follows this message\'s own declaration, not the chat\'s stored one (review r3)', () => {
    const r = rig();
    chatWith(r, 'c1');
    r.acceptsOnboard = true;
    expect(r.svc.digest('c1', false, { onboard: false }).onboard).toBeUndefined();
    r.acceptsOnboard = false;
    expect(r.svc.digest('c1', false, { onboard: true }).onboard).toBe(true);
    expect(r.svc.digest('c1', false).onboard).toBeUndefined();
  });

  it('only for a client that draws the card, on a daemon that advertises it', async () => {
    const r = rig();
    r.acceptsOnboard = false;
    expect(await propose(r, 'c1', chatWith(r, 'c1'), block)).toBeNull();
    r.acceptsOnboard = true;
    r.onboardOn = false;
    expect(await propose(r, 'c2', chatWith(r, 'c2'), block)).toBeNull();
    expect(parseMakeBlock(JSON.stringify(block))).toMatchObject({ op: 'onboard', onboard: { url: URL } });
    expect(parseMakeBlock(JSON.stringify({ ...block, theme: { name: 'x', patch: { theme: 'wicked-dark' } } }))).toBeNull();
  });

  it('a refused registration or onboarding start fails the Go with the reason; Go again finishes it once fixed', async () => {
    const r = rig();
    const p = (await propose(r, 'c1', chatWith(r, 'c1'), block))!;
    r.registerAnswer = { status: 400, body: { error: "fatal: could not read Username for 'https://github.com': terminal prompts disabled" } };
    const go = await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1');
    expect(go.code).toBe(502);
    expect(go.body).toMatchObject({ code: 'launch_failed', error: expect.stringMatching(/wicked-studio was not added: fatal: could not read Username/) });
    // Registered (and attached), but onboarding could not start: said so, and the card stays open to Go again.
    r.registerAnswer = { status: 201, body: { onboardRunId: null, onboardError: 'garden is too old', projectAttached: true } };
    const again = await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1');
    expect(again.body).toMatchObject({ error: expect.stringMatching(/registered in Wicked Labs, but onboarding could not start: garden is too old/) });
    expect(r.sessions).toEqual([]);
    // Fixed: Go again registers the same repository again (its own earlier registration, not a refusal) and starts it.
    r.registerAnswer = { status: 201, body: { onboardRunId: 'x', projectAttached: true } };
    const done = await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1');
    expect(done.code, JSON.stringify(done.body)).toBe(200);
    expect(r.registered).toHaveLength(3);
    expect(r.sessions).toEqual([r.registered[2]!.ctx.runId]);
  });

  it('a Go whose run started but whose attach did not land finishes the attach on Go again, never registering twice', async () => {
    const r = rig();
    const p = (await propose(r, 'c1', chatWith(r, 'c1'), block))!;
    r.registerAnswer = { status: 201, body: { onboardRunId: 'x', projectAttachError: 'project busy' } };
    const go = await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1');
    expect(go.body).toMatchObject({ code: 'launch_failed', error: expect.stringMatching(/onboarding started, but it was not added to Wicked Labs: project busy\. Go again adds it/) });
    const again = await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1');
    expect(again.code, JSON.stringify(again.body)).toBe(200);
    expect(r.registered).toHaveLength(1);
    expect(r.attached).toEqual([{ projectId: 'proj_labs', repoId: 'wicked-studio', actor: 'maria' }]);
    // …and its run is filed by its own id (a restart loses the in-memory run map; review r2).
    expect(r.filed).toEqual([{ projectId: 'proj_labs', runId: r.registered[0]!.ctx.runId }]);
  });

  it('attached but the run\'s filing failed: the Go files the run itself', async () => {
    const r = rig();
    const p = (await propose(r, 'c1', chatWith(r, 'c1'), block))!;
    r.registerAnswer = { status: 201, body: { onboardRunId: 'x', projectAttached: true, projectAttachError: 'filing failed' } };
    expect((await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1')).code).toBe(200);
    expect(r.filed).toEqual([{ projectId: 'proj_labs', runId: r.registered[0]!.ctx.runId }]);
  });

  it('neither onboarded nor attached: the refusal says both', async () => {
    const r = rig();
    const p = (await propose(r, 'c1', chatWith(r, 'c1'), block))!;
    r.registerAnswer = { status: 201, body: { onboardRunId: null, onboardError: 'garden is too old', projectAttachError: 'project archived' } };
    expect((await r.svc.decide('c1', p.pid, { decision: 'go' }, ME, 'i1')).body).toMatchObject({
      error: expect.stringMatching(/wicked-studio is registered \(not added to Wicked Labs: project archived\), but onboarding could not start: garden is too old/),
    });
  });

  it('a daemon that can\'t onboard now says so on a new repository\'s card; adding a registered one to a project still works', async () => {
    const r = rig();
    r.daemonRefusal = "this daemon can't onboard a repository now: wicked-garden 12.66.1 or newer is needed";
    expect(await propose(r, 'c1', chatWith(r, 'c1'), block)).toMatchObject({ blocked: expect.stringMatching(/can't onboard a repository now/) });
    r.repos = [repo('wicked-studio', { git_url: URL })];
    expect(await propose(r, 'c2', chatWith(r, 'c2'), block)).toMatchObject({ blocked: null, onboard: { existing: { id: 'wicked-studio' } } });
  });

  it('nothing the seat wrote that could carry a credential reaches the card (name, project, reason; review r3)', async () => {
    const r = rig();
    const secret = 'https://me:pa)ss_SECRET9@github.com/o/r.git';
    for (const [i, b] of [
      { onboard: { url: URL, project: 'Ops', name: secret } },
      { onboard: { url: URL, project: secret } },
      { onboard: { url: URL, project: 'Ops' }, reason: `see ${secret}` },
      { onboard: { url: URL, project: 'Ops' }, reason: 'see https://github.com/o/r.git?access_token=SECRET9' },
      { onboard: { url: URL, project: 'Ops' }, reason: 'see https://host.example/o/r.git#access_token=SECRET9\\' },
    ].entries()) {
      const p = (await propose(r, `s${i}`, chatWith(r, `s${i}`), b))!;
      expect(JSON.stringify(p)).not.toContain('SECRET9');
    }
  });

  it('a name whose registry id is taken (core slugs it) or whose clone folder holds another checkout blocks, on the card and on Go', async () => {
    const r = rig();
    r.repos = [repo('foo-bar', { name: 'foo-bar', root_path: '/srv/foo-bar' })];
    expect(await propose(r, 'c1', chatWith(r, 'c1'), { onboard: { url: 'https://github.com/o/foo_bar.git', project: 'Ops' } }))
      .toMatchObject({ blocked: 'a different repository is already registered as “foo-bar”; give this one another name' });
    r.repos = [];
    r.occupants.set('wicked-studio', 'https://github.com/someone-else/other.git');
    expect(await propose(r, 'c2', chatWith(r, 'c2'), block)).toMatchObject({ blocked: '~/.wicked/repos/wicked-studio already holds another checkout; give this one another name' });
    // The registry moved after the card was drawn: Go refuses before anything is registered.
    r.occupants.clear();
    const p = (await propose(r, 'c3', chatWith(r, 'c3'), block))!;
    expect(p.blocked).toBeNull();
    r.repos = [repo('wicked-studio', { root_path: '/srv/elsewhere' })];
    const go = await r.svc.decide('c3', p.pid, { decision: 'go' }, ME, 'i1');
    expect(go.body).toMatchObject({ code: 'launch_failed', error: expect.stringMatching(/wicked-studio was not added: a different repository is already registered/) });
    expect(r.registered).toHaveLength(0);
  });

  it('a repository registered under another name is found by its checkout\'s origin, past the first 60 and with a token in it', async () => {
    const r = rig();
    r.repos = [...Array.from({ length: 70 }, (_, i) => repo(`other-${i}`)), repo('studio-checkout', { root_path: '/srv/studio-checkout' })];
    r.origins.set('/srv/studio-checkout', 'https://me:ghp_secret123@github.com/mikeparcewski/Wicked-Studio.git');
    const p = (await propose(r, 'c1', chatWith(r, 'c1'), block))!;
    expect(p).toMatchObject({ blocked: null, onboard: { existing: { id: 'studio-checkout' } } });
    expect(JSON.stringify(p)).not.toContain('ghp_secret123');
  });

  it('an address carrying a token is refused without repeating it', async () => {
    const r = rig();
    const p = (await propose(r, 'c1', chatWith(r, 'c1'), { onboard: { url: 'https://me:ghp_secret123@github.com/o/r.git', project: 'Ops' } }))!;
    expect(JSON.stringify(p)).not.toContain('ghp_secret123');
    expect(p.blocked).toMatch(/that address can't be added: the address carries a user name or token/);
    expect(withoutCredentials('https://me:ghp_secret123@github.com/o/r.git')).toBe('https://github.com/o/r.git');
    expect(withoutCredentials('ssh://git@github.com/o/r.git')).toBe('ssh://git@github.com/o/r.git');
    expect(withoutCredentials('git@github.com:o/r.git')).toBe('git@github.com:o/r.git');
    // A query can carry a token too; an ssh user without a password is part of the address (review r2).
    expect(withoutCredentials('https://github.com/o/r.git?access_token=ghp_x')).toBe('https://github.com/o/r.git');
    expect(withoutCredentials('ssh://alice@git.example.com/repo.git')).toBe('ssh://alice@git.example.com/repo.git');
    expect(withoutCredentials('https://DOMAIN\\alice:fixture-secret@host.example/o/r.git')).toBe('https://host.example/o/r.git');
    expect(withoutCredentials('https://host.example/o/r.git?access_token=SECRET9#\\')).toBe('https://host.example/o/r.git');
    expect(withoutCredentials('https://host.example/o/r?session=abc123\\x')).toBe('https://host.example/o/r');
    // The seat's own words on the card lose any address's token too.
    const q = (await propose(r, 'c2', chatWith(r, 'c2'), { onboard: { url: 'https://github.com/o/r.git', project: 'Ops' }, reason: 'from https://me:ghp_secret123@github.com/o/r.git' }))!;
    expect(JSON.stringify(q)).not.toContain('ghp_secret123');
  });
});

