// crew#1767: `/health` must not wait on the engine's actor past its own bound through the chat-workflow
// read. `capabilities.chatWorkflows` comes from `adapter.listPresets()`, an actor round trip: it is read
// once, starting when the routes are registered, and a probe waits for it only inside the ping's
// HEALTH_PING_WAIT_MS. While the actor is busy the probe answers `[]`; once the read lands, the held list.
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HEALTH_PING_WAIT_MS, registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { AuditLog } from '../src/api/audit.js';
import type { CoreAdapter } from '../src/core/adapter.js';

const ANALYZE = {
  name: 'analyze', scope: 'global', created_by: 'builtin', updated_at: 1,
  steps: [{ catalog: 'understand', id: 'answer', gate: { human_confirm: { unconditional: true } }, instructions: 'Answer READ-ONLY.' }],
};

const servers: FastifyInstance[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

function routes(listPresets: () => Promise<unknown[]>, ping: () => Promise<string> = async () => 'ok'): FastifyInstance {
  const adapter = {
    sessionsDetail: vi.fn(async () => []),
    sessions: vi.fn(async () => []),
    listRepos: vi.fn(async () => []),
    getSettings: vi.fn(async () => ({})),
    engineCapabilities: vi.fn(() => ({ deliverGate: false, revisesPr: false })),
    ping: vi.fn(ping),
    listPresets: vi.fn(listPresets),
  } as unknown as CoreAdapter;
  const app = Fastify({ logger: false });
  registerRoutes(
    app,
    adapter,
    new GateCache(),
    new ElicitationCache(),
    { bus: null, index: new MembershipIndex(), log: () => undefined },
    { audit: AuditLog.noop(), authMode: 'off' },
    {},
  );
  servers.push(app);
  return app;
}

describe('crew#1767: /health and the chat-workflow read', () => {
  it('answers within the ping bound while the preset read waits on a busy actor, and the held list once it lands', async () => {
    let release!: (rows: unknown[]) => void;
    const listPresets = vi.fn(() => new Promise<unknown[]>((resolve) => (release = resolve)));
    const app = routes(listPresets);
    // The read started at registration, before any probe.
    await vi.waitFor(() => expect(listPresets).toHaveBeenCalledTimes(1));

    const t0 = performance.now();
    const [r1, r2] = await Promise.all([
      app.inject({ method: 'GET', url: '/api/v1/health' }),
      app.inject({ method: 'GET', url: '/api/v1/health' }),
    ]);
    const took = performance.now() - t0;
    expect(took).toBeLessThan(HEALTH_PING_WAIT_MS + 750);
    for (const r of [r1, r2]) {
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ status: 'ok', ping: 'ok' });
      expect(r.json().capabilities.chatWorkflows).toEqual([]);
    }
    // One read in flight: the probes joined the registration's read.
    expect(listPresets).toHaveBeenCalledTimes(1);

    release([ANALYZE]);
    await vi.waitFor(async () => {
      const r = await app.inject({ method: 'GET', url: '/api/v1/health' });
      expect(r.json().capabilities.chatWorkflows).toEqual(['analyze']);
    });
    // Held until restart: no further read.
    await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(listPresets).toHaveBeenCalledTimes(1);
  });

  it('waits inside the bound for a read that is about to land, so a probe right after boot still names analyze', async () => {
    const app = routes(() => new Promise((resolve) => setTimeout(() => resolve([ANALYZE]), 50)));
    const r = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(r.json().capabilities.chatWorkflows).toEqual(['analyze']);
  });

  it('a failed read is dropped: the next probe reads again', async () => {
    let calls = 0;
    const app = routes(async () => {
      calls += 1;
      if (calls === 1) throw new Error('actor not booted');
      return [ANALYZE];
    });
    await vi.waitFor(() => expect(calls).toBe(1));
    const r = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(r.json().capabilities.chatWorkflows).toEqual(['analyze']);
    expect(calls).toBe(2);
  });
});
