// crew#327 — the invariants `LaunchRunInput.projectGraph` carries but its TYPE cannot.
//
// Both are CROSS-FIELD, so no shape on `projectGraph` itself could express them, and the earlier
// attempt to say so in a doc comment ("treat repoLabel as required whenever repoRef is set") is
// exactly the kind of promise a later caller does not read. They are enforced where the launch is
// assembled instead, and they THROW:
//
//   - `projectGraph` without `projectId` — the binding is the PROJECT's graph, so a run that is not
//     filed into that project is claiming a context it does not belong to;
//   - `repoRef` without `projectGraph.repoLabel` — the engine uses the label to confirm the
//     co-located graph actually holds this run's repo, and without it a graph that does NOT hold it
//     would answer "not found" about the worktree the worker is sitting in.
//
// Loud rather than lenient, because the failure these prevent is the silent kind this whole slice
// exists to end: a run that records one thing about what it could see and observes another.
//
// The last test is the one that matters most — `resolveProjectGraphBinding`, the only producer of
// these bindings today, satisfies both invariants on every arm it can return. So a throw here means
// a NEW caller got it wrong, never that the guards fight the real path.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../src/core/adapter.js';
import type { LaunchOptions } from 'wicked-core-ts';
import { removeScratch } from './setup/scratch.js';

let dir: string;
let adapter: CoreAdapter;
let launched: LaunchOptions[];

function stubCore(a: CoreAdapter, name: string, impl: unknown): void {
  (a as unknown as { core: Record<string, unknown> }).core[name] = impl;
}

/** The addon actually installed here is >= 0.7.1, so the capability gate is not what is under test. */
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pg-launch-'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  launched = [];
  stubCore(adapter, 'launchRun', (opts: LaunchOptions) => {
    launched.push(opts);
    return Promise.resolve(opts.sessionId);
  });
});

afterEach(() => {
  adapter.close();
  removeScratch(dir);
});

const BASE = { problem: 'p', clisJson: '[]' } as const;

describe('launchRun refuses a projectGraph the run cannot honestly claim (crew#327)', () => {
  it('throws when projectGraph arrives without the projectId whose graph it is', async () => {
    await expect(
      adapter.launchRun({
        ...BASE,
        sessionId: 'r1',
        projectGraph: { dbPath: '/graphs/p1/estate.db' },
      }),
    ).rejects.toThrow(/must be filed into that project|pass projectId/);
    expect(launched).toHaveLength(0);
  });

  it('throws when a REPO-BOUND run carries no repoLabel — the engine could not confirm the graph', async () => {
    await expect(
      adapter.launchRun({
        ...BASE,
        sessionId: 'r2',
        projectId: 'proj-1',
        repoRef: 'engine-repo',
        projectGraph: { dbPath: '/graphs/p1/estate.db' },
      }),
    ).rejects.toThrow(/repoLabel/);
    expect(launched).toHaveLength(0);
  });

  it('names the repo in that refusal, so the message says which run it is about', async () => {
    await expect(
      adapter.launchRun({
        ...BASE,
        sessionId: 'r3',
        projectId: 'proj-1',
        repoRef: 'daemon-repo',
        projectGraph: { dbPath: '/graphs/p1/estate.db' },
      }),
    ).rejects.toThrow(/'daemon-repo'/);
  });

  it('a repo-bound run WITH a label launches, and the binding reaches the engine verbatim', async () => {
    const id = await adapter.launchRun({
      ...BASE,
      sessionId: 'r4',
      projectId: 'proj-1',
      repoRef: 'engine-repo',
      projectGraph: { dbPath: '/graphs/p1/estate.db', repoLabel: 'engine-repo' },
    });

    expect(id).toBe('r4');
    expect(launched).toHaveLength(1);
    expect(launched[0]?.projectGraph).toStrictEqual({
      dbPath: '/graphs/p1/estate.db',
      repoLabel: 'engine-repo',
    });
  });

  /**
   * A REPO-LESS run legitimately has no label — there is no own repo to confirm — so the second
   * guard must not fire on the interactive draft/demo seams, which launch this way on every doc.
   */
  it('a repo-LESS run needs no label and is not refused', async () => {
    const id = await adapter.launchRun({
      ...BASE,
      sessionId: 'r5',
      projectId: 'proj-1',
      projectGraph: { dbPath: '/graphs/p1/estate.db' },
    });

    expect(id).toBe('r5');
    expect(launched[0]?.projectGraph).toStrictEqual({ dbPath: '/graphs/p1/estate.db' });
  });

  it('a launch with NO projectGraph is untouched by either guard', async () => {
    const id = await adapter.launchRun({ ...BASE, sessionId: 'r6', repoRef: 'engine-repo' });
    expect(id).toBe('r6');
    expect(launched[0]?.projectGraph).toBeUndefined();
  });
});
