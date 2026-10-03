// DES-TRIGGER-REGISTRY-001 TR-W5b — deliver audit, ungated, quiet-after-claim.
//
// Test 2 (§8): one fixture table per check, run through the check itself (pure over the input and
// the run's folded state). Then the registry: joins reach the check unfiltered, the shipped entries
// load, and the restart key test for quiet-after-claim — two daemon lives, a detection frame in
// each after the same claim, exactly one row.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RecordedEvent } from 'wicked-crew-api-types';
import { readBus } from '../src/core/bus.js';
import type { CoreEvent } from '../src/core/types.js';
import { deliverAuditCheck } from '../src/watch/checks/deliver-audit.js';
import { SHIPPED_CHECKS } from '../src/watch/checks/index.js';
import { quietAfterClaimCheck } from '../src/watch/checks/quiet-after-claim.js';
import { ungatedCheck } from '../src/watch/checks/ungated.js';
import { WATCH_FINDING_PREFIX, WATCH_FINDING_RAISED } from '../src/watch/events.js';
import { watchIdOf } from '../src/watch/keys.js';
import { loadEntries, SHIPPED_ENTRIES_DIR } from '../src/watch/loader.js';
import { WatchRegistry, type WatchRegistryOptions } from '../src/watch/registry.js';
import { Router } from '../src/watch/router.js';
import type { CheckOutput, KeyPointInput, RunWatchState, WatchCheck } from '../src/watch/types.js';
import { removeScratch } from './setup/scratch.js';

const ctx = { now: () => 0, stats: () => ({ queueDepth: 0, queueHwm: 0, shedTotal: 0, tailLagMs: 0 }) };

function input(source: KeyPointInput['source'], event: Record<string, unknown>): KeyPointInput {
  return { source, type: String(event['type']), event: { session: 'run-1', ...event }, runId: 'run-1', at: 1 };
}

/** Feed a sequence through one check with a fresh state; the outputs of each step, in order. */
function run(check: WatchCheck<Record<string, never>, Record<string, never>>, steps: KeyPointInput[]): CheckOutput[][] {
  const state: RunWatchState = { runId: 'run-1', seen: new Set(), bag: new Map() };
  return steps.map((s) => {
    state.seen.add(s.type);
    return check.evaluate(s, state, {}, {}, ctx) as CheckOutput[];
  });
}

const core = (e: Record<string, unknown>): KeyPointInput => input('core', e);
const lift = (outcome: string, ord = 7, attempt = 1, extra: Record<string, unknown> = {}): KeyPointInput =>
  core({ type: 'deliverLiftEvaluated', ord, attempt, outcome, baseRef: 'origin/main', conflicts: [], note: null, ...extra });
const checks = (passed: boolean, ord = 7, attempt = 1): KeyPointInput => core({ type: 'repoChecksEvaluated', ord, attempt, passed, checks: [], skipped: [] });
const captured = (ord: number, attempt: number, stepStatus = 'ok'): KeyPointInput =>
  core({ type: 'unitOutputCaptured', ord, attempt, stepStatus, outputBytes: 10, governed: true });
const gate = (ord: number, extra: Record<string, unknown> = {}): KeyPointInput => core({ type: 'gateEvaluated', ord, ...extra });
const stalled = (ord: number | undefined, quietForMs = 16 * 60_000): KeyPointInput =>
  input('watchdog', { type: 'workerStalled', ...(ord !== undefined ? { ord } : {}), quietForMs });

const raised = (outs: CheckOutput[]): Array<{ subject: string; kind: string | undefined; severity: string | undefined }> =>
  outs.flatMap((o) => (o.op === 'raise' ? [{ subject: o.subject, kind: o.kind, severity: o.severity }] : []));

describe('deterministic:deliver_audit — fixture table (test 2)', () => {
  it('lifted, then a re-check, then the unit ends → nothing', () => {
    const out = run(deliverAuditCheck, [lift('lifted'), checks(true), captured(7, 1), gate(7)]);
    expect(raised(out.flat())).toEqual([]);
  });
  it('lifted and the unit ends with no re-check → ONE high finding (not repeated at the gate)', () => {
    const out = run(deliverAuditCheck, [lift('lifted'), captured(7, 1), gate(7)]);
    expect(raised(out[1]!)).toEqual([{ subject: '7:1:lift-unverified', kind: 'finding', severity: 'high' }]);
    expect(out[2]).toEqual([]);
  });
  it('lifted and the gate closes the unit (no attempt on the gate) → the finding', () => {
    const out = run(deliverAuditCheck, [lift('lifted', 4, 2), gate(4)]);
    expect(raised(out[1]!)).toEqual([{ subject: '4:2:lift-unverified', kind: 'finding', severity: 'high' }]);
  });
  it('a re-check that ran and FAILED is not a finding (the engine failed the unit, pushed nothing)', () => {
    expect(raised(run(deliverAuditCheck, [lift('lifted'), checks(false), gate(7)]).flat())).toEqual([]);
  });
  it('a late re-check clears the raised finding', () => {
    const out = run(deliverAuditCheck, [lift('lifted'), gate(7), checks(true)]);
    expect(out[2]).toEqual([{ op: 'clear', subject: '7:1:lift-unverified' }]);
  });
  it("another attempt's output does not close this attempt's lift", () => {
    expect(run(deliverAuditCheck, [lift('lifted', 7, 1), captured(7, 2)]).flat()).toEqual([]);
  });
  it('skipped → medium flag at once; conflict / failed → info flags; unchanged → nothing', () => {
    expect(raised(run(deliverAuditCheck, [lift('skipped', 7, 1, { note: 'fetch failed' })])[0]!)).toEqual([
      { subject: '7:1:lift-skipped', kind: 'flag', severity: 'medium' },
    ]);
    expect(raised(run(deliverAuditCheck, [lift('conflict', 7, 1, { conflicts: ['a.json', 'b.ts'] })])[0]!)).toEqual([
      { subject: '7:1:lift-conflict', kind: 'flag', severity: 'info' },
    ]);
    expect(raised(run(deliverAuditCheck, [lift('failed')])[0]!)).toEqual([{ subject: '7:1:lift-failed', kind: 'flag', severity: 'info' }]);
    expect(run(deliverAuditCheck, [lift('unchanged'), gate(7)]).flat()).toEqual([]);
  });
  it('the conflict sentence counts files and says nothing was pushed', () => {
    const [o] = run(deliverAuditCheck, [lift('conflict', 7, 1, { conflicts: ['a.json', 'b.ts'] })])[0]!;
    expect(o).toMatchObject({ op: 'raise', sentence: 'Delivery stopped: the work would conflict with the newest main in 2 files. Nothing was pushed.' });
  });
  it('coverage: not checked until a lift outcome was seen', () => {
    const state: RunWatchState = { runId: 'r', seen: new Set(), bag: new Map() };
    expect(deliverAuditCheck.coverage(state)).toEqual({ state: 'not_checked', reason: 'nothing was delivered on this run yet' });
    deliverAuditCheck.evaluate(lift('unchanged'), state, {}, {}, ctx);
    expect(deliverAuditCheck.coverage(state)).toEqual({ state: 'checked' });
  });
});

describe('deterministic:ungated — fixture table (test 2)', () => {
  it('an ungated gate → an info flag with the engine reason; the attempt comes from the unit output', () => {
    const out = run(ungatedCheck, [captured(3, 2), gate(3, { ungated: true, ungatedReason: 'no judge: no eligible judge seat' })]);
    expect(out[1]).toEqual([
      expect.objectContaining({ op: 'raise', subject: '3:2:ungated', sentence: 'Nothing checked this step: no judge: no eligible judge seat', ord: 3, attempt: 2 }),
    ]);
  });
  it('a gated unit (including a judge-verified PASS with no floor) → nothing', () => {
    expect(run(ungatedCheck, [captured(3, 1), gate(3, { ungated: false, hasDeterministicFloor: false, agentVerdict: 'PASS' })]).flat()).toEqual([]);
    expect(run(ungatedCheck, [gate(3, {})]).flat()).toEqual([]); // an older engine: absent reads as not ungated
  });
  it('the reason is capped at 200 characters; a missing reason still flags', () => {
    const [o] = run(ungatedCheck, [gate(5, { ungated: true, ungatedReason: 'x'.repeat(500) })])[0]!;
    expect((o as Extract<CheckOutput, { op: 'raise' }>).sentence.length).toBeLessThanOrEqual('Nothing checked this step: '.length + 200);
    expect(run(ungatedCheck, [gate(5, { ungated: true })])[0]).toEqual([expect.objectContaining({ sentence: 'Nothing checked this step.', subject: '5:-:ungated' })]);
  });
  it('coverage counts every gate that says whether it was gated; an older engine reads "too old"', () => {
    const state: RunWatchState = { runId: 'r', seen: new Set(), bag: new Map() };
    expect(ungatedCheck.coverage(state)).toMatchObject({ state: 'not_checked' });
    ungatedCheck.evaluate(gate(1, {}), state, {}, {}, ctx);
    expect(ungatedCheck.coverage(state)).toEqual({ state: 'not_checked', reason: 'the engine is too old to say whether a step was checked' });
    ungatedCheck.evaluate(gate(1, { ungated: false }), state, {}, {}, ctx);
    expect(ungatedCheck.coverage(state)).toEqual({ state: 'checked' });
  });
});

describe('deterministic:quiet_after_claim — fixture table (test 2)', () => {
  it('handed back ok, no gate, then a detection frame → one medium finding keyed on the claim', () => {
    const out = run(quietAfterClaimCheck, [captured(5, 2), stalled(5)]);
    expect(out[1]).toEqual([
      expect.objectContaining({ op: 'raise', subject: '5:2:after-claim', sentence: "Says it's finished, but nothing new in 16 min.", ord: 5, attempt: 2 }),
    ]);
  });
  it('a second quiet period on the same claim raises nothing more', () => {
    expect(run(quietAfterClaimCheck, [captured(5, 2), stalled(5), stalled(5, 40 * 60_000)])[2]).toEqual([]);
  });
  it('a frame without ord is about the cursor unit (the latest claim)', () => {
    expect(raised(run(quietAfterClaimCheck, [captured(5, 1), stalled(undefined)])[1]!)).toEqual([{ subject: '5:1:after-claim', kind: undefined, severity: undefined }]);
  });
  it('the gate already ran → nothing; the gate arriving after the finding clears it', () => {
    expect(raised(run(quietAfterClaimCheck, [captured(5, 1), gate(5), stalled(5)]).flat())).toEqual([]);
    expect(run(quietAfterClaimCheck, [captured(5, 1), stalled(5), gate(5)])[2]).toEqual([{ op: 'clear', subject: '5:1:after-claim' }]);
  });
  it('no claim (still working, or a failed hand-back) → nothing; the PTY-path event (stalledSecs) is not the frame', () => {
    expect(run(quietAfterClaimCheck, [stalled(5)]).flat()).toEqual([]);
    expect(run(quietAfterClaimCheck, [captured(5, 1, 'failed'), stalled(5)]).flat()).toEqual([]);
    expect(run(quietAfterClaimCheck, [captured(5, 1), input('watchdog', { type: 'workerStalled', ord: 5, stalledSecs: 900 })]).flat()).toEqual([]);
  });
  it('a newer attempt re-claims: its own key', () => {
    const out = run(quietAfterClaimCheck, [captured(5, 1), stalled(5), captured(5, 2), stalled(5)]);
    expect(raised(out[3]!).map((r) => r.subject)).toEqual(['5:2:after-claim']);
  });
});

describe('the shipped entries and the router joins', () => {
  it('the three TR-W5b entries load, enabled, with their joins', () => {
    const { entries, refused } = loadEntries(SHIPPED_ENTRIES_DIR, SHIPPED_CHECKS);
    expect(refused).toEqual([]);
    const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
    expect(byId['deliver-audit']).toMatchObject({ on: { source: 'core', type: 'deliverLiftEvaluated' }, enabled: true, emit: { as: 'finding', severity: 'high' } });
    expect(byId['deliver-audit']!.join!.map((j) => j.type)).toEqual(['repoChecksEvaluated', 'unitOutputCaptured', 'gateEvaluated']);
    expect(byId['ungated']).toMatchObject({ on: { source: 'core', type: 'gateEvaluated' }, enabled: true, emit: { as: 'flag', severity: 'info', watch_kind: 'problem' } });
    expect(byId['quiet-after-claim']).toMatchObject({ on: { source: 'watchdog', type: 'workerStalled' }, enabled: true, emit: { as: 'finding', watch_kind: 'quiet' } });
    // The internal entries have no join (none is serialized).
    expect('join' in byId['registry-lagging']!).toBe(false);
  });

  it('a joined type reaches its entry unfiltered; only `on` is filtered', () => {
    const { entries } = loadEntries(SHIPPED_ENTRIES_DIR, SHIPPED_CHECKS);
    const filtered = entries.map((e) => (e.id === 'deliver-audit' ? { ...e, filter: { outcome: 'lifted' } } : e));
    const r = new Router(filtered);
    expect(r.wants('core', 'repoChecksEvaluated')).toBe('p1');
    // TR-W6: claim-vs-evidence joins the same floor frame.
    expect(r.route(core({ type: 'repoChecksEvaluated', ord: 1 })).map((e) => e.id).sort()).toEqual(['claim-vs-evidence', 'deliver-audit']);
    expect(r.route(core({ type: 'deliverLiftEvaluated', outcome: 'skipped' })).map((e) => e.id)).toEqual([]);
    expect(r.route(core({ type: 'gateEvaluated', ord: 1 })).map((e) => e.id).sort()).toEqual(['claim-vs-evidence', 'deliver-audit', 'quiet-after-claim', 'ungated']);
    // TR-W7: scope-drift triggers on the same floor frame but its filter wants `floor: "creator"`, so a
    // floor frame without it is not routed there.
    expect(r.route(core({ type: 'repoChecksEvaluated', ord: 1, floor: 'creator' })).map((e) => e.id).sort()).toEqual(['claim-vs-evidence', 'deliver-audit', 'scope-drift']);
    // Joins never count as an entry "of" a source (the internal ticks walk only triggers).
    expect(r.entriesOf('core').map((e) => e.id).sort()).toEqual(['claim-vs-evidence', 'deliver-audit', 'risky-call', 'scope-drift', 'ungated']);
  });

  it('the loader refuses a join from the internal source and a bus join that is not 4 segments', async () => {
    const { validateEntry } = await import('../src/watch/loader.js');
    const base = loadEntries(SHIPPED_ENTRIES_DIR, SHIPPED_CHECKS).entries.find((e) => e.id === 'ungated')!;
    expect(validateEntry({ ...base, join: [{ source: 'internal', type: 'registry.tick' }] }, 'ungated', SHIPPED_CHECKS)).toMatchObject({ reason: expect.stringMatching(/join/) });
    expect(validateEntry({ ...base, join: [{ source: 'bus', type: 'wicked.crew.x' }] }, 'ungated', SHIPPED_CHECKS)).toMatchObject({ reason: expect.stringMatching(/4-segment/) });
  });
});

// ── The registry end to end (the bus double from tests/setup) ──────────────────────────────────

let dir: string;
let busPath: string;
let registries: WatchRegistry[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'watch-w5b-'));
  busPath = join(dir, 'bus', 'bus.db');
  registries = [];
});

afterEach(async () => {
  for (const r of registries) await r.stop();
  removeScratch(dir);
});

function makeRegistry(over: Partial<WatchRegistryOptions> = {}): WatchRegistry {
  const r = new WatchRegistry({
    dbPath: busPath,
    settings: async () => undefined,
    projectOf: () => undefined,
    flushMs: 0,
    tickMs: 0,
    pollIntervalMs: 20,
    sleep: async () => undefined,
    ...over,
  });
  registries.push(r);
  return r;
}

async function rows(entryId: string): Promise<Array<Record<string, unknown>>> {
  const all = (await readBus(busPath, WATCH_FINDING_PREFIX, { history: true })) as unknown as Array<{ event_type: string; payload: Record<string, unknown> }>;
  return all.filter((x) => x.event_type === WATCH_FINDING_RAISED && x.payload['entry_id'] === entryId).map((x) => x.payload);
}

const ev = (e: Record<string, unknown>): CoreEvent => ({ session: 'run-q', ...e }) as unknown as CoreEvent;

describe('the registry with the shipped TR-W5b entries', () => {
  it('deliver-audit: a lifted deliver unit that ends unverified is one high finding on the bus', async () => {
    const r = makeRegistry();
    await r.arm();
    r.offer(ev({ type: 'deliverLiftEvaluated', ord: 9, attempt: 1, outcome: 'lifted', conflicts: [] }));
    r.offer(ev({ type: 'unitOutputCaptured', ord: 9, attempt: 1, stepStatus: 'ok', outputBytes: 1, governed: true }));
    r.offer(ev({ type: 'gateEvaluated', ord: 9, ungated: false }));
    await r.flush();
    const found = await rows('deliver-audit');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'finding', severity: 'high', ord: 9, attempt: 1, watch_id: watchIdOf('run-q', 'deliver-audit', 1, '9:1:lift-unverified') });
    expect(r.coverage('run-q')).toEqual(expect.arrayContaining([{ entry_id: 'deliver-audit', state: 'checked' }, { entry_id: 'ungated', state: 'checked' }]));
  });

  it('quiet-after-claim after a restart: the replayed claim\'s gate clears the row the first life raised', async () => {
    const recorded: RecordedEvent[] = [
      { ...ev({ type: 'unitOutputCaptured', ord: 2, attempt: 1, stepStatus: 'ok', outputBytes: 1, governed: true }), ts: 1000, seq: 1 } as unknown as RecordedEvent,
    ];
    const opts: Partial<WatchRegistryOptions> = { liveRuns: async () => ['run-q'], runEvents: async () => recorded };
    const first = makeRegistry(opts);
    await first.arm();
    first.offerWatchdog({ type: 'workerStalled', session: 'run-q', ord: 2, quietForMs: 15 * 60_000 });
    await first.flush();
    await first.stop();
    registries.splice(registries.indexOf(first), 1);
    const second = makeRegistry(opts);
    await second.arm();
    second.offer(ev({ type: 'gateEvaluated', ord: 2, ungated: false }));
    await second.flush();
    const id = watchIdOf('run-q', 'quiet-after-claim', 1, '2:1:after-claim');
    expect(second.feed({ run: 'run-q' }).cleared).toEqual(expect.arrayContaining([expect.objectContaining({ watch_id: id, reason: 'resolved' })]));
  });

  it('quiet-after-claim restart key: a detection frame after the same claim in two daemon lives → ONE row', async () => {
    const recorded: RecordedEvent[] = [
      { ...ev({ type: 'unitOutputCaptured', ord: 4, attempt: 3, stepStatus: 'ok', outputBytes: 1, governed: true }), ts: 1000, seq: 1 } as unknown as RecordedEvent,
    ];
    const opts: Partial<WatchRegistryOptions> = { liveRuns: async () => ['run-q'], runEvents: async () => recorded };
    const first = makeRegistry(opts);
    await first.arm(); // the boot replay folds the claim
    first.offerWatchdog({ type: 'workerStalled', session: 'run-q', ord: 4, quietForMs: 15 * 60_000 });
    await first.flush();
    await first.stop();
    registries.splice(registries.indexOf(first), 1);
    // The daemon restarts; the watchdog clock is not re-armed and fires again after the same claim.
    const second = makeRegistry(opts);
    await second.arm();
    second.offerWatchdog({ type: 'workerStalled', session: 'run-q', ord: 4, quietForMs: 15 * 60_000 });
    await second.flush();
    const found = await rows('quiet-after-claim');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ watch_id: watchIdOf('run-q', 'quiet-after-claim', 1, '4:3:after-claim'), watch_kind: 'quiet', kind: 'finding' });
    expect(second.feed({ run: 'run-q' }).findings.filter((f) => f.entry_id === 'quiet-after-claim')).toHaveLength(1);
  });
});
