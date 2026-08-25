/**
 * WHICH graph a run launched into a project is bound to — the launch-time decision, not the query.
 *
 * # Why this is its own file
 *
 * project-graph-route.test.ts pins that the graph SURFACE names its own degradation. This pins what
 * a LAUNCH does with the same information, and the two answers differ on purpose: `GET /graph`
 * reports a partially-indexed project as `ready` with a warning, while a launch has to make a
 * binary choice — project graph or repo graph — for a worker that will act on it.
 *
 * The property under test is not "the happy path binds". It is that the ONE case which would give a
 * worker tools that deny the existence of the code in its own worktree — a project graph that does
 * not hold the run's own repo — declines to bind, and says which refresh would fix it. That case is
 * FINDING-069's shape arriving through a new door, and it is reachable by nothing worse than
 * attaching a repo to a project and launching before anyone refreshes.
 *
 * Nothing here spawns `wicked-estate`: every case is decided from the manifest and the membership,
 * before a binary would run. The engine re-verifies all of it against the database itself
 * (`actor::project_code_graph_db`); these tests pin crew's half — the half that has the CAUSE.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveProjectGraphBinding } from '../src/projects/graph.js';
import { projectGraphDb, projectGraphManifest } from '../src/projects/graph-paths.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { ProjectMember, RepoEntry } from '../src/core/types.js';

const PROJECT_ID = 'proj_bind';

function repoMember(ref: string): ProjectMember {
  return {
    id: `${PROJECT_ID}:crew.repo:${ref}`,
    project_id: PROJECT_ID,
    member_kind: 'crew.repo',
    member_ref: ref,
    meta: null,
    attached_at: 0,
    attached_by: 'api',
  };
}

function repo(id: string): RepoEntry {
  return {
    id,
    name: id,
    root_path: join('/repos', id),
    default_branch: 'main',
    registered_at: 0,
    code_graph_db: join('/repos', id, '.codegraph', 'estate.db'),
  };
}

function adapterFor(members: ProjectMember[], repos: RepoEntry[]): CoreAdapter {
  return {
    projectMembers: vi.fn(async () => members),
    listRepos: vi.fn(async () => repos),
  } as unknown as CoreAdapter;
}

/**
 * A built project graph holding exactly `labels`.
 *
 * Both artifacts, because `projectGraphStatus` deliberately ignores a manifest whose database is
 * gone — a manifest alone would report every repo indexed into a file that does not exist.
 */
function buildGraph(labels: string[]): void {
  const db = projectGraphDb(PROJECT_ID);
  mkdirSync(join(db, '..'), { recursive: true });
  writeFileSync(db, 'a database is all `existsSync` checks for here');
  writeFileSync(
    projectGraphManifest(PROJECT_ID),
    JSON.stringify({
      version: 1,
      projectId: PROJECT_ID,
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

let graphRoot: string;

beforeEach(() => {
  graphRoot = mkdtempSync(join(tmpdir(), 'crew-bind-'));
  process.env['WICKED_CREW_PROJECT_GRAPH_ROOT'] = graphRoot;
});

afterEach(() => {
  delete process.env['WICKED_CREW_PROJECT_GRAPH_ROOT'];
  rmSync(graphRoot, { recursive: true, force: true });
});

describe('resolveProjectGraphBinding — what a run launched into a project gets to see', () => {
  it('binds the project graph when it holds the run’s own repo', async () => {
    buildGraph(['engine-repo', 'daemon-repo']);
    const adapter = adapterFor(
      [repoMember('engine-repo'), repoMember('daemon-repo')],
      [repo('engine-repo'), repo('daemon-repo')],
    );

    const { binding, reason } = await resolveProjectGraphBinding(adapter, PROJECT_ID, 'engine-repo');

    expect(binding).toEqual({ dbPath: projectGraphDb(PROJECT_ID), repoLabel: 'engine-repo' });
    // The label is what lets the engine verify the binding rather than trust it, so it is not
    // optional decoration on a repo run.
    expect(binding?.repoLabel).toBe('engine-repo');
    expect(reason).toMatch(/bound to the project graph/);
  });

  /**
   * THE CASE THIS EXISTS FOR. The graph is healthy and holds a sibling; the run's own repo was
   * attached after the last refresh. Binding it would hand the worker tools that answer "not found"
   * about the file it is editing.
   */
  it('refuses when the graph does not hold the run’s own repo, and names the refresh', async () => {
    buildGraph(['daemon-repo']);
    const adapter = adapterFor(
      [repoMember('engine-repo'), repoMember('daemon-repo')],
      [repo('engine-repo'), repo('daemon-repo')],
    );

    const { binding, reason } = await resolveProjectGraphBinding(adapter, PROJECT_ID, 'engine-repo');

    expect(binding).toBeNull();
    expect(reason).toMatch(/does not hold 'engine-repo'/);
    expect(reason).toMatch(/answer "not found" about its own worktree/);
    expect(reason).toMatch(/graph\/refresh/);
  });

  /**
   * The remedy is per-CAUSE, not a suffix (Copilot on #327). A member ref the registry no longer
   * knows has no repo to index, so a refresh reports the same dangling member and changes nothing.
   * Sending an operator mid-incident to run one costs them the time AND the trust to believe the
   * next message, so this branch names the two actions that DO resolve it.
   */
  it('does NOT prescribe a refresh for a dangling member — a refresh cannot fix it', async () => {
    buildGraph(['daemon-repo']);
    // 'ghost-repo' is attached as a member but absent from the registry: the dangling shape.
    const adapter = adapterFor(
      [repoMember('ghost-repo'), repoMember('daemon-repo')],
      [repo('daemon-repo')],
    );

    const { binding, reason } = await resolveProjectGraphBinding(adapter, PROJECT_ID, 'ghost-repo');

    expect(binding).toBeNull();
    expect(reason).toMatch(/registry no longer knows this ref/);
    expect(reason).not.toMatch(/graph\/refresh/);
    expect(reason).toMatch(/Re-register the repo|DELETE .*\/members\//);
  });

  /**
   * The moved-root cause already spells out its own longer remedy (estate refuses to rebind a
   * label to a new root, so the graph has to be rebuilt). Appending the generic refresh line after
   * it contradicted the nuance the reason had just supplied.
   */
  it('leaves the moved-root reason to carry its own remedy, un-suffixed', async () => {
    buildGraph(['engine-repo']);
    // The registry now points somewhere else than the manifest rows were indexed from.
    const moved: RepoEntry = { ...repo('engine-repo'), root_path: '/repos/engine-repo-moved' };
    const adapter = adapterFor([repoMember('engine-repo')], [moved]);

    const { binding, reason } = await resolveProjectGraphBinding(adapter, PROJECT_ID, 'engine-repo');

    expect(binding).toBeNull();
    expect(reason).toMatch(/describe a different checkout/);
    // Its own text names the refresh AND the rebuild fallback; what must not appear is the flat
    // "POST …/graph/refresh fixes it." claim tacked on the end.
    expect(reason).not.toMatch(/graph\/refresh fixes it\./);
  });

  /**
   * PARTIAL is bound, deliberately. The run's own repo is described correctly, so the graph is a
   * strict superset of the per-repo graph; refusing would return LESS because it was not enough.
   * The partiality is stated rather than hidden.
   */
  it('binds a graph that is missing some OTHER member, and says answers are partial', async () => {
    buildGraph(['engine-repo']);
    const adapter = adapterFor(
      [repoMember('engine-repo'), repoMember('daemon-repo')],
      [repo('engine-repo'), repo('daemon-repo')],
    );

    const { binding, reason } = await resolveProjectGraphBinding(adapter, PROJECT_ID, 'engine-repo');

    expect(binding?.repoLabel).toBe('engine-repo');
    expect(reason).toMatch(/1 member repo\(s\) are not in it/);
    expect(reason).toMatch(/partial/);
  });

  it('does not index at launch: a project graph that was never built just degrades', async () => {
    const adapter = adapterFor([repoMember('engine-repo')], [repo('engine-repo')]);

    const { binding, reason } = await resolveProjectGraphBinding(adapter, PROJECT_ID, 'engine-repo');

    expect(binding).toBeNull();
    expect(reason).toMatch(/no code graph yet/);
    expect(reason).toMatch(/own repo's code graph/);
    // The launch touched nothing. An index here would block the response for as long as the
    // slowest member repo takes.
    expect(adapter.listRepos).toHaveBeenCalled();
  });

  /**
   * The same "no graph built yet" degradation, reached by a REPO-LESS run — the interactive
   * draft/demo seams, which launch with no repoRef at all. Such a run has no own repo to fall
   * back to, so telling it that it "uses its own repo's code graph" names a graph that does not
   * exist and sends whoever is debugging it looking for one. It gets nothing, and is told that.
   */
  it('tells a repo-less run it gets NOTHING — not that it falls back to a repo it does not have', async () => {
    const adapter = adapterFor([repoMember('engine-repo')], [repo('engine-repo')]);

    const { binding, reason } = await resolveProjectGraphBinding(adapter, PROJECT_ID, undefined);

    expect(binding).toBeNull();
    expect(reason).toMatch(/no code graph yet/);
    expect(reason).toMatch(/repo-less run gets no code graph/);
    expect(reason).not.toMatch(/own repo's code graph/);
  });

  /** The unreadable-membership path degrades too, and owes a repo-less run the same honesty. */
  it('names the right fallback for each run shape when the project graph cannot be read', async () => {
    const adapter = adapterFor([repoMember('engine-repo')], [repo('engine-repo')]);
    adapter.listRepos = vi.fn(async () => {
      throw new Error('registry unreadable');
    });

    const bound = await resolveProjectGraphBinding(adapter, PROJECT_ID, 'engine-repo');
    const repoless = await resolveProjectGraphBinding(adapter, PROJECT_ID, undefined);

    expect(bound.binding).toBeNull();
    expect(bound.reason).toMatch(/could not be read/);
    expect(bound.reason).toMatch(/own repo's code graph/);

    expect(repoless.binding).toBeNull();
    expect(repoless.reason).toMatch(/could not be read/);
    expect(repoless.reason).toMatch(/repo-less run gets no code graph/);
    expect(repoless.reason).not.toMatch(/own repo's code graph/);
  });

  /** Filing a run into a project and attaching its repo are separate acts; one can happen alone. */
  it('refuses when the run’s repo is not a member of the project at all', async () => {
    buildGraph(['daemon-repo']);
    const adapter = adapterFor([repoMember('daemon-repo')], [repo('daemon-repo'), repo('other')]);

    const { binding, reason } = await resolveProjectGraphBinding(adapter, PROJECT_ID, 'other');

    expect(binding).toBeNull();
    expect(reason).toMatch(/is not a crew\.repo member/);
    expect(reason).toMatch(/members/);
  });

  /** No own-repo to be wrong about ⇒ any non-empty graph is a gain over the nothing it gets today. */
  it('binds a repo-less run with no label', async () => {
    buildGraph(['engine-repo', 'daemon-repo']);
    const adapter = adapterFor(
      [repoMember('engine-repo'), repoMember('daemon-repo')],
      [repo('engine-repo'), repo('daemon-repo')],
    );

    const { binding } = await resolveProjectGraphBinding(adapter, PROJECT_ID, undefined);

    expect(binding).toEqual({ dbPath: projectGraphDb(PROJECT_ID) });
    expect(binding && 'repoLabel' in binding).toBe(false);
  });

  /**
   * Binding is an ENHANCEMENT. A project whose membership cannot be read must cost the run its
   * wider graph, never the launch.
   */
  it('degrades instead of throwing when the project cannot be read', async () => {
    const adapter = {
      projectMembers: vi.fn(async () => {
        throw new Error('store unavailable');
      }),
      listRepos: vi.fn(async () => []),
    } as unknown as CoreAdapter;

    const { binding, reason } = await resolveProjectGraphBinding(adapter, PROJECT_ID, 'engine-repo');

    expect(binding).toBeNull();
    expect(reason).toMatch(/store unavailable/);
    expect(reason).toMatch(/own repo's code graph/);
  });

  /**
   * A repo that MOVED keeps its manifest row (estate refuses to rebind a label to a new root), so
   * the graph still claims the label while holding the old checkout's symbols. `projectGraphStatus`
   * already reports that as not-indexed; the binding must inherit that judgement rather than read
   * the label off the manifest and call it good.
   */
  it('refuses when the graph’s rows describe a checkout the registry no longer points at', async () => {
    buildGraph(['engine-repo']);
    const moved: RepoEntry = { ...repo('engine-repo'), root_path: '/repos/moved-elsewhere' };
    const adapter = adapterFor([repoMember('engine-repo')], [moved]);

    const { binding, reason } = await resolveProjectGraphBinding(adapter, PROJECT_ID, 'engine-repo');

    expect(binding).toBeNull();
    expect(reason).toMatch(/different checkout/);
  });
});
