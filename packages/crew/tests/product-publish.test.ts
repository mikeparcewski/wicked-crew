// crew#372 (DES-372 rev 4): product publish. A finished compose run's plan becomes GitHub issues, card first, through
// the tracker write path, against the fake github-mcp-server (tests/fixtures/pm/fake-github.mjs: stdio, a real create
// that stores and reads back, switches for the uncertain outcomes; no network, no real token). The run is the real
// shape: a compose launch on the stub-runner CoreAdapter, captured once it completed
// (tests/fixtures/product/compose-run-view.json). Its compose facts go through the real recorder and reader
// (composeFactsOf, RunTimingIndex.noteLaunchFacts / composeOf).

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditLog, appendLineSynced } from '../src/api/audit.js';
import { composeFactsOf, type ComposeLevel } from '../src/api/compose-facts.js';
import { type ProductPublishDeps, READ_BACK_FRESH_MS, registerProductPublishRoutes, strippedCharacter } from '../src/api/product-publish.js';
import { RunTimingIndex } from '../src/api/run-timing-index.js';
import type { Actor, ProductPublicationsResponse, ProductPublishResponse, SessionView } from '../src/core/types.js';
import { DataGate } from '../src/knowledge/gate/gate.js';
import { SourceReadLog } from '../src/knowledge/gate/record.js';
import { trackerIdOf, trackerLinkIdOf, type StoredTracker } from '../src/knowledge/registry/entry.js';
import { bindingFor, bindingPolicy } from '../src/knowledge/trackers/bindings.js';
import { McpRegistryStore } from '../src/mcp/registry-store.js';
import { SourceCatalogStore } from '../src/sources/store.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_GITHUB = join(HERE, 'fixtures', 'pm', 'fake-github.mjs');
const FIX = JSON.parse(readFileSync(join(HERE, 'fixtures', 'product', 'compose-run-view.json'), 'utf8')) as { projectId: string; draft: string; review: string; view: SessionView };
const PID = FIX.projectId;
const RUN = FIX.view.session.id;
const GH_ID = '11111111-0000-4000-8000-00000000g372';
const GH2_ID = '11111111-0000-4000-8000-00000000g373';
const REFS = [{ repoId: 'repo-a', key: 'REQ-1' }, { repoId: 'repo-a', key: 'REQ-2' }];
const stamp = new Date().toISOString();

const PLAN = {
  epics: [
    {
      title: 'Accounts & access',
      features: [
        {
          title: 'Sign in and out',
          requirementRefs: REFS,
          stories: [
            { title: 'Email sign in (< 3 tries)', acceptance: ['A user with an email signs in', 'A wrong password is refused'] },
            { title: "Sign out from any page", acceptance: ["The session ends and the user's data is hidden"] },
          ],
        },
      ],
    },
  ],
};
const KEYS = ['e1', 'e1.f1', 'e1.f1.s1', 'e1.f1.s2'];
const draftText = (plan: unknown): string => `Here is the plan.\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\`\n`;

let base: string;
let mcpDir: string;
let ghLog: string;
let store: McpRegistryStore;
let gate: DataGate;
let token: string;
let view: SessionView;
let output: string | null;
let index: RunTimingIndex;
let actor: Actor;
let app: FastifyInstance;
let deps: ProductPublishDeps;
/** The routes' clock (crew#1911): each test starts past every read-back an earlier test left fresh. */
let nowMs = Date.now();
let auditPath: string;

function toolsOf(writeOn = true) {
  return ['get_me', 'issue_read', 'issue_write'].map((name) => {
    const b = bindingFor('github', name);
    return {
      name, description: null, inputSchema: { type: 'object' }, outputSchema: null, annotations: { readOnlyHint: name !== 'issue_write' }, classOverride: null,
      enabled: name === 'issue_write' ? writeOn : true, schemaHash: `h-${name}`, observedSchemaHash: `h-${name}`, present: true,
      disclosure: name === 'issue_read' ? { class: 'rows', schemaHash: `h-${name}` } : null,
      binding: b === null ? null : { policy: bindingPolicy(b), schemaHash: `h-${name}` },
    };
  });
}

function tracker(sourceId: string, key: string, targets: Array<{ kind: 'project' | 'repo'; id: string }>): StoredTracker {
  const id = trackerIdOf(sourceId, 'github.com', key);
  return { id, tenant: 'github.com', tenantLabel: null, siteHost: null, key, label: key, links: targets.map((t) => ({ id: trackerLinkIdOf(id, t), target: t, linkedAt: stamp, linkedBy: 'local' })) };
}

interface World { enabled?: boolean; writeOn?: boolean; auth?: { ref: string; env: string } | null; links?: Array<{ kind: 'project' | 'repo'; id: string }>; second?: boolean; lib?: boolean }
function world(w: World = {}): void {
  const common = { url: null, health: { state: 'ok', consecutiveFailures: 0, checkedAt: stamp, lastError: null }, registeredAt: stamp, updatedAt: stamp, kind: 'mcp-stdio', command: process.execPath, pm: { system: 'github' }, agents: { see: true, query: true, projects: [PID], everyProject: false } };
  const servers = [{ ...common, id: GH_ID, name: 'gh', enabled: w.enabled ?? true, args: [FAKE_GITHUB, ghLog], auth: w.auth === undefined ? { ref: 'env:PM_FAKE', env: 'FAKE_PM_TOKEN' } : w.auth, tools: toolsOf(w.writeOn ?? true), trackers: [tracker(GH_ID, 'owner/app', w.links ?? [{ kind: 'project', id: PID }]), ...(w.lib === true ? [tracker(GH_ID, 'owner/lib', [{ kind: 'project', id: PID }])] : [])] }];
  if (w.second === true) servers.push({ ...common, id: GH2_ID, name: 'gh2', enabled: true, args: [FAKE_GITHUB, ghLog], auth: { ref: 'env:PM_FAKE', env: 'FAKE_PM_TOKEN' }, tools: toolsOf(true), trackers: [tracker(GH2_ID, 'owner/app', [{ kind: 'project', id: PID }])] });
  writeFileSync(join(mcpDir, 'registry.json'), JSON.stringify({ version: 1, servers }));
}

const calls = (): Array<{ tool: string; args: Record<string, unknown> }> =>
  existsSync(join(ghLog, 'calls.ndjson')) ? readFileSync(join(ghLog, 'calls.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { tool: string; args: Record<string, unknown> }) : [];
const creates = () => calls().filter((c) => c.tool === 'issue_write' && c.args['method'] === 'create');
const issues = (): { next: number; issues: Array<{ repo: string; number: number; title: string; body: string; deleted?: boolean }> } =>
  existsSync(join(ghLog, 'issues.json')) ? JSON.parse(readFileSync(join(ghLog, 'issues.json'), 'utf8')) : { next: 100, issues: [] };
const sw = (name: string, on: boolean) => (on ? writeFileSync(join(ghLog, name), '') : rmSync(join(ghLog, name), { force: true }));
const journal = (): Array<Record<string, unknown>> => {
  const root = join(deps.journalDir!, 'product-publish');
  if (!existsSync(root)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const d of readdirSync(root)) for (const f of readdirSync(join(root, d)).filter((n) => n.endsWith('.ndjson'))) for (const l of readFileSync(join(root, d, f), 'utf8').split('\n')) if (l.trim() !== '') out.push(JSON.parse(l) as Record<string, unknown>);
  return out;
};

const post = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: `/api/v1/projects/${PID}/product/publish`, payload: { runId: RUN, repo: 'owner/app', ...payload } });
const getPub = () => app.inject({ method: 'GET', url: `/api/v1/projects/${PID}/product/publish/${RUN}` });
async function card(): Promise<{ publishHash: string; card: { items: Array<{ key: string; title: string; body: string }> } }> {
  const r = await post({});
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { publishHash: string; card: { items: Array<{ key: string; title: string; body: string }> } };
}
async function publish(): Promise<{ status: number; body: Record<string, unknown> }> {
  const c = await card();
  const r = await post({ confirm: c.publishHash });
  return { status: r.statusCode, body: r.json() as Record<string, unknown> };
}
const states = (body: unknown): string[] => ((body as { publication: { items: Array<{ state: string }> } }).publication.items).map((i) => i.state);

function facts(level: ComposeLevel = 'stories', refs = REFS) {
  index = new RunTimingIndex();
  index.noteLaunchFacts(RUN, { projectId: PID, compose: composeFactsOf(PID, refs, level, FIX.draft, FIX.review) });
}

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), 'publish-crew-'));
  mcpDir = join(base, 'mcp');
  ghLog = join(base, 'github');
  mkdirSync(mcpDir, { recursive: true });
  mkdirSync(ghLog, { recursive: true });
  store = new McpRegistryStore(mcpDir);
  auditPath = join(base, 'audit.log');
  gate = new DataGate({
    store,
    catalogs: new SourceCatalogStore(join(mcpDir, 'catalogs')),
    secret: async (ref) => (ref === 'env:PM_FAKE' ? token : null),
    record: new SourceReadLog(mcpDir, async () => undefined),
    audit: new AuditLog(join(base, 'gate-audit.log'), () => undefined),
    resolver: () => async () => { throw new Error('no agent here'); },
    lister: () => async () => JSON.stringify({ tools: [] }),
    members: async () => [],
    log: () => undefined,
    deadlineMs: 20_000,
  });
  deps = {
    store,
    pm: gate.pm,
    projectExists: async (id) => id === PID,
    composeOf: (runId) => index.composeOf(runId),
    runView: async (runId) => (runId === RUN ? view : undefined),
    workOutput: async (unitId) => (unitId === `${RUN}:draft` ? output : null),
    audit: new AuditLog(auditPath, () => undefined),
    actorOf: () => actor,
    journalDir: join(base, 'j0'),
    now: () => nowMs,
  };
  app = Fastify({ logger: false });
  registerProductPublishRoutes(app, deps);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
  token = `pub-fake-${randomUUID().slice(0, 8)}`; // ggignore: a made-up test credential
  actor = { id: 'local', kind: 'human', trust: 'admin' };
  view = structuredClone(FIX.view);
  output = draftText(PLAN);
  facts();
  world();
  nowMs += READ_BACK_FRESH_MS + 1;
  deps.journalDir = join(base, `j-${randomUUID().slice(0, 8)}`);
  delete deps.appendLine;
  delete deps.syncJournalDirs;
  deps.pm = gate.pm;
  deps.store = store;
  for (const f of ['calls.ndjson', 'issues.json', 'createerror', 'createexit', 'createjunk', 'createhost', 'createpull', 'createrefuse', 'login']) rmSync(join(ghLog, f), { force: true });
});

describe('the card and the confirm', () => {
  it('(1) a card lists every item in order, as the account it posts as, and sends nothing', async () => {
    const c = (await card()) as unknown as { done: boolean; card: Record<string, unknown> & { items: Array<Record<string, unknown>> }; publication: unknown };
    expect(c.done).toBe(false);
    expect(c.publication).toBeNull();
    expect(c.card).toMatchObject({ runId: RUN, projectId: PID, repo: 'owner/app', source: 'gh', identity: 'pat-bot' });
    expect(c.card.items.map((i) => [i.key, i.kind, i.parentKey])).toEqual([['e1', 'epic', null], ['e1.f1', 'feature', 'e1'], ['e1.f1.s1', 'story', 'e1.f1'], ['e1.f1.s2', 'story', 'e1.f1']]);
    const story = c.card.items[2]!;
    expect(story['body']).toBe(
      `Acceptance criteria:\n- [ ] A user with an email signs in\n- [ ] A wrong password is refused\n\nPart of {{parent}}\n\n---\nPublished by wicked-crew from run ${RUN}\n<!-- wicked-publish run=${RUN} key=e1.f1.s1 -->`,
    );
    expect(c.card.items[1]!['body']).toContain('Requirements:\n- repo-a REQ-1\n- repo-a REQ-2');
    expect(creates()).toEqual([]);
    expect(journal()).toEqual([]);
  });

  it('(2) a confirm creates every item, journaled before and after each; the answer and GET both say published', async () => {
    const r = await publish();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ done: true, publication: { repo: 'owner/app', source: 'gh', published: true } });
    expect(states(r.body)).toEqual(['created', 'created', 'created', 'created']);
    expect((r.body as unknown as ProductPublishResponse & { done: true }).publication.items.map((i) => [i.number, i.readBack])).toEqual([[100, 'ok'], [101, 'ok'], [102, 'ok'], [103, 'ok']]);
    expect(journal().map((l) => (l['kind'] === 'approved' ? 'approved' : `${String(l['kind'])}:${String(l['key'])}`))).toEqual(['approved', ...KEYS.flatMap((k) => [`sending:${k}`, `created:${k}`])]);
    // The parent's number is in each child's body; the card's `{{parent}}` never reaches GitHub.
    const kept = issues().issues;
    expect(kept.map((i) => i.body.match(/Part of (#\d+)/)?.[1] ?? null)).toEqual([null, '#100', '#101', '#101']);
    expect(kept.some((i) => i.body.includes('{{parent}}'))).toBe(false);
    // The fake escapes a title's "<" as the server's sanitize.PlainText does; the read-back decodes it (read back ok above).
    expect(kept[0]!.title).toBe('Accounts & access');
    expect(kept[2]!.title).toBe('Email sign in (&lt; 3 tries)');
    const g = (await getPub()).json() as ProductPublicationsResponse;
    expect(g.publishable).toEqual({ ok: true, items: 4 });
    expect(g.targets).toEqual([{ repo: 'owner/app', source: 'gh' }]);
    expect(g.publications.map((p) => p.published)).toEqual([true]);
    // A second confirm creates nothing again.
    const again = await publish();
    expect(again.body).toMatchObject({ done: true, publication: { published: true } });
    expect(creates()).toHaveLength(4);
    await (deps.audit as AuditLog).flush();
    expect(readFileSync(auditPath, 'utf8')).toContain('product.publish');
  });

  it('(3) what changed after the card was shown sends nothing: the plan or the credential (card_changed), the link (repo_not_linked)', async () => {
    const c = await card();
    output = draftText({ epics: [{ ...PLAN.epics[0]!, title: 'Accounts' }] });
    expect((await post({ confirm: c.publishHash })).json()).toMatchObject({ code: 'card_changed', publishHash: expect.any(String) });
    output = draftText(PLAN);
    token = `${token}-rotated`;
    expect((await post({ confirm: c.publishHash })).json()).toMatchObject({ code: 'card_changed' });
    world({ links: [{ kind: 'repo', id: 'repo-a' }] }); // a repository's link is not the project's
    const r = await post({ confirm: c.publishHash });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ code: 'repo_not_linked' });
    expect(creates()).toEqual([]);
  });

  it('(4) a create refused before dispatch (the source switched off between items) is not_sent; a re-confirm sends only the rest', async () => {
    let n = 0;
    const real = gate.pm.vendorRead.bind(gate.pm);
    deps.pm = {
      vendorRead: async (e, tool, args, cls, before, cred) => {
        if (tool === 'issue_write' && ++n === 3) world({ enabled: false });
        return real(e, tool, args, cls, before, cred);
      },
    };
    const r = await publish();
    expect(states(r.body)).toEqual(['created', 'created', 'not_sent', 'missing']);
    expect(creates()).toHaveLength(2);
    deps.pm = gate.pm;
    world();
    const again = await publish();
    expect(again.body).toMatchObject({ publication: { published: true } });
    expect(creates().map((c) => c.args['title'])).toEqual(['Accounts & access', 'Sign in and out', 'Email sign in (< 3 tries)', 'Sign out from any page']);
  });

  it('(9) a second confirm while the first is sending is in_progress, and nothing is sent twice', async () => {
    const c = await card();
    const both = await Promise.all([post({ confirm: c.publishHash }), post({ confirm: c.publishHash })]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(both.map((r) => (r.json() as { code?: string }).code).filter(Boolean)).toEqual(['in_progress']);
    expect(creates()).toHaveLength(4);
  });

  it('(10) a source with no credential of its own is credential_unpinned', async () => {
    world({ auth: null });
    const r = await post({});
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ code: 'credential_unpinned' });
  });

  it('(12) the same content with a rotated credential resumes the same publication; other content after a partial publish is publication_differs', async () => {
    sw('createrefuse', true);
    const first = await publish();
    expect(states(first.body)).toEqual(['unsure', 'missing', 'missing', 'missing']);
    // An isError answer is unsure (the server answers isError after GitHub received it, too): resolve it as absent.
    expect((await post({ resolve: { key: 'e1', issue: null } })).json()).toMatchObject({ done: true });
    sw('createrefuse', false);
    const oldHash = (await card()).publishHash;
    token = `${token}-rotated`;
    const c = await card();
    expect(c.publishHash).not.toBe(oldHash);
    const r = await post({ confirm: c.publishHash });
    expect(r.json()).toMatchObject({ publication: { published: true } });
    expect(journal().filter((l) => l['kind'] === 'approved')).toHaveLength(2);
    expect(new Set(journal().map((l) => l['publication'])).size).toBe(1);
    output = draftText({ epics: [{ ...PLAN.epics[0]!, title: 'Accounts, renamed' }] });
    const d = await post({});
    expect(d.statusCode).toBe(409);
    expect(d.json()).toMatchObject({ code: 'publication_differs', publication: { published: true } });
  });
});

describe('the barriers and the account', () => {
  it('(3) another account behind the same credential is card_changed (the card names who posts)', async () => {
    const c = await card();
    writeFileSync(join(ghLog, 'login'), 'someone-else');
    expect((await post({ confirm: c.publishHash })).json()).toMatchObject({ code: 'card_changed', card: { identity: 'someone-else' } });
    expect(creates()).toEqual([]);
  });

  it('(6) no create is dispatched before its flushed approved and sending lines: each barrier is awaited', async () => {
    const gateOf = () => {
      let release!: () => void;
      let reached!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const at = new Promise<void>((r) => (reached = r));
      return { held, at, release, reached };
    };
    const approved = gateOf();
    const firstSending = gateOf();
    deps.appendLine = async (p, l, m) => {
      if (l.includes('"kind":"approved"')) {
        approved.reached();
        await approved.held;
        return appendLineSynced(p, l, m);
      }
      if (l.includes('"kind":"sending"') && l.includes('"key":"e1"')) {
        await appendLineSynced(p, l, m); // its bytes are on disk; its barrier has not returned
        firstSending.reached();
        await firstSending.held;
        return;
      }
      return appendLineSynced(p, l, m);
    };
    const seen: string[] = [];
    const real = gate.pm.vendorRead.bind(gate.pm);
    deps.pm = {
      vendorRead: async (e, tool, args, cls, before, cred) => {
        if (tool === 'issue_write') {
          const last = journal().at(-1)!;
          seen.push(`${String(last['kind'])}:${String(last['key'])}:${String(args['title'])}`);
        }
        return real(e, tool, args, cls, before, cred);
      },
    };
    const c = await card();
    const sending = post({ confirm: c.publishHash });
    await approved.at;
    await new Promise((r) => setTimeout(r, 300));
    expect(creates()).toEqual([]);
    approved.release();
    await firstSending.at;
    await new Promise((r) => setTimeout(r, 300));
    expect(journal().at(-1)).toMatchObject({ kind: 'sending', key: 'e1' });
    expect(creates()).toEqual([]);
    firstSending.release();
    expect((await sending).json()).toMatchObject({ publication: { published: true } });
    expect(seen).toEqual(['sending:e1:Accounts & access', 'sending:e1.f1:Sign in and out', 'sending:e1.f1.s1:Email sign in (< 3 tries)', 'sending:e1.f1.s2:Sign out from any page']);
  });

  it('(6) a journal directory that cannot be synced after the approval sends nothing (503); a retry syncs again and sends', async () => {
    deps.syncJournalDirs = async () => {
      throw Object.assign(new Error('fsync EIO'), { code: 'EIO' });
    };
    const a = await publish();
    expect(a.status).toBe(503);
    expect(a.body).toMatchObject({ code: 'journal_unavailable' });
    expect(creates()).toEqual([]);
    let synced = 0;
    deps.syncJournalDirs = async () => {
      synced++;
    };
    expect((await publish()).body).toMatchObject({ publication: { published: true } });
    expect(synced).toBe(1);
  });

  it('(6) a sending line whose bytes landed but whose flush failed sends nothing (and reads unsure: a person says it is absent)', async () => {
    deps.appendLine = async (p, l, m) => {
      await appendLineSynced(p, l, m);
      if (l.includes('"kind":"sending"')) throw new Error('fsync EIO after write');
    };
    expect(states((await publish()).body)).toEqual(['unsure', 'missing', 'missing', 'missing']);
    expect(creates()).toEqual([]);
  });

  it('(7) a "changed" answer that crew\'s own admission did not give (a vendor error carrying the marker) is unsure, never not_sent', async () => {
    const real = gate.pm.vendorRead.bind(gate.pm);
    deps.pm = {
      vendorRead: async (e, tool, args, cls, before, cred) => {
        const r = await real(e, tool, args, cls, before, cred);
        return tool === 'issue_write' ? { ok: false as const, code: 'changed', reason: 'wicked-pm-dispatch-revoked in a vendor error' } : r;
      },
    };
    expect(states((await publish()).body)).toEqual(['unsure', 'missing', 'missing', 'missing']);
    expect(issues().issues).toHaveLength(1);
  });

  it('(8) a tracker registry that cannot be read is 503 on GET, never an empty list of repositories', async () => {
    deps.store = { read: async () => { throw new Error('EIO'); } };
    const g = await getPub();
    expect(g.statusCode).toBe(503);
    expect(g.json()).toMatchObject({ code: 'registry_unavailable' });
  });
});

describe('uncertain outcomes are never resent', () => {
  it('(5) an in-band tool error after GitHub stored it is unsure; a re-confirm is unresolved; resolve #N continues', async () => {
    sw('createerror', true);
    const r = await publish();
    expect(states(r.body)).toEqual(['unsure', 'missing', 'missing', 'missing']);
    sw('createerror', false);
    const c = await card();
    expect((await post({ confirm: c.publishHash })).json()).toMatchObject({ code: 'unresolved' });
    expect(creates()).toHaveLength(1);
    // A number whose issue is not this item is refused.
    const seven = await post({ resolve: { key: 'e1', issue: 7 } });
    expect(seven.json(), seven.body).toMatchObject({ code: 'resolve_differs' });
    const ok = await post({ resolve: { key: 'e1', issue: 100 } });
    expect(ok.statusCode, ok.body).toBe(200);
    // The answer's card is the latest approval's (who posts, through which source), its items the frozen content.
    expect(ok.json()).toMatchObject({ card: { identity: 'pat-bot', source: 'gh', items: KEYS.map((key) => ({ key })) } });
    expect(states(ok.json())).toEqual(['created', 'missing', 'missing', 'missing']);
    const done = await publish();
    expect(done.body).toMatchObject({ publication: { published: true } });
    expect(creates()).toHaveLength(4);
  });

  it('(5) a connection lost after the call (the server died) is unsure; resolve null records absent and the next confirm creates it', async () => {
    sw('createexit', true);
    const r = await publish();
    expect(states(r.body)).toEqual(['unsure', 'missing', 'missing', 'missing']);
    sw('createexit', false);
    const res = await post({ resolve: { key: 'e1', issue: null } });
    expect(states(res.json())).toEqual(['absent', 'missing', 'missing', 'missing']);
    expect((await publish()).body).toMatchObject({ publication: { published: true } });
  });

  it('(5, 14) an answer crew cannot read, a url on another host, or a pull-request url is unsure, never created', async () => {
    for (const s of ['createjunk', 'createhost', 'createpull']) {
      deps.journalDir = join(base, `j-${s}`);
      sw(s, true);
      const r = await publish();
      sw(s, false);
      expect(states(r.body), s).toEqual(['unsure', 'missing', 'missing', 'missing']);
    }
  });

  it('(6) a failed flush sends nothing: on approved (journal_unavailable) and on sending; a failed outcome write stops and reads unsure', async () => {
    deps.appendLine = async (p, l, m) => {
      if (l.includes('"kind":"approved"')) throw new Error('fsync EIO');
      return appendLineSynced(p, l, m);
    };
    const a = await publish();
    expect(a.status).toBe(503);
    expect(a.body).toMatchObject({ code: 'journal_unavailable' });
    deps.appendLine = async (p, l, m) => {
      if (l.includes('"kind":"sending"')) throw new Error('fsync EIO');
      return appendLineSynced(p, l, m);
    };
    expect(states((await publish()).body)).toEqual(['missing', 'missing', 'missing', 'missing']);
    expect(creates()).toEqual([]);
    deps.appendLine = async (p, l, m) => {
      if (l.includes('"kind":"created"')) throw new Error('fsync EIO');
      return appendLineSynced(p, l, m);
    };
    expect(states((await publish()).body)).toEqual(['unsure', 'missing', 'missing', 'missing']);
    expect(creates()).toHaveLength(1);
  });

  it('(6) a crash between sending and its outcome folds to unsure; a line torn mid-append is skipped; a damaged one is journal_unreadable', async () => {
    deps.appendLine = async (p, l, m) => {
      if (l.includes('"kind":"created"')) throw new Error('crash');
      return appendLineSynced(p, l, m);
    };
    await publish();
    delete deps.appendLine;
    const g = (await getPub()).json() as ProductPublicationsResponse;
    expect(g.publications[0]!.items.map((i) => i.state)).toEqual(['unsure', 'missing', 'missing', 'missing']);
    const root = join(deps.journalDir!, 'product-publish');
    const file = join(root, readdirSync(root)[0]!, readdirSync(join(root, readdirSync(root)[0]!)).find((n) => n.endsWith('.ndjson'))!);
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"v":1,"publication":"x","kind":"crea`);
    expect(((await getPub()).json() as ProductPublicationsResponse).publications).toHaveLength(1);
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n{"v":1,"kind":"nonsense"}\n`);
    const bad = await post({});
    expect(bad.statusCode).toBe(409);
    expect(bad.json()).toMatchObject({ code: 'journal_unreadable' });
  });

  it('(13) resolve while a confirm holds the slot is in_progress; resolve on a created key is not_unsure', async () => {
    const c = await card();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const real = gate.pm.vendorRead.bind(gate.pm);
    deps.pm = {
      vendorRead: async (e, tool, args, cls, before, cred) => {
        if (tool === 'issue_write') await held;
        return real(e, tool, args, cls, before, cred);
      },
    };
    const sending = post({ confirm: c.publishHash });
    await new Promise((r) => setTimeout(r, 200));
    for (let i = 0; i < 100 && !journal().some((l) => l['kind'] === 'sending'); i++) await new Promise((r) => setTimeout(r, 100));
    expect((await post({ resolve: { key: 'e1', issue: null } })).json()).toMatchObject({ code: 'in_progress' });
    // GET shows the item being sent while this daemon holds its slot.
    expect(((await getPub()).json() as ProductPublicationsResponse).publications[0]!.items[0]!.state).toBe('sending');
    release();
    expect((await sending).statusCode).toBe(200);
    deps.pm = gate.pm;
    expect((await post({ resolve: { key: 'e1', issue: null } })).json()).toMatchObject({ code: 'not_unsure' });
  });
});

describe('the run and its plan', () => {
  const refusal = async (code: string, error?: RegExp): Promise<void> => {
    const r = await post({});
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json()).toMatchObject({ code });
    if (error !== undefined) expect(r.json().error).toMatch(error);
    // The same reason is there before the click.
    const g = (await getPub()).json() as ProductPublicationsResponse;
    expect(g.publishable).toMatchObject({ ok: false, code });
    expect(creates()).toEqual([]);
  };

  it('(7) not a compose: no compose facts (a run from before this shipped), or another project', async () => {
    index = new RunTimingIndex();
    await refusal('not_a_compose', /compose again to publish/);
    index.noteLaunchFacts(RUN, { compose: composeFactsOf('proj_other', REFS, 'stories', FIX.draft, FIX.review) });
    await refusal('not_a_compose');
  });

  it('(7) a plan edited at its gate (same unit ids, other instructions or catalog) is compose_unverified, in plain words', async () => {
    const draft = view.units.find((u) => u.id === `${RUN}:draft`)!;
    draft.instructions = `${draft.instructions}\nAlso add an epic for billing.`;
    // crew#1902: a change to the instructions is taken only as a person's gate edit the view proves; this view has none.
    await refusal('compose_unverified', /^crew cannot confirm this plan's change was a person's edit at its gate \(the engine did not record which plan revision the draft step ran under\); compose again to publish$/);
    view = structuredClone(FIX.view);
    view.units.find((u) => u.id === `${RUN}:review`)!.catalog = 'review';
    await refusal('compose_unverified');
    view = structuredClone(FIX.view);
    view.units.find((u) => u.id === `${RUN}:draft`)!.amendments = ['more epics'];
    await refusal('compose_unverified');
    view = structuredClone(FIX.view);
    delete view.units.find((u) => u.id === `${RUN}:draft`)!.instructions; // an older engine: not an edit, said so
    await refusal('compose_unverified', /^crew cannot confirm this is the compose as it was launched \(the engine did not record the draft step's instructions\); compose again to publish$/);
  });

  describe('crew#1902: a plan a person edited at its gate', () => {
    // tests/fixtures/product/compose-run-view-edited.json: wicked-crew CI on core main (#1912, after wicked-core#1929): a
    // compose held at its plan gate, EDITED there through adapter.confirmGate(plan) (the draft's instructions changed,
    // both step ids kept), accepted (plan rev 2 -> 3), and confirmed to completion. The draft unit ran the edited text.
    // tests/fixtures/product/compose-run-view-edited-note.json: the same through the crew#1902 probe (#1986, CI on core
    // main), the edit carrying the note "Keep billing small.".
    type Fix = typeof FIX;
    const EDITED_FIX = JSON.parse(readFileSync(join(HERE, 'fixtures', 'product', 'compose-run-view-edited.json'), 'utf8')) as Fix;
    const NOTE_FIX = JSON.parse(readFileSync(join(HERE, 'fixtures', 'product', 'compose-run-view-edited-note.json'), 'utf8')) as Fix;
    // tests/fixtures/product/compose-run-view-review-edited-note.json (codex on #1988): only the REVIEW was edited at the
    // gate, with a note; the engine put the note on the unchanged DRAFT's description (its instructions are the launch's).
    const REVIEW_NOTE_FIX = JSON.parse(readFileSync(join(HERE, 'fixtures', 'product', 'compose-run-view-review-edited-note.json'), 'utf8')) as Fix;
    type Accepted = { rev: number; by: string; proposal_id: string; steps: { steps: Array<Record<string, unknown>> } };
    const acceptedOf = (v: SessionView) => (v.session as unknown as { team_plan: { accepted: Accepted } }).team_plan.accepted;
    const unitOf = (v: SessionView, id: string) => v.units.find((u) => u.id === `${v.session.id}:${id}`)! as SessionView['units'][number] & { plan_rev?: number };
    /** An independent spelling of wicked-core's mint_proposal_id (team/events.rs, bus.rs deterministic_key). */
    const mint = (run: string, by: string, source: string): string => {
      const h = createHash('sha256');
      for (const part of [run, by, source]) { h.update(part, 'utf8'); h.update(Buffer.from([0])); }
      return `p-${h.digest('hex').slice(0, 32)}`;
    };
    async function withRun<T>(fix: Fix, mutate: (v: SessionView, runId: string) => void, fn: (runId: string) => Promise<T>): Promise<T> {
      const ed = structuredClone(fix);
      const runId = ed.view.session.id;
      mutate(ed.view, runId);
      view = ed.view;
      index = new RunTimingIndex();
      index.noteLaunchFacts(runId, { compose: composeFactsOf(PID, REFS, 'stories', ed.draft, ed.review) });
      const before = deps.runView;
      const beforeOut = deps.workOutput;
      deps.runView = async (id) => (id === runId ? view : undefined);
      deps.workOutput = async (id) => (id === `${runId}:draft` ? output : null);
      try {
        return await fn(runId);
      } finally {
        deps.runView = before;
        deps.workOutput = beforeOut;
      }
    }
    const postRun = (runId: string, payload: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: `/api/v1/projects/${PID}/product/publish`, payload: { runId, repo: 'owner/app', ...payload } });
    const getRun = (runId: string) => app.inject({ method: 'GET', url: `/api/v1/projects/${PID}/product/publish/${runId}` });
    const refusedWith = async (runId: string, detail: RegExp, error?: RegExp | string): Promise<Record<string, unknown>> => {
      const r = await postRun(runId);
      expect(r.statusCode, r.body).toBe(409);
      const body = r.json() as Record<string, unknown>;
      expect(body['code']).toBe('compose_unverified');
      expect(String(body['detail'])).toMatch(detail);
      if (error !== undefined) expect(body['error']).toEqual(typeof error === 'string' ? error : expect.stringMatching(error));
      const g = (await getRun(runId)).json() as ProductPublicationsResponse;
      expect(g.publishable).toMatchObject({ ok: false, code: 'compose_unverified' });
      expect(creates()).toEqual([]);
      return body;
    };

    it('the fixtures are the engine\'s: the accepted rev 3 is the gate edit\'s proposal, minted from gate 1', () => {
      for (const fix of [EDITED_FIX, NOTE_FIX]) {
        const runId = fix.view.session.id;
        const a = acceptedOf(fix.view);
        expect(a).toMatchObject({ rev: 3, by: 'human' });
        expect(a.proposal_id).toBe(mint(runId, 'human', `g-${runId}-1`));
        expect(unitOf(fix.view, 'draft').plan_rev).toBe(3);
        expect(unitOf(fix.view, 'draft').instructions).not.toBe(fix.draft);
      }
      // The note is on the description only: never in amendments, never in the instructions.
      const d = unitOf(NOTE_FIX.view, 'draft');
      expect(d.amendments ?? []).toEqual([]);
      expect(d.description.endsWith(' (operator amendment: Keep billing small.)')).toBe(true);
      expect(d.instructions).not.toContain('Keep billing small.');
    });

    it('publishes, and the card says it is the plan as edited at its gate (rev 3); the GET agrees before the click', async () => {
      await withRun(EDITED_FIX, () => {}, async (runId) => {
        const g = (await getRun(runId)).json() as ProductPublicationsResponse;
        expect(g.publishable).toMatchObject({ ok: true });
        const c = await postRun(runId);
        expect(c.statusCode, c.body).toBe(200);
        const shown = c.json() as { publishHash: string; card: { edited?: unknown; items: unknown[] } };
        expect(shown.card.edited).toEqual({ planRev: 3 });
        const r = await postRun(runId, { confirm: shown.publishHash });
        expect(r.statusCode, r.body).toBe(200);
        expect(creates()).toHaveLength(KEYS.length);
        // The journal keeps the card the person confirmed, edited flag and all.
        expect(journal().find((l) => l['kind'] === 'approved')!['card']).toMatchObject({ edited: { planRev: 3 } });
      });
    });

    it('an unedited compose\'s card has no edited flag (its hash does not move)', async () => {
      const c = await card();
      expect('edited' in (c.card as Record<string, unknown>)).toBe(false);
    });

    it('STALE READS: the revision published is the one the draft ran under; a card read before the view changed is card_changed', async () => {
      // The draft ran under rev 2 while the run's accepted plan is rev 3: rev 2 is not on the view, so it is not confirmed.
      await withRun(EDITED_FIX, (v) => { unitOf(v, 'draft').plan_rev = 2; }, async (runId) => {
        await refusedWith(runId, /^the draft step ran under plan revision 2, which is not the run's accepted plan$/, /^crew cannot confirm this plan's change was a person's edit at its gate \(the draft step ran under plan revision 2/);
      });
      // A card shown as edited, then a view where the draft ran the launched text: the hash the person saw is refused.
      await withRun(EDITED_FIX, () => {}, async (runId) => {
        const shown = (await postRun(runId)).json() as { publishHash: string };
        unitOf(view, 'draft').instructions = EDITED_FIX.draft;
        const r = await postRun(runId, { confirm: shown.publishHash });
        expect(r.json()).toMatchObject({ code: 'card_changed' });
        expect(creates()).toEqual([]);
      });
    });

    it('IDENTITY REUSE: a change that is not a person\'s edit at a gate, or a step the revision did not accept, is refused', async () => {
      const notGate = /^plan revision 3 was not a person's edit at the plan's gate$/;
      // A person's change through the mid-run edit route (source Edit{request_id}).
      await withRun(EDITED_FIX, (v, runId) => { acceptedOf(v).proposal_id = mint(runId, 'human', 'req-7'); }, (runId) => refusedWith(runId, notGate));
      // A seat's plan (by a seat, even from a gate's id).
      await withRun(EDITED_FIX, (v, runId) => { acceptedOf(v).proposal_id = mint(runId, 'claude#1', `g-${runId}-1`); }, (runId) => refusedWith(runId, notGate));
      // A gate the run never opened (its counter says 1).
      await withRun(EDITED_FIX, (v, runId) => { acceptedOf(v).proposal_id = mint(runId, 'human', `g-${runId}-2`); }, (runId) => refusedWith(runId, notGate));
      // Rev 3's draft step is other text than the draft ran.
      await withRun(EDITED_FIX, (v) => { acceptedOf(v).steps.steps.find((x) => x['id'] === 'draft')!['instructions'] = 'Something else.'; },
        (runId) => refusedWith(runId, /^the draft step is not the one plan revision 3 accepted$/));
      // Rev 3 names the draft under another catalog than the unit's.
      await withRun(EDITED_FIX, (v) => { acceptedOf(v).steps.steps.find((x) => x['id'] === 'draft')!['catalog'] = 'understand'; },
        (runId) => refusedWith(runId, /^the draft step is not the one plan revision 3 accepted$/));
      // The unit's catalog is no longer Compose's: refused as before, whatever the revision says.
      await withRun(EDITED_FIX, (v) => { unitOf(v, 'draft').catalog = 'understand'; acceptedOf(v).steps.steps.find((x) => x['id'] === 'draft')!['catalog'] = 'understand'; },
        (runId) => refusedWith(runId, /^the draft step is not the produce step Compose launched$/));
    });

    it('PARTIAL FAILURE: no plan_rev, no accepted plan, no gate counter or no accepted steps on the view is not confirmed', async () => {
      await withRun(EDITED_FIX, (v) => { delete unitOf(v, 'draft').plan_rev; }, (runId) => refusedWith(runId, /^the engine did not record which plan revision the draft step ran under$/));
      await withRun(EDITED_FIX, (v) => { (v.session as unknown as { team_plan: unknown }).team_plan = null; }, (runId) => refusedWith(runId, /^the draft step ran under plan revision 3, which is not the run's accepted plan$/));
      await withRun(EDITED_FIX, (v) => { delete (v.session as unknown as { team: Record<string, unknown> }).team['gate_seq']; }, (runId) => refusedWith(runId, /^plan revision 3 was not a person's edit at the plan's gate$/));
      await withRun(EDITED_FIX, (v) => { (acceptedOf(v) as unknown as Record<string, unknown>)['steps'] = null; }, (runId) => refusedWith(runId, /^the draft step is not the one plan revision 3 accepted$/));
    });

    it('a gate edit that carried a note is refused in its own words (coord Q1; crew#1983)', async () => {
      const words = "this plan was edited at its gate with a note; publishing an edited plan with a note isn't supported yet: edit it without a note, or compose again to publish";
      await withRun(NOTE_FIX, () => {}, (runId) => refusedWith(runId, /^the draft step carries a note from its gate$/, words));
      // codex on #1988: the note lands on the step the plan releases next, not the edited one. Only the review was edited;
      // the draft, unchanged, carries the note: still refused.
      const d = unitOf(REVIEW_NOTE_FIX.view, 'draft');
      expect(d.instructions).toBe(REVIEW_NOTE_FIX.draft);
      expect(d.description.endsWith(' (operator amendment: Keep billing small.)')).toBe(true);
      expect(unitOf(REVIEW_NOTE_FIX.view, 'review').instructions).not.toBe(REVIEW_NOTE_FIX.review);
      await withRun(REVIEW_NOTE_FIX, () => {}, (runId) => refusedWith(runId, /^the draft step carries a note from its gate$/, words));
      // codex r2: a note that itself ends with the edited instructions (the person wrote both) is still a note.
      await withRun(NOTE_FIX, (v) => {
        const draft = unitOf(v, 'draft');
        const text = `${draft.instructions!})`;
        draft.instructions = text;
        acceptedOf(v).steps.steps.find((x) => x['id'] === 'draft')!['instructions'] = text;
        draft.description = `${draft.description.split(' ||| ')[0]} ||| ${text} (operator amendment: see ${text.slice(0, -1)})`;
        expect(draft.description.endsWith(text)).toBe(true);
      }, (runId) => refusedWith(runId, /^the draft step carries a note from its gate$/, words));
    });

    it('UNTRUSTED TEXT OUT: the edited instructions reach neither the card nor a refusal', async () => {
      const marked = (v: SessionView) => {
        const text = `${unitOf(v, 'draft').instructions!}\nMARKER-1902 <b>x</b>`;
        unitOf(v, 'draft').instructions = text;
        unitOf(v, 'draft').description = `${unitOf(v, 'draft').description.split(' ||| ')[0]} ||| ${text}`;
        acceptedOf(v).steps.steps.find((x) => x['id'] === 'draft')!['instructions'] = text;
      };
      await withRun(EDITED_FIX, marked, async (runId) => {
        const c = await postRun(runId);
        expect(c.statusCode, c.body).toBe(200);
        expect(c.body).not.toMatch(/MARKER-1902/);
      });
      await withRun(EDITED_FIX, (v) => { marked(v); acceptedOf(v).steps.steps.find((x) => x['id'] === 'draft')!['instructions'] = 'MARKER-1902 other'; }, async (runId) => {
        const body = await refusedWith(runId, /not the one plan revision 3 accepted/);
        expect(JSON.stringify(body)).not.toMatch(/MARKER-1902/);
        expect((await getRun(runId)).body).not.toMatch(/MARKER-1902/);
      });
    });
  });

  it('(7) not finished; the plan block unparsable; a ref not covered or invented; stories at the epics level', async () => {
    view.session.status = 'awaiting_human';
    await refusal('run_not_finished');
    view = structuredClone(FIX.view);
    output = 'Here is the plan.\n```json\n{"epics": [\n```\n';
    await refusal('plan_unreadable', /not valid JSON/);
    output = draftText({ epics: [{ title: 'A', features: [{ title: 'F', requirementRefs: [REFS[0]], stories: [] }] }] });
    await refusal('plan_unreadable', /no feature covers requirement repo-a REQ-2/);
    output = draftText({ epics: [{ title: 'A', features: [{ title: 'F', requirementRefs: [...REFS, { repoId: 'repo-a', key: 'REQ-9' }], stories: [] }] }] });
    await refusal('plan_unreadable', /REQ-9, which this compose was not given/);
    output = draftText(PLAN);
    facts('epics');
    await refusal('plan_unreadable', /e1\.f1 has stories, but this compose drafted epics and features only/);
  });

  it('(14) a zero-width space in a title is plan_unreadable naming the item; the sanitizer table holds', async () => {
    output = draftText({ epics: [{ ...PLAN.epics[0]!, features: [{ ...PLAN.epics[0]!.features[0]!, stories: [{ title: 'Email​ sign in', acceptance: [] }, PLAN.epics[0]!.features[0]!.stories[1]!] }] }] });
    await refusal('plan_unreadable', /title of e1\.f1\.s1 has an invisible character \(U\+200B\)/);
    // A character reference GitHub's server would decode does not round-trip; `Q&A` does.
    output = draftText({ epics: [{ ...PLAN.epics[0]!, title: 'Use &lt; 3 attempts' }] });
    await refusal('plan_unreadable', /title of e1 has "&" right before/);
    output = draftText({ epics: [{ ...PLAN.epics[0]!, title: 'Q&A for accounts' }] });
    expect((await post({})).statusCode).toBe(200);
    // A requirement key is checked like any other text of a body.
    const odd = [{ repoId: 'repo-a', key: 'REQ-1\u200b' }, REFS[1]!];
    facts('stories', odd);
    output = draftText({ epics: [{ ...PLAN.epics[0]!, features: [{ ...PLAN.epics[0]!.features[0]!, requirementRefs: odd }] }] });
    await refusal('plan_unreadable', /requirement repo-a REQ-1.*invisible character \(U\+200B\)/);
    expect(strippedCharacter('ok ✅ ❤️ #️⃣')).toBeNull();
    expect(strippedCharacter('a️')).toBe('U+FE0F');
    expect(strippedCharacter(' ️')).toBe('U+FE0F');
    expect(strippedCharacter('x‮')).toBe('U+202E');
    expect(strippedCharacter('x\ud800')).toBe('U+D800');
  });

  it('(3) two sources linking the repository is ambiguous until the source is named; a write tool left off is write_tool_off', async () => {
    world({ second: true });
    expect((await post({})).json()).toMatchObject({ code: 'ambiguous' });
    const named = await post({ repo: 'gh2:owner/app' });
    expect(named.statusCode, named.body).toBe(200);
    world({ writeOn: false });
    expect((await post({})).json()).toMatchObject({ code: 'write_tool_off' });
  });
});

describe('who may publish, and the read-back', () => {
  it('(8) an agent, or a person below operator trust, gets 403 on POST and GET', async () => {
    actor = { id: 'seat:claude', kind: 'agent', trust: 'admin' };
    expect((await post({})).statusCode).toBe(403);
    expect((await getPub()).statusCode).toBe(403);
    actor = { id: 'viewer', kind: 'human', trust: 'observer' };
    expect((await post({})).json()).toMatchObject({ code: 'publish_human_only' });
    expect((await getPub()).statusCode).toBe(403);
  });

  it('(11) a retitled or edited issue reads back differs, a deleted one unreadable; published turns false', async () => {
    await publish();
    const st = issues();
    st.issues[0]!.title = 'Accounts (renamed on GitHub)';
    st.issues[2]!.deleted = true;
    writeFileSync(join(ghLog, 'issues.json'), JSON.stringify(st));
    // (crew#1911) A read-back that matched is trusted for READ_BACK_FRESH_MS; the edit shows once it is due again.
    expect(((await getPub()).json() as ProductPublicationsResponse).publications[0]!.items.map((i) => i.readBack)).toEqual(['ok', 'ok', 'ok', 'ok']);
    nowMs += READ_BACK_FRESH_MS;
    const g = (await getPub()).json() as ProductPublicationsResponse;
    expect(g.publications[0]!.items.map((i) => i.readBack)).toEqual(['differs', 'ok', 'unreadable', 'ok']);
    expect(g.publications[0]!.published).toBe(false);
  });
});

// crew#1911 — a GET reads GitHub back only where it must, and never beside a send.
describe('reading issues back (crew#1911)', () => {
  const reads = () => calls().filter((c) => c.tool === 'issue_read').length;
  const journalFile = (): string => {
    const root = join(deps.journalDir!, 'product-publish');
    const d = join(root, readdirSync(root)[0]!);
    return join(d, readdirSync(d).find((n) => n.endsWith('.ndjson'))!);
  };
  /** A gate the test opens: `at` resolves when it is reached, `release` lets it go. */
  const gateOf = () => {
    let release!: () => void;
    let reached!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const at = new Promise<void>((r) => (reached = r));
    return { held, at, release, reached };
  };
  const real = () => gate.pm.vendorRead.bind(gate.pm);

  it('the send reads each issue back once, right after creating it; a GET while fresh reads nothing', async () => {
    const order: string[] = [];
    const vr = real();
    deps.pm = {
      vendorRead: async (e, tool, args, cls, before, cred) => {
        if (tool === 'issue_write' || tool === 'issue_read') order.push(tool === 'issue_write' ? 'create' : 'read');
        return vr(e, tool, args, cls, before, cred);
      },
    };
    expect((await publish()).body).toMatchObject({ publication: { published: true } });
    expect(order).toEqual(['create', 'read', 'create', 'read', 'create', 'read', 'create', 'read']);
    const before = reads();
    const g = (await getPub()).json() as ProductPublicationsResponse;
    expect(g.publications[0]).toMatchObject({ published: true });
    expect(reads()).toBe(before);
  });

  it('freshness runs on a monotonic clock: a wall clock stepped back keeps no read-back fresh (crew#1919)', async () => {
    const saved = deps.now!;
    delete deps.now;
    let mono = nowMs + 10 * READ_BACK_FRESH_MS; // past every read-back earlier tests left on the tests' clock
    const perf = vi.spyOn(performance, 'now').mockImplementation(() => mono);
    const wall = vi.spyOn(Date, 'now');
    try {
      await publish();
      wall.mockReturnValue(Date.now() - 3_600_000); // the wall clock steps back an hour
      mono += READ_BACK_FRESH_MS + 1;
      const before = reads();
      await getPub();
      expect(reads() - before).toBe(4);
    } finally {
      perf.mockRestore();
      wall.mockRestore();
      deps.now = saved;
      nowMs = mono; // the read-backs this test left are on its clock: later tests start past them
    }
  });

  it('a GET past the freshness reads again; one that differs or is unreadable is read on every GET until it matches', async () => {
    await publish();
    nowMs += READ_BACK_FRESH_MS;
    let before = reads();
    await getPub();
    expect(reads() - before).toBe(4);
    const st = issues();
    const title = st.issues[1]!.title;
    st.issues[1]!.title = 'Sign in and out (edited on GitHub)';
    st.issues[2]!.deleted = true;
    writeFileSync(join(ghLog, 'issues.json'), JSON.stringify(st));
    nowMs += READ_BACK_FRESH_MS;
    await getPub();
    for (let i = 0; i < 2; i++) {
      before = reads();
      const g = (await getPub()).json() as ProductPublicationsResponse;
      expect(reads() - before).toBe(2);
      expect(g.publications[0]!.items.map((x) => x.readBack)).toEqual(['ok', 'differs', 'unreadable', 'ok']);
    }
    st.issues[1]!.title = title;
    writeFileSync(join(ghLog, 'issues.json'), JSON.stringify(st));
    before = reads();
    expect(((await getPub()).json() as ProductPublicationsResponse).publications[0]!.items[1]!.readBack).toBe('ok');
    expect(reads() - before).toBe(2);
    before = reads();
    await getPub();
    expect(reads() - before).toBe(1);
  });

  it('a read-back stands only for the number and content it was read against', async () => {
    await publish();
    const st = issues();
    const lines = readFileSync(journalFile(), 'utf8').split('\n');
    // The journal now says e1 is another issue (a repaired journal): e1 is read again for its number, and e1.f1, whose
    // body names its parent's number, for its content.
    const other = st.issues[3]!.number;
    writeFileSync(journalFile(), lines.map((l) => (l.includes('"kind":"created"') && l.includes('"key":"e1"') ? l.replace(/"number":\d+/, `"number":${other}`).replace(/issues\/\d+"/, `issues/${other}"`) : l)).join('\n'));
    const before = reads();
    const g = (await getPub()).json() as ProductPublicationsResponse;
    expect(reads() - before).toBe(2);
    expect(g.publications[0]!.items.map((x) => x.readBack)).toEqual(['differs', 'differs', 'ok', 'ok']);
  });

  it('while any publication is being sent, a GET reads nothing and a card waits; an issue not read yet is not checked yet (null)', async () => {
    world({ lib: true });
    // owner/lib is published first: a second publication on the same source, which the GET also reads back.
    const lc = (await post({ repo: 'owner/lib' })).json() as { publishHash: string };
    expect(states((await post({ repo: 'owner/lib', confirm: lc.publishHash })).json())).toEqual(['created', 'created', 'created', 'created']);
    const lib = (x: ProductPublicationsResponse) => x.publications.find((p) => p.repo === 'owner/lib')!.items.map((i) => i.readBack);
    const libBefore = lib((await getPub()).json() as ProductPublicationsResponse);
    const sentS1 = gateOf();
    const readE1f1 = gateOf();
    deps.appendLine = async (p, l, m) => {
      if (l.includes('"kind":"sending"') && l.includes('"key":"e1.f1.s1"') && l.includes('"repo":"owner/app"')) {
        sentS1.reached();
        await sentS1.held;
      }
      return appendLineSynced(p, l, m);
    };
    const vr = real();
    let appE1f1: number | null = null;
    deps.pm = {
      vendorRead: async (e, tool, args, cls, before, cred) => {
        // The sender's read-back of owner/app's e1.f1: its `created` line is on disk, its read-back not yet done.
        if (tool === 'issue_read' && args['repo'] === 'app' && args['issue_number'] === appE1f1) {
          readE1f1.reached();
          await readE1f1.held;
        }
        const r = await vr(e, tool, args, cls, before, cred);
        if (tool === 'issue_write' && args['repo'] === 'app' && args['title'] === 'Sign in and out') appE1f1 = issues().issues.at(-1)!.number;
        return r;
      },
    };
    const scheduled = () => calls().filter((c) => c.tool === 'issue_read' || c.tool === 'get_me').length;
    const c = await card();
    const sending = post({ confirm: c.publishHash });
    try {
      await readE1f1.at;
      let before = scheduled();
      let g = (await getPub()).json() as ProductPublicationsResponse;
      expect(scheduled()).toBe(before);
      const app = (x: ProductPublicationsResponse) => x.publications.find((p) => p.repo === 'owner/app')!;
      // (crew#1919) e1.f1 is created and not read back yet: 'not checked yet', never 'unreadable' (which reads as deleted).
      expect(app(g).items.map((i) => [i.state, i.readBack])).toEqual([['created', 'ok'], ['created', null], ['missing', null], ['missing', null]]);
      expect(app(g).items[1]).toMatchObject({ number: appE1f1, url: expect.stringContaining(`/issues/${appE1f1}`) });
      expect(app(g).published).toBe(false);
      readE1f1.release();
      await sentS1.at;
      nowMs += READ_BACK_FRESH_MS; // nothing is fresh now: an observer would read if it could
      before = scheduled();
      g = (await getPub()).json() as ProductPublicationsResponse;
      const cardNow = await post({ repo: 'owner/lib' });
      expect(cardNow.json()).toMatchObject({ code: 'in_progress' });
      expect(scheduled()).toBe(before);
      expect(app(g).items.map((i) => [i.state, i.readBack])).toEqual([['created', 'ok'], ['created', 'ok'], ['missing', null], ['missing', null]]);
      expect(lib(g)).toEqual(libBefore); // owner/lib's last read-backs, though none is fresh: not read beside the send
    } finally {
      readE1f1.release();
      sentS1.release();
    }
    expect((await sending).json()).toMatchObject({ publication: { published: true } });
  });

  it('every issue created and one not checked yet is not published; once crew has checked it, it is (crew#1919)', async () => {
    const lastRead = gateOf();
    const vr = real();
    let last: number | null = null;
    deps.pm = {
      vendorRead: async (e, tool, args, cls, before, cred) => {
        // The sender's read-back of the last story: every issue's `created` line is on disk, this read-back not done.
        if (tool === 'issue_read' && args['issue_number'] === last) {
          lastRead.reached();
          await lastRead.held;
        }
        const r = await vr(e, tool, args, cls, before, cred);
        if (tool === 'issue_write' && args['title'] === 'Sign out from any page') last = issues().issues.at(-1)!.number;
        return r;
      },
    };
    const c = await card();
    const sending = post({ confirm: c.publishHash });
    try {
      await lastRead.at;
      const before = reads();
      const g = (await getPub()).json() as ProductPublicationsResponse;
      expect(reads()).toBe(before);
      expect(g.publications[0]!.items.map((i) => [i.state, i.readBack])).toEqual([['created', 'ok'], ['created', 'ok'], ['created', 'ok'], ['created', null]]);
      expect(g.publications[0]!.published).toBe(false);
    } finally {
      lastRead.release();
    }
    const done = (await sending).json() as { publication: { published: boolean; items: Array<{ readBack: string | null }> } };
    expect(done.publication.items.map((i) => i.readBack)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(done.publication.published).toBe(true);
  });

  it('a send waits for an observer read already on the source queue before it does anything', async () => {
    let refuse = 2;
    const firstRead = gateOf();
    let blockRead = false;
    const vr = real();
    deps.pm = {
      vendorRead: async (e, tool, args, cls, before, cred) => {
        if (tool === 'issue_write' && --refuse === 0) return { ok: false, code: 'busy', reason: 'the queue was full' } as never;
        if (tool === 'issue_read' && blockRead) {
          blockRead = false;
          firstRead.reached();
          await firstRead.held;
        }
        return vr(e, tool, args, cls, before, cred);
      },
    };
    expect(states((await publish()).body)).toEqual(['created', 'not_sent', 'missing', 'missing']);
    const c = await card();
    nowMs += READ_BACK_FRESH_MS;
    blockRead = true;
    const g = getPub();
    await firstRead.at;
    // The confirm's handler reaches the slot and its wait synchronously after it asks who the actor is; until the
    // observer read ends it must not begin (its first step asks whether the project exists).
    const entered = gateOf();
    const actorOf = deps.actorOf;
    const projectExists = deps.projectExists;
    let asked = 0;
    deps.actorOf = (req) => {
      entered.reached();
      return actorOf(req);
    };
    deps.projectExists = async (id) => {
      asked++;
      return projectExists(id);
    };
    let sending: ReturnType<typeof post> | null = null;
    try {
      sending = post({ confirm: c.publishHash });
      await entered.at;
      await new Promise((r) => setImmediate(r));
      expect(asked).toBe(0);
      expect(creates()).toHaveLength(1);
    } finally {
      firstRead.release();
      deps.actorOf = actorOf;
      deps.projectExists = projectExists;
    }
    await g;
    expect((await sending!).json()).toMatchObject({ publication: { published: true } });
    expect(creates()).toHaveLength(4);
  });
});
