// F-2R2-008: the project graph FOLLOWS the repo graphs — a completed onboarding run refreshes every
// project its repo is a member of. Bounded (one project at a time, at most two rounds), logged, and
// never fatal. Over FAKE deps: no engine, no estate binary, no state home.

import { describe, expect, it, vi } from 'vitest';

import { refreshProjectGraphsAfterOnboarding } from '../src/projects/auto-refresh.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { ProjectGraphRefreshResult } from '../src/core/types.js';

const adapter = {} as unknown as CoreAdapter;

function result(rows: { repoId: string; action: 'indexed' | 'skipped-head-unchanged' | 'failed' }[]): ProjectGraphRefreshResult {
  return {
    status: { state: 'ready' } as ProjectGraphRefreshResult['status'],
    indexed: rows.filter((r) => r.action === 'indexed').map((r) => r.repoId),
    skipped: rows.filter((r) => r.action === 'skipped-head-unchanged').map((r) => r.repoId),
    failed: rows.filter((r) => r.action === 'failed').map((r) => ({ repoId: r.repoId, label: r.repoId, error: 'boom' })),
    repos: rows.map((r) => ({ repoId: r.repoId, label: r.repoId, action: r.action })),
  };
}

describe('refreshProjectGraphsAfterOnboarding', () => {
  it('refreshes every project the repo is a member of, one at a time, and logs each outcome', async () => {
    const order: string[] = [];
    const log = vi.fn();
    const refresh = vi.fn(async (projectId: string) => {
      order.push(projectId);
      return result([{ repoId: 'r1', action: 'indexed' }]);
    });
    const out = await refreshProjectGraphsAfterOnboarding(adapter, 'r1', {
      memberProjects: async () => ['p1', 'p2'],
      refresh,
      log,
    });
    expect(order).toEqual(['p1', 'p2']);
    expect(out.refreshed.map((r) => [r.projectId, r.rounds])).toEqual([['p1', 1], ['p2', 1]]);
    expect(out.failed).toEqual([]);
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringMatching(/onboarding of r1 completed — refreshing project p1/),
      expect.stringMatching(/project p1 graph is ready \(indexed 1, skipped 0, failed 0\)/),
      expect.stringMatching(/refreshing project p2/),
      expect.stringMatching(/project p2 graph is ready/),
    ]);
  });

  it('a repo in no project refreshes nothing and says nothing', async () => {
    const refresh = vi.fn();
    const log = vi.fn();
    const out = await refreshProjectGraphsAfterOnboarding(adapter, 'lonely', { memberProjects: async () => [], refresh, log });
    expect(out).toEqual({ repoId: 'lonely', refreshed: [], failed: [] });
    expect(refresh).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('runs ONE extra round when the (coalesced) refresh it joined had already passed the repo — never a third', async () => {
    let calls = 0;
    const refresh = vi.fn(async () => {
      calls += 1;
      // First answer: the in-flight refresh had no row for r9 (it started before r9 was indexed).
      return calls === 1 ? result([{ repoId: 'r1', action: 'skipped-head-unchanged' }]) : result([{ repoId: 'r9', action: 'indexed' }]);
    });
    const out = await refreshProjectGraphsAfterOnboarding(adapter, 'r9', { memberProjects: async () => ['p1'], refresh, log: () => undefined });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(out.refreshed).toEqual([{ projectId: 'p1', rounds: 2, indexed: ['r9'], skipped: [], failed: [] }]);
  });

  it('a repo the second round STILL cannot index is reported, not retried again', async () => {
    const refresh = vi.fn(async () => result([{ repoId: 'r9', action: 'failed' }]));
    const out = await refreshProjectGraphsAfterOnboarding(adapter, 'r9', { memberProjects: async () => ['p1'], refresh, log: () => undefined });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(out.refreshed[0]).toMatchObject({ projectId: 'p1', rounds: 2, failed: ['r9'] });
  });

  it('a refresh that throws is logged as a failure for THAT project; the next project still runs; the run is untouched', async () => {
    const log = vi.fn();
    const refresh = vi.fn(async (projectId: string) => {
      if (projectId === 'p1') throw new Error('wicked-estate does not support index --repo');
      return result([{ repoId: 'r1', action: 'indexed' }]);
    });
    const out = await refreshProjectGraphsAfterOnboarding(adapter, 'r1', { memberProjects: async () => ['p1', 'p2'], refresh, log });
    expect(out.failed).toEqual([{ projectId: 'p1', error: 'wicked-estate does not support index --repo' }]);
    expect(out.refreshed.map((r) => r.projectId)).toEqual(['p2']);
    expect(log.mock.calls.some((c) => /project p1 graph refresh FAILED: wicked-estate does not support/.test(String(c[0])))).toBe(true);
  });

  it('an engine without projects (membership lookup throws) refreshes nothing and says so once', async () => {
    const log = vi.fn();
    const refresh = vi.fn();
    const out = await refreshProjectGraphsAfterOnboarding(adapter, 'r1', {
      memberProjects: async () => {
        throw new Error('Resolving a member’s projects needs wicked-core-ts >= 0.6.0');
      },
      refresh,
      log,
    });
    expect(out.refreshed).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toMatch(/membership lookup failed/);
  });
});
