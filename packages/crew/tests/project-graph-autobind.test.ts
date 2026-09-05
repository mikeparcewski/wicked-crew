// PART B of grounding follow-on #1 — the adapter-level SAFETY NET.
//
// The two interactive seams (chat/edit) now resolve a project-graph binding themselves (PART A),
// but the durable fix is centralized in `CoreAdapter.launchRun`: ANY project-filed launch that did
// not already carry a `projectGraph` gets one resolved for it, so a future project-filed caller
// cannot silently ship a run whose worker sees only its own repo (`run_code_graph_db → None → no
// estate MCP`). What this file pins:
//
//   - projectId set + projectGraph UNSET + the project HAS a built graph → the launch reaches the
//     engine with `projectGraph` populated from the on-disk manifest (repo-less: dbPath, no label);
//   - a repo-bound launch (repoRef set) threads that repoRef through, so the resolved binding
//     carries the `repoLabel` the cross-field guard requires;
//   - projectGraph ALREADY set → the safety net does not re-resolve it (the seams that resolved in
//     PART A pass their own binding, and it must survive verbatim);
//   - projectId UNSET → nothing is resolved and nothing is attached;
//   - the pre-existing crew#327 cross-field validation still fires on explicit bad input — the
//     safety net is inserted BEFORE it, not in place of it.
//
// The engine is stubbed (as in project-graph-launch.test.ts): what a real engine does with the
// binding is wicked-core's tests' business; THIS file's business is what crew hands it. The
// installed addon is >= 0.7.1, so the projectGraph version guard is satisfied (not under test here).
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../src/core/adapter.js';
import { projectGraphDb, projectGraphManifest, repoLabel } from '../src/projects/graph-paths.js';
import type { LaunchOptions } from 'wicked-core-ts';
import type { ProjectMember, RepoEntry } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

let dir: string;
let adapter: CoreAdapter;
let launched: LaunchOptions[];

function stubCore(a: CoreAdapter, name: string, impl: unknown): void {
  (a as unknown as { core: Record<string, unknown> }).core[name] = impl;
}

/** Wire the project's membership + registry through the stub core, JSON-encoded like the addon. */
function stubProject(members: ProjectMember[], repos: RepoEntry[]): void {
  stubCore(adapter, 'projectMembers', () => Promise.resolve(JSON.stringify(members)));
  stubCore(adapter, 'listRepos', () => Promise.resolve(JSON.stringify(repos)));
}

function repoMember(projectId: string, ref: string): ProjectMember {
  return {
    id: `${projectId}:crew.repo:${ref}`,
    project_id: projectId,
    member_kind: 'crew.repo',
    member_ref: ref,
    meta: null,
    attached_at: 0,
    attached_by: 'api',
  };
}

function repoEntry(id: string): RepoEntry {
  return {
    id,
    name: id,
    root_path: join('/repos', id),
    default_branch: 'main',
    registered_at: 0,
    code_graph_db: join('/repos', id, '.codegraph', 'estate.db'),
  };
}

/** A built project graph holding `labels` — db AND manifest, because `projectGraphStatus` ignores a
 *  manifest whose database is gone. Mirrors project-graph-binding.test.ts::buildGraph. */
function buildGraph(projectId: string, labels: string[]): void {
  const db = projectGraphDb(projectId);
  mkdirSync(join(db, '..'), { recursive: true });
  writeFileSync(db, 'a database is all existsSync checks for here');
  writeFileSync(
    projectGraphManifest(projectId),
    JSON.stringify({
      version: 1,
      projectId,
      repos: labels.map((label) => ({
        repoId: label,
        label,
        rootPath: join('/repos', label),
        head: 'abc1234def5678',
        indexedAt: 1,
      })),
    }),
  );
}

const BASE = { problem: 'p', clisJson: '[]' } as const;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pg-autobind-'));
  process.env['WICKED_CREW_PROJECT_GRAPH_ROOT'] = join(dir, 'project-graphs');
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  launched = [];
  stubCore(adapter, 'launchRun', (opts: LaunchOptions) => {
    launched.push(opts);
    return Promise.resolve(opts.sessionId);
  });
});

afterEach(() => {
  adapter.close();
  delete process.env['WICKED_CREW_PROJECT_GRAPH_ROOT'];
  removeScratch(dir);
});

describe('launchRun auto-binds a project graph for a project-filed launch (grounding follow-on #1, PART B)', () => {
  it('resolves and attaches the project graph when projectId is set, projectGraph is unset, and the project has a graph (repo-less)', async () => {
    buildGraph('proj-1', ['engine-repo']);
    stubProject([repoMember('proj-1', 'engine-repo')], [repoEntry('engine-repo')]);

    const id = await adapter.launchRun({ ...BASE, sessionId: 'r1', projectId: 'proj-1' });

    expect(id).toBe('r1');
    expect(launched).toHaveLength(1);
    // Repo-less: the binding is the project db with NO label (the worker spans every bound repo).
    expect(launched[0]?.projectGraph).toStrictEqual({ dbPath: projectGraphDb('proj-1') });
    expect(launched[0]?.projectId).toBe('proj-1');
  });

  it('threads repoRef through so a repo-bound launch gets the repoLabel the cross-field guard needs', async () => {
    buildGraph('proj-1', ['engine-repo']);
    stubProject([repoMember('proj-1', 'engine-repo')], [repoEntry('engine-repo')]);

    const id = await adapter.launchRun({
      ...BASE,
      sessionId: 'r2',
      projectId: 'proj-1',
      repoRef: 'engine-repo',
    });

    expect(id).toBe('r2');
    // A repo-bound binding MUST carry the label, else the crew#327 guard below would have thrown.
    expect(launched[0]?.projectGraph).toStrictEqual({
      dbPath: projectGraphDb('proj-1'),
      repoLabel: repoLabel('engine-repo'),
    });
  });

  it('does NOT re-resolve a projectGraph the caller already supplied — the seam-resolved binding survives verbatim', async () => {
    // A DIFFERENT graph exists on disk; the caller's explicit binding must win, proving the safety
    // net's `=== undefined` guard leaves an already-resolved launch (draft/demo/chat/edit) untouched.
    buildGraph('proj-1', ['engine-repo']);
    stubProject([repoMember('proj-1', 'engine-repo')], [repoEntry('engine-repo')]);

    const explicit = { dbPath: '/explicit/seam/estate.db' };
    const id = await adapter.launchRun({
      ...BASE,
      sessionId: 'r3',
      projectId: 'proj-1',
      projectGraph: explicit,
    });

    expect(id).toBe('r3');
    expect(launched[0]?.projectGraph).toStrictEqual(explicit);
    expect(launched[0]?.projectGraph?.dbPath).not.toBe(projectGraphDb('proj-1'));
  });

  it('leaves a launch with NO projectId untouched — nothing is resolved, nothing is attached', async () => {
    // A graph even exists for proj-1, but this launch is unfiled, so the safety net never fires.
    buildGraph('proj-1', ['engine-repo']);
    stubProject([repoMember('proj-1', 'engine-repo')], [repoEntry('engine-repo')]);

    const id = await adapter.launchRun({ ...BASE, sessionId: 'r4' });

    expect(id).toBe('r4');
    expect(launched[0]?.projectGraph).toBeUndefined();
  });

  it('attaches nothing when the project has no built graph (degrade to null keeps the launch)', async () => {
    // Members exist but no graph was ever built → resolveProjectGraphBinding returns null.
    stubProject([repoMember('proj-1', 'engine-repo')], [repoEntry('engine-repo')]);

    const id = await adapter.launchRun({ ...BASE, sessionId: 'r5', projectId: 'proj-1' });

    expect(id).toBe('r5');
    expect(launched).toHaveLength(1);
    expect(launched[0]?.projectGraph).toBeUndefined();
  });

  it('degrades to no binding (never throws) when the membership lookup itself fails', async () => {
    stubCore(adapter, 'projectMembers', () => Promise.reject(new Error('store unavailable')));
    stubCore(adapter, 'listRepos', () => Promise.resolve('[]'));

    const id = await adapter.launchRun({ ...BASE, sessionId: 'r6', projectId: 'proj-1' });

    expect(id).toBe('r6');
    expect(launched[0]?.projectGraph).toBeUndefined();
  });

  // ── the pre-existing crew#327 cross-field validation is inserted-BEFORE, not replaced ──────────
  it('still THROWS on an explicit projectGraph without a projectId (validation fires after the safety net)', async () => {
    await expect(
      adapter.launchRun({ ...BASE, sessionId: 'r7', projectGraph: { dbPath: '/graphs/p1/estate.db' } }),
    ).rejects.toThrow(/must be filed into that project|pass projectId/);
    expect(launched).toHaveLength(0);
  });

  it('still THROWS on an explicit repo-bound projectGraph with no repoLabel', async () => {
    await expect(
      adapter.launchRun({
        ...BASE,
        sessionId: 'r8',
        projectId: 'proj-1',
        repoRef: 'engine-repo',
        projectGraph: { dbPath: '/graphs/p1/estate.db' },
      }),
    ).rejects.toThrow(/repoLabel/);
    expect(launched).toHaveLength(0);
  });
});
