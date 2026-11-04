// DES-PM-001 §3.4 against a real wicked-estate-mcp (WICKED_ESTATE_MCP_EXE; estate >= d6c40e2, wicked-estate#394): the
// tracker projector's generations are accepted, and the reader boundary holds end to end: a unit's visible set (crew's
// T(u)), estate's filtering, and the relay's release. Link tests (i), (ii) and (iv), the projection half. Skipped where
// no binary is given (CI builds no estate); run locally with the binary the integrator uses.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { callEstateTool, callEstateToolRaw } from '../src/core/estate-mcp-client.js';
import { visibleDeps } from '../src/knowledge/package.js';
import { trackerIdOf, trackerLinkIdOf, type StoredTracker } from '../src/knowledge/registry/entry.js';
import { catalogDocId } from '../src/knowledge/shapes/shapes.js';
import { withTrackers } from '../src/knowledge/trackers/map.js';
import { TrackerProjector } from '../src/knowledge/trackers/projector.js';
import { pmEntriesOf, trackerSetOf } from '../src/knowledge/trackers/set.js';
import { releaseVisible } from '../src/mcp/estate-relay.js';
import { McpRegistryStore } from '../src/mcp/registry-store.js';

const EXE = process.env['WICKED_ESTATE_MCP_EXE'] ?? '';
const JIRA_ID = '22222222-0000-4000-8000-00000000j001';
const P = 'proj_p';
const Q = 'proj_q';
const stamp = new Date().toISOString();
const members: Record<string, string[]> = { [P]: ['r'], [Q]: ['r'] };

function tracker(key: string, targets: Array<{ kind: 'project' | 'repo'; id: string }>): StoredTracker {
  const id = trackerIdOf(JIRA_ID, 'c1', key);
  return { id, tenant: 'c1', tenantLabel: 'acme', siteHost: 'acme.atlassian.net', key, label: `${key} project`, links: targets.map((t) => ({ id: trackerLinkIdOf(id, t), target: t, linkedAt: stamp, linkedBy: 'local' })) };
}

describe.skipIf(EXE === '' || process.platform === 'win32')('tracker projection against a real wicked-estate-mcp', () => {
  let base: string;
  let store: McpRegistryStore;
  const env = (): NodeJS.ProcessEnv => ({
    ...process.env,
    HOME: base,
    WICKED_HOME: join(base, 'wicked'),
    WICKED_MEMORY_DB: join(base, 'memory.db'),
    WICKED_KNOWLEDGE_DB: join(base, 'knowledge.db'),
    WICKED_XEDGE_DB: join(base, 'xedge.db'),
    WICKED_ESTATE_DB: ':memory:',
  });
  const io = { spawn: () => spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'] as const, env: env() }), timeoutMs: 60_000 };
  const estate = (tool: string, args: Record<string, unknown>) => callEstateTool(tool, args, io);
  const writeWorld = (trackers: StoredTracker[]): void => {
    const server = { id: JIRA_ID, name: 'jira', kind: 'mcp-stdio', command: '/bin/echo', args: [], url: null, auth: null, pm: { system: 'jira' }, agents: { see: true, query: true, projects: [P, Q], everyProject: false }, enabled: true, health: { state: 'ok', consecutiveFailures: 0, checkedAt: stamp, lastError: null }, registeredAt: stamp, updatedAt: stamp, tools: [], trackers };
    writeFileSync(join(base, 'mcp', 'registry.json'), JSON.stringify({ version: 1, servers: [server] }));
  };
  /** A unit's visible set, as the relay computes it: crew's T(u), acknowledged trackers only, plus its repos and project. */
  const visibleOf = async (pj: TrackerProjector, projectId: string, repoId: string | null): Promise<string[]> => {
    const repos = [...new Set([...(repoId !== null ? [repoId] : []), ...(members[projectId] ?? [])])];
    const set = trackerSetOf(pmEntriesOf(await store.read()), projectId, repos);
    return visibleDeps([], projectId, repos, undefined, set.filter((t) => pj.acknowledged(t.trackerId)).map((t) => t.trackerId));
  };
  /** `knowledge.neighbors` as a unit receives it: estate's answer under its visible set, then the relay's release. */
  const neighborsFor = async (visible: string[], id: string): Promise<{ nodes: Array<{ store: string; id: string }>; edges: Array<{ rel: string; to: { store: string; id: string } }> } | null> => {
    const raw = await callEstateToolRaw('knowledge.neighbors', { id, store: 'knowledge', depth: 1, visible }, io);
    const result = (raw['result'] ?? {}) as Record<string, unknown>;
    if (result['isError'] === true || raw['error'] !== undefined) return null;
    const released = releaseVisible('knowledge.neighbors', result, new Set(visible));
    if (!released.ok) return null;
    return JSON.parse(String((released.result['content'] as Array<{ text: string }>)[0]!.text)) as never;
  };

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'pm-estate-live-'));
    mkdirSync(join(base, 'mcp'), { recursive: true });
    store = new McpRegistryStore(join(base, 'mcp'));
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('(i)+(ii) PROJA is tracked_in P; Q (sharing repo r) sees PROJX tracked_in repo:r, never project:P, and no PROJA', async () => {
    writeWorld([tracker('PROJA', [{ kind: 'project', id: P }]), tracker('PROJB', [{ kind: 'project', id: Q }]), tracker('PROJX', [{ kind: 'repo', id: 'r' }, { kind: 'project', id: P }])]);
    const pj = new TrackerProjector({ store, call: estate, addresses: async () => [{ runId: 'run-1', projectId: P, repoId: 'r', addresses: [{ trackerId: trackerIdOf(JIRA_ID, 'c1', 'PROJA'), source: 'jira', system: 'jira', ref: 'PROJA-1', closing: true }] }], delivered: (id) => (id === 'run-1' ? 'https://github.com/owner/app/pull/7' : undefined) });
    await pj.reconcile();
    for (const k of ['PROJA', 'PROJB', 'PROJX']) expect(pj.projection(trackerIdOf(JIRA_ID, 'c1', k)), k).toBe('current');

    const inP = await visibleOf(pj, P, null);
    const a = await neighborsFor(inP, catalogDocId(trackerIdOf(JIRA_ID, 'c1', 'PROJA'), 'tracker'));
    expect(a?.edges.map((e) => [e.rel, e.to.id])).toContainEqual(['tracked_in', `project:${P}`]);
    // The trail: PROJA-1 addressed by run-1, closed by its PR.
    const issue = await neighborsFor(inP, catalogDocId(trackerIdOf(JIRA_ID, 'c1', 'PROJA'), 'issue/PROJA-1'));
    expect(issue?.nodes.map((n) => `${n.store}:${n.id}`).sort()).toEqual(expect.arrayContaining(['control:run:run-1', 'control:pr:r#7']));

    const inQ = await visibleOf(pj, Q, 'r');
    expect(inQ).not.toContain(`source:${trackerIdOf(JIRA_ID, 'c1', 'PROJA')}`);
    const x = await neighborsFor(inQ, catalogDocId(trackerIdOf(JIRA_ID, 'c1', 'PROJX'), 'tracker'));
    expect(x?.edges.map((e) => e.to.id)).toEqual(['repo:r']);
    expect(await neighborsFor(inQ, catalogDocId(trackerIdOf(JIRA_ID, 'c1', 'PROJA'), 'tracker'))).toBeNull();
    const recall = (await estate('knowledge.recall', { query: 'PROJA project tracker jira', visible: inQ })) as { items: Array<{ scope?: string }> };
    expect(recall.items.filter((i) => i.scope === `source:${trackerIdOf(JIRA_ID, 'c1', 'PROJA')}`)).toEqual([]);
    await expect(estate('knowledge.source_catalog', { sourceId: trackerIdOf(JIRA_ID, 'c1', 'PROJA'), visible: inQ })).rejects.toThrow();

    // The person's map: the trackers, their projects and repo, and the trail.
    const map = await withTrackers(estate, { nodes: [], edges: [], sources: [], shapes: 0, skipped: 0, truncated: false, notes: [] }, ['PROJA', 'PROJB', 'PROJX'].map((k) => ({ id: trackerIdOf(JIRA_ID, 'c1', k), source: 'jira', key: k, label: `${k} project` })), [{ id: P, name: 'Billing' }, { id: Q, name: 'Ops' }], ['repo:r']);
    expect(map.nodes.filter((n) => n.kind === 'tracker').map((n) => n.label).sort()).toEqual(['PROJA', 'PROJB', 'PROJX']);
    expect(map.nodes.find((n) => n.key === `control:project:${P}`)?.label).toBe('Billing');
    expect(map.edges.filter((e) => e.rel === 'tracked_in').map((e) => e.to).sort()).toEqual([`control:project:${P}`, `control:project:${P}`, `control:project:${Q}`, 'repo:r']);
    expect(map.nodes.some((n) => n.kind === 'pr')).toBe(true);
  }, 120_000);

  it('(iv) removing the last link tombstones the tracker: neither neighbours nor the catalog show it', async () => {
    writeWorld([tracker('PROJA', [{ kind: 'project', id: P }])]);
    const pj = new TrackerProjector({ store, call: estate });
    await pj.reconcile();
    const inP = await visibleOf(pj, P, null);
    expect(await neighborsFor(inP, catalogDocId(trackerIdOf(JIRA_ID, 'c1', 'PROJA'), 'tracker'))).not.toBeNull();
    // The routes' unlink: the tracker leaves and is retired.
    writeWorld([]);
    await store.mutate((f) => {
      f.servers[0]!.retired = [{ id: trackerIdOf(JIRA_ID, 'c1', 'PROJA'), since: stamp }];
    });
    await pj.reconcile();
    const visible = [...inP];
    expect(await neighborsFor(visible, catalogDocId(trackerIdOf(JIRA_ID, 'c1', 'PROJA'), 'tracker'))).toBeNull();
    const after = (await store.read()).servers[0]!;
    expect(after.retired).toBeUndefined();
  }, 120_000);
});
