// studio#1012 review: GET /repos reads checkout origins at most eight at a time, and two overlapping lists share one read
// per checkout. `execCapped` mocked so the reads can be held open and counted; the real-git cases are in
// repos-git-url.test.ts.
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Only `git remote get-url` is held and counted; any other exec runs for real.
const h = vi.hoisted(() => ({ active: 0, peak: 0, reads: [] as string[] }));
vi.mock('../src/core/exec.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/exec.js')>();
  const execCapped: typeof real.execCapped = async (file, args, opts) => {
    if (!args.includes('get-url')) return real.execCapped(file, args, opts);
    h.reads.push(args[1]!);
    h.active += 1;
    h.peak = Math.max(h.peak, h.active);
    await new Promise((r) => setTimeout(r, 15));
    h.active -= 1;
    return { stdout: `https://github.com/acme/${args[1]!.split('/').pop()}.git\n`, stderr: '' };
  };
  return { ...real, execCapped };
});

import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes } from '../src/api/routes.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import { MembershipIndex } from '../src/projects/membership-index.js';

const repo = (i: number) => ({ id: `r${i}`, name: `r${i}`, root_path: `/srv/r${i}`, default_branch: 'main', registered_at: 1 });

function app(list: () => unknown[]) {
  const a = Fastify({ logger: false });
  registerRoutes(a, { listRepos: async () => list() } as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), { bus: null, index: new MembershipIndex(), log: () => undefined });
  return a;
}

const urls = (res: { json(): unknown }) => (res.json() as { repos: Array<{ git_url?: string }> }).repos.map((r) => r.git_url);

describe('GET /api/v1/repos — origin reads are bounded', () => {
  beforeEach(() => {
    h.active = 0;
    h.peak = 0;
    h.reads.length = 0;
  });

  it('reads at most eight origins at once, once per checkout across overlapping lists', async () => {
    const repos = Array.from({ length: 20 }, (_, i) => repo(i));
    const a = app(() => repos);
    try {
      const [x, y] = await Promise.all([a.inject({ method: 'GET', url: '/api/v1/repos' }), a.inject({ method: 'GET', url: '/api/v1/repos' })]);
      for (const res of [x, y]) expect(urls(res)).toEqual(repos.map((r) => `https://github.com/acme/${r.id}.git`));
      expect(h.reads).toHaveLength(20);
      expect(new Set(h.reads).size).toBe(20);
      expect(h.peak).toBeLessThanOrEqual(8);
      expect(h.peak).toBeGreaterThan(1);
    } finally {
      await a.close();
    }
  });

  it('holds the bound across overlapping lists of different registries', async () => {
    // Each list sees a different registry (a repo unregistered and another added in between): the bound is shared.
    let n = 0;
    const a = app(() => { n += 1; return Array.from({ length: 12 }, (_, i) => repo(i + n * 12)); });
    try {
      const all = await Promise.all([1, 2, 3].map(() => a.inject({ method: 'GET', url: '/api/v1/repos' })));
      for (const res of all) expect(urls(res).every((u) => typeof u === 'string')).toBe(true);
      expect(h.reads).toHaveLength(36);
      expect(h.peak).toBe(8);
    } finally {
      await a.close();
    }
  });
});
