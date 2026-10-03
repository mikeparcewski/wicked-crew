// WT-W4 — workflow discovery (DES-walkthrough-proof §4.13; §8 "fixture logs produce exactly the two
// proposals; PA additions not counted; dedup; nothing promoted"). Two deterministic queries registered
// as trigger-registry entries, fired on run terminal frames, counting over a project-level view the
// daemon builds (`src/api/discovery-source.ts`) and the registry hands to the checks as `ctx.discovery`.
// Each hit is ONE `proposal` row per (project, query, draft hash) — run-less, project-scoped — that the
// emitter hands to the existing review queue (`policy:testing`). Nothing here lands a rule.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RecordedEvent, RepoEntry, SessionView, WatchFinding } from 'wicked-crew-api-types';
import { makeDiscoverySource, humanAddedOf, type PlanRow } from '../src/api/discovery-source.js';
import { emitOnBus, readBus } from '../src/core/bus.js';
import type { CoreEvent } from '../src/core/types.js';
import {
  addedByHandCheck,
  addedByHandProposals,
  draftHash,
  whatCatchesCheck,
  whatCatchesProposals,
  type AddedByHandParams,
  type AddedByHandThreshold,
  type WhatCatchesThreshold,
} from '../src/watch/checks/discovery.js';
import { SHIPPED_CHECKS } from '../src/watch/checks/index.js';
import { WATCH_FINDING_PREFIX, WATCH_FINDING_RAISED } from '../src/watch/events.js';
import { loadEntries, SHIPPED_ENTRIES_DIR } from '../src/watch/loader.js';
import { WatchRegistry, type WatchRegistryOptions } from '../src/watch/registry.js';
import type { CheckCtx, DiscoveryRun, DiscoverySnapshot, KeyPointInput, RunWatchState } from '../src/watch/types.js';
import { removeScratch } from './setup/scratch.js';

const DAY = 86_400_000;
const NOW = 1_760_000_000_000;
const PARAMS: AddedByHandParams = { catalog: ['test', 'test_plan', 'walkthrough_plan', 'walkthrough_review', 'review', 'critique'] };
const T5: AddedByHandThreshold = { consecutive: 5 };
const T3: WhatCatchesThreshold = { times: 3, window_days: 30 };

let n = 0;
const run = (id: string, over: Partial<DiscoveryRun> = {}): DiscoveryRun => ({
  run_id: id,
  kind: 'feature',
  launched_at: NOW - 10 * DAY + ++n * 60_000,
  human_added: [],
  walkthrough: null,
  test: null,
  ...over,
});
const snap = (runs: DiscoveryRun[], project = 'proj-1'): DiscoverySnapshot => ({ project_id: project, runs, unreadable: 0 });

beforeEach(() => {
  n = 0;
});

describe('addedByHandProposals — a step a person added to N consecutive launched chains', () => {
  it('five consecutive newest runs carrying a human-added catalog id → ONE proposal naming the step, the runs and the kinds', () => {
    const runs = [run('r1'), run('r2', { human_added: ['walkthrough_review'] }), run('r3', { human_added: ['walkthrough_review'], kind: 'bug' }), run('r4', { human_added: ['walkthrough_review'] }), run('r5', { human_added: ['walkthrough_review'] }), run('r6', { human_added: ['walkthrough_review', 'build'] })];
    const out = addedByHandProposals(snap(runs), PARAMS, T5);
    expect(out).toEqual([
      {
        query: 'added_by_hand',
        catalog: 'walkthrough_review',
        rule: 'A bug or feature run includes the `walkthrough_review` step.',
        sentence: "You've added `walkthrough_review` by hand to 5 consecutive bug or feature runs — make it the default?",
        evidence: { count: 5, window: '5 consecutive runs', run_ids: ['r2', 'r3', 'r4', 'r5', 'r6'], kinds: ['bug', 'feature'] },
      },
    ]);
  });

  it('the streak is counted from the newest run back; a gap breaks it; four is not five; `build` is not a step a testing rule may oblige', () => {
    const hand = { human_added: ['walkthrough_review', 'build'] };
    expect(addedByHandProposals(snap([run('a', hand), run('b', hand), run('c'), run('d', hand), run('e', hand), run('f', hand)]), PARAMS, T5)).toEqual([]);
    expect(addedByHandProposals(snap([run('a', hand), run('b', hand), run('c', hand), run('d', hand)]), PARAMS, T5)).toEqual([]);
    const five = [run('a', hand), run('b', hand), run('c', hand), run('d', hand), run('e', hand)];
    expect(addedByHandProposals(snap(five), PARAMS, T5).map((p) => p.catalog)).toEqual(['walkthrough_review']);
    expect(addedByHandProposals(snap(five), PARAMS, { consecutive: 6 })).toEqual([]);
  });

  it('runs are ordered by launch time whatever order the snapshot lists them in', () => {
    const hand = { human_added: ['test'] };
    const shuffled = [run('e', hand), run('a', hand), run('c'), run('d', hand), run('b', hand)].map((r, i) => ({ ...r, launched_at: NOW - (5 - 'abcde'.indexOf(r.run_id)) * DAY + i }));
    // launch order a, b, c, d, e: the newest two carry it, c does not → streak 2.
    expect(addedByHandProposals(snap(shuffled), PARAMS, { consecutive: 2 }).map((p) => p.evidence.run_ids)).toEqual([['d', 'e']]);
  });
});

describe('whatCatchesProposals — a walkthrough FAIL while the same run\'s test verdict was PASS, K times in the window', () => {
  it('three such runs inside 30 days → ONE proposal to hold TST-1002; FAIL/FAIL, FAIL/none and an old FAIL/PASS do not count', () => {
    const caught = { walkthrough: 'FAIL', test: 'PASS' };
    const runs = [
      run('old', { ...caught, launched_at: NOW - 40 * DAY }),
      run('r1', caught),
      run('r2', { walkthrough: 'FAIL', test: 'FAIL' }),
      run('r3', { walkthrough: 'FAIL', test: null }),
      run('r4', { ...caught, kind: 'bug' }),
      run('r5', { walkthrough: 'PASS', test: 'PASS' }),
      run('r6', caught),
    ];
    expect(whatCatchesProposals(snap(runs), T3, NOW)).toEqual([
      {
        query: 'what_catches',
        rule: 'A change to code or config gets Test plus a walkthrough review by a different helper (TST-1002, held).',
        sentence: 'A walkthrough caught what the tests passed 3 times in the last 30 days — hold TST-1002 (Test plus a walkthrough review) for bug or feature runs?',
        evidence: { count: 3, window: '30d', run_ids: ['r1', 'r4', 'r6'], kinds: ['bug', 'feature'] },
      },
    ]);
    expect(whatCatchesProposals(snap(runs.slice(0, 5)), T3, NOW)).toEqual([]); // two inside the window
  });
});

describe('the two queries over one fixture produce exactly the two proposals (§8), keyed by (project, query, draft hash)', () => {
  it('and the key is the draft, not the count: a sixth run re-derives the same subject', () => {
    const both = { human_added: ['walkthrough_review'], walkthrough: 'FAIL', test: 'PASS' };
    const five = [run('r1', both), run('r2', both), run('r3', both), run('r4', both), run('r5', both)];
    const a = addedByHandProposals(snap(five), PARAMS, T5);
    const w = whatCatchesProposals(snap(five), T3, NOW);
    expect([...a, ...w].map((p) => p.query)).toEqual(['added_by_hand', 'what_catches']);
    const six = [...five, run('r6', both)];
    expect(addedByHandProposals(snap(six), PARAMS, T5).map((p) => draftHash(p.query, p.rule))).toEqual(a.map((p) => draftHash(p.query, p.rule)));
    expect(draftHash('added_by_hand', 'x')).toMatch(/^[0-9a-f]{12}$/);
    expect(draftHash('added_by_hand', 'x')).not.toBe(draftHash('what_catches', 'x'));
  });
});

// ── the checks: a terminal frame, the project view through ctx.discovery, run-less project rows ──

const ctxWith = (discovery: CheckCtx['discovery']): CheckCtx => ({
  now: () => NOW,
  stats: () => ({ queueDepth: 0, queueHwm: 0, shedTotal: 0, tailLagMs: 0 }),
  ...(discovery !== undefined ? { discovery } : {}),
});
const terminal = (runId: string, type = 'sessionCompleted'): KeyPointInput => ({ source: 'core', type, event: { type, session: runId }, runId, at: NOW });
const fresh = (runId: string): RunWatchState => ({ runId, seen: new Set(), bag: new Map() });

describe('deterministic:added_by_hand / what_catches as checks', () => {
  const both = { human_added: ['walkthrough_review'], walkthrough: 'FAIL', test: 'PASS' };
  const view = snap([run('r1', both), run('r2', both), run('r3', both), run('r4', both), run('r5', both)]);

  it('raises one RUN-LESS, project-scoped proposal row per hit: subject = project:query:hash, `project` set, facts.proposal = the policy:testing queue item', async () => {
    const state = fresh('r5');
    const out = await addedByHandCheck.evaluate(terminal('r5'), state, PARAMS, T5, ctxWith(async () => view));
    expect(out).toHaveLength(1);
    const o = out[0]!;
    expect(o.op).toBe('raise');
    if (o.op !== 'raise') return;
    expect(o.subject).toBe(`proj-1:added_by_hand:${draftHash('added_by_hand', 'A feature run includes the `walkthrough_review` step.')}`);
    expect(o.project).toBe('proj-1');
    expect(o.kind).toBeUndefined(); // the entry's emit.as (proposal) stands
    expect(o.re).toBe('sessionCompleted#r5');
    expect(o.facts).toEqual({
      proposal: {
        kind_type: 'policy:testing',
        payload: { rule: 'A feature run includes the `walkthrough_review` step.', severity: 'warn', evidence: { count: 5, window: '5 consecutive runs', run_ids: ['r1', 'r2', 'r3', 'r4', 'r5'], kinds: ['feature'] } },
        facets: { project: 'proj-1' },
      },
      query: 'added_by_hand',
      catalog: 'walkthrough_review',
      count: 5,
      kinds: ['feature'],
    });
    expect(addedByHandCheck.coverage(state)).toEqual({ state: 'checked' });
    const w = await whatCatchesCheck.evaluate(terminal('r5', 'runCancelled'), fresh('r5'), {}, T3, ctxWith(async () => view));
    expect(w.map((x) => (x.op === 'raise' ? [x.subject.split(':').slice(0, 2).join(':'), x.project] : []))).toEqual([['proj-1:what_catches', 'proj-1']]);
  });

  it('coverage tells the truth: not ended yet; no discovery source; the run belongs to no project; the view could not be read in time', async () => {
    expect(addedByHandCheck.coverage(fresh('r1'))).toEqual({ state: 'not_checked', reason: 'the run has not ended yet' });
    const noSource = fresh('r1');
    expect(await addedByHandCheck.evaluate(terminal('r1'), noSource, PARAMS, T5, ctxWith(undefined))).toEqual([]);
    expect(addedByHandCheck.coverage(noSource)).toMatchObject({ state: 'not_checked', reason: expect.stringMatching(/no discovery source/) as unknown as string });
    const noProject = fresh('r1');
    expect(await whatCatchesCheck.evaluate(terminal('r1'), noProject, {}, T3, ctxWith(async () => null))).toEqual([]);
    expect(whatCatchesCheck.coverage(noProject)).toMatchObject({ state: 'not_checked', reason: expect.stringMatching(/no project/) as unknown as string });
    const slow = fresh('r1');
    expect(await whatCatchesCheck.evaluate(terminal('r1'), slow, {}, T3, ctxWith(async () => Promise.reject(new Error('the discovery read timed out after 600 ms'))))).toEqual([]);
    expect(whatCatchesCheck.coverage(slow)).toMatchObject({ state: 'not_checked', reason: expect.stringMatching(/could not be read in time.*600 ms/) as unknown as string });
  });

  it('describe names the thresholds', () => {
    expect(addedByHandCheck.describe(T5)).toMatch(/5 consecutive/);
    expect(whatCatchesCheck.describe(T3)).toMatch(/3 times/);
    expect(whatCatchesCheck.describe(T3)).toMatch(/30 days/);
  });
});

// ── the daemon's view: bus plan rows + sessions + seals + the ledger ──────────

let dir: string;
let busPath: string;
let registries: WatchRegistry[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'watch-w8-'));
  busPath = join(dir, 'bus', 'bus.db');
  registries = [];
});

afterEach(async () => {
  for (const r of registries) await r.stop();
  removeScratch(dir);
});

type Step = { catalog: string; id: string; added_by?: string };
const proposed = (runId: string, by: string, kind: string, steps: Step[], id = 'p'): PlanRow =>
  ({ event_id: 0, event_type: 'wicked.team.plan.proposed', payload: { run_id: runId, by, at: 1, ord: null, attempt: null, re: null, proposal_id: `${runId}-${id}`, kind, steps } }) as unknown as PlanRow;
const accepted = (runId: string, rev: number, steps: Step[], remove: string[] = []): PlanRow =>
  ({ event_id: 0, event_type: 'wicked.team.plan.accepted', payload: { run_id: runId, by: 'engine', at: 1, ord: null, attempt: null, re: null, plan_rev: rev, steps, override: remove.length > 0 ? { remove, reason: 'operator' } : null } }) as unknown as PlanRow;
const revised = (runId: string, reason: string, added: Step[]): PlanRow =>
  ({ event_id: 0, event_type: 'wicked.team.plan.revised', payload: { run_id: runId, by: 'claude#1', at: 1, ord: null, attempt: null, re: null, plan_rev: 2, reason, from_band: '20-39', to_band: '20-39', high_risk: false, added } }) as unknown as PlanRow;

describe('humanAddedOf — which catalog ids a PERSON put in the plan', () => {
  const pa = [{ catalog: 'build', id: 'b' }, { catalog: 'test', id: 't' }];
  it('a human edit adds what the PA\'s proposal did not have; what the PA already had is not "added by hand"; floor-added steps never count', () => {
    expect(humanAddedOf([proposed('r', 'claude#1', 'initial', pa), proposed('r', 'human', 'edit', [...pa, { catalog: 'walkthrough_plan', id: 'wp' }, { catalog: 'walkthrough_review', id: 'wr' }, { catalog: 'review', id: 'rv', added_by: 'floor' }])])).toEqual(['walkthrough_plan', 'walkthrough_review']);
    expect(humanAddedOf([proposed('r', 'claude#1', 'initial', [...pa, { catalog: 'walkthrough_review', id: 'wr' }]), proposed('r', 'human', 'edit', [...pa, { catalog: 'walkthrough_review', id: 'wr' }])])).toEqual([]);
  });
  it('PA additions (plan.revised pa_added / member_request) are not human; an override that removed the step takes it back', () => {
    expect(humanAddedOf([proposed('r', 'claude#1', 'initial', pa), revised('r', 'pa_added', [{ catalog: 'walkthrough_review', id: 'wr' }])])).toEqual([]);
    expect(humanAddedOf([proposed('r', 'claude#1', 'initial', pa), proposed('r', 'human', 'edit', [...pa, { catalog: 'walkthrough_review', id: 'wr' }]), accepted('r', 2, pa, ['wr'])])).toEqual([]);
  });
  it('a launch that carried a human plan (no PA proposal) counts every non-floor step; no rows → nothing', () => {
    expect(humanAddedOf([proposed('r', 'human', 'initial', [{ catalog: 'build', id: 'b' }, { catalog: 'test', id: 't' }, { catalog: 'review', id: 'rv', added_by: 'floor' }])])).toEqual(['build', 'test']);
    expect(humanAddedOf([])).toEqual([]);
  });
});

const SEAL = (overall: string) =>
  `recorder output\nWALKTHROUGH-SEAL ${JSON.stringify({ tree: 'abc123', storyline_sha: null, bundle_sha: 'a'.repeat(64), overall, chapters: [{ key: 'c1', verdict: overall }], edited_by: null })}\n`;

function view(id: string, status: string, units: Array<{ ord: number; catalog: string; status?: string }>, over: Record<string, unknown> = {}): SessionView {
  return {
    session: { id, workflow_id: 'feature', status, repo_ref: 'repo-1', created_at: NOW - 5 * DAY, ...over },
    units: units.map((u) => ({ id: `${id}:u${u.ord}`, session_id: id, ord: u.ord, catalog: u.catalog, status: u.status ?? 'completed' })),
  } as unknown as SessionView;
}

describe('makeDiscoverySource — the project view the registry hands to the checks', () => {
  async function seedBus(rows: PlanRow[]): Promise<void> {
    for (const r of rows) {
      const p = r.payload as { run_id: string; proposal_id?: string; plan_rev?: number };
      await emitOnBus(busPath, { event_type: r.event_type, domain: 'wicked-team', subdomain: 'plan', idempotency_key: `${r.event_type}:${p.run_id}:${p.proposal_id ?? p.plan_rev ?? Math.random()}`, payload: r.payload });
    }
  }

  it('reads human-added steps off the bus, the walkthrough verdict off the recorder\'s seal, the test verdict through the ledger read, the launch time off the first frame; caches terminal runs; counts unreadable ones', async () => {
    const pa = [{ catalog: 'build', id: 'b' }, { catalog: 'test', id: 't' }];
    await seedBus([
      proposed('r1', 'claude#1', 'initial', pa, 'p1'),
      proposed('r1', 'human', 'edit', [...pa, { catalog: 'walkthrough_plan', id: 'wp' }, { catalog: 'walkthrough_review', id: 'wr' }], 'p2'),
      proposed('r2', 'claude#1', 'initial', pa, 'p1'),
      proposed('other', 'human', 'initial', [{ catalog: 'walkthrough_review', id: 'wr' }], 'p1'), // another project's run
    ]);
    const reads: string[] = [];
    const verdicts: string[] = [];
    const source = makeDiscoverySource({
      dbPath: busPath,
      runsOf: (project) => (project === 'proj-1' ? ['r1', 'r2', 'r3', 'chat-9'] : []),
      sessions: async () => [
        view('r1', 'completed', [{ ord: 0, catalog: 'build' }, { ord: 1, catalog: 'test' }, { ord: 2, catalog: 'walkthrough_plan' }, { ord: 3, catalog: 'walkthrough_review' }]),
        view('r2', 'executing', [{ ord: 0, catalog: 'build' }, { ord: 1, catalog: 'test' }], { created_at: undefined }),
        view('r3', 'failed', [{ ord: 0, catalog: 'build' }]),
        view('other', 'completed', [{ ord: 0, catalog: 'walkthrough_review' }]),
      ],
      runEvents: async (id) => {
        reads.push(id);
        if (id === 'r3') return null;
        return [{ type: 'sessionStarted', ts: id === 'r2' ? NOW - 1 * DAY : NOW - 3 * DAY, seq: 1 } as unknown as RecordedEvent, { type: 'sessionCompleted', ts: NOW, seq: 2 } as unknown as RecordedEvent];
      },
      workOutput: async (unitId) => (unitId === 'r1:u3' ? SEAL('FAIL') : null),
      repos: async () => [{ id: 'repo-1', name: 'repo', root_path: '/nowhere', default_branch: 'main', registered_at: 0 } as RepoEntry],
      testVerdict: async (repoRoot, runId) => {
        verdicts.push(`${repoRoot}:${runId}`);
        return runId === 'r1' ? 'PASS' : null;
      },
      now: () => NOW,
    });
    const first = await source('proj-1');
    expect(first.project_id).toBe('proj-1');
    expect(first.unreadable).toBe(1); // r3: no event log
    expect(first.runs.map((r) => r.run_id)).toEqual(['r1', 'r2']); // launch order; r3 unreadable; chat-9 is not a run
    expect(first.runs[0]).toEqual({ run_id: 'r1', kind: 'feature', launched_at: NOW - 5 * DAY, human_added: ['walkthrough_plan', 'walkthrough_review'], walkthrough: 'FAIL', test: 'PASS' });
    expect(first.runs[1]).toEqual({ run_id: 'r2', kind: 'feature', launched_at: NOW - 1 * DAY, human_added: [], walkthrough: null, test: null });
    expect(verdicts).toEqual(['/nowhere:r1', '/nowhere:r2']); // only runs with a test step and a repo are read
    // Terminal runs are cached; the live one is re-read; the unreadable one is retried.
    reads.length = 0;
    const second = await source('proj-1');
    expect(second.runs).toEqual(first.runs);
    expect(reads.sort()).toEqual(['r2', 'r3']);
    expect(await source('proj-2')).toEqual({ project_id: 'proj-2', runs: [], unreadable: 0 });
  });

  it('without a bus the view still answers (no plan rows → nothing human-added), never throws', async () => {
    const source = makeDiscoverySource({
      dbPath: undefined,
      runsOf: () => ['r1'],
      sessions: async () => [view('r1', 'completed', [{ ord: 0, catalog: 'build' }])],
      runEvents: async () => [{ type: 'sessionStarted', ts: NOW - DAY, seq: 1 } as unknown as RecordedEvent],
      workOutput: async () => null,
      repos: async () => [],
      now: () => NOW,
    });
    expect((await source('proj-1')).runs).toEqual([{ run_id: 'r1', kind: 'feature', launched_at: NOW - 5 * DAY, human_added: [], walkthrough: null, test: null }]);
  });
});

// ── the shipped entries and the registry: dedup across runs and restarts, the sink, nothing promoted ──

function entriesDir(): string {
  const d = join(dir, 'entries');
  mkdirSync(d, { recursive: true });
  for (const e of loadEntries(SHIPPED_ENTRIES_DIR, SHIPPED_CHECKS).entries.filter((x) => x.on.source === 'internal' || x.id === 'added-by-hand' || x.id === 'what-catches')) {
    writeFileSync(join(d, `${e.id}.json`), JSON.stringify(e));
  }
  return d;
}

function makeRegistry(over: Partial<WatchRegistryOptions> = {}): WatchRegistry {
  const r = new WatchRegistry({
    dbPath: busPath,
    settings: async () => undefined,
    projectOf: (runId) => (runId.startsWith('none-') ? undefined : 'proj-1'),
    flushMs: 0,
    tickMs: 0,
    pollIntervalMs: 20,
    sleep: async () => undefined,
    // The fixture runs are dated against NOW; what_catches' 30-day window reads the registry's clock.
    now: () => NOW,
    entriesDir: entriesDir(),
    ...over,
  });
  registries.push(r);
  return r;
}

const ended = (runId: string, type = 'sessionCompleted'): CoreEvent => ({ type, session: runId }) as unknown as CoreEvent;

async function watchRows(): Promise<Array<{ event_type: string; payload: WatchFinding }>> {
  return (await readBus(busPath, WATCH_FINDING_PREFIX, { history: true })).map((r) => ({ event_type: r.event_type, payload: r.payload as WatchFinding }));
}

describe('the shipped discovery entries', () => {
  it('fire on the three terminal frames, emit proposals (decision), never roll up in practice, and are p2', () => {
    const { entries, refused } = loadEntries(SHIPPED_ENTRIES_DIR, SHIPPED_CHECKS);
    expect(refused).toEqual([]);
    for (const [id, check, threshold] of [
      ['added-by-hand', 'deterministic:added_by_hand', { consecutive: 5 }],
      ['what-catches', 'deterministic:what_catches', { times: 3, window_days: 30 }],
    ] as const) {
      expect(entries.find((e) => e.id === id)).toMatchObject({
        version: 1,
        on: { source: 'core', type: 'sessionCompleted' },
        join: [
          { source: 'core', type: 'sessionFailed' },
          { source: 'core', type: 'runCancelled' },
        ],
        filter: {},
        check,
        threshold,
        emit: { as: 'proposal', severity: 'info', watch_kind: 'decision', attach: null, rate: { per_run: 1000 } },
        priority: 'p2',
        enabled: true,
      });
    }
    expect(entries.find((e) => e.id === 'added-by-hand')?.params).toEqual(PARAMS);
  });

  it('one row per (project, query, draft) across runs AND restarts; the sink gets each proposal once; nothing lands a rule', async () => {
    const both = { human_added: ['walkthrough_review'], walkthrough: 'FAIL', test: 'PASS' };
    const viewOf = snap([run('r1', both), run('r2', both), run('r3', both), run('r4', both), run('r5', both)]);
    const submitted: WatchFinding[] = [];
    const asked: string[] = [];
    const opts: Partial<WatchRegistryOptions> = {
      discovery: async (project) => {
        asked.push(project);
        return viewOf;
      },
      submitProposal: async (f) => void submitted.push(f),
    };
    const r = makeRegistry(opts);
    await r.arm();
    r.offer(ended('r5'));
    await r.flush();
    let rows = await watchRows();
    expect(rows.map((x) => x.event_type)).toEqual([WATCH_FINDING_RAISED, WATCH_FINDING_RAISED]);
    const byQuery = Object.fromEntries(rows.map((x) => [x.payload.facts['query'] as string, x.payload]));
    expect(byQuery['added_by_hand']).toMatchObject({ run_id: null, project_id: 'proj-1', kind: 'proposal', watch_kind: 'decision', anchor: null, entry_id: 'added-by-hand' });
    expect(byQuery['what_catches']).toMatchObject({ run_id: null, project_id: 'proj-1', kind: 'proposal', entry_id: 'what-catches' });
    expect(byQuery['added_by_hand']!.sentence).toBe("You've added `walkthrough_review` by hand to 5 consecutive feature runs — make it the default?");
    expect(submitted.map((f) => (f.facts['proposal'] as { kind_type: string }).kind_type)).toEqual(['policy:testing', 'policy:testing']);
    expect(asked).toEqual(['proj-1']);
    // A second run of the same project ends: the same drafts resolve to the same rows; the sink is not asked again.
    r.offer(ended('r6', 'sessionFailed'));
    r.offer(ended('none-7')); // a run outside every project: nothing to count over
    await r.flush();
    rows = await watchRows();
    expect(rows).toHaveLength(2);
    expect(submitted).toHaveLength(2);
    expect(r.coverage('r6').map((c) => [c.entry_id, c.state])).toEqual([
      ['added-by-hand', 'checked'],
      ['what-catches', 'checked'],
    ]);
    expect(r.coverage('none-7').find((c) => c.entry_id === 'added-by-hand')).toMatchObject({ state: 'not_checked', reason: expect.stringMatching(/no project/) as unknown as string });
    await r.stop();
    // A restart hydrates the feed from the bus: the same proposals are not raised or filed again.
    const again = makeRegistry(opts);
    await again.arm();
    again.offer(ended('r8'));
    await again.flush();
    expect(await watchRows()).toHaveLength(2);
    expect(submitted).toHaveLength(2);
  });

  it('below the thresholds nothing is raised, and the view is read once per TTL for the project', async () => {
    const asked: string[] = [];
    const r = makeRegistry({
      discovery: async (project) => {
        asked.push(project);
        return snap([run('r1', { human_added: ['walkthrough_review'] }), run('r2', { walkthrough: 'FAIL', test: 'PASS' })]);
      },
    });
    await r.arm();
    r.offer(ended('r1'));
    r.offer(ended('r2'));
    await r.flush();
    expect(await watchRows()).toEqual([]);
    expect(asked).toEqual(['proj-1']);
  });
});
