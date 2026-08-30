// TH-20 / test-R22 — campaign budget/runtime governance at the crew supervision layer.
//
// A fake scheduler and a hand-cranked clock drive `CampaignSupervisor` directly (the
// stall-watchdog test idiom): wall-clock budget exhaustion aborts remaining nodes with
// EXCLUDED-WITH-REASON status (never silent — state + frames + scheduler all see it),
// per-node timeouts kill only RUNNING time (awaiting-human is quiet by design), the
// kill/abandon policy decides what happens to in-flight nodes, cost per node lands in the
// `campaign-supervision.json` evidence report, and the TH-8-style env pins fail closed:
// a node may not launch without the exact `WICKED_UNIT_TIMEOUT_SECS` the policy pinned.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertNodeEnvPinned,
  assertWithinNightlyCap,
  buildSupervisionReport,
  CampaignSupervisor,
  DEFAULT_KILL_POLICY,
  DEFAULT_MAX_NODES,
  DEFAULT_NODE_TIMEOUT_SECS,
  DEFAULT_UNIT_TIMEOUT_SECS,
  DEFAULT_WALL_CLOCK_BUDGET_SECS,
  nodeEnvPins,
  resolveBudgetPolicy,
  SUPERVISION_REPORT_FILENAME,
  writeSupervisionReport,
  type CampaignBudgetExceededFrame,
  type CampaignBudgetPolicy,
  type CampaignNodeExcludedFrame,
  type SchedulerNodeView,
} from '../src/campaign/supervision.js';

const SEC = 1_000;
const MIN = 60_000;

/** A policy with test-scale ceilings (numbers stay honest multiples of the env knobs). */
function policy(overrides?: Partial<CampaignBudgetPolicy>): CampaignBudgetPolicy {
  return {
    wallClockBudgetMs: 60 * MIN,
    nodeTimeoutMs: 10 * MIN,
    unitTimeoutSecs: 900,
    maxNodes: 25,
    killPolicy: 'kill-running',
    ...overrides,
  };
}

/** Fake scheduler over a mutable node table + a captured mutation log. */
function fakeScheduler(nodes: SchedulerNodeView[]) {
  const cancelled: Array<{ nodeId: string; runId: string | undefined; reason: string }> = [];
  const excluded: Array<{ nodeId: string; reason: string }> = [];
  return {
    nodes,
    cancelled,
    excluded,
    scheduler: {
      listNodes: async () => nodes.map((n) => ({ ...n })),
      cancelNode: async (
        _campaignId: string,
        nodeId: string,
        runId: string | undefined,
        reason: string,
      ) => {
        cancelled.push({ nodeId, runId, reason });
        const n = nodes.find((x) => x.nodeId === nodeId);
        if (n !== undefined) n.phase = 'terminal';
      },
      excludeNode: async (_campaignId: string, nodeId: string, reason: string) => {
        excluded.push({ nodeId, reason });
        const n = nodes.find((x) => x.nodeId === nodeId);
        if (n !== undefined) n.phase = 'terminal';
      },
    },
  };
}

function build(nodes: SchedulerNodeView[], p: CampaignBudgetPolicy) {
  let nowMs = Date.parse('2026-08-29T01:00:00Z'); // a nightly run, fittingly
  const frames: Array<CampaignBudgetExceededFrame | CampaignNodeExcludedFrame> = [];
  const logs: string[] = [];
  const fake = fakeScheduler(nodes);
  const sup = new CampaignSupervisor({
    scheduler: fake.scheduler,
    broadcast: (f) => frames.push(f),
    now: () => nowMs,
    log: (m) => logs.push(m),
  });
  sup.supervise('c1', p);
  return { sup, fake, frames, logs, tick: (ms: number) => (nowMs += ms) };
}

// ---------------------------------------------------------------------------
// Policy resolution + TH-8-style pins
// ---------------------------------------------------------------------------

describe('resolveBudgetPolicy — env knobs, fail-closed parsing', () => {
  it('defaults are the documented ceilings — never unbounded', () => {
    const p = resolveBudgetPolicy({});
    expect(p.wallClockBudgetMs).toBe(DEFAULT_WALL_CLOCK_BUDGET_SECS * SEC);
    expect(p.nodeTimeoutMs).toBe(DEFAULT_NODE_TIMEOUT_SECS * SEC);
    expect(p.unitTimeoutSecs).toBe(DEFAULT_UNIT_TIMEOUT_SECS);
    expect(p.maxNodes).toBe(DEFAULT_MAX_NODES);
    expect(p.killPolicy).toBe(DEFAULT_KILL_POLICY);
    expect(p.maxCostUsd).toBeUndefined(); // opt-in: wall-clock stays the hard ceiling
  });

  it('honors an ambient WICKED_UNIT_TIMEOUT_SECS as THE pin', () => {
    const p = resolveBudgetPolicy({ WICKED_UNIT_TIMEOUT_SECS: '600' });
    expect(p.unitTimeoutSecs).toBe(600);
    expect(nodeEnvPins(p)).toEqual({ WICKED_UNIT_TIMEOUT_SECS: '600' });
  });

  it('reads every campaign knob', () => {
    const p = resolveBudgetPolicy({
      WICKED_CAMPAIGN_BUDGET_SECS: '7200',
      WICKED_CAMPAIGN_NODE_TIMEOUT_SECS: '600',
      WICKED_CAMPAIGN_MAX_NODES: '10',
      WICKED_CAMPAIGN_MAX_COST_USD: '25.50',
      WICKED_CAMPAIGN_KILL_POLICY: 'abandon-running',
    });
    expect(p.wallClockBudgetMs).toBe(7200 * SEC);
    expect(p.nodeTimeoutMs).toBe(600 * SEC);
    expect(p.maxNodes).toBe(10);
    expect(p.maxCostUsd).toBe(25.5);
    expect(p.killPolicy).toBe('abandon-running');
  });

  it('a malformed ceiling throws — a typo must never mean "unbounded"', () => {
    expect(() => resolveBudgetPolicy({ WICKED_CAMPAIGN_BUDGET_SECS: '4h' })).toThrow(/not a positive number/);
    expect(() => resolveBudgetPolicy({ WICKED_CAMPAIGN_BUDGET_SECS: '0' })).toThrow(/not a positive number/);
    expect(() => resolveBudgetPolicy({ WICKED_CAMPAIGN_MAX_NODES: '2.5' })).toThrow(/integer node count/);
    expect(() => resolveBudgetPolicy({ WICKED_CAMPAIGN_KILL_POLICY: 'yolo' })).toThrow(/kill-running/);
    // A fractional unit pin would be silently IGNORED by the engine's u64 parse (falling
    // back to its 2-hour default) — refuse it here instead.
    expect(() => resolveBudgetPolicy({ WICKED_UNIT_TIMEOUT_SECS: '900.5' })).toThrow(/integer number of seconds/);
  });
});

describe('assertNodeEnvPinned — the TH-8-style fail-closed preflight', () => {
  const p = policy();

  it('passes when the node env carries the exact pin', () => {
    expect(() => assertNodeEnvPinned({ WICKED_UNIT_TIMEOUT_SECS: '900' }, p)).not.toThrow();
  });

  it('a missing pin refuses: unpinned means the engine 2-hour default', () => {
    expect(() => assertNodeEnvPinned({}, p)).toThrow(/missing the WICKED_UNIT_TIMEOUT_SECS pin/);
    expect(() => assertNodeEnvPinned({}, p)).toThrow(/7200 s/);
  });

  it('a mismatched pin refuses: the manifest must not lie about the environment', () => {
    expect(() => assertNodeEnvPinned({ WICKED_UNIT_TIMEOUT_SECS: '7200' }, p)).toThrow(/pin mismatch/);
  });
});

describe('assertWithinNightlyCap — no unbounded nightly spend by omission', () => {
  it('at the cap passes; over the cap refuses with both numbers', () => {
    const p = policy({ maxNodes: 25 });
    expect(() => assertWithinNightlyCap(25, p)).not.toThrow();
    expect(() => assertWithinNightlyCap(26, p)).toThrow(/26 nodes exceeds the nightly cap of 25/);
  });
});

// ---------------------------------------------------------------------------
// Supervisor — fake scheduler, hand-cranked clock
// ---------------------------------------------------------------------------

describe('CampaignSupervisor — wall-clock budget', () => {
  it('exhaustion aborts remaining nodes EXCLUDED-WITH-REASON — never silent', async () => {
    const { sup, fake, frames, logs, tick } = build(
      [
        { nodeId: 'done', phase: 'terminal', runId: 'r0' },
        { nodeId: 'live', phase: 'running', runId: 'r1' },
        { nodeId: 'queued', phase: 'pending' },
      ],
      policy({ wallClockBudgetMs: 60 * MIN, nodeTimeoutMs: 120 * MIN }),
    );

    tick(30 * MIN);
    await sup.sweep();
    expect(sup.state('c1')?.exhausted).toBeUndefined(); // inside budget: nothing touched
    expect(frames).toEqual([]);

    tick(31 * MIN);
    await sup.sweep();

    const state = sup.state('c1');
    expect(state?.exhausted).toMatchObject({ kind: 'wall-clock', policyApplied: 'kill-running' });

    // The never-launched node: excluded at the scheduler so it can never dispatch.
    expect(fake.excluded).toHaveLength(1);
    expect(fake.excluded[0]).toMatchObject({ nodeId: 'queued' });
    expect(fake.excluded[0]?.reason).toMatch(/wall-clock budget 3600s exceeded/);
    expect(fake.excluded[0]?.reason).toMatch(/never launched/);

    // The in-flight node: killed under kill-running, through the cancel path.
    expect(fake.cancelled).toHaveLength(1);
    expect(fake.cancelled[0]).toMatchObject({ nodeId: 'live', runId: 'r1' });

    // The abort is visible in campaign state, per node, with reasons.
    const byId = new Map(state?.nodes.map((n) => [n.nodeId, n]));
    expect(byId.get('queued')?.exclusion).toMatchObject({ kind: 'campaign-budget', applied: 'excluded' });
    expect(byId.get('live')?.exclusion).toMatchObject({ kind: 'campaign-budget', applied: 'cancelled' });
    expect(byId.get('done')?.exclusion).toBeUndefined(); // finished work is never rewritten

    // And on the wire: one budget frame naming the touched nodes + one frame per node.
    const budgetFrames = frames.filter((f) => f.type === 'campaignBudgetExceeded');
    expect(budgetFrames).toHaveLength(1);
    expect(budgetFrames[0]).toMatchObject({ campaign: 'c1', kind: 'wall-clock' });
    expect(budgetFrames[0]?.nodes.sort()).toEqual(['live', 'queued']);
    const nodeFrames = frames.filter((f) => f.type === 'campaignNodeExcluded');
    expect(nodeFrames.map((f) => f.node).sort()).toEqual(['live', 'queued']);
    expect(logs.some((l) => l.includes('wall-clock budget'))).toBe(true);
  });

  it('exhaustion is enforced exactly once — a later sweep stays quiet', async () => {
    const { sup, frames, tick } = build(
      [{ nodeId: 'n1', phase: 'pending' }],
      policy({ wallClockBudgetMs: 10 * MIN }),
    );
    tick(11 * MIN);
    await sup.sweep();
    const after = frames.length;
    tick(10 * MIN);
    await sup.sweep();
    expect(frames.length).toBe(after);
  });

  it('abandon-running lets in-flight nodes finish but still puts them on record', async () => {
    const { sup, fake, frames, tick } = build(
      [
        { nodeId: 'live', phase: 'running', runId: 'r1' },
        { nodeId: 'queued', phase: 'pending' },
      ],
      policy({ wallClockBudgetMs: 10 * MIN, nodeTimeoutMs: 120 * MIN, killPolicy: 'abandon-running' }),
    );
    tick(11 * MIN);
    await sup.sweep();

    expect(fake.cancelled).toEqual([]); // abandoned, not killed
    expect(fake.excluded.map((e) => e.nodeId)).toEqual(['queued']);
    const byId = new Map(sup.state('c1')?.nodes.map((n) => [n.nodeId, n]));
    expect(byId.get('live')?.exclusion).toMatchObject({ applied: 'abandoned', kind: 'campaign-budget' });
    expect(byId.get('live')?.exclusion?.reason).toMatch(/abandoned to finish/);
    const budget = frames.find((f) => f.type === 'campaignBudgetExceeded');
    expect(budget).toMatchObject({ policyApplied: 'abandon-running' });
  });

  it('a FINISHED campaign never trips its budget on a later sweep', async () => {
    const { sup, frames, tick, fake } = build(
      [{ nodeId: 'n1', phase: 'terminal', runId: 'r1' }],
      policy({ wallClockBudgetMs: 10 * MIN }),
    );
    await sup.sweep(); // observes all-terminal ⇒ released
    tick(60 * MIN);
    await sup.sweep();
    expect(frames).toEqual([]);
    expect(fake.cancelled).toEqual([]);
    expect(sup.state('c1')?.exhausted).toBeUndefined();
  });
});

describe('CampaignSupervisor — per-node timeout', () => {
  it('kills a node whose RUNNING time exceeds the timeout, with the reason on record', async () => {
    const { sup, fake, frames, tick } = build(
      [{ nodeId: 'slow', phase: 'running', runId: 'r1' }],
      policy({ nodeTimeoutMs: 10 * MIN, wallClockBudgetMs: 120 * MIN }),
    );
    await sup.sweep(); // first observation opens the interval
    tick(11 * MIN);
    await sup.sweep();

    expect(fake.cancelled).toHaveLength(1);
    expect(fake.cancelled[0]?.reason).toMatch(/node-timeout: ran 660s, per-node timeout is 600s/);
    const node = sup.state('c1')?.nodes.find((n) => n.nodeId === 'slow');
    expect(node?.exclusion).toMatchObject({ kind: 'node-timeout', applied: 'cancelled' });
    expect(frames.filter((f) => f.type === 'campaignNodeExcluded')).toHaveLength(1);
  });

  it('awaiting-human never counts: a gate is quiet by design', async () => {
    const gated: SchedulerNodeView = { nodeId: 'gated', phase: 'running', runId: 'r1' };
    const { sup, fake, tick } = build(
      [gated],
      policy({ nodeTimeoutMs: 10 * MIN, wallClockBudgetMs: 240 * MIN }),
    );
    await sup.sweep(); // running: interval opens
    tick(5 * MIN);
    gated.phase = 'awaiting-human';
    await sup.sweep(); // 5 min of running banked; clock now paused
    tick(60 * MIN); // a long human lunch
    gated.phase = 'running';
    await sup.sweep(); // resumes: banked 5 min, interval re-opens
    tick(4 * MIN);
    await sup.sweep(); // 9 min running total — under the 10-min timeout

    expect(fake.cancelled).toEqual([]);
    const node = sup.state('c1')?.nodes.find((n) => n.nodeId === 'gated');
    expect(node?.cost.wallMs).toBe(9 * MIN); // human wait is NOT billed to the node

    tick(2 * MIN);
    await sup.sweep(); // 11 min running total — now it trips
    expect(fake.cancelled).toHaveLength(1);
  });
});

describe('CampaignSupervisor — cost accounting + cost budget', () => {
  it('recordNodeCost accumulates per node and totals; the opt-in USD ceiling exhausts like wall-clock', async () => {
    const { sup, fake, frames, tick } = build(
      [
        { nodeId: 'a', phase: 'running', runId: 'r1' },
        { nodeId: 'b', phase: 'pending' },
      ],
      policy({ maxCostUsd: 10, wallClockBudgetMs: 240 * MIN, nodeTimeoutMs: 240 * MIN }),
    );
    await sup.sweep();
    sup.recordNodeCost('c1', 'a', { usd: 4, inputTokens: 1_000, outputTokens: 200 });
    sup.recordNodeCost('c1', 'a', { usd: 2.5, inputTokens: 500 });
    tick(1 * MIN);
    await sup.sweep();
    expect(sup.state('c1')?.totalCostUsd).toBeCloseTo(6.5);
    expect(sup.state('c1')?.exhausted).toBeUndefined(); // under the ceiling

    sup.recordNodeCost('c1', 'a', { usd: 5 }); // 11.5 > 10
    tick(1 * MIN);
    await sup.sweep();

    expect(sup.state('c1')?.exhausted).toMatchObject({ kind: 'cost', budget: 10 });
    expect(fake.excluded.map((e) => e.nodeId)).toEqual(['b']);
    expect(fake.excluded[0]?.reason).toMatch(/cost budget \$10 exceeded \(spent \$11.50\)/);
    const node = sup.state('c1')?.nodes.find((n) => n.nodeId === 'a');
    expect(node?.cost).toMatchObject({ usd: 11.5, inputTokens: 1_500, outputTokens: 200 });
    expect(frames.some((f) => f.type === 'campaignBudgetExceeded' && f.kind === 'cost')).toBe(true);
  });
});

describe('supervision evidence report — cost per node, regressions diffable', () => {
  let dir = '';
  afterEach(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  it('carries policy, budget outcome, totals, and a per-node cost row (wall-clock always)', async () => {
    const nodes: SchedulerNodeView[] = [
      { nodeId: 'a', phase: 'running', runId: 'r1' },
      { nodeId: 'b', phase: 'pending' },
    ];
    const { sup, tick } = build(
      nodes,
      policy({ wallClockBudgetMs: 10 * MIN, nodeTimeoutMs: 120 * MIN }),
    );
    await sup.sweep();
    sup.recordNodeCost('c1', 'a', { usd: 3.25, inputTokens: 900 });
    tick(11 * MIN);
    await sup.sweep(); // budget exhausts: a killed, b excluded

    const state = sup.state('c1');
    if (state === undefined) throw new Error('supervision state must exist for c1');
    const report = buildSupervisionReport(state);

    expect(report.report).toBe('campaign-supervision');
    expect(report.policy).toMatchObject({
      wall_clock_budget_secs: 600,
      unit_timeout_pin_secs: 900, // the TH-8-style pin, on the evidence record
      kill_policy: 'kill-running',
    });
    expect(report.budget).toMatchObject({ exhausted: true, kind: 'wall-clock', policy_applied: 'kill-running' });
    expect(report.totals.cost_usd).toBeCloseTo(3.25);
    expect(report.totals.wall_ms).toBe(11 * MIN); // a's running time; b never ran

    const a = report.nodes.find((n) => n.node_id === 'a');
    expect(a?.cost).toMatchObject({ wall_ms: 11 * MIN, usd: 3.25, input_tokens: 900 });
    expect(a?.excluded).toMatchObject({ kind: 'campaign-budget', applied: 'cancelled' });
    const b = report.nodes.find((n) => n.node_id === 'b');
    expect(b?.cost.wall_ms).toBe(0);
    expect(b?.excluded?.reason).toMatch(/never launched/);

    // And it lands as the campaign-supervision.json artifact, valid JSON on disk.
    dir = mkdtempSync(join(tmpdir(), 'th20-evidence-'));
    const path = await writeSupervisionReport(dir, report);
    expect(path.endsWith(SUPERVISION_REPORT_FILENAME)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as typeof report;
    expect(onDisk.nodes.map((n) => n.node_id).sort()).toEqual(['a', 'b']);
    expect(onDisk.budget.exhausted).toBe(true);
  });
});

describe('CampaignSupervisor — registration discipline', () => {
  it('refuses a second clock for the same campaign', () => {
    const { sup } = build([], policy());
    expect(() => sup.supervise('c1', policy())).toThrow(/already supervised/);
  });

  it('cost for an unknown campaign is dropped, not misattributed', () => {
    const { sup } = build([], policy());
    sup.recordNodeCost('nope', 'a', { usd: 1 });
    expect(sup.state('nope')).toBeUndefined();
    expect(sup.state('c1')?.totalCostUsd).toBeUndefined();
  });
});
