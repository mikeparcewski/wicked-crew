// The one "needs you" rule (`GET /system.attention[]`, api-types 0.140.0) over the rig's own data:
// `fixtures/needs-2026-10-27.json` is the scrubbed GET-only dump the needs definition was derived
// from (rig :7721, crew 0.16.3, snapshot 2026-10-27T04:11:50Z). The ranked list it must give is
// DEFINITION §5: five items, in this order — host load (slows 4), wicked-core's red base (3 runs,
// its fix's deliver gate is the action), wicked-crew's red base (1), core #840's dead seat (1), the
// ask refused by input governance (1). Everything else is either unresolved work (with what it
// cost and how to resolve it) or not stuck at all.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionView, SystemCli, SystemInfraRow, SystemRun } from 'wicked-crew-api-types';

import { buildNeeds, foldRunCost, isAnsweredAsk, needsLevel, RunCostCache, supersession } from '../src/api/needs.js';
import { judgeGaps, runLiveness } from '../src/api/system-snapshot.js';

interface DumpRun {
  id: string;
  title: string;
  status: string;
  repo: string | null;
  workflow: string;
  created_h_ago: number;
  delivery: string;
  retry_of: string | null;
  ask_turn: boolean | null;
  archived: boolean;
  units_total?: number | null;
  units_done?: number | null;
  rejected_units?: Array<{ ord: number; cli: string; denial: string }> | null;
  gate?: { ord: number; kind: string; receivedAt: string; prompt: string } | null;
}
const dump = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'needs-2026-10-27.json'), 'utf8')) as {
  snapshot_at: string;
  system: { clis: Array<{ cli: string; state: string; reason: string | null; workEligible: boolean; councilEligible: boolean }>; infra: Array<{ key: string; state: string; reason: string }> };
  runs: DumpRun[];
};
const NOW = Date.parse(dump.snapshot_at);
const HOUR = 3_600_000;

/** The dump keeps each run's title; the one run whose stated problem matters to the merge carries the
 *  problem text the definition quotes from the rig (`GET /runs/29bcace4…`). */
const PROBLEM: Record<string, string> = {
  '29bcace4': "Make wicked-core's own test suite pass: the BASE is red with 39 failures inside the floor sandbox, so every core run needs operator overrides.",
};

function viewOf(r: DumpRun): SessionView {
  const ask = r.workflow.startsWith('ask/');
  const total = r.units_total ?? 0;
  const done = r.units_done ?? 0;
  const units = Array.from({ length: total }, (_, i) => {
    const ord = i + 1;
    const rejected = r.rejected_units?.find((u) => u.ord === ord);
    return {
      id: ask ? `${r.id}:answer-${ord}` : `${r.id}:u${ord}`,
      session_id: r.id,
      ord,
      status: ord <= done ? 'done' : rejected !== undefined ? 'rejected' : 'pending',
      assigned_cli: rejected?.cli ?? 'claude',
      denial_reason: rejected?.denial ?? null,
      phase_ref: null,
      stage: 'build',
    };
  });
  return {
    session: {
      id: r.id,
      title: r.title,
      problem: PROBLEM[r.id] ?? r.title,
      status: r.status,
      workflow_id: r.workflow,
      repo_ref: r.repo,
      clis: [],
      archived_at: r.archived ? Math.floor(NOW / 1000) : null,
      archive_note: null,
      created_at: Math.floor((NOW - r.created_h_ago * HOUR) / 1000),
      delivery: r.delivery,
      ...(r.retry_of !== null ? { retry_of: r.retry_of } : {}),
      ...(ask ? { ask_path: true } : {}),
      ...(r.ask_turn === true ? { ask_turn: true } : {}),
    },
    units,
  } as unknown as SessionView;
}

const LABEL: Record<string, string> = { load: 'Host load', gateway: 'Model gateway', broker: 'Credential broker', daemon: 'Daemon', disk: 'Free disk', skills: 'Skills snapshot' };
const infra = dump.system.infra.map((r) => ({ key: r.key, label: LABEL[r.key] ?? r.key, state: r.state, reason: r.reason, remedy: null }) as unknown as SystemInfraRow);
const clis = dump.system.clis.map(
  (c) =>
    ({
      cli: c.cli,
      label: c.cli,
      state: c.state,
      stateReason: c.reason,
      canSignIn: true,
      councilEligible: c.councilEligible,
      workEligible: c.workEligible,
      ...(c.state === 'benched' ? { benchedUntil: '2026-10-27T04:28:00.000Z' } : {}),
    }) as unknown as SystemCli,
);

function fromDump(runsIn: DumpRun[] = dump.runs, extra: { infra?: SystemInfraRow[]; now?: number } = {}) {
  const views = runsIn.map(viewOf);
  const live = views.filter((v) => !['completed', 'cancelled', 'failed'].includes(v.session.status));
  const pairs = live.map((view) => {
    const g = runsIn.find((r) => r.id === view.session.id)!.gate ?? null;
    const run = runLiveness({
      view,
      now: extra.now ?? NOW,
      evidence: null,
      gate: g === null ? null : { interactionId: `ir_${view.session.id}`, ord: g.ord, kind: g.kind, prompt: g.prompt, receivedAt: g.receivedAt },
      quietAfterMs: 5 * 60_000,
      stallAfterMs: 15 * 60_000,
    });
    return { view, run };
  });
  const runs: SystemRun[] = pairs.map((p) => p.run);
  return buildNeeds({
    now: extra.now ?? NOW,
    views,
    runs,
    infra: extra.infra ?? infra,
    clis,
    gaps: judgeGaps(pairs, clis),
    infraHoldsLive: () => false,
  });
}

describe('the needs-you rule over the rig dump of 2026-10-27 (DEFINITION §5)', () => {
  const needs = fromDump();

  it('the number is 5, ranked: host load, core red base, crew red base, core #840 dead seat, the refused ask', () => {
    expect(needs.attention.map((a) => a.id)).toEqual([
      'infra:load',
      'base:wicked-core:test',
      'base:wicked-crew:test_targeted',
      'run:290a7fee',
      'run:68c26704',
    ]);
    // 6 distinct runs held by 5 items.
    expect(new Set(needs.attention.filter((a) => a.kind === 'prevents').flatMap((a) => a.blockedRunIds ?? [])).size).toBe(6);
  });

  it('host load slows the four held runs whose next step is real work (not a delivery, not an ask)', () => {
    const load = needs.attention[0]!;
    expect(load).toMatchObject({ kind: 'slows', severity: 'yellow', blocks: 4, waitedSince: null });
    expect([...load.blockedRunIds!].sort()).toEqual(['1940f173', '290a7fee', '2ebd9da2', '64f05d3d']);
    expect(load.reason).toMatch(/slows the next step of 4 run\(s\) and every new run/);
  });

  it("wicked-core's red base is ONE item holding 3 runs, and its action is the fix's deliver gate", () => {
    const core = needs.attention[1]!;
    expect(core).toMatchObject({ kind: 'prevents', severity: 'red', blocks: 3, target: { kind: 'run', runId: '29bcace4', gateOrd: 10 } });
    expect([...core.blockedRunIds!].sort()).toEqual(['1940f173', '29bcace4', '2ebd9da2']);
    // The oldest gate's arrival (2ebd9da2, 105.1 h), never a launch time.
    expect(core.waitedSince).toBe('2026-10-22T19:06:43.782Z');
    expect(core.unitsLeft).toBe(1 + 2 + 6);
    expect(core.remedy).toMatch(/Approve delivery of 29bcace4/);
  });

  it("wicked-crew's red base is its own item: the same label in another repo is no evidence of one cause", () => {
    expect(needs.attention[2]).toMatchObject({ blocks: 1, blockedRunIds: ['64f05d3d'], waitedSince: '2026-10-25T20:52:49.130Z' });
  });

  it("the dead seat folds the seats that left no failover into the run's item; no CLI is an item of its own", () => {
    const dead = needs.attention[3]!;
    expect(dead).toMatchObject({ blockedRunIds: ['290a7fee'], action: { kind: 'open_gate' } });
    expect(dead.title).toMatch(/dead seat/);
    expect(dead.reason).toMatch(/no failover: pi signed out, copilot benched until 04:28 UTC, opencode signed out/);
    expect(dead.remedy).toMatch(/sign in pi and opencode/);
    expect(needs.attention.some((a) => a.source === 'cli')).toBe(false);
  });

  it('an ask held at an ESCALATION is a real gate, even when an older daemon stamped ask_turn on it', () => {
    expect(needs.attention[4]).toMatchObject({ blockedRunIds: ['68c26704'], target: { kind: 'run', runId: '68c26704', gateOrd: 1 } });
    const v = viewOf(dump.runs.find((r) => r.id === '68c26704')!);
    expect(isAnsweredAsk(v, { gate: { kind: 'escalation' } } as SystemRun)).toBe(false);
  });

  it('answered asks are not stuck, and are not unresolved before they have been parked a day', () => {
    const ids = [...needs.attention.flatMap((a) => a.blockedRunIds ?? []), ...needs.unresolved.map((u) => u.runId)];
    expect(ids).not.toContain('b87f42fb');
    expect(ids).not.toContain('e43c4560');
    // A day later the parked asks are work to resolve (archive with a reason).
    const later = fromDump(dump.runs, { now: NOW + 25 * HOUR });
    expect(later.unresolved.filter((u) => u.why === 'parked').map((u) => u.runId).sort()).toEqual(['b87f42fb', 'e43c4560']);
    expect(later.unresolved.find((u) => u.runId === 'b87f42fb')!.actions).toEqual(['archive']);
  });

  it('superseded runs, the 13 old tiny-math failures and the delivered-then-failed install are unresolved, never dropped', () => {
    const by = Object.fromEntries(needs.unresolved.map((u) => [u.runId, u]));
    expect(needs.unresolved).toHaveLength(16);
    expect(by['7f4e149f']).toMatchObject({ why: 'superseded', supersededBy: '6f11390c', actions: ['close_superseded', 'archive'] });
    expect(by['9bd0f728']).toMatchObject({ why: 'superseded', supersededBy: '306fae88' });
    expect(by['9bd0f728']!.reason).toMatch(/retried as 306fae88, which delivered/);
    expect(by['910e3e0b']).toMatchObject({ why: 'superseded', supersededBy: '6f11390c' });
    expect(by['89da69fb']).toMatchObject({ why: 'superseded', supersededBy: '531faaef' });
    const tinyFailed = dump.runs.filter((r) => r.repo === 'tiny-math' && r.status === 'failed').map((r) => r.id);
    expect(tinyFailed).toHaveLength(13);
    for (const id of tinyFailed) expect(by[id], id).toBeDefined();
    expect(by['1ff74953']).toMatchObject({ why: 'failed', actions: ['retry', 'archive'] });
    // wall time from launch; cost unknown until the run's log is read
    expect(by['7f4e149f']!.cost).toMatchObject({ costUsd: null, tokens: null });
    expect(by['7f4e149f']!.cost.wallMs).toBeCloseTo(17 * HOUR, -4);
    expect(needs.unresolvedSpend).toEqual({ costUsd: null, tokens: null, costKnown: 0 });
  });

  it('nothing is both stuck and unresolved, and the level is red', () => {
    const stuck = new Set(needs.attention.flatMap((a) => a.blockedRunIds ?? []));
    for (const u of needs.unresolved) expect(stuck.has(u.runId), u.runId).toBe(false);
    expect(needsLevel(needs.attention, needs.unresolved)).toBe('red');
  });
});

describe('unresolved work keeps the system from going green', () => {
  const failedOld: DumpRun = { id: 'old-fail', title: 'Probe', status: 'failed', repo: 'tiny-math', workflow: 'ask/adhoc', created_h_ago: 240, delivery: 'none', retry_of: null, ask_turn: null, archived: false };

  it('unresolved only → yellow, never green; nothing at all → green', () => {
    const calm = infra.map((r) => ({ ...r, state: r.state === 'off' ? 'off' : 'ok' }) as SystemInfraRow);
    const only = fromDump([failedOld], { infra: calm });
    expect(only.attention).toEqual([]);
    expect(only.unresolved.map((u) => u.runId)).toEqual(['old-fail']);
    expect(needsLevel(only.attention, only.unresolved)).toBe('yellow');
    const none = fromDump([], { infra: calm });
    expect(needsLevel(none.attention, none.unresolved)).toBe('green');
  });

  it('an archived run is resolved: archiving removes the item', () => {
    const archived = fromDump([{ ...failedOld, archived: true }]);
    expect(archived.unresolved).toEqual([]);
  });

  it('a failed run under 7 days is stuck; past 7 days it moves to unresolved; a retried one is resolved', () => {
    const fresh = fromDump([{ ...failedOld, created_h_ago: 20 }]);
    expect(fresh.attention.map((a) => a.id)).toContain('run:old-fail');
    expect(fresh.unresolved).toEqual([]);
    const retried = fromDump([failedOld, { ...failedOld, id: 'retry-1', status: 'completed', created_h_ago: 1, retry_of: 'old-fail' }]);
    expect(retried.unresolved).toEqual([]);
    expect(supersession([viewOf(failedOld), viewOf({ ...failedOld, id: 'retry-1', retry_of: 'old-fail', created_h_ago: 1 })]).get('old-fail')).toEqual({ by: 'retry-1', retried: true });
  });

  it('cost: cliUsage frames sum per run; the cache reads a terminal run once', async () => {
    expect(foldRunCost([{ type: 'cliUsage', inputTokens: 100, outputTokens: 20, costUsd: 0.5 }, { type: 'cliUsage', inputTokens: 1, costUsd: 0.25 }, { type: 'unitDispatched' }])).toEqual({
      costUsd: 0.75,
      tokens: { input: 101, output: 20 },
    });
    expect(foldRunCost([{ type: 'unitDispatched' }])).toEqual({ costUsd: null, tokens: null });
    const cache = new RunCostCache();
    let reads = 0;
    const read = async () => {
      reads += 1;
      return [{ type: 'cliUsage', inputTokens: 10, outputTokens: 5, costUsd: 1.5 }];
    };
    await cache.fill([{ id: 'old-fail', final: true }], read);
    await cache.fill([{ id: 'old-fail', final: true }], read);
    expect(reads).toBe(1);
    const views = [viewOf(failedOld)];
    const n = buildNeeds({ now: NOW, views, runs: [], infra: [], clis, gaps: [], infraHoldsLive: () => false, costOf: (id) => cache.get(id) });
    expect(n.unresolved[0]!.cost).toMatchObject({ costUsd: 1.5, tokens: { input: 10, output: 5 } });
    expect(n.unresolvedSpend).toEqual({ costUsd: 1.5, tokens: { input: 10, output: 5 }, costKnown: 1 });
  });
});
