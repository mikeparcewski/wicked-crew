// crew#496 / studio#230 — `AgentSession.ended_at` + onboarding `created_at` (DES-L8 r2 §5 PR-8B;
// api-types 0.38.0). "Every run says *time unknown*; the onboarding runs are unfiled and undated."
//
//   - `RunTimingIndex` gains the terminal half: `setEnded` (first stamp wins — idempotent per run),
//     `endedAtFor` (unix SECONDS, `undefined` = ABSENT on the wire), `hydrateFromEndedEntries`
//     (newest entry per run wins; `ts <= 0` stamps nothing);
//   - the run DTO echoes `ended_at` on GET /runs and GET /runs/:id from the index, ABSENT otherwise;
//   - `recordRunLaunched` (the ONE recorder every launch route uses) is reached by the onboarding
//     path through `CoreAdapter.setOnRunLaunched`, fired AFTER the engine accepted the launch, once
//     per run, with the run's launch detail — and a throwing recorder never fails the launch.
//
// The daemon-side terminal frame write (`run.ended` then `setEnded`) is pinned end-to-end by
// tests/integration/delivery-none-launch-e2e.test.ts over the real (stub-dispatcher) engine.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { AuditLog } from '../src/api/audit.js';
import { RunTimingIndex, recordRunLaunched } from '../src/api/run-timing-index.js';
import { CoreAdapter } from '../src/core/adapter.js';
import type { AuditEntry, SessionView } from '../src/core/types.js';
import type { LaunchOptions } from 'wicked-core-ts';
import { removeScratch } from './setup/scratch.js';

function entry(runId: string, ts: number): AuditEntry {
  return { ts, action: 'run.ended', runId, actor: { id: 'daemon', kind: 'system', trust: 'admin' } } as unknown as AuditEntry;
}

describe('RunTimingIndex — the terminal half (ended_at)', () => {
  it('setEnded stamps whole unix SECONDS; the FIRST stamp wins (a re-terminal never moves it)', () => {
    const idx = new RunTimingIndex();
    expect(idx.endedAtFor('r')).toBeUndefined();
    idx.setEnded('r', 1_700_000_000_999);
    expect(idx.endedAtFor('r')).toBe(1_700_000_000);
    idx.setEnded('r', 1_700_000_500_000); // a resume's second terminal frame
    expect(idx.endedAtFor('r')).toBe(1_700_000_000);
  });

  it('hydrateFromEndedEntries: the FIRST terminal wins (newest-first trail ⇒ the oldest entry), the same rule as setEnded; ts <= 0 and non-string runIds stamp nothing', () => {
    const idx = new RunTimingIndex();
    idx.hydrateFromEndedEntries([
      entry('a', 2_000_000), // a later re-terminal (resume) — newest on the trail
      entry('a', 1_000_000), // the run's first terminal — the honest ended_at
      entry('b', 0), // audit disabled — never fabricated
      { ts: 5_000_000, action: 'run.ended', runId: 42 } as unknown as AuditEntry,
    ]);
    expect(idx.endedAtFor('a')).toBe(1_000);
    expect(idx.endedAtFor('b')).toBeUndefined();
    expect(idx.endedAtFor('42')).toBeUndefined();
  });

  it('ended and created are independent maps — a run may carry either, both or neither', () => {
    const idx = new RunTimingIndex();
    idx.set('only-created', 10_000);
    idx.setEnded('only-ended', 20_000);
    expect(idx.createdAtFor('only-created')).toBe(10);
    expect(idx.endedAtFor('only-created')).toBeUndefined();
    expect(idx.createdAtFor('only-ended')).toBeUndefined();
    expect(idx.endedAtFor('only-ended')).toBe(20);
  });
});

function view(id: string, status: string): SessionView {
  return {
    session: {
      id,
      workflow_id: `wf-${id}`,
      problem: 'p',
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['stub'],
      status,
      human_confirm: 'none',
      unit_ix: 1,
      attempt: 0,
      workdir: null,
      repo_ref: null,
      extra_write_roots: [],
      archived_at: null,
      archive_note: null,
    },
    units: [],
  } as unknown as SessionView;
}

describe('the run DTO echoes ended_at (GET /runs, GET /runs/:id) — ABSENT when the index has none', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    const views = [view('run-done', 'completed'), view('run-live', 'executing')];
    const runTimingIndex = new RunTimingIndex();
    runTimingIndex.set('run-done', 1_700_000_000_000);
    runTimingIndex.setEnded('run-done', 1_700_000_090_000);
    const adapter = {
      sessionsDetail: vi.fn().mockResolvedValue(views),
      sessions: vi.fn().mockResolvedValue(views.map((v) => v.session.id)),
    };
    app = Fastify({ logger: false });
    registerRoutes(
      app,
      adapter as unknown as CoreAdapter,
      new GateCache(),
      new ElicitationCache(),
      { bus: null, index: new MembershipIndex(), log: () => undefined },
      { audit: AuditLog.noop(), authMode: 'off' },
      { runTimingIndex },
    );
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  it('list + detail carry created_at AND ended_at for the dated run; the live run carries neither', async () => {
    const list = (await app.inject({ method: 'GET', url: '/api/v1/runs' })).json() as {
      runs: { session: Record<string, unknown> }[];
    };
    const done = list.runs.find((r) => r.session['id'] === 'run-done')!.session;
    const live = list.runs.find((r) => r.session['id'] === 'run-live')!.session;
    expect(done['created_at']).toBe(1_700_000_000);
    expect(done['ended_at']).toBe(1_700_000_090);
    expect('ended_at' in live).toBe(false); // ABSENT, never null
    expect('created_at' in live).toBe(false);
    const detail = (await app.inject({ method: 'GET', url: '/api/v1/runs/run-done' })).json() as {
      run: { session: Record<string, unknown> };
    };
    expect(detail.run.session['ended_at']).toBe(1_700_000_090);
  });
});

describe('onboarding created_at — the adapter reports its off-POST-/runs launch to the daemon recorder', () => {
  let dir: string;
  let adapter: CoreAdapter;
  let priorOverlayDir: string | undefined;

  function stubCore(a: CoreAdapter, name: string, impl: unknown) {
    (a as unknown as { core: Record<string, unknown> }).core[name] = impl;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'onboard-created-at-'));
    const overlayDir = join(dir, 'workflows');
    mkdirSync(overlayDir, { recursive: true });
    priorOverlayDir = process.env['WICKED_WORKFLOWS_DIR'];
    process.env['WICKED_WORKFLOWS_DIR'] = overlayDir;
    adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
    stubCore(adapter, 'launchRun', (opts: LaunchOptions) => Promise.resolve(opts.sessionId));
  });

  afterEach(() => {
    if (priorOverlayDir === undefined) delete process.env['WICKED_WORKFLOWS_DIR'];
    else process.env['WICKED_WORKFLOWS_DIR'] = priorOverlayDir;
    adapter.close();
    removeScratch(dir);
  });

  it('launchOnboardingRun fires the recorder ONCE, after the launch, with the onboarding detail — and recordRunLaunched dates the run', async () => {
    const audit = AuditLog.noop();
    const runTimingIndex = new RunTimingIndex();
    const seen: Array<{ runId: string; detail: Record<string, unknown> }> = [];
    adapter.setOnRunLaunched((runId, detail) => {
      seen.push({ runId, detail });
      recordRunLaunched(audit, runTimingIndex, { id: 'daemon', kind: 'system', trust: 'admin' }, runId, detail);
    });
    const runId = await adapter.launchOnboardingRun('repo-1', 'alpha');
    expect(seen).toEqual([{ runId, detail: { workflow: 'onboarding', repoRef: 'repo-1', repoName: 'alpha', deliver: 'none' } }]);
    // The noop trail answers ts 0 ⇒ nothing stamped (created_at is derived ONLY from a durable entry).
    expect(runTimingIndex.createdAtFor(runId)).toBeUndefined();
  });

  it('a recorder that throws never fails the launch the engine already accepted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      adapter.setOnRunLaunched(() => {
        throw new Error('trail on fire');
      });
      await expect(adapter.launchOnboardingRun('repo-2', 'beta')).resolves.toMatch(/[0-9a-f-]{36}/);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('launch record failed');
    } finally {
      warn.mockRestore();
    }
  });

  it('with no recorder wired (a CLI-driven adapter) the launch is byte-for-byte today', async () => {
    await expect(adapter.launchOnboardingRun('repo-3', 'gamma')).resolves.toMatch(/[0-9a-f-]{36}/);
  });
});
