// The background delivery-derivation cache (delivery-cache.ts) + the `GET /runs` request-path
// contract it exists for — the p99 finding: p50=182ms but p99=18.7s, 100% of >5s requests on the
// LIST route, because the crew#311 vacuity split ran two git probes (10s timeout each) per
// would-be-stranded run at DTO assembly, fanned out over ~20 terminal worktrees and contending
// with the active worker's git. Pins:
//
//   REQUEST PATH — `GET /runs` / `GET /runs/:id` NEVER invoke the derivation probes, however
//     cold the cache: a miss answers the stat-only tri-state (`deliveryStateOf` — the
//     pre-crew#311 stranded/none label) and does not enqueue anything;
//   `?limit=N` — honored (it was silently ignored; 317KB payloads regardless), applied AFTER the
//     actionable-first sort so a capped poll still sees needs-you runs first, default UNBOUNDED
//     (an implicit cap would silently change results for un-migrated callers), malformed values
//     refused 400 instead of ignored (the FINDING-031 posture);
//   SELF-HEAL — a cache miss degrades for at most one sweep: the same request answers the full
//     derivation ('vacuous', both worktree-present and reaped shapes) after `sweep()`;
//   POOL — the background sweep runs at most MAX_CONCURRENT_DERIVATIONS derivations at once,
//     with an in-flight guard per run (an overlapping warm folds into the pending derivation,
//     never a second git pair), and only candidate runs (completed + repo-scoped +
//     not-yet-delivered) are ever derived;
//   WARM — `warm(runId)` derives one run immediately (the terminal-frame hook), and a run the
//     DeliveryIndex already answers is skipped.
//
// Fastify inject() with a mock adapter (no NAPI), mirroring run-delivery-field.test.ts.

import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { QeGateCache } from '../src/qe/gate-events.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import {
  DeliveryIndex,
  VacuityProbeUnavailable,
  type VacuityProbes,
} from '../src/api/delivery-index.js';
import {
  DeliveryDerivationCache,
  MAX_CONCURRENT_DERIVATIONS,
} from '../src/api/delivery-cache.js';
import { AuditLog } from '../src/api/audit.js';
import { GroupIndex } from '../src/api/group-index.js';
import { buildGroups, sessionsById } from '../src/campaigns/rollup.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { SessionView } from '../src/core/types.js';
import type { FastifyInstance } from 'fastify';

type MockAdapter = {
  sessionsDetail: ReturnType<typeof vi.fn>;
  sessions: ReturnType<typeof vi.fn>;
};

function view(
  id: string,
  over: {
    status?: string;
    repo_ref?: string | null;
    workdir?: string | null;
    archived_at?: number | null;
  } = {},
): SessionView {
  return {
    session: {
      id,
      workflow_id: `wf-${id}`,
      problem: 'p',
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['stub'],
      status: over.status ?? 'completed',
      human_confirm: 'none',
      unit_ix: 1,
      attempt: 0,
      workdir: over.workdir ?? null,
      repo_ref: over.repo_ref ?? null,
      extra_write_roots: [],
      archived_at: over.archived_at ?? null,
      archive_note: null,
    },
    units: [],
  } as unknown as SessionView;
}

/** App + the cache the routes read, built over spy-able probes — nothing started, no timers. */
function build(
  views: SessionView[],
  probes: Partial<VacuityProbes> = {},
  deliveryIndex = new DeliveryIndex(),
  retryBaseMs?: number,
): { app: FastifyInstance; cache: DeliveryDerivationCache; adapter: MockAdapter } {
  const adapter: MockAdapter = {
    sessionsDetail: vi.fn().mockResolvedValue(views),
    sessions: vi.fn().mockResolvedValue(views.map((v) => v.session.id)),
  };
  const full: VacuityProbes = {
    worktreeExists: probes.worktreeExists ?? (() => true),
    worktreeIsClean: probes.worktreeIsClean ?? (async () => false),
    runBranchIsEmpty: probes.runBranchIsEmpty ?? (async () => false),
  };
  const cache = new DeliveryDerivationCache({
    listViews: () => adapter.sessionsDetail() as Promise<SessionView[]>,
    probes: full,
    isDelivered: (runId) => deliveryIndex.urlFor(runId) !== undefined,
    ...(retryBaseMs !== undefined ? { retryBaseMs } : {}),
  });
  const app = Fastify({ logger: false });
  registerRoutes(
    app,
    adapter as unknown as CoreAdapter,
    new GateCache(),
    new ElicitationCache(),
    new QeGateCache(),
    { bus: null, index: new MembershipIndex(), log: () => undefined },
    { audit: AuditLog.noop(), authMode: 'off' },
    {
      deliveryIndex,
      deliveryCache: cache,
      worktreeExists: full.worktreeExists,
      worktreeIsClean: full.worktreeIsClean,
      runBranchIsEmpty: full.runBranchIsEmpty,
    },
  );
  return { app, cache, adapter };
}

async function listRuns(
  app: FastifyInstance,
  qs = '',
): Promise<{ code: number; runs: { session: Record<string, unknown> }[]; error?: string }> {
  const res = await app.inject({ method: 'GET', url: `/api/v1/runs${qs}` });
  const body = res.json() as { runs?: { session: Record<string, unknown> }[]; error?: string };
  return { code: res.statusCode, runs: body.runs ?? [], ...(body.error !== undefined ? { error: body.error } : {}) };
}

describe('GET /runs never spawns git — the derivation probes are request-path-unreachable', () => {
  it('a COLD cache serves the whole fan-out from stat-only reads; no probe is ever invoked', async () => {
    const worktreeIsClean = vi.fn(async () => true);
    const runBranchIsEmpty = vi.fn(async () => true);
    // The worst-case fan-out shape: every run completed + repo-scoped, half with live worktrees
    // (the would-be-'stranded' set that used to pay the git pair) and half reaped (the
    // would-be-'none' set that used to pay the branch probe).
    const views = [
      ...[1, 2, 3].map((i) => view(`run-live-${i}`, { repo_ref: 'r', workdir: `/wt/${i}` })),
      ...[4, 5, 6].map((i) => view(`run-reaped-${i}`, { repo_ref: 'r', workdir: '/gone' })),
    ];
    const { app } = build(views, {
      worktreeExists: (p) => p.startsWith('/wt/'),
      worktreeIsClean,
      runBranchIsEmpty,
    });
    try {
      await app.ready();
      const { runs } = await listRuns(app);
      // The degraded (pre-crew#311) tri-state, straight from one stat per run:
      for (const i of [1, 2, 3]) {
        expect(runs.find((r) => r.session['id'] === `run-live-${i}`)!.session['delivery']).toBe('stranded');
      }
      for (const i of [4, 5, 6]) {
        expect(runs.find((r) => r.session['id'] === `run-reaped-${i}`)!.session['delivery']).toBe('none');
      }
      // The detail route rides the same cache read:
      const detail = await app.inject({ method: 'GET', url: '/api/v1/runs/run-live-1' });
      expect((detail.json() as { run: { session: Record<string, unknown> } }).run.session['delivery']).toBe('stranded');
      // THE pin: neither request invoked a derivation probe — the request path cannot spawn git.
      expect(worktreeIsClean).not.toHaveBeenCalled();
      expect(runBranchIsEmpty).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('?limit — honored, post-sort, default unbounded, loud on malformed input', () => {
  const mixed = [
    view('run-done', { repo_ref: null }),
    view('run-gated', { status: 'awaiting_human' }),
    view('run-busy', { status: 'executing' }),
    view('run-archived', { archived_at: 1 }),
  ];

  it('returns the top N AFTER the actionable-first sort (a capped poll still sees needs-you first)', async () => {
    const { app } = build(mixed);
    try {
      await app.ready();
      const { runs } = await listRuns(app, '?limit=2');
      expect(runs.map((r) => r.session['id'])).toEqual(['run-gated', 'run-busy']);
    } finally {
      await app.close();
    }
  });

  it('defaults to UNBOUNDED (the param was ignored before — an implicit cap would change results silently)', async () => {
    const { app } = build(mixed);
    try {
      await app.ready();
      // No limit: every visible (non-archived) run, ordered.
      const all = await listRuns(app);
      expect(all.runs.map((r) => r.session['id'])).toEqual(['run-gated', 'run-busy', 'run-done']);
      // A limit past the end is the same full set, and composes with ?include=archived.
      const over = await listRuns(app, '?limit=99');
      expect(over.runs).toHaveLength(3);
      const archived = await listRuns(app, '?include=archived&limit=99');
      expect(archived.runs).toHaveLength(4);
    } finally {
      await app.close();
    }
  });

  it('limit=0 is a real (empty) answer; malformed/repeated values are refused 400, never ignored', async () => {
    const { app } = build(mixed);
    try {
      await app.ready();
      expect((await listRuns(app, '?limit=0')).runs).toEqual([]);
      // Canonical decimal ONLY (Copilot on #435): the `Number(...)` aliases — hex, exponent,
      // signed, whitespace-padded (`%20` = ' 1', `%2B` = '+1'), Infinity, non-canonical zeros —
      // are refused exactly like the plainly-garbage spellings, never quietly honored.
      for (const qs of [
        '?limit=banana',
        '?limit=-1',
        '?limit=1.5',
        '?limit=',
        '?limit=1&limit=2',
        '?limit=0x10',
        '?limit=2e3',
        '?limit=%201',
        '?limit=%2B1',
        '?limit=Infinity',
        '?limit=01',
      ]) {
        const res = await listRuns(app, qs);
        expect(res.code, qs).toBe(400);
        expect(res.error, qs).toContain('limit');
      }
    } finally {
      await app.close();
    }
  });
});

describe('self-heal — a miss degrades to the stat-only label for one sweep, then reads the full derivation', () => {
  it("worktree-present vacuous: 'stranded' cold, 'vacuous' after one sweep", async () => {
    const { app, cache } = build([view('run-v', { repo_ref: 'r', workdir: '/wt' })], {
      worktreeExists: () => true,
      worktreeIsClean: async () => true,
    });
    try {
      await app.ready();
      expect((await listRuns(app)).runs[0]!.session['delivery']).toBe('stranded');
      await cache.sweep();
      expect((await listRuns(app)).runs[0]!.session['delivery']).toBe('vacuous');
    } finally {
      await app.close();
    }
  });

  it("reaped vacuous (the FINDING-003 shape): 'none' cold, 'vacuous' after one sweep", async () => {
    const { app, cache } = build([view('run-r', { repo_ref: 'r', workdir: '/gone' })], {
      worktreeExists: () => false,
      runBranchIsEmpty: async () => true,
    });
    try {
      await app.ready();
      expect((await listRuns(app)).runs[0]!.session['delivery']).toBe('none');
      await cache.sweep();
      expect((await listRuns(app)).runs[0]!.session['delivery']).toBe('vacuous');
    } finally {
      await app.close();
    }
  });
});

describe('the background pool — capped, in-flight-guarded, candidates only', () => {
  it(`runs at most ${MAX_CONCURRENT_DERIVATIONS} derivations at once and folds a warm into the pending job`, async () => {
    // Six candidates, each derivation gated on a hand-released promise so the pool's shape is
    // observable: the sweep must hold at the cap, never fan all six out at once.
    const gates: Array<() => void> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const worktreeIsClean = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((release) => gates.push(release));
      inFlight -= 1;
      return true;
    });
    const views = [1, 2, 3, 4, 5, 6].map((i) =>
      view(`run-${i}`, { repo_ref: 'r', workdir: `/wt/${i}` }),
    );
    const { cache } = build(views, { worktreeExists: () => true, worktreeIsClean });

    const sweeping = cache.sweep();
    // Let the pool fill: exactly the cap starts, the rest queue.
    await vi.waitFor(() => expect(worktreeIsClean.mock.calls.length).toBe(MAX_CONCURRENT_DERIVATIONS));
    expect(inFlight).toBe(MAX_CONCURRENT_DERIVATIONS);
    // A terminal-frame warm for a run the sweep already holds in-flight: the guard folds it
    // into the pending derivation — no extra probe, ever. (Not awaited yet: the fold means it
    // settles exactly when the gated derivation does.)
    const warmed = cache.warm('run-1');
    // Release everything; the queue drains through the pool.
    while (worktreeIsClean.mock.calls.length < views.length || gates.length > 0) {
      gates.splice(0).forEach((release) => release());
      await new Promise((r) => setTimeout(r, 0));
    }
    await Promise.all([sweeping, warmed]);
    expect(worktreeIsClean).toHaveBeenCalledTimes(views.length); // one per run — the guard held
    expect(maxInFlight).toBe(MAX_CONCURRENT_DERIVATIONS);
  });

  it('derives candidates only: non-terminal, failed, repo-less, and delivered runs are never probed', async () => {
    const worktreeIsClean = vi.fn(async () => true);
    const runBranchIsEmpty = vi.fn(async () => true);
    const index = new DeliveryIndex();
    index.set('run-pr', 'https://github.com/o/r/pull/9');
    const { cache } = build(
      [
        view('run-live', { status: 'executing', repo_ref: 'r', workdir: '/wt' }),
        view('run-failed', { status: 'failed', repo_ref: 'r', workdir: '/wt' }),
        view('run-repoless'),
        view('run-pr', { repo_ref: 'r', workdir: '/wt' }),
        view('run-candidate', { repo_ref: 'r', workdir: '/wt' }),
      ],
      { worktreeExists: () => true, worktreeIsClean, runBranchIsEmpty },
      index,
    );
    await cache.sweep();
    expect(worktreeIsClean.mock.calls).toHaveLength(1); // run-candidate alone
    expect(runBranchIsEmpty).not.toHaveBeenCalled();
  });

  it('NEVER caches a failed derivation — the raced terminal warm degrades, retries, and heals (PR #435 review)', async () => {
    // The defect: the terminal-frame warm derives at the most turbulent instant of a run's life
    // (concurrent with the engine's terminal reap); a probe that failed used to read `false`
    // ("not clean") and be CACHED as an honest 'stranded' — pinned forever where no sweep ticks.
    // Pin the rule: a probe throw leaves the entry untouched (the read keeps the honest
    // stat-only degrade) and a short-backoff retry re-derives to the truth.
    let exists = true; // the worktree, reaped between the failed probe and the retry
    const worktreeIsClean = vi.fn(async () => {
      throw new VacuityProbeUnavailable('git status could not answer', 'raced the terminal reap');
    });
    const runBranchIsEmpty = vi.fn(async () => true); // post-reap truth: branch carries nothing
    const { cache } = build(
      [view('run-raced', { repo_ref: 'r', workdir: '/wt' })],
      { worktreeExists: () => exists, worktreeIsClean, runBranchIsEmpty },
      new DeliveryIndex(),
      5, // retry backoff floor, shortened for the test
    );
    try {
      await cache.warm('run-raced'); // the failed derivation itself
      const facts = { id: 'run-raced', status: 'completed', repo_ref: 'r', workdir: '/wt' } as const;
      // Not cached: the read still answers the stat-only degrade, never the raced 'stranded'
      // dressed up as a full derivation. (Both spell 'stranded' here — what is pinned is that
      // the WRONG shape was not recorded, proven by the heal below.)
      expect(cache.read(facts)).toEqual({ delivery: 'stranded' });
      exists = false; // the reap lands
      // The retry (5ms backoff) re-derives against the post-reap truth and heals to 'vacuous'.
      await vi.waitFor(() => expect(cache.read(facts)).toEqual({ delivery: 'vacuous' }), {
        timeout: 2_000,
      });
      expect(runBranchIsEmpty).toHaveBeenCalled();
    } finally {
      cache.stop(); // clears any pending retry timer
    }
  });

  it("a 'stranded' verdict over a worktree that VANISHED mid-derivation is retried, not recorded", async () => {
    // The reap deletes files depth-first: `git status` can succeed and read "dirty" (deleted
    // paths) an instant before the .git link disappears. A verdict whose subject is gone is not
    // an answer — the stat re-check turns it into a retry that lands on the branch-probe truth.
    let exists = true;
    const worktreeIsClean = vi.fn(async () => {
      exists = false; // the reap lands DURING the probe; git still answered "not clean"
      return false;
    });
    const runBranchIsEmpty = vi.fn(async () => true);
    const { cache } = build(
      [view('run-vanish', { repo_ref: 'r', workdir: '/wt' })],
      { worktreeExists: () => exists, worktreeIsClean, runBranchIsEmpty },
      new DeliveryIndex(),
      5,
    );
    try {
      await cache.warm('run-vanish');
      const facts = { id: 'run-vanish', status: 'completed', repo_ref: 'r', workdir: '/wt' } as const;
      await vi.waitFor(() => expect(cache.read(facts)).toEqual({ delivery: 'vacuous' }), {
        timeout: 2_000,
      });
    } finally {
      cache.stop();
    }
  });

  it('warm(runId) derives one run immediately (the terminal-frame hook) and skips delivered runs', async () => {
    const worktreeIsClean = vi.fn(async () => true);
    const index = new DeliveryIndex();
    index.set('run-pr', 'https://github.com/o/r/pull/9');
    const { cache } = build(
      [
        view('run-a', { repo_ref: 'r', workdir: '/wt' }),
        view('run-pr', { repo_ref: 'r', workdir: '/wt' }),
      ],
      { worktreeExists: () => true, worktreeIsClean },
      index,
    );
    await cache.warm('run-a');
    expect(
      cache.read({ id: 'run-a', status: 'completed', repo_ref: 'r', workdir: '/wt' }),
    ).toEqual({ delivery: 'vacuous' });
    await cache.warm('run-pr');
    expect(worktreeIsClean).toHaveBeenCalledTimes(1); // run-a alone — the PR run never probes
  });
});

describe('campaigns rollup — a probe that cannot answer degrades that request, never 500s', () => {
  it('serves the stat-only tri-state when the vacuity probe throws (PR #435 review)', async () => {
    // The rollup still derives on the request path (out of the cache's scope, same shared probe
    // memo): a raced worktree must cost one request its refinement, not a whole campaign
    // scoreboard its 200.
    const groupIndex = new GroupIndex();
    groupIndex.set('run-x', { label: 'batch-1' });
    const views = [view('run-x', { repo_ref: 'r', workdir: '/wt' })];
    const groups = await buildGroups(sessionsById(views), {
      groupIndex,
      deliveryUrlFor: () => undefined,
      vacuity: {
        worktreeExists: () => true,
        worktreeIsClean: async () => {
          throw new VacuityProbeUnavailable('git status could not answer', 'raced teardown');
        },
        runBranchIsEmpty: async () => false,
      },
    });
    expect(groups).toEqual([
      { label: 'batch-1', runs: [{ runId: 'run-x', status: 'completed', delivery: 'stranded' }] },
    ]);
  });
});
