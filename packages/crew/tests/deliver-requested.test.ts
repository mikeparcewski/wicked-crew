// crew#762: a durable fact that a run's delivery was requested. `stranded` with no deliver unit
// covers both "launched with deliver: none, kept locally as asked" and "a post-hoc delivery was
// attempted and failed". `AgentSession.deliver_requested` tells them apart, also after a restart.

import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { DeliveryIndex } from '../src/api/delivery-index.js';
import { RunTimingIndex, recordRunLaunched } from '../src/api/run-timing-index.js';
import { AuditLog } from '../src/api/audit.js';
import { removeScratch } from './setup/scratch.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { SessionView } from '../src/core/types.js';

const KEPT = 'run-kept';
const TRIED = 'run-tried';
const ASKED = 'run-asked';
const UNKNOWN = 'run-unknown';

const view = (id: string): SessionView =>
  ({
    session: {
      id,
      workflow_id: `wf-${id}`,
      problem: 'x',
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['stub'],
      status: 'completed',
      human_confirm: 'none',
      unit_ix: 1,
      attempt: 0,
      workdir: `/wt/${id}`,
      repo_ref: 'repo-1',
      extra_write_roots: [],
      archived_at: null,
      archive_note: null,
    },
    units: [],
  }) as unknown as SessionView;

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const d of dirs.splice(0)) removeScratch(d);
});

async function build(audit: AuditLog, hydrate: boolean): Promise<FastifyInstance> {
  const views = [view(KEPT), view(TRIED), view(ASKED), view(UNKNOWN)];
  const adapter = {
    sessionsDetail: vi.fn(async () => views),
    sessions: vi.fn(async () => views.map((v) => v.session.id)),
  } as unknown as CoreAdapter;
  const runTimingIndex = new RunTimingIndex();
  const deliveryIndex = new DeliveryIndex();
  if (hydrate) {
    runTimingIndex.hydrateFromLaunchEntries(await audit.readAll({ action: 'run.launched' }));
    await deliveryIndex.hydrate(audit);
  }
  const app = Fastify({ logger: false });
  registerRoutes(
    app,
    adapter,
    new GateCache(),
    new ElicitationCache(),
    { bus: null, index: new MembershipIndex(), log: () => undefined },
    { audit, authMode: 'off' },
    {
      runTimingIndex,
      deliveryIndex,
      // The lift fails the way a lift conflict does: the script's loud non-zero exit.
      deliverExec: async () => ({ status: 1, output: 'CONFLICT (content): Merge conflict in a.ts' }),
    },
  );
  apps.push(app);
  return app;
}

async function requested(app: FastifyInstance): Promise<Record<string, unknown>> {
  const runs = (await app.inject({ method: 'GET', url: '/api/v1/runs' })).json() as { runs: Array<{ session: { id: string; deliver_requested?: boolean } }> };
  return Object.fromEntries(runs.runs.map((r) => [r.session.id, r.session.deliver_requested]));
}

describe('crew#762 — AgentSession.deliver_requested', () => {
  it('none at launch reads false; a failed post-hoc attempt reads true; deliver: pr reads true; no launch record is absent — and all of it survives a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deliver-requested-'));
    dirs.push(dir);
    const audit = new AuditLog(join(dir, 'audit.log'), () => undefined);
    const app = await build(audit, false);
    const actor = { id: 'local', kind: 'human', trust: 'operator' } as never;
    void app;
    // The launch records, as POST /runs writes them (the RESOLVED decision).
    for (const [id, deliver] of [[KEPT, 'none'], [TRIED, 'none'], [ASKED, 'pr']] as const) {
      recordRunLaunched(audit, undefined, actor, id, { workflow: 'bug', deliver });
    }
    await audit.flush();
    // A fresh route set hydrated from the trail: what a restarted daemon reads.
    const booted = await build(audit, true);
    const attempt = await booted.inject({ method: 'POST', url: `/api/v1/runs/${TRIED}/deliver` });
    expect(attempt.statusCode).toBe(409);
    expect(await requested(booted)).toEqual({ [KEPT]: false, [TRIED]: true, [ASKED]: true, [UNKNOWN]: undefined });
    await audit.flush();
    const restarted = await build(audit, true);
    expect(await requested(restarted)).toEqual({ [KEPT]: false, [TRIED]: true, [ASKED]: true, [UNKNOWN]: undefined });
  });
});
