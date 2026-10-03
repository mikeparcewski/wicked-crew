/**
 * `deterministic:claim_vs_evidence` (DES-trigger-registry §4.3 row 1, §4.4, §4.7; TR-W6).
 *
 * Reads only fields the engine computed — no regex over transcripts (laya's `RX_CLAIM` was a
 * measurement baseline, not a detector). Two arms, because `evaluatorVerdict` is `null` for
 * creator, neutral and tool units (B3):
 *
 *  - **Evaluator arm.** `gateEvaluated.evaluatorVerdict === "PASS"` while the `repoChecksEvaluated`
 *    emitted just before that gate says `passed: false` → one HIGH finding: "Said it passed; its
 *    own checks failed (lint)". The join is the unit's `ord`; the attempt comes from the floor
 *    (N3: `gateEvaluated` carries no attempt). A floor is evidence for its OWN gate only: the gate
 *    consumes it, so a later gate with no fresh floor is never read against a stale one.
 *  - **Creator arm.** `repoChecksEvaluated{floor: "creator", passed: false}` → one MEDIUM finding:
 *    "Handed back as finished; its own checks failed (lint)". A creator that hands back output has
 *    claimed it is finished; the engine's creator floor failing is the structural contradiction.
 *
 * A floor that did not RUN (`outcome: "not_run"` — no write boundary could be armed) is not "its
 * checks failed": neither arm speaks, and coverage says the checks could not run. A floor that hit
 * its bound (`outcome: "timed_out"`) says "did not finish".
 *
 * Failing check names come from `repoChecksEvaluated.checks` (exit code, timeout or spawn error).
 * Clearing (§4.7): a `gateEvaluated{combined: true}` for the unit means a later attempt passed —
 * every finding this check holds open on that unit is cleared.
 * Coverage: "not checked" when no floor ran for the run (the gate's `floorNote` says why).
 */

import { z } from 'zod';
import type { CheckOutput, WatchCheck } from '../types.js';

interface Floor {
  attempt: number;
  passed: boolean;
  ran: boolean;
  timedOut: boolean;
  failing: string[];
  floor: string;
}

interface Bag {
  /** The `repoChecksEvaluated` awaiting its gate, per unit ord — consumed by that gate. */
  pending: Map<number, Floor>;
  /** Floors that ran (passed or failed). */
  floors: number;
  /** Floors that could not run, and the engine's last reason. */
  notRun: number;
  notRunNote: string | null;
  gates: number;
  /** The last `floorNote` a gate carried (why no floor ran), for coverage. */
  floorNote: string | null;
  raised: Set<string>;
  /** Raised subjects still open, per unit ord — what a passing gate clears. */
  open: Map<number, Set<string>>;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The checks that failed, by name: a non-zero exit, a timeout or a spawn error. */
export function failingCheckNames(checks: unknown): string[] {
  if (!Array.isArray(checks)) return [];
  const out: string[] = [];
  for (const c of checks) {
    if (typeof c !== 'object' || c === null) continue;
    const r = c as Record<string, unknown>;
    const name = typeof r['name'] === 'string' && r['name'] !== '' ? r['name'] : 'check';
    const exit = r['exitCode'];
    const failed = (typeof exit === 'number' && exit !== 0) || r['timedOut'] === true || (typeof r['spawnError'] === 'string' && r['spawnError'] !== '');
    if (failed && !out.includes(name)) out.push(name);
  }
  return out;
}

function named(failing: string[]): string {
  if (failing.length === 0) return 'its checks';
  const shown = failing.slice(0, 3).join(', ');
  return failing.length > 3 ? `${shown}, +${failing.length - 3} more` : shown;
}

/** "its own checks failed (lint)" / "its own checks did not finish (test)". */
const evidence = (f: Floor): string => `its own checks ${f.timedOut ? 'did not finish' : 'failed'} (${named(f.failing)})`;

function raise(bag: Bag, ord: number, out: Extract<CheckOutput, { op: 'raise' }>): CheckOutput[] {
  if (bag.raised.has(out.subject)) return [];
  bag.raised.add(out.subject);
  const open = bag.open.get(ord) ?? new Set<string>();
  open.add(out.subject);
  bag.open.set(ord, open);
  return [out];
}

export const claimVsEvidenceCheck: WatchCheck<Record<string, never>, Record<string, never>> = {
  name: 'deterministic:claim_vs_evidence',
  lane: 'deterministic',
  paramsSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  thresholdSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  evaluate(input, state) {
    const bag =
      (state.bag.get('claim') as Bag | undefined) ??
      ({ pending: new Map(), floors: 0, notRun: 0, notRunNote: null, gates: 0, floorNote: null, raised: new Set(), open: new Map() } satisfies Bag);
    state.bag.set('claim', bag);
    const e = input.event;
    const ord = num(e['ord']);
    if (ord === null) return [];
    if (input.type === 'repoChecksEvaluated') {
      const attempt = num(e['attempt']) ?? 0;
      const passed = e['passed'] === true;
      const outcome = text(e['outcome']);
      const floor = text(e['floor']);
      const ran = outcome !== 'not_run';
      const current: Floor = { attempt, passed, ran, timedOut: outcome === 'timed_out', failing: failingCheckNames(e['checks']), floor };
      bag.pending.set(ord, current);
      if (!ran) {
        bag.notRun++;
        bag.notRunNote = text(e['sandboxError']) || text(e['detectError']) || bag.notRunNote;
        return [];
      }
      bag.floors++;
      if (floor !== 'creator' || passed) return [];
      return raise(bag, ord, {
        op: 'raise',
        subject: `${ord}:${attempt}:creator-floor-failed`,
        kind: 'finding',
        severity: 'medium',
        sentence: `Handed back as finished; ${evidence(current)}.`,
        facts: { arm: 'creator', floor, passed: false, failing: current.failing, timed_out: current.timedOut },
        ord,
        attempt,
        re: `repoChecksEvaluated#${ord}:${attempt}`,
      });
    }
    if (input.type !== 'gateEvaluated') return [];
    bag.gates++;
    if (typeof e['floorNote'] === 'string' && e['floorNote'] !== '') bag.floorNote = e['floorNote'];
    // The floor emitted just before this gate is this gate's evidence — and no later gate's.
    const floor = bag.pending.get(ord);
    bag.pending.delete(ord);
    if (e['combined'] === true) {
      // A later attempt of this unit passed its gate: what this check held open on it is resolved.
      const open = bag.open.get(ord);
      if (open === undefined || open.size === 0) return [];
      bag.open.delete(ord);
      return [...open].map((subject) => ({ op: 'clear', subject }) as const);
    }
    const verdict = text(e['evaluatorVerdict']).trim().toUpperCase();
    if (verdict !== 'PASS' || floor === undefined || !floor.ran || floor.passed) return [];
    return raise(bag, ord, {
      op: 'raise',
      subject: `${ord}:${floor.attempt}:evaluator-pass-vs-floor`,
      kind: 'finding',
      severity: 'high',
      sentence: `Said it passed; ${evidence(floor)}.`,
      facts: { arm: 'evaluator', verdict: 'PASS', floor: floor.floor, passed: false, failing: floor.failing, timed_out: floor.timedOut },
      ord,
      attempt: floor.attempt,
      re: `gateEvaluated#${ord}`,
    });
  },
  coverage(state) {
    const bag = state.bag.get('claim') as Bag | undefined;
    if (bag !== undefined && bag.floors > 0) return { state: 'checked' };
    if (bag !== undefined && bag.notRun > 0) {
      return { state: 'not_checked', reason: `the step's checks could not run${bag.notRunNote !== null && bag.notRunNote !== '' ? `: ${bag.notRunNote.slice(0, 160)}` : ''}` };
    }
    if (bag !== undefined && bag.gates > 0) {
      return {
        state: 'not_checked',
        reason: bag.floorNote !== null ? `no deterministic floor ran: ${bag.floorNote.slice(0, 160)}` : 'no step ran its checks — nothing to read the verdict against',
      };
    }
    return { state: 'not_checked', reason: 'no step has run its checks yet' };
  },
  describe: () => 'When a step is handed back as finished, or an evaluator says PASS, while the step\'s own checks failed',
};
