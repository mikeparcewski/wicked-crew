// DES-PM-001 §3 (PM-1): a PM system is a registry entry on the vendor's own MCP server, marked by `pm`, under the
// source safeguards: its tools' bindings are bound to the saved schema; a re-save keeps its switches and links and
// turns "query" off when the execution descriptor changes; a restore turns "query" off; the marker cannot be dropped
// or changed; a non-human cannot register one; its tools never reach the plain broker path, the shim's raw list or Apps.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { registerMcpRoutes } from '../src/api/mcp.js';
import type { Actor } from '../src/core/types.js';
import { setAgentAccess } from '../src/knowledge/gate/sources.js';
import { trackerIdOf } from '../src/knowledge/registry/entry.js';
import { McpBroker } from '../src/mcp/broker.js';
import { McpCallRecordFile } from '../src/mcp/call-records.js';
import type { McpUpstreamConfig } from '../src/mcp/probe.js';
import { McpRegistry } from '../src/mcp/registry.js';
import { McpRegistryStore } from '../src/mcp/registry-store.js';
import type { SecretStore } from '../src/mcp/secrets.js';
import { coreRepoSlug, mayAttachRepo, reRegisterRefusal } from '../src/projects/repo-guard.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { registerProjectRoutes } from '../src/projects/routes.js';
import { ProjectSettingsStore } from '../src/projects/settings.js';

class NoSecrets implements SecretStore {
  readonly available = true;
  async get(): Promise<string | null> {
    return null;
  }
  async has(): Promise<boolean> {
    return false;
  }
  async set(): Promise<void> {}
  async delete(): Promise<void> {}
}

const TOOLS = ['getJiraIssue', 'searchJiraIssuesUsingJql', 'search', 'addOrEditJiraIssueComment'].map((name) => ({ name, description: name, inputSchema: { type: 'object' }, outputSchema: null, annotations: name.startsWith('add') ? { destructiveHint: false } : { readOnlyHint: true } }));
const config = (args: string[], pm: boolean = true): McpUpstreamConfig => ({ name: 'jira', kind: 'mcp-stdio', command: '/bin/echo', args, url: null, auth: { ref: 'env:PM_X', env: 'T' }, ...(pm ? { pm: { system: 'jira' as const } } : {}) });

let base: string;
let store: McpRegistryStore;
let registry: McpRegistry;
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'pm-reg-'));
  mkdirSync(join(base, 'mcp'), { recursive: true });
  store = new McpRegistryStore(join(base, 'mcp'));
  registry = new McpRegistry({ store, secrets: new NoSecrets(), probe: async () => ({ ok: true, serverInfo: null, tools: TOOLS }), discover: () => [], env: { PM_X: 'x' } });
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const save = async (c: McpUpstreamConfig) => registry.save((await registry.preview(c)).previewHash);

describe('a PM entry under the source safeguards', () => {
  it('a save binds the bound read tools (rows) to their schema; every other tool is unbound and unclassed', async () => {
    const pre = await registry.preview(config(['a']));
    const byName = new Map(pre.tools.map((t) => [t.name, t]));
    expect(byName.get('getJiraIssue')).toMatchObject({ disclosure: 'rows', binding: { policy: 'jira/getJiraIssue@1' } });
    expect(byName.get('search')).toMatchObject({ disclosure: null, binding: null });
    const s = await registry.save(pre.previewHash);
    expect(s.pm).toEqual({ system: 'jira' });
    expect(s.agents).toEqual({ see: true, query: false, projects: [], everyProject: false });
    expect(s.tools.find((t) => t.name === 'searchJiraIssuesUsingJql')?.binding).toMatchObject({ inForce: true });
    expect(s.tools.find((t) => t.name === 'addOrEditJiraIssueComment')?.binding).toBeNull();
  });

  it('a re-save keeps the switches and the links; a descriptor change turns query off; the marker is fixed', async () => {
    await setAgentAccess(store, 'jira', { query: true, projects: ['proj_p'] });
    const tid = trackerIdOf((await registry.get('jira')).id, 'c1', 'PROJA');
    await store.mutate((f) => {
      f.servers.find((x) => x.name === 'jira')!.trackers = [{ id: tid, tenant: 'c1', tenantLabel: null, key: 'PROJA', label: 'A', links: [{ id: 'tl_0000000000000000', target: { kind: 'project', id: 'proj_p' }, linkedAt: 'now', linkedBy: 'local' }] }];
    });
    const same = await save(config(['a']));
    expect(same.agents).toMatchObject({ query: true, projects: ['proj_p'] });
    expect(same.trackers?.map((t) => t.key)).toEqual(['PROJA']);
    const moved = await save(config(['b']));
    expect(moved.agents).toMatchObject({ query: false, projects: ['proj_p'] });
    expect(moved.trackers?.map((t) => t.key)).toEqual(['PROJA']);
    await expect(save(config(['b'], false))).rejects.toMatchObject({ code: 'pm_marker_fixed' });
    // With a staged credential, the refused save never writes it, not even for a moment.
    let writes = 0;
    const keyed = new McpRegistry({ store, secrets: { available: true, get: async () => null, has: async () => false, set: async () => void writes++, delete: async () => undefined }, probe: async () => ({ ok: true, serverInfo: null, tools: TOOLS }), discover: () => [], env: { PM_X: 'x' } });
    const staged = await keyed.preview({ ...config(['b'], false), auth: { ref: 'keychain:wicked-mcp/jira', env: 'T' } }, 'new-value');
    await expect(keyed.save(staged.previewHash)).rejects.toMatchObject({ code: 'pm_marker_fixed' });
    expect(writes).toBe(0);
  });

  it('a restore brings the links back with query off, and tells the projector', async () => {
    await setAgentAccess(store, 'jira', { query: true });
    await save(config(['b']));
    const keep = (await registry.generations()).current;
    // Unlink everything, then restore the generation that still had the link.
    await store.mutate((f) => {
      f.servers.find((x) => x.name === 'jira')!.trackers = [];
    });
    let told = 0;
    registry.onRestored = () => void told++;
    const plan = await registry.planRestore(keep);
    expect(plan.queryReset).toContain('jira');
    await registry.restore(plan);
    const after = await registry.get('jira');
    expect(after.trackers?.map((t) => t.key)).toEqual(['PROJA']);
    expect(after.agents).toMatchObject({ query: false });
    expect(told).toBe(1);
  });

  it('a PM source is switched on or off, or removed, by a person only; the agent view lists none of its tools', async () => {
    let actor: Actor = { id: 'seat:x', kind: 'agent', trust: 'admin' };
    const app = Fastify({ logger: false });
    registerMcpRoutes(app, { registry, audit: new AuditLog(join(base, 'audit.log'), () => undefined), actorOf: () => actor } as never);
    await app.ready();
    expect((await app.inject({ method: 'PATCH', url: '/api/v1/mcp/servers/jira', payload: { enabled: false } })).json()).toMatchObject({ code: 'pm_source_human_only' });
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/mcp/servers/jira' })).json()).toMatchObject({ code: 'pm_source_human_only' });
    const view = (await app.inject({ method: 'GET', url: '/api/v1/mcp/servers' })).json() as { servers: Array<{ name: string; tools: unknown[]; pm?: unknown }> };
    expect(view.servers.find((x) => x.name === 'jira')).toMatchObject({ pm: { system: 'jira' }, tools: [] });
    actor = { id: 'local', kind: 'human', trust: 'admin' };
    expect((await app.inject({ method: 'PATCH', url: '/api/v1/mcp/servers/jira', payload: { enabled: true } })).statusCode).toBe(200);
    await app.close();
  });

  it("its tools are never the plain path's: not callable raw, not an Apps tool, refused by a broker with no gate", async () => {
    expect((await registry.callableTools()).filter((t) => t.server === 'jira')).toEqual([]);
    expect(await registry.appTool('jira', 'getJiraIssue')).toBeNull();
    expect((await registry.resolveCall('jira', 'getJiraIssue'))?.pm).toBe(true);
    const broker = new McpBroker({ registry, engine: () => ({ evaluateCall: async () => JSON.stringify({ decision: 'allow', subject: 'mcp:jira/getJiraIssue', class: 'read', ruleIds: [], obligations: [], claimId: 'c', unit: { runId: 'r', ord: 1, attempt: 1, phase: 'p', seat: 's' } }), evaluateOutput: async () => '{}' }) as never, records: new McpCallRecordFile(join(base, 'mcp')) });
    const a = await broker.call({ token: 't', subject: 'mcp:jira/getJiraIssue', args: {} } as never);
    expect(a.body).toMatchObject({ outcome: 'guard_error' });
  });

  it('only a human operator registers a PM source (403 pm_source_human_only)', async () => {
    let actor: Actor = { id: 'seat:x', kind: 'agent', trust: 'admin' };
    const app = Fastify({ logger: false });
    registerMcpRoutes(app, { registry, audit: new AuditLog(join(base, 'audit.log'), () => undefined), actorOf: () => actor } as never);
    await app.ready();
    const body = { name: 'jira-new', kind: 'mcp-stdio', command: '/bin/echo', args: ['z'], pm: { system: 'jira' } };
    const r = await app.inject({ method: 'POST', url: '/api/v1/mcp/servers/preview', payload: body });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json()).toMatchObject({ code: 'pm_source_human_only' });
    actor = { id: 'local', kind: 'human', trust: 'admin' };
    expect((await app.inject({ method: 'POST', url: '/api/v1/mcp/servers/preview', payload: body })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/v1/mcp/servers/preview', payload: { ...body, kind: 'rest', command: undefined, url: 'https://x.example' } })).statusCode).toBe(400);
    await app.close();
  });
});

describe('Q-PM2 at the route: POST /projects/:id/members refuses a non-human crew.repo attach before the engine', () => {
  it('an agent at admin trust gets 403 repo_attach_human_only and nothing is attached; a person attaches', async () => {
    let attached = 0;
    const adapter = {
      projectGet: async (id: string) => ({ id, name: id, status: 'active' }),
      listRepos: async () => [{ id: 'r', name: 'r', root_path: base }],
      sessions: async () => [],
      projectMemberAttach: async (projectId: string, kind: string, ref: string) => {
        attached++;
        return { member: { id: `${projectId}:${kind}:${ref}`, project_id: projectId, member_kind: kind, member_ref: ref, meta: null, attached_at: 0 }, created: true };
      },
      projectMembers: async () => [],
      memberProjects: async () => [],
    } as unknown as CoreAdapter;
    const app = Fastify({ logger: false });
    let actor: Actor = { id: 'seat:x', kind: 'agent', trust: 'admin' };
    app.addHook('onRequest', async (req) => {
      (req as unknown as { actor: Actor }).actor = actor;
    });
    registerProjectRoutes(app, adapter, { bus: null, index: new MembershipIndex(), log: () => {}, settings: new ProjectSettingsStore(join(base, 'settings.json')) });
    await app.ready();
    const r = await app.inject({ method: 'POST', url: '/api/v1/projects/proj_p/members', payload: { kind: 'crew.repo', ref: 'r' } });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json()).toMatchObject({ code: 'repo_attach_human_only' });
    expect(attached).toBe(0);
    actor = { id: 'local', kind: 'human', trust: 'operator' };
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/proj_p/members', payload: { kind: 'crew.repo', ref: 'r' } })).statusCode).toBeLessThan(300);
    expect(attached).toBe(1);
    await app.close();
  });
});

describe('Q-PM2: attaching a repo and re-pointing an existing repo id are a person\'s', () => {
  it("core's slug: four kebab words", () => {
    expect(coreRepoSlug('My Cool Repo Name Extra')).toBe('my-cool-repo-name');
    expect(coreRepoSlug('!!!')).toBe('repo');
    expect(coreRepoSlug('billing-api')).toBe('billing-api');
  });
  it('a non-human may not attach a repo; a person may', () => {
    expect(mayAttachRepo({ id: 'seat:x', kind: 'agent', trust: 'admin' })).toBe(false);
    expect(mayAttachRepo({ id: 'p', kind: 'plugin', trust: 'operator' } as Actor)).toBe(false);
    expect(mayAttachRepo({ id: 'local', kind: 'human', trust: 'operator' })).toBe(true);
  });
  it('a non-human re-registering an existing id at another checkout gets 409 repo_exists; the same checkout, a new name or a person pass', async () => {
    const repos = async () => [{ id: 'billing-api', root_path: base }];
    const agent: Actor = { id: 'seat:x', kind: 'agent', trust: 'admin' };
    expect(await reRegisterRefusal(agent, 'billing-api', join(base, 'mcp'), false, repos)).toMatchObject({ status: 409, body: { code: 'repo_exists' } });
    expect(await reRegisterRefusal(agent, 'billing api', undefined, true, repos)).toMatchObject({ status: 409 });
    expect(await reRegisterRefusal(agent, 'billing-api', base, false, repos)).toBeNull();
    expect(await reRegisterRefusal(agent, 'other', join(base, 'mcp'), false, repos)).toBeNull();
    expect(await reRegisterRefusal({ id: 'local', kind: 'human', trust: 'operator' }, 'billing-api', join(base, 'mcp'), false, repos)).toBeNull();
  });
});
