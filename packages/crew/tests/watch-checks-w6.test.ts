// TR-W6 — claims against evidence, and warned rules (DES-trigger-registry §4.3 rows 1 and 7, §8
// test 2 fixtures + test 3's two positives by shape). Both checks read only engine-computed fields.

import { describe, expect, it } from 'vitest';

import { SHIPPED_CHECKS } from '../src/watch/checks/index.js';
import { claimVsEvidenceCheck, failingCheckNames } from '../src/watch/checks/claim-vs-evidence.js';
import { warnedRuleCheck, watchSeverityOf } from '../src/watch/checks/warned-rule.js';
import { loadEntries, SHIPPED_ENTRIES_DIR } from '../src/watch/loader.js';
import { RULES_SNAPSHOT_TTL_MS, WatchRegistry } from '../src/watch/registry.js';
import { matchesFilter } from '../src/watch/router.js';
import type { CheckCtx, CheckOutput, KeyPointInput, RunWatchState, WatchCheck, WatchRuleBrief } from '../src/watch/types.js';

const RULES = new Map<string, WatchRuleBrief>([
  ['OPS-WATCH-001', { effect: 'warn', severity: 'warn' }],
  ['OPS-WATCH-003', { effect: 'warn', severity: 'error' }],
  ['GOV-FORCE-PUSH', { effect: 'deny', severity: 'critical' }],
  ['OPS-COND-001', { effect: 'allow_with_conditions', severity: 'warn' }],
  ['DOC-ONLY', { severity: 'info' }],
]);

function ctxWith(rules: ReadonlyMap<string, WatchRuleBrief> | 'unreadable' | null): CheckCtx {
  const base = { now: () => 0, stats: () => ({ queueDepth: 0, queueHwm: 0, shedTotal: 0, tailLagMs: 0 }) };
  if (rules === null) return base;
  if (rules === 'unreadable') return { ...base, rules: async () => Promise.reject(new Error('store locked')) };
  return { ...base, rules: async () => rules };
}

function input(event: Record<string, unknown>): KeyPointInput {
  return { source: 'core', type: String(event['type']), event: { session: 'run-1', ...event }, runId: 'run-1', at: 1 };
}

async function run(check: WatchCheck<Record<string, never>, Record<string, never>>, steps: KeyPointInput[], ctx: CheckCtx = ctxWith(RULES)) {
  const state: RunWatchState = { runId: 'run-1', seen: new Set(), bag: new Map() };
  const outs: CheckOutput[][] = [];
  for (const s of steps) {
    state.seen.add(s.type);
    outs.push(await check.evaluate(s, state, {}, {}, ctx));
  }
  return { outs, state, cleared: outs.flat().flatMap((o) => (o.op === 'clear' ? [o.subject] : [])), raised: outs.flat().flatMap((o) => (o.op === 'raise' ? [{ subject: o.subject, kind: o.kind, severity: o.severity, sentence: o.sentence }] : [])) };
}

const checkRun = (name: string, exitCode: number | null, extra: Record<string, unknown> = {}) => ({
  name,
  argv: [name],
  source: 'package.json',
  exitCode,
  timedOut: false,
  spawnError: null,
  durationMs: 10,
  stdoutTail: '',
  stderrTail: '',
  ...extra,
});
const floor = (ord: number, attempt: number, passed: boolean, floorKind: string, checks: unknown[] = [], extra: Record<string, unknown> = {}): KeyPointInput =>
  input({ type: 'repoChecksEvaluated', ord, attempt, passed, criterion: 'repo checks', checks, skipped: [], floor: floorKind, outcome: passed ? 'passed' : 'failed', ...extra });
const gate = (ord: number, extra: Record<string, unknown> = {}): KeyPointInput =>
  input({ type: 'gateEvaluated', ord, hasDeterministicFloor: true, deterministicPass: true, combined: true, ...extra });
const hook = (ord: number, attempt: number, decision: 'allow' | 'deny' | 'allow_with_conditions', fired: string[] | undefined, toolName = 'Bash'): KeyPointInput =>
  input({ type: 'governanceHookFired', ord, attempt, toolName, decision, denyingPolicy: decision === 'deny' ? 'GOV-FORCE-PUSH' : null, ...(fired !== undefined ? { firedPolicies: fired } : {}) });

describe('deterministic:claim_vs_evidence — fixture table (test 2)', () => {
  it('evaluator arm: PASS over a failed floor → ONE high finding naming the failing checks, once', async () => {
    const { raised } = await run(claimVsEvidenceCheck, [
      floor(3, 0, false, 'verify', [checkRun('lint', 1), checkRun('test', 0)]),
      gate(3, { evaluatorVerdict: 'PASS', evaluatorPass: true, deterministicPass: false, combined: false }),
      gate(3, { evaluatorVerdict: 'PASS', evaluatorPass: true, deterministicPass: false, combined: false }),
    ]);
    expect(raised).toEqual([{ subject: '3:0:evaluator-pass-vs-floor', kind: 'finding', severity: 'high', sentence: 'Said it passed; its own checks failed (lint).' }]);
  });

  it('a PASS over a PASSING floor, a FAIL verdict, or a creator unit (null verdict) over a failed evaluator floor → nothing from the evaluator arm', async () => {
    const { raised } = await run(claimVsEvidenceCheck, [
      floor(3, 0, true, 'verify'),
      gate(3, { evaluatorVerdict: 'PASS' }),
      floor(4, 0, false, 'verify', [checkRun('lint', 1)]),
      gate(4, { evaluatorVerdict: 'FAIL' }),
      gate(4, { evaluatorVerdict: null }),
    ]);
    expect(raised).toEqual([]);
  });

  it('creator arm: the creator floor fails → ONE medium finding at the floor (no gate needed), once per attempt; a passing creator floor is silent', async () => {
    const { raised } = await run(claimVsEvidenceCheck, [
      floor(2, 0, false, 'creator', [checkRun('lint', 2), checkRun('typecheck', 1), checkRun('test', 0, { timedOut: true }), checkRun('build', 1)]),
      floor(2, 0, false, 'creator', [checkRun('lint', 2)]),
      floor(2, 1, true, 'creator'),
    ]);
    expect(raised).toEqual([
      { subject: '2:0:creator-floor-failed', kind: 'finding', severity: 'medium', sentence: 'Handed back as finished; its own checks failed (lint, typecheck, test, +1 more).' },
    ]);
  });

  it('the attempt on the evaluator finding is the floor\'s (gateEvaluated carries none, N3); a LATER attempt whose gate is combined:true clears the unit\'s open findings (§4.7), once', async () => {
    const { raised, cleared } = await run(claimVsEvidenceCheck, [
      floor(5, 1, false, 'verify', [checkRun('lint', 1)]),
      gate(5, { evaluatorVerdict: 'pass', deterministicPass: false, combined: false }),
      floor(5, 2, true, 'verify'),
      gate(5, { evaluatorVerdict: 'PASS' }),
      gate(5, { evaluatorVerdict: 'PASS' }),
    ]);
    expect(raised.map((r) => r.subject)).toEqual(['5:1:evaluator-pass-vs-floor']);
    expect(cleared).toEqual(['5:1:evaluator-pass-vs-floor']);
  });

  it('clearing is per unit: a creator finding on ord 2 is cleared by ord 2\'s passing gate, never by another unit\'s; a gate that is not combined:true clears nothing', async () => {
    const { raised, cleared, outs } = await run(claimVsEvidenceCheck, [
      floor(2, 0, false, 'creator', [checkRun('lint', 1)]),
      gate(2, { deterministicPass: false, combined: false }),
      gate(7, { combined: true }),
      floor(2, 1, true, 'creator'),
      gate(2, { combined: true }),
    ]);
    expect(raised.map((r) => r.subject)).toEqual(['2:0:creator-floor-failed']);
    expect(cleared).toEqual(['2:0:creator-floor-failed']);
    expect(outs[1]).toEqual([]);
    expect(outs[2]).toEqual([]);
  });

  it('a floor is evidence for its OWN gate only: a later PASS gate with no fresh floor is not read against the stale failing one', async () => {
    const { raised } = await run(claimVsEvidenceCheck, [
      floor(4, 0, false, 'verify', [checkRun('lint', 1)]),
      gate(4, { evaluatorVerdict: 'FAIL', deterministicPass: false, combined: false }),
      gate(4, { evaluatorVerdict: 'PASS', hasDeterministicFloor: false, combined: false }),
    ]);
    expect(raised).toEqual([]);
  });

  it('a floor that did not RUN (outcome not_run: no write boundary) is never "its checks failed"; a floor that timed out says "did not finish"', async () => {
    const notRun = await run(claimVsEvidenceCheck, [
      floor(2, 0, false, 'creator', [], { outcome: 'not_run', sandboxError: 'no sandbox on this host' }),
      floor(3, 0, false, 'verify', [], { outcome: 'not_run', sandboxError: 'no sandbox on this host' }),
      gate(3, { evaluatorVerdict: 'PASS', deterministicPass: false, combined: false }),
    ]);
    expect(notRun.raised).toEqual([]);
    expect(claimVsEvidenceCheck.coverage(notRun.state)).toEqual({ state: 'not_checked', reason: 'the step\'s checks could not run: no sandbox on this host' });
    const timedOut = await run(claimVsEvidenceCheck, [floor(2, 0, false, 'creator', [checkRun('test', null, { timedOut: true })], { outcome: 'timed_out' })]);
    expect(timedOut.raised).toEqual([{ subject: '2:0:creator-floor-failed', kind: 'finding', severity: 'medium', sentence: 'Handed back as finished; its own checks did not finish (test).' }]);
  });

  it('coverage: not checked until a floor ran; a gate with no floor says why (floorNote); checked once any floor ran', async () => {
    const none = await run(claimVsEvidenceCheck, []);
    expect(claimVsEvidenceCheck.coverage(none.state)).toEqual({ state: 'not_checked', reason: 'no step has run its checks yet' });
    const noFloor = await run(claimVsEvidenceCheck, [gate(1, { hasDeterministicFloor: false, floorNote: 'the repo declares no checks' })]);
    expect(claimVsEvidenceCheck.coverage(noFloor.state)).toEqual({ state: 'not_checked', reason: 'no deterministic floor ran: the repo declares no checks' });
    const some = await run(claimVsEvidenceCheck, [floor(1, 0, true, 'verify')]);
    expect(claimVsEvidenceCheck.coverage(some.state)).toEqual({ state: 'checked' });
  });

  it('failingCheckNames: exit code, timeout and spawn error each count; passing runs and junk do not', () => {
    expect(failingCheckNames([checkRun('lint', 1), checkRun('ok', 0), checkRun('slow', null, { timedOut: true }), checkRun('gone', null, { spawnError: 'ENOENT' }), 'junk', null])).toEqual(['lint', 'slow', 'gone']);
    expect(failingCheckNames(undefined)).toEqual([]);
  });
});

describe('test 3 — the two laya positives, by shape (the labelled corpus is not in this lane)', () => {
  it('positive A (run 4f6b3450 ord 3): a creator unit with no VERDICT whose own creator floor failed → the creator arm flags it', async () => {
    const { raised, cleared } = await run(claimVsEvidenceCheck, [
      floor(3, 0, false, 'creator', [checkRun('npm run lint', 1)]),
      gate(3, { evaluatorVerdict: null, agentVerdict: null, hasDeterministicFloor: true, deterministicPass: false, combined: false }),
    ]);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.subject).toBe('3:0:creator-floor-failed');
    expect(cleared).toEqual([]);
  });

  it('positive B: an evaluator that wrote VERDICT: PASS over a floor that failed → the evaluator arm flags it high', async () => {
    const { raised } = await run(claimVsEvidenceCheck, [
      floor(6, 0, false, 'verify', [checkRun('cargo clippy', 101)]),
      gate(6, { evaluatorVerdict: 'PASS', evaluatorPass: true, judgeCli: 'codex', deterministicPass: false, combined: false }),
    ]);
    expect(raised).toEqual([{ subject: '6:0:evaluator-pass-vs-floor', kind: 'finding', severity: 'high', sentence: 'Said it passed; its own checks failed (cargo clippy).' }]);
  });
});

describe('deterministic:warned_rule (risky-call) — fixture table (test 2)', () => {
  it('each fired warn rule on an allowed call → one flag with the rule\'s severity, naming the rule id ONLY (§7: no rule text on the bus); deny, allow_with_conditions and recall-only rules are not flags; once per (unit, attempt, rule)', async () => {
    const { raised, outs } = await run(warnedRuleCheck, [
      hook(4, 0, 'allow', ['OPS-WATCH-001', 'DOC-ONLY', 'OPS-WATCH-003', 'OPS-WATCH-001', 'OPS-COND-001']),
      hook(4, 0, 'allow', ['OPS-WATCH-001']),
      hook(4, 1, 'allow_with_conditions', ['OPS-WATCH-001', 'OPS-COND-001'], 'Write'),
    ]);
    expect(raised).toEqual([
      { subject: '4:0:warned:OPS-WATCH-001', kind: 'flag', severity: 'medium', sentence: 'A rule you asked to be warned about fired on Bash: OPS-WATCH-001.' },
      { subject: '4:0:warned:OPS-WATCH-003', kind: 'flag', severity: 'high', sentence: 'A rule you asked to be warned about fired on Bash: OPS-WATCH-003.' },
      { subject: '4:1:warned:OPS-WATCH-001', kind: 'flag', severity: 'medium', sentence: 'A rule you asked to be warned about fired on Write: OPS-WATCH-001.' },
    ]);
    const first = outs[0]![0]!;
    expect(first.op === 'raise' ? first.facts : null).toEqual({ rule_id: 'OPS-WATCH-001', tool: 'Bash', effect: 'warn', rule_severity: 'warn', decision: 'allow' });
  });

  it('a DENIED call is the engine\'s own record — no flag, even when warn rules fired beside the deny; an unknown id is skipped', async () => {
    const { raised } = await run(warnedRuleCheck, [hook(1, 0, 'deny', ['GOV-FORCE-PUSH', 'OPS-WATCH-001']), hook(2, 0, 'allow', ['NOT-A-RULE'])]);
    expect(raised).toEqual([]);
  });

  it('coverage: an engine without firedPolicies is "too old"; a store that cannot be read is "not readable"; frames with the field are checked', async () => {
    const old = await run(warnedRuleCheck, [hook(1, 0, 'allow', undefined)]);
    expect(warnedRuleCheck.coverage(old.state)).toEqual({ state: 'not_checked', reason: 'the engine is too old to carry the fired rules (needs wicked-core-ts >= 0.7.35)' });
    const locked = await run(warnedRuleCheck, [hook(1, 0, 'allow', ['OPS-WATCH-001'])], ctxWith('unreadable'));
    expect(locked.raised).toEqual([]);
    expect(warnedRuleCheck.coverage(locked.state)).toEqual({ state: 'not_checked', reason: 'the rule store could not be read, so fired rules could not be classified' });
    const noSource = await run(warnedRuleCheck, [hook(1, 0, 'allow', ['OPS-WATCH-001'])], ctxWith(null));
    expect(warnedRuleCheck.coverage(noSource.state)).toMatchObject({ state: 'not_checked' });
    const fine = await run(warnedRuleCheck, [hook(1, 0, 'allow', [])]);
    expect(warnedRuleCheck.coverage(fine.state)).toEqual({ state: 'checked' });
    const none = await run(warnedRuleCheck, []);
    expect(warnedRuleCheck.coverage(none.state)).toEqual({ state: 'not_checked', reason: 'no governed tool call has reached a gate yet' });
  });

  it('severity mapping: critical/error → high, warn → medium, info/unknown → info', () => {
    expect(['critical', 'error', 'warn', 'info', undefined].map(watchSeverityOf)).toEqual(['high', 'high', 'medium', 'info', 'info']);
  });
});

describe('the registry\'s rule snapshot and the shipped set', () => {
  it('reads the store once per TTL and never per frame; a retired rule is not in the snapshot', async () => {
    let reads = 0;
    let now = 1_000;
    const registry = new WatchRegistry({
      dbPath: undefined,
      settings: async () => undefined,
      projectOf: () => undefined,
      now: () => now,
      rules: async () => {
        reads++;
        return [
          { id: 'OPS-WATCH-001', effect: 'warn', severity: 'warn', statement: 'x' },
          { id: 'OLD', effect: 'warn', severity: 'warn', statement: 'y', retired: true },
        ];
      },
    });
    const ctx = (registry as unknown as { ctx(): CheckCtx }).ctx();
    expect(ctx.rules).toBeDefined();
    const a = await ctx.rules!();
    const b = await ctx.rules!();
    expect(reads).toBe(1);
    expect([...a.entries()]).toEqual([['OPS-WATCH-001', { effect: 'warn', severity: 'warn' }]]);
    expect(b).toBe(a);
    now += RULES_SNAPSHOT_TTL_MS + 1;
    await ctx.rules!();
    expect(reads).toBe(2);
    const bare = new WatchRegistry({ dbPath: undefined, settings: async () => undefined, projectOf: () => undefined });
    expect((bare as unknown as { ctx(): CheckCtx }).ctx().rules).toBeUndefined();
  });

  it('both checks are shipped and both entries load enabled with the right triggers, joins and filters', () => {
    expect(SHIPPED_CHECKS.has('deterministic:claim_vs_evidence')).toBe(true);
    expect(SHIPPED_CHECKS.has('deterministic:warned_rule')).toBe(true);
    const { entries, refused } = loadEntries(SHIPPED_ENTRIES_DIR, SHIPPED_CHECKS);
    expect(refused).toEqual([]);
    const claim = entries.find((e) => e.id === 'claim-vs-evidence')!;
    expect(claim).toMatchObject({ on: { source: 'core', type: 'gateEvaluated' }, join: [{ source: 'core', type: 'repoChecksEvaluated' }], check: 'deterministic:claim_vs_evidence', emit: { as: 'finding', severity: 'high' }, enabled: true });
    const risky = entries.find((e) => e.id === 'risky-call')!;
    expect(risky).toMatchObject({ on: { source: 'core', type: 'governanceHookFired' }, filter: { decision: ['allow', 'allow_with_conditions'] }, check: 'deterministic:warned_rule', emit: { as: 'flag', severity: 'medium' }, enabled: true });
    expect(risky.join).toBeUndefined();
    // §4.3 row 7: `decision != "deny"` — the engine also says `allow_with_conditions`.
    expect(['allow', 'allow_with_conditions', 'deny'].map((decision) => matchesFilter(risky.filter, { decision }))).toEqual([true, true, false]);
  });
});
