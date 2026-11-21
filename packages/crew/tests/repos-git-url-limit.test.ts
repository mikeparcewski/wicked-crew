// studio#1012 review: GET /repos reads checkout origins at most eight at a time, and two overlapping lists share one read
// per checkout. `execCapped` mocked so the reads can be held open and counted; the real-git cases are in
// repos-git-url.test.ts.
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

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

describe('GET /api/v1/repos — origin reads are bounded', () => {
  it('reads at most eight origins at once, once per checkout across overlapping lists', async () => {
    const repos = Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, name: `r${i}`, root_path: `/srv/r${i}`, default_branch: 'main', registered_at: 1 }));
    const app = Fastify({ logger: false });
    registerRoutes(app, { listRepos: async () => repos } as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), { bus: null, index: new MembershipIndex(), log: () => undefined });
    try {
      const [a, b] = await Promise.all([app.inject({ method: 'GET', url: '/api/v1/repos' }), app.inject({ method: 'GET', url: '/api/v1/repos' })]);
      for (const res of [a, b]) {
        const out = (res.json() as { repos: Array<{ id: string; git_url?: string }> }).repos;
        expect(out.map((r) => r.git_url)).toEqual(repos.map((r) => `https://github.com/acme/${r.id}.git`));
      }
      expect(h.reads).toHaveLength(20);
      expect(new Set(h.reads).size).toBe(20);
      expect(h.peak).toBeLessThanOrEqual(8);
      expect(h.peak).toBeGreaterThan(1);
    } finally {
      await app.close();
    }
  });
});
