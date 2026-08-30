// CREW-UX-8 (crew#321, api-types 0.11.0) — `AgentSession.delivery`: the delivered PR on the
// LIST wire.
//
// Fastify inject() with a mock adapter (no NAPI). Pins:
//   DTO echo — `session.delivery = { kind: 'pull_request', url }` present on BOTH `GET /runs`
//     and `GET /runs/:id` for a run the index holds; ABSENT — never `null` — for a run that
//     delivered nothing, so `'delivery' in session` and `!== undefined` agree.
//   Durability — the `run.delivered` audit entry (action + runId + detail.url) is the system
//     of record; a fresh DeliveryIndex hydrates it back from the trail (the restart path),
//     newest-first with first-seen-per-run winning, and a corrupt newest write never
//     resurrects an older one.
//   Extraction — `prUrlFrom` mirrors crew's own deliver-phase grep (last `/pull/<digits>`
//     match wins; the `/pull/new/<branch>` create-PR form can never match); `deliverUnitOf`
//     keys on the `:deliver` id suffix with the `tool_cmd` fallback, never on `workflow_id`.

import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { QeGateCache } from '../src/qe/gate-events.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { DeliveryIndex, deliverUnitOf, prUrlFrom } from '../src/api/delivery-index.js';
import { AuditLog } from '../src/api/audit.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { SessionView, WorkUnit } from '../src/core/types.js';
import type { FastifyInstance } from 'fastify';

type MockAdapter = {
  sessionsDetail: ReturnType<typeof vi.fn>;
  sessions: ReturnType<typeof vi.fn>;
};

const SYSTEM_ACTOR = { id: 'daemon', kind: 'system', trust: 'admin' } as const;

function unit(id: string, over: Partial<WorkUnit> = {}): WorkUnit {
  return {
    id,
    session_id: 'run-a',
    ord: 0,
    description: 'u',
    stage: 'build',
    assigned_cli: null,
    assigned_invocation: null,
    council_task_ref: null,
    routing: null,
    denial_reason: null,
    phase_ref: null,
    conformance_ref: null,
    phase_status: null,
    collection_scope: null,
    status: 'done',
    ...over,
  } as WorkUnit;
}

function view(id: string, units: WorkUnit[] = []): SessionView {
  return {
    session: {
      id,
      workflow_id: `wf-${id}`,
      problem: 'p',
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['stub'],
      status: 'completed',
      human_confirm: 'none',
      unit_ix: 1,
      attempt: 0,
      workdir: null,
      repo_ref: null,
      extra_write_roots: [],
      archived_at: null,
      archive_note: null,
    },
    units,
  } as unknown as SessionView;
}

function buildApp(mockAdapter: MockAdapter, deliveryIndex: DeliveryIndex): FastifyInstance {
  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch (e) {
      done(e as Error);
    }
  });
  registerRoutes(
    app,
    mockAdapter as unknown as CoreAdapter,
    new GateCache(),
    new ElicitationCache(),
    new QeGateCache(),
    { bus: null, index: new MembershipIndex(), log: () => undefined },
    { audit: AuditLog.noop(), authMode: 'off' },
    { deliveryIndex },
  );
  return app;
}

describe('CREW-UX-8 — session.delivery on the run DTOs', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it('present on BOTH list and detail when the index holds the run; ABSENT for the neighbor', async () => {
    const index = new DeliveryIndex();
    index.set('run-a', 'https://github.com/o/r/pull/121');
    const mockAdapter: MockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([view('run-a'), view('run-b')]),
      sessions: vi.fn().mockResolvedValue(['run-a', 'run-b']),
    };
    app = buildApp(mockAdapter, index);
    await app.ready();

    const list = (await app.inject({ method: 'GET', url: '/api/v1/runs' })).json() as {
      runs: { session: Record<string, unknown> }[];
    };
    const a = list.runs.find((r) => r.session['id'] === 'run-a')!.session;
    const b = list.runs.find((r) => r.session['id'] === 'run-b')!.session;
    expect(a['delivery']).toEqual({ kind: 'pull_request', url: 'https://github.com/o/r/pull/121' });
    // Absence is the ONE spelling of "delivered nothing" — never null.
    expect('delivery' in b).toBe(false);

    const detail = (await app.inject({ method: 'GET', url: '/api/v1/runs/run-a' })).json() as {
      run: { session: Record<string, unknown> };
    };
    expect(detail.run.session['delivery']).toEqual({
      kind: 'pull_request',
      url: 'https://github.com/o/r/pull/121',
    });
  });
});

describe('DeliveryIndex.hydrate — the restart path over the audit trail', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-delivery-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a fresh index answers from the trail; newest entry per run wins', async () => {
    const auditPath = join(dir, 'audit.log');
    const audit = new AuditLog(auditPath, () => undefined);
    audit.record('run.delivered', SYSTEM_ACTOR, {
      runId: 'run-a',
      detail: { url: 'https://github.com/o/r/pull/1' },
    });
    // A newer write for the same run supersedes (resume/retry re-resolution).
    audit.record('run.delivered', SYSTEM_ACTOR, {
      runId: 'run-a',
      detail: { url: 'https://github.com/o/r/pull/2' },
    });
    audit.record('run.delivered', SYSTEM_ACTOR, {
      runId: 'run-b',
      detail: { url: 'https://github.com/o/r/pull/3' },
    });
    await audit.flush();

    const index = new DeliveryIndex();
    await index.hydrate(new AuditLog(auditPath, () => undefined));
    expect(index.deliveryFor('run-a')).toEqual({
      kind: 'pull_request',
      url: 'https://github.com/o/r/pull/2',
    });
    expect(index.deliveryFor('run-b')).toEqual({
      kind: 'pull_request',
      url: 'https://github.com/o/r/pull/3',
    });
    expect(index.deliveryFor('run-c')).toBeUndefined();
  });

  it('a corrupt NEWEST entry never resurrects an older url (the #312 rule)', async () => {
    const auditPath = join(dir, 'audit.log');
    const audit = new AuditLog(auditPath, () => undefined);
    audit.record('run.delivered', SYSTEM_ACTOR, {
      runId: 'run-a',
      detail: { url: 'https://github.com/o/r/pull/1' },
    });
    audit.record('run.delivered', SYSTEM_ACTOR, {
      runId: 'run-a',
      detail: { url: 42 as unknown as string },
    });
    await audit.flush();

    const index = new DeliveryIndex();
    await index.hydrate(new AuditLog(auditPath, () => undefined));
    // Unknowable current record = no record — never the superseded older one.
    expect(index.deliveryFor('run-a')).toBeUndefined();
  });

  it('a missing trail hydrates to empty, best-effort (the pre-#321 behavior, not an error)', async () => {
    const index = new DeliveryIndex();
    await index.hydrate(new AuditLog(join(dir, 'nope.log'), () => undefined));
    expect(index.deliveryFor('run-a')).toBeUndefined();
  });
});

describe('prUrlFrom — crew\'s own deliver-phase grep, mirrored', () => {
  it('takes the LAST /pull/<digits> match (tail -1)', () => {
    const out = [
      'remote: Create a pull request by visiting:',
      'remote:   https://github.com/o/r/pull/new/feat-x',
      'https://github.com/o/r/pull/9',
      'https://github.com/o/r/pull/121',
    ].join('\n');
    expect(prUrlFrom(out)).toBe('https://github.com/o/r/pull/121');
  });

  it('the /pull/new/<branch> create-PR form can never match', () => {
    expect(prUrlFrom('https://github.com/o/r/pull/new/feat-x')).toBeNull();
    expect(prUrlFrom('no urls at all')).toBeNull();
  });
});

describe('deliverUnitOf — id suffix primary, tool_cmd fallback, never workflow_id', () => {
  it('finds the composed :deliver unit by id suffix', () => {
    const v = view('run-a', [unit('run-a:u0'), unit('wf-base:deliver')]);
    expect(deliverUnitOf(v)?.id).toBe('wf-base:deliver');
  });

  it('falls back to a tool_cmd invoking gh pr create (overlay-carried deliver phase)', () => {
    const v = view('run-a', [
      unit('run-a:u0'),
      unit('run-a:ship', { tool_cmd: ['bash', '-lc', 'git push && gh pr create --fill'] }),
    ]);
    expect(deliverUnitOf(v)?.id).toBe('run-a:ship');
  });

  it('no deliver unit → null (a run with no deliver phase claims nothing)', () => {
    expect(deliverUnitOf(view('run-a', [unit('run-a:u0')]))).toBeNull();
  });
});
