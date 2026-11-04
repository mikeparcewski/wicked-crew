// (DES-APPS-001 §9.3, slice K6) The publish run's guards: only that run's `check`/`produce` Tool unit passes as a step
// (the engine's real unit shape), the QE exclusion is every builder since the last published VERSION, an Apps publish's
// gates are a human operator's only (by every path), and the Teams package's details.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AuditLog } from '../src/api/audit.js';
import { isUnitTokenRoute } from '../src/api/auth.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes } from '../src/api/routes.js';
import { buildersSince } from '../src/apps/store.js';
import { outlinePng, teamsManifest } from '../src/apps/publish/teams.js';
import { runBaseOf, runtimeDir, serverArtifact, unitOfToken, type PublishAdapter } from '../src/apps/publish/wire.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { AppVersion } from '../src/core/types.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';

const RUN = 'apps-publish-esc-0123456789ab';

describe('the step token resolver (the engine`s unit shape)', () => {
  const adapter = (units: Array<{ id: string; ord: number; tool_cmd?: string[] | null }>, ord: number, runId = RUN): PublishAdapter => ({
    launchRun: async () => runId,
    seatsForWorkflow: async () => [],
    sessionsDetail: async () => [{ session: { id: runId, status: 'executing' }, units }],
    askUnit: async () => ({ runId, ord }),
    runEvents: async () => [],
  });
  const units = [
    { id: `${RUN}:check`, ord: 0, tool_cmd: ['wicked-crew', 'apps-check', '--publish'] },
    { id: `${RUN}:qe`, ord: 1, tool_cmd: null },
    { id: `${RUN}:produce`, ord: 2, tool_cmd: ['wicked-crew', 'apps-produce'] },
  ];

  it('names the authored step from the unit id and knows a Tool unit by its command', async () => {
    expect(await unitOfToken(adapter(units, 0))('t')).toEqual({ runId: RUN, step: 'check', tool: true });
    expect(await unitOfToken(adapter(units, 2))('t')).toEqual({ runId: RUN, step: 'produce', tool: true });
    // The QE seat (an agent unit of the same run) is no Tool step.
    expect(await unitOfToken(adapter(units, 1))('t')).toEqual({ runId: RUN, step: 'qe', tool: false });
    // A unit id of another run's shape names no step.
    expect(await unitOfToken(adapter([{ id: 'other-run:check', ord: 0, tool_cmd: ['x'] }], 0))('t')).toEqual({ runId: RUN, step: null, tool: true });
    const bad: PublishAdapter = { ...adapter(units, 0), askUnit: async () => Promise.reject(new Error('invalid_token')) };
    expect(await unitOfToken(bad)('t')).toBeNull();
  });
});

describe('the run`s base, as the engine recorded it', () => {
  const C1 = '1'.repeat(40);
  const C2 = '2'.repeat(40);
  it('is the run`s own runBaseResolved commit; another run`s, a malformed one, or none answers what it should', async () => {
    const of = (events: Array<Record<string, unknown>> | null) => runBaseOf({ runEvents: async () => events })(RUN);
    expect(await of([{ type: 'sessionStarted', session: RUN }, { type: 'runBaseResolved', session: RUN, baseCommit: C1 }])).toBe(C1);
    expect(await of([{ type: 'runBaseResolved', session: 'other', baseCommit: C2 }])).toBeNull();
    expect(await of([{ type: 'runBaseResolved', session: RUN, baseCommit: 'HEAD' }])).toBeNull();
    expect(await of([])).toBeNull();
    expect(await of(null)).toBeNull();
  });
});

describe('the runtime and the server artifact (Publish is offered only when produce can run)', () => {
  it('answers a configured directory only when every part produce reads is there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'k6-art-'));
    try {
      expect(runtimeDir({ WICKED_APPS_RUNTIME_DIR: join(dir, 'missing') })).toBeNull();
      mkdirSync(join(dir, 'rt'));
      writeFileSync(join(dir, 'rt', 'runtime.js'), '');
      expect(runtimeDir({ WICKED_APPS_RUNTIME_DIR: join(dir, 'rt') })).toBeNull(); // no runtime.css
      writeFileSync(join(dir, 'rt', 'runtime.css'), '');
      expect(runtimeDir({ WICKED_APPS_RUNTIME_DIR: join(dir, 'rt') })).toBe(join(dir, 'rt'));
      expect(serverArtifact({ WICKED_APPS_SERVER_ARTIFACT: join(dir, 'missing') })).toBeNull();
      mkdirSync(join(dir, 'art', 'server', 'lib', 'bundle'), { recursive: true });
      writeFileSync(join(dir, 'art', 'Dockerfile'), 'FROM scratch\n');
      expect(serverArtifact({ WICKED_APPS_SERVER_ARTIFACT: join(dir, 'art') })).toBeNull(); // a Dockerfile alone
      writeFileSync(join(dir, 'art', 'server', 'lib', 'bundle', 'server.mjs'), '');
      mkdirSync(join(dir, 'art', 'runners'));
      writeFileSync(join(dir, 'art', 'runners', 'sqlite-runner.mjs'), '');
      expect(serverArtifact({ WICKED_APPS_SERVER_ARTIFACT: join(dir, 'art') })).toBe(join(dir, 'art'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the QE builder exclusion', () => {
  const v = (version: number, tree: string, builder?: string): AppVersion =>
    ({ version, tree, commit: tree, base: null, at: version, author: { kind: builder === undefined ? 'human' : 'seat', id: builder ?? 'priya' }, summary: '', check: { level: 'spec', checked: [] }, receipt: builder === undefined ? { kind: 'you', tree, version, at: version, actor: { id: 'priya', kind: 'human', trust: 'operator' } } : { kind: 'reviewed', tree, version, at: version, actor: { id: 'priya', kind: 'human', trust: 'operator' }, review: { runId: `turn-${version}`, builder, reviewer: 'codex' } } }) as AppVersion;

  it('is every builder of a reviewed version after the last published one, by version and not by tree', () => {
    const versions = [v(1, 't1'), v(2, 't2', 'claude'), v(3, 't3', 'pi'), v(4, 't2', 'codex#2'), v(5, 't5')];
    expect(buildersSince(versions, 0)).toEqual(['claude', 'codex#2', 'pi']);
    // v2 published: v4 rebuilt v2's tree, and its builder still counts.
    expect(buildersSince(versions, 2)).toEqual(['codex#2', 'pi']);
    expect(buildersSince(versions, 5)).toEqual([]);
  });
});

describe('an Apps publish`s gates are a human operator`s only', () => {
  let app: FastifyInstance;
  let dir: string;
  const confirmCalls: unknown[][] = [];
  const audit = { record: vi.fn(() => Date.now()), readAll: vi.fn(async () => []) } as unknown as AuditLog;
  const gateCache = new GateCache();
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'k6-gate-'));
    const view = {
      session: { id: RUN, workflow_id: 'apps-publish', problem: 'p', entity_mode: 'shared', collection_scope: null, clis: ['claude', 'codex'], status: 'awaiting_human', human_confirm: 'all', unit_ix: 2, attempt: 0, workdir: join(dir, 'wt'), repo_ref: 'esc', extra_write_roots: [], evidence_root: join(dir, 'ev'), verified_tree: null, archived_at: null, archive_note: null },
      units: [{ id: `${RUN}:produce`, session_id: RUN, ord: 2, description: '', stage: 'build', phase_ref: 'unit-2', assigned_cli: null, assigned_invocation: null, council_task_ref: null, routing: null, status: 'pending', tool_cmd: ['wicked-crew', 'apps-produce'] }],
    };
    const mockAdapter = {
      sessionsDetail: vi.fn(async () => [structuredClone(view)]),
      sessions: vi.fn(async () => [RUN]),
      listRepos: vi.fn(async () => []),
      listWorkflows: () => BUILTIN_WORKFLOWS,
      getWorkflow: () => null,
      interactionRequests: vi.fn(async () => [{ kind: 'gate', ord: 2, prompt: 'consent', created_at: Date.now() }]),
      runEvents: vi.fn(async () => []),
      listConformanceClaims: vi.fn(async () => []),
      confirmGate: vi.fn(async (...args: unknown[]) => {
        confirmCalls.push(args);
        return 'executing';
      }),
    };
    const appsStore = { publishingOf: (id: string) => (id === RUN ? { slug: 'esc', publishing: {} } : null), publish: null, turns: null, sourceStage: null, has: () => false, list: () => [] };
    app = Fastify({ logger: false });
    app.addHook('onRequest', async (req) => {
      const named = req.headers['x-test-actor'];
      if (typeof named === 'string') {
        const [kind, trust] = named.split('/');
        (req as unknown as { actor: unknown }).actor = { id: `test-${kind}`, kind, trust };
      }
    });
    registerRoutes(app, mockAdapter as unknown as CoreAdapter, gateCache, new ElicitationCache(), undefined, { audit, authMode: 'off' }, { apps: appsStore as never, worktreeExists: () => true, deliverExec: async () => ({ status: 0, output: '' }) } as never);
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a seat (agent), a plugin or a standing order (system) cannot approve it, by the gate or by resume; nothing is confirmed', async () => {
    for (const actor of ['agent/operator', 'plugin/operator', 'system/operator', 'agent/admin']) {
      const g = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN}/gate`, headers: { 'x-test-actor': actor }, payload: { approve: true } });
      expect(g.statusCode, `${actor} gate: ${g.body}`).toBe(403);
      expect(g.json().code).toBe('human_operator_only');
      const r = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN}/resume`, headers: { 'x-test-actor': actor } });
      expect(r.statusCode, `${actor} resume: ${r.body}`).toBe(403);
    }
    // A publish the app's record no longer points at (replaced after it failed) keeps the rule for its whole life,
    // and a reassign (which can approve) is refused the same way.
    const replaced = 'apps-publish-esc-ffffffffffff';
    for (const actor of ['agent/operator', 'system/operator']) {
      const g = await app.inject({ method: 'POST', url: `/api/v1/runs/${replaced}/gate`, headers: { 'x-test-actor': actor }, payload: { approve: true } });
      expect(g.statusCode, `${actor} replaced gate: ${g.body}`).toBe(403);
      expect(g.json().code).toBe('human_operator_only');
      const ra = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN}/reassign`, headers: { 'x-test-actor': actor }, payload: {} });
      expect(ra.statusCode, `${actor} reassign: ${ra.body}`).toBe(403);
      expect(ra.json().code).toBe('human_operator_only');
    }
    expect(confirmCalls).toEqual([]);
    expect((audit.record as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === 'gate.apps_publish_refused').length).toBeGreaterThanOrEqual(12);
    // A human operator passes this guard (whatever the gate then answers).
    const human = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN}/gate`, headers: { 'x-test-actor': 'human/operator' }, payload: { approve: true } });
    expect(human.json().code).not.toBe('human_operator_only');
  });
});

describe('the worker-facing publish routes and the Teams package', () => {
  it('the two step routes are bearer-exempt unit-token routes (exactly them)', () => {
    expect(isUnitTokenRoute('POST', '/api/v1/apps/publish/check')).toBe(true);
    expect(isUnitTokenRoute('POST', '/api/v1/apps/publish/produce')).toBe(true);
    expect(isUnitTokenRoute('POST', '/api/v1/apps/esc/publish')).toBe(false);
    expect(isUnitTokenRoute('GET', '/api/v1/apps/publish/check')).toBe(false);
  });

  it('the outline icon is a white mark on transparency, and the package version climbs with each publish', () => {
    const png = outlinePng();
    const idat = png.indexOf(Buffer.from('IDAT'));
    const raw = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
    const alpha = (x: number, y: number): number => raw[y * (1 + 32 * 4) + 1 + x * 4 + 3]!;
    expect(alpha(0, 0)).toBe(255); // the frame
    expect(alpha(5, 5)).toBe(0); // transparent between frame and mark
    expect(alpha(15, 15)).toBe(255); // the mark
    const m = { app: { slug: 'esc', name: 'Escalations', version: 14 }, site: { origin: 'https://esc.example.com' }, identity: { clientId: '99999999-8888-7777-6666-555555555555' } } as never;
    expect((teamsManifest(m, 1) as { version: string }).version).toBe('1.1.14');
    expect((teamsManifest(m, 2) as { version: string }).version).toBe('1.2.14');
  });
});
