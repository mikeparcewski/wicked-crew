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
const iso = (ms: number): string => new Date(ms).toISOString();

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
    expect(load.reason).toMatch(/slows the next step of 4 jobs and every new one/);
    expect(load.reason).not.toMatch(/\(s\)/);
  });

  it("the core repo's red base is ONE item holding 3 runs, and its action is the fix's deliver gate", () => {
    const core = needs.attention[1]!;
    expect(core).toMatchObject({ kind: 'prevents', severity: 'red', blocks: 3, target: { kind: 'run', runId: '29bcace4', gateOrd: 10 } });
    expect([...core.blockedRunIds!].sort()).toEqual(['1940f173', '29bcace4', '2ebd9da2']);
    // The oldest gate's arrival (2ebd9da2, 105.1 h), never a launch time.
    expect(core.waitedSince).toBe('2026-10-22T19:06:43.782Z');
    expect(core.unitsLeft).toBe(1 + 2 + 6);
    // The fix is named once: the reason says what to do, the remedy names it.
    expect(core.reason).toBe('2 jobs fail `test` on a base that fails it too. The fix is ready: approve its delivery and merge it, then retry the held jobs.');
    expect(core.remedy).toBe("Deliver “Make wicked-core's own test suite pass”.");
  });

  it("wicked-crew's red base is its own item: the same label in another repo is no evidence of one cause", () => {
    expect(needs.attention[2]).toMatchObject({ blocks: 1, blockedRunIds: ['64f05d3d'], waitedSince: '2026-10-25T20:52:49.130Z' });
  });

  it("the dead seat folds the seats that left no failover into the run's item; no CLI is an item of its own", () => {
    const dead = needs.attention[3]!;
    expect(dead).toMatchObject({ blockedRunIds: ['290a7fee'], action: { kind: 'open_gate' } });
    expect(dead.title).toBe('A job lost its helper: wicked-core#840: a loopback socket masks dir removed after…');
    expect(dead.reason).toBe('No other helper can take over');
    expect(dead.remedy).toBe('Approve the retry; sign in pi and opencode so another helper can take over (copilot benched until 04:28 UTC).');
    expect(needs.attention.some((a) => a.source === 'cli')).toBe(false);
  });

  it('every item reads in plain words: no "(s)", no raw slugs, a held ask says what happened', () => {
    for (const a of needs.attention) {
      expect(`${a.title} ${a.reason} ${a.remedy}`, a.id).not.toMatch(/\(s\)/);
      expect(a.title, a.id).not.toMatch(/_/);
    }
    for (const u of needs.unresolved) expect(`${u.title} ${u.reason}`, u.runId).not.toMatch(/\(s\)/);
    expect(needs.attention[2]!.reason).toBe('1 job fails `test_targeted` on a base that fails it too.');
    expect(needs.attention[4]).toMatchObject({ title: 'Where is wicked-core riskiest to change', reason: 'A tool call was refused by the job’s rules' });
    const tiny = needs.unresolved.find((u) => u.runId === '1ff74953')!;
    expect(tiny).toMatchObject({ repo: 'tiny-math', workflow: 'ask/adhoc', reason: 'failed 10 days ago and was never retried or archived' });
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

describe('review fixes (xreview r1 on crew#1159)', () => {
  const base: DumpRun = { id: 'x', title: 'T', status: 'failed', repo: 'r', workflow: 'bug', created_h_ago: 240, delivery: 'none', retry_of: null, ask_turn: null, archived: false };
  const calm = infra.map((r) => ({ ...r, state: r.state === 'off' ? 'off' : 'ok' }) as SystemInfraRow);
  const withEnd = (r: DumpRun, endedHAgo: number): SessionView => {
    const v = viewOf(r);
    (v.session as { ended_at?: number }).ended_at = Math.floor((NOW - endedHAgo * HOUR) / 1000);
    return v;
  };
  const needsOf = (views: SessionView[], runs: SystemRun[] = [], gaps: Parameters<typeof buildNeeds>[0]['gaps'] = [], rows = calm) =>
    buildNeeds({ now: NOW, views, runs, infra: rows, clis, gaps, infraHoldsLive: () => false });

  it('a failure is aged from when it FAILED: launched 10 days ago, failed an hour ago, is stuck', () => {
    expect(needsOf([withEnd(base, 1)]).attention.map((a) => a.id)).toEqual(['run:x']);
    const old = needsOf([withEnd(base, 200)]);
    expect(old.attention).toEqual([]);
    expect(old.unresolved[0]!.reason).toMatch(/failed 8 days ago/);
  });

  it('an answered ask never comes back through a judge gap or host load', () => {
    const ask = viewOf(dump.runs.find((r) => r.id === 'b87f42fb')!);
    const g = dump.runs.find((r) => r.id === 'b87f42fb')!.gate!;
    const run = runLiveness({ view: ask, now: NOW, evidence: null, gate: { interactionId: 'i', ord: g.ord, kind: g.kind, prompt: g.prompt, receivedAt: g.receivedAt }, quietAfterMs: 5 * 60_000, stallAfterMs: 15 * 60_000 });
    const gap = { run, creator: 'claude', blockedBy: [clis.find((c) => c.cli === 'copilot')!] };
    const n = needsOf([ask], [run], [gap], infra);
    expect(n.attention).toEqual([]);
  });

  it('held runs whose denial IS the same missing judge are one item; a run held by its own failure keeps its own', () => {
    const judged = (id: string, denial: string): { view: SessionView; run: SystemRun } => {
      const view = viewOf({ ...base, id, status: 'awaiting_human', created_h_ago: 5, units_total: 2, units_done: 1, rejected_units: [{ ord: 2, cli: 'codex', denial }], gate: { ord: 2, kind: 'escalation', receivedAt: iso(NOW - HOUR), prompt: 'p' } });
      const run = runLiveness({ view, now: NOW, evidence: null, gate: { interactionId: id, ord: 2, kind: 'escalation', prompt: 'p', receivedAt: iso(NOW - HOUR) }, quietAfterMs: 5 * 60_000, stallAfterMs: 15 * 60_000 });
      return { view, run };
    };
    const a = judged('j1', 'unit 2 checks work built on `codex` and ran on that same seat; the run requires a distinct evaluator (distinct_evaluator)');
    const b = judged('j2', 'unit 2 checks work built on `codex` and ran on that same seat; the run requires a distinct evaluator (distinct_evaluator)');
    const c = judged('j3', 'repo checks floor failed: test: exit 1');
    const out = [clis.find((x) => x.cli === 'copilot')!];
    const gaps = [a, b, c].map((p) => ({ run: p.run, creator: 'codex', blockedBy: out }));
    const n = needsOf([a.view, b.view, c.view], [a.run, b.run, c.run], gaps);
    expect(n.attention.map((x) => [x.id, x.blocks])).toEqual([['seat:codex:copilot', 2], ['run:j3', 1]]);
    expect(n.attention[1]!.reason).toBe('Its checks failed; no independent reviewer for codex’s work (copilot benched)');
    expect(n.attention[0]!.reason).toBe('No helper in the pool can review codex’s work (copilot benched)');
  });

  it('a slowdown that slows nothing is not counted; an unreadable run list is (never green)', () => {
    const loaded = calm.map((r) => (r.key === 'load' ? { ...r, state: 'degraded' } : r) as SystemInfraRow);
    expect(needsOf([], [], [], loaded).attention).toEqual([]);
    const blind = calm.map((r) => (r.key === 'daemon' ? { ...r, state: 'degraded', reason: 'serving, but the engine did not list its runs' } : r) as SystemInfraRow);
    const n = needsOf([], [], [], blind);
    expect(n.attention.map((x) => x.id)).toEqual(['infra:daemon']);
    expect(needsLevel(n.attention, n.unresolved)).toBe('yellow');
  });

  it('a resumed failed run that ended again has its cost read again', async () => {
    const cache = new RunCostCache();
    let cost = 1;
    const read = async () => [{ type: 'cliUsage', costUsd: cost }];
    await cache.fill([{ id: 'r', final: true, stamp: 'failed:100' }], read);
    cost = 3;
    await cache.fill([{ id: 'r', final: true, stamp: 'failed:100' }], read);
    expect(cache.get('r')!.costUsd).toBe(1);
    await cache.fill([{ id: 'r', final: true, stamp: 'failed:200' }], read);
    expect(cache.get('r')!.costUsd).toBe(3);
  });

  const live = (id: string, extra: Partial<DumpRun>, gate: { ord: number; kind: string } | null): { view: SessionView; run: SystemRun } => {
    const g = gate === null ? null : { ...gate, receivedAt: iso(NOW - 2 * HOUR), prompt: 'p' };
    const view = viewOf({ ...base, id, status: 'awaiting_human', created_h_ago: 5, ...extra, gate: g });
    const run = runLiveness({ view, now: NOW, evidence: null, gate: g === null ? null : { interactionId: id, ord: g.ord, kind: g.kind, prompt: 'p', receivedAt: g.receivedAt }, quietAfterMs: 5 * 60_000, stallAfterMs: 15 * 60_000 });
    return { view, run };
  };

  it("an earlier unit's old denial never re-labels a run now at its deliver gate", () => {
    const d = live('d1', { repo: 'repo-a', units_total: 10, units_done: 9, rejected_units: [{ ord: 4, cli: 'claude', denial: 'dead seat: every eligible seat has now failed it; test: exit 1 base_red_unseparated' }] }, { ord: 10, kind: 'deliver' });
    // unit 4 is done now (it was retried); its denial text stayed on the row
    const n = needsOf([d.view], [d.run]);
    expect(n.attention.map((a) => [a.id, a.title])).toEqual([['run:d1', 'T']]);
  });

  it('a cancelled retry supersedes nothing: the failure it was meant to redo is still unresolved', () => {
    const a = withEnd({ ...base, id: 'A' }, 200);
    const b = viewOf({ ...base, id: 'B', status: 'cancelled', created_h_ago: 100, retry_of: 'A' });
    expect(needsOf([a, b]).unresolved.map((u) => [u.runId, u.why])).toEqual([['A', 'failed']]);
  });

  it('an open run whose retry failed is still stuck; a running superseded run is never offered a resolve', () => {
    const held = live('H', { units_total: 2, units_done: 1, rejected_units: [{ ord: 2, cli: 'claude', denial: 'boom' }] }, { ord: 2, kind: 'escalation' });
    const retry = withEnd({ ...base, id: 'R', created_h_ago: 1, retry_of: 'H' }, 0.5);
    const n = needsOf([held.view, retry], [held.run]);
    expect(n.attention.map((a) => a.id).sort()).toEqual(['run:H', 'run:R']);
    expect(n.unresolved).toEqual([]);
    const running = viewOf({ ...base, id: 'E', status: 'executing', created_h_ago: 5 });
    const done = viewOf({ ...base, id: 'C', status: 'completed', created_h_ago: 1, retry_of: 'E' });
    const runE = { runId: 'E', liveness: 'working', reason: 'working' } as unknown as SystemRun;
    expect(needsOf([running, done], [runE]).unresolved).toEqual([]);
  });

  it('only a run at its deliver gate joins a red base as its fix, and only one', () => {
    const floor = (id: string) => live(id, { repo: 'repo-a', units_total: 3, units_done: 1, rejected_units: [{ ord: 2, cli: 'codex', denial: 'test: exit 101 [base_red_unseparated: base red]' }] }, { ord: 2, kind: 'escalation' });
    const fixAt = (id: string, kind: string) => {
      const p = live(id, { repo: 'repo-a', units_total: 3, units_done: 2 }, { ord: 3, kind });
      (p.view.session as { problem: string }).problem = 'the BASE is red with 39 failures';
      return p;
    };
    const [f1, f2, fx, fy, fz] = [floor('f1'), floor('f2'), fixAt('fx', 'deliver'), fixAt('fy', 'deliver'), fixAt('fz', 'escalation')];
    const all = [f1, f2, fx, fy, fz];
    const n = needsOf(all.map((p) => p.view), all.map((p) => p.run));
    const base = n.attention.find((a) => a.id === 'base:repo-a:test')!;
    expect([...base.blockedRunIds!].sort()).toEqual(['f1', 'f2', 'fx']);
    expect(base.target).toMatchObject({ runId: 'fx' });
    expect(n.attention.map((a) => a.id)).toEqual(expect.arrayContaining(['run:fy', 'run:fz']));
  });

  it('no seat at all: red, every eligible run held (never an answered ask), ahead of one run on a tie', () => {
    const out = clis.map((c) => ({ ...c, state: 'signed_out', workEligible: false, councilEligible: false }) as SystemCli);
    const ask = viewOf(dump.runs.find((r) => r.id === 'b87f42fb')!);
    const g = dump.runs.find((r) => r.id === 'b87f42fb')!.gate!;
    const askRun = runLiveness({ view: ask, now: NOW, evidence: null, gate: { interactionId: 'i', ord: g.ord, kind: g.kind, prompt: g.prompt, receivedAt: g.receivedAt }, quietAfterMs: 5 * 60_000, stallAfterMs: 15 * 60_000 });
    const h = live('H', { units_total: 2, units_done: 1, rejected_units: [{ ord: 2, cli: 'claude', denial: 'boom' }] }, { ord: 2, kind: 'escalation' });
    const n = buildNeeds({ now: NOW, views: [ask, h.view], runs: [askRun, h.run], infra: calm, clis: out, gaps: [], infraHoldsLive: () => false });
    expect(n.attention.map((a) => a.id)).toEqual(['cli:none', 'run:H']);
    expect(n.attention[0]).toMatchObject({ severity: 'red', blockedRunIds: ['H'] });
    const idle = buildNeeds({ now: NOW, views: [], runs: [], infra: calm, clis: out, gaps: [], infraHoldsLive: () => false });
    expect(idle.attention[0]).toMatchObject({ id: 'cli:none', severity: 'red' });
  });

  it('xreview r1 on crew#1163: the words never say something false about a run', () => {
    const held = (id: string, denial: string) => live(id, { units_total: 2, units_done: 1, rejected_units: [{ ord: 2, cli: 'claude', denial }] }, { ord: 2, kind: 'escalation' });
    const say = (denial: string): string => { const h = held('w', denial); return needsOf([h.view], [h.run]).attention[0]!.reason; };
    // enforcement that never ran is not a refusal
    expect(say('governance_unproven (fail-closed): the unit made tool calls on the wrapped carrier but its gate-hook never ran — so every call went unchecked (core#653)')).toBe('Its tool calls ran without the required checks');
    expect(say('input governance denied a tool-call in unit-1 (claim boundary-deny:unit-1)')).toBe('A tool call was refused by the job’s rules');
    expect(say('input governance refused the phase input')).toBe('Its input was refused by the job’s rules');
    // a crashed CLI is not a failed check
    expect(say('(cli `codex` exited 1) exit 1: boom')).toBe('It stopped and waits for your decision');
    expect(say('repo checks floor failed: test: exit 101')).toBe('Its checks failed');
    // a dead seat with helpers left says its helper stopped, not that none can take over
    const calmClis = clis.map((c) => ({ ...c, state: 'signed_in', workEligible: true, councilEligible: true }) as SystemCli);
    const d = held('d', 'dead seat: every eligible seat has now failed it');
    const n = buildNeeds({ now: NOW, views: [d.view], runs: [d.run], infra: calm, clis: calmClis, gaps: [], infraHoldsLive: () => false });
    expect(n.attention[0]).toMatchObject({ title: 'A job lost its helper: T', reason: 'Its helper stopped unexpectedly', remedy: 'Approve the retry.' });
    // an old dead-seat denial never re-titles a run now waiting at its deliver gate
    const later = live('l', { units_total: 3, units_done: 2, rejected_units: [{ ord: 3, cli: 'claude', denial: 'dead seat: every eligible seat has now failed it' }] }, { ord: 3, kind: 'deliver' });
    expect(needsOf([later.view], [later.run]).attention[0]).toMatchObject({ title: 'T', reason: 'Ready to deliver' });
    // a repo slug reads with spaces in the red base's title
    const f = live('f', { repo: 'my_repo', units_total: 2, units_done: 1, rejected_units: [{ ord: 2, cli: 'codex', denial: 'test: exit 101 [base_red_unseparated: base red]' }] }, { ord: 2, kind: 'escalation' });
    expect(needsOf([f.view], [f.run]).attention[0]!.title).toBe("my repo's base is red inside the floor sandbox");
  });
});

