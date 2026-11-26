// crew#1885 (coord's codex-check on crew#1946): the credential that reads a run's delivery text with no bearer is in no
// process's argv. The engine runs the deliver unit as `bash -lc <script>`, so everything the script text holds is on the
// shell's command line, which another local user can read with `ps` while it runs. Under `auth: required` on a shared
// host, a value lifted from that command line must read nothing through `POST /deliver/text`.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { AuditLog } from '../src/api/audit.js';
import { registerAuthHooks, type ResolvedAuth } from '../src/api/auth.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import { deliverPresetStep } from '../src/core/deliver.js';
import type { SessionView, WorkUnit } from '../src/core/types.js';
import { withRunViews } from './support/run-views.js';

const RUN_ID = '5c1e0b7a-3f0e-4d8e-9a43-1885a2b1c0de';

const REQUIRED: ResolvedAuth = {
  mode: 'required',
  verifiers: [{ name: 'test', verify: async (t) => (t === 'operator-token' ? { id: 'op', kind: 'human', trust: 'admin' } : null) }],
  allowedOrigins: null,
};

/** The command line the engine is handed for the deliver unit, as the launch composes it (`CoreAdapter.deliverStep`). */
function engineArgv(): string[] {
  const step = deliverPresetStep(null, [], RUN_ID, 'fix the archive controls', { apiOrigin: 'http://127.0.0.1:7701', repoRef: 'wicked-studio' });
  const exec = step.executor;
  if (exec === undefined || exec.type !== 'tool') throw new Error('the deliver step is not a Tool');
  return [...exec.cmd];
}

/** The run, its deliver unit dispatched and running that command. */
function delivering(argv: string[]): SessionView {
  const unit = (over: Partial<WorkUnit> & { id: string; ord: number }): WorkUnit => ({
    session_id: RUN_ID, description: 'x', stage: 'build', assigned_cli: null, assigned_invocation: null, council_task_ref: null,
    routing: null, denial_reason: null, phase_ref: null, conformance_ref: null, phase_status: 'approved', collection_scope: null,
    status: 'done', ...over,
  } as WorkUnit);
  return {
    session: {
      id: RUN_ID, workflow_id: `feature-deliver-${RUN_ID}`, problem: 'fix the archive controls', entity_mode: 'shared',
      collection_scope: null, clis: ['claude'], status: 'executing', human_confirm: 'all', unit_ix: 2, attempt: 0,
      workdir: '/tmp/wt', repo_ref: 'wicked-studio', extra_write_roots: [], archived_at: null, archive_note: null,
    } as SessionView['session'],
    units: [
      unit({ id: `${RUN_ID}:build`, ord: 1, role: 'creator', assigned_cli: 'claude', gate: 'auto' }),
      unit({ id: `${RUN_ID}:deliver`, ord: 2, status: 'distributed', phase_status: null, routing: { method: 'tool' }, gate: 'auto', tool_cmd: argv }),
    ],
  };
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

async function buildApp(views: SessionView[]): Promise<FastifyInstance> {
  const adapter = {
    sessionsDetail: vi.fn(async () => views),
    sessions: vi.fn(async () => views.map((v) => v.session.id)),
    setDeliverApiOrigin: vi.fn(),
    listWorkflows: () => [],
  } as unknown as CoreAdapter;
  const app = Fastify({ logger: false });
  registerAuthHooks(app, REQUIRED);
  registerRoutes(app, withRunViews(adapter), new GateCache(), new ElicitationCache(), { bus: null, index: new MembershipIndex(), log: () => undefined }, { audit: AuditLog.noop(), authMode: 'required' }, {});
  apps.push(app);
  await app.ready();
  return app;
}

describe('the deliver text credential is in no argv (crew#1885, codex-check on crew#1946)', () => {
  it('no hex value on the deliver unit\'s command line reads the run\'s delivery text, under required auth', async () => {
    const argv = engineArgv();
    expect(argv.slice(0, 2)).toEqual(['bash', '-lc']);
    // Every nonce-shaped value a `ps` reader sees: each run of 16 or more hex digits in any argument.
    const seen = [...new Set(argv.flatMap((a) => a.match(/[0-9a-fA-F]{16,}/g) ?? []))];
    // The sentinel nonce (crew#739) is one of them: the engine and crew read it from this command line by design.
    expect(seen.length).toBeGreaterThan(0);
    const app = await buildApp([delivering(argv)]);
    // The bearer route refuses a caller with no operator token (the threat model: another local user, no bearer).
    expect((await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN_ID}/deliver-text` })).statusCode).toBe(401);
    for (const value of seen) {
      for (const field of ['nonce', 'key']) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/deliver/text',
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ run: RUN_ID, [field]: value }),
        });
        expect(res.statusCode, `${field} = a ${value.length}-digit value from the command line: ${res.statusCode}`).not.toBe(200);
      }
    }
  });
});
