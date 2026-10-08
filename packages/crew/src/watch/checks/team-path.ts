/**
 * The ask path's Watchtower rows (DES-ASK-TEAM-CHAT-001 §4.1, §4.5, §4.6; slice ASK-C3): three
 * deterministic checks, each a projection of ONE `wicked.team.*` fact the engine already owns — the
 * registry PULLS the rows off the bus (the `teamEvent` relay's rows; `scope-drift` was the first
 * bus entry). Advisory by construction (TR §4.5): a row is a flag on the feed, never a gate input.
 *
 *   - `deterministic:path_repicked` (entry `path-repicked`, `problem`): a PA step's attempt ended
 *     for a seat cause and the engine re-pinned the PA — `path.repicked{from, to, reason, pick_seq}`.
 *     One row per `pick_seq` (the engine's per-run re-pick counter).
 *   - `deterministic:reviewer_absent` (entry `reviewer-absent`, `quiet`): the supervisor could not
 *     seat a member — `member.joined{status:"failed"}`, `seat:null` when no distinct signed-in seat
 *     exists (§4.6 "absent, and said so"). The engine publishes that row once per attempt; the
 *     Watchtower keeps ONE open row per member slot (`member_id`), keyed by the first failure's
 *     producer identity (`ord:attempt:member_id:open_seq`), so a one-seat machine does not grow a
 *     row per answer step. It clears when that slot attaches (`member.joined{status:"attached"}`).
 *   - `deterministic:help_unanswered` (entry `help-unanswered`, `quiet`): a help request's terminal
 *     outcome was not `answered` — `help.answered{outcome: timed_out | failed | no_member}` (§4.5:
 *     the outcome is a fact on S's row, never inferred from a missing one). One row per
 *     `help_id:answer_id`; the question comes from the joined `help.requested`. It clears when a
 *     later help on the run is `answered` (the helpers are answering again).
 *
 * Every row of the three clears when the path ends (`path.ended`). Nothing here tests for "is this
 * an ask": any team path that re-picks, cannot seat its reviewer, or loses a help turn is shown the
 * same way. A path that ended while the daemon was down is not a live run at boot, so its replay
 * does not run and its open rows clear only by dismissal (the same rule as `scope-drift`).
 */

import { z } from 'zod';
import type { CheckOutput, KeyPointInput, RunWatchState, WatchCheck } from '../types.js';

export const PATH_REPICKED_TYPE = 'wicked.team.path.repicked';
export const PATH_ENDED_TYPE = 'wicked.team.path.ended';
export const MEMBER_JOINED_TYPE = 'wicked.team.member.joined';
export const HELP_REQUESTED_TYPE = 'wicked.team.help.requested';
export const HELP_ANSWERED_TYPE = 'wicked.team.help.answered';

const TEXT_MAX = 160;

type Empty = Record<string, never>;
const empty = z.object({}).strict() as unknown as z.ZodType<Empty>;

/** The team envelope + payload of a pulled bus row (`{…, payload:{run_id, ord, attempt, by, …}}`). */
function payloadOf(input: KeyPointInput): Record<string, unknown> {
  const p = input.event['payload'];
  return p !== null && typeof p === 'object' ? (p as Record<string, unknown>) : {};
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const cap = (s: string): string => (s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX - 1)}…` : s);

/** What each check folds: the team rows it has seen, and the subjects it holds open. */
interface Bag {
  seen: number;
  /** Open subjects (raised, not yet cleared), in raise order. */
  open: Map<string, { slot: string | null }>;
  ended: boolean;
}

function bagOf(state: RunWatchState, key: string): Bag {
  let bag = state.bag.get(key) as Bag | undefined;
  if (bag === undefined) {
    bag = { seen: 0, open: new Map(), ended: false };
    state.bag.set(key, bag);
  }
  return bag;
}

/** `path.ended`: every open row of this check clears, and nothing raises after it. */
function endPath(bag: Bag): CheckOutput[] {
  bag.ended = true;
  const out: CheckOutput[] = [...bag.open.keys()].map((subject) => ({ op: 'clear', subject }));
  bag.open.clear();
  return out;
}

function coverageOf(bag: Bag | undefined, what: string, run?: { ended: boolean }): { state: 'checked' } | { state: 'not_checked'; reason: string } {
  if (bag !== undefined && bag.seen > 0) return { state: 'checked' };
  return { state: 'not_checked', reason: run?.ended === true ? `nothing to check: no ${what} on this run` : `no ${what} on this run yet` };
}

export const pathRepickedCheck: WatchCheck<Empty, Empty> = {
  name: 'deterministic:path_repicked',
  lane: 'deterministic',
  paramsSchema: empty,
  thresholdSchema: empty,
  evaluate(input, state) {
    const bag = bagOf(state, 'repicked');
    bag.seen++;
    if (input.type === PATH_ENDED_TYPE) return endPath(bag);
    if (input.type !== PATH_REPICKED_TYPE || bag.ended) return [];
    const p = payloadOf(input);
    const pickSeq = num(p['pick_seq']);
    if (pickSeq === null) return [];
    const subject = `repick:${pickSeq}`;
    if (bag.open.has(subject)) return [];
    bag.open.set(subject, { slot: null });
    const from = str(p['from']) ?? 'the answering seat';
    const to = str(p['to']) ?? 'another seat';
    const reason = str(p['reason']);
    return [
      {
        op: 'raise',
        subject,
        sentence: `${to} takes over — ${from} stopped answering${reason !== null ? ` (${cap(reason)})` : ''}.`,
        facts: { from, to, reason, pick_seq: pickSeq },
        ord: num(p['ord']),
        attempt: num(p['attempt']),
        re: `path.repicked#${pickSeq}`,
      },
    ];
  },
  coverage: (state, run) => coverageOf(state.bag.get('repicked') as Bag | undefined, 'team path row', run),
  describe: () => 'When the answering seat stops and another seat takes over the path',
};

export const reviewerAbsentCheck: WatchCheck<Empty, Empty> = {
  name: 'deterministic:reviewer_absent',
  lane: 'deterministic',
  paramsSchema: empty,
  thresholdSchema: empty,
  evaluate(input, state) {
    const bag = bagOf(state, 'reviewer');
    bag.seen++;
    if (input.type === PATH_ENDED_TYPE) return endPath(bag);
    if (input.type !== MEMBER_JOINED_TYPE) return [];
    const p = payloadOf(input);
    const slot = str(p['member_id']);
    if (slot === null) return [];
    const status = p['status'];
    if (status === 'attached') {
      const out: CheckOutput[] = [];
      for (const [subject, o] of bag.open) {
        if (o.slot === slot) {
          bag.open.delete(subject);
          out.push({ op: 'clear', subject });
        }
      }
      return out;
    }
    if (status !== 'failed' || bag.ended) return [];
    // One open row per slot: a later attempt's failure is the same absence.
    for (const o of bag.open.values()) if (o.slot === slot) return [];
    const ord = num(p['ord']);
    const attempt = num(p['attempt']);
    const subject = `${ord ?? '-'}:${attempt ?? '-'}:${slot}:${num(p['open_seq']) ?? '-'}`;
    bag.open.set(subject, { slot });
    const seat = str(p['seat']);
    const reason = str(p['reason']) ?? str(p['error']);
    return [
      {
        op: 'raise',
        subject,
        sentence:
          seat === null
            ? `No reviewer — ${reason !== null ? cap(reason) : 'no distinct signed-in seat'}. Sign in another helper to get one.`
            : `The reviewer could not join on ${seat}${reason !== null ? `: ${cap(reason)}` : ''}.`,
        facts: { member_id: slot, seat, reason },
        ord,
        attempt,
        re: `member.joined#${slot}`,
      },
    ];
  },
  coverage: (state, run) => coverageOf(state.bag.get('reviewer') as Bag | undefined, 'team member row', run),
  describe: () => 'When a team path has no reviewer: no distinct signed-in seat, or the reviewer could not join',
};

const NOT_ANSWERED: Record<string, string> = {
  timed_out: 'timed out',
  failed: 'failed',
  no_member: 'no other helper is signed in',
};

export const helpUnansweredCheck: WatchCheck<Empty, Empty> = {
  name: 'deterministic:help_unanswered',
  lane: 'deterministic',
  paramsSchema: empty,
  thresholdSchema: empty,
  evaluate(input, state) {
    const bag = bagOf(state, 'help');
    const questions = (state.bag.get('help.questions') as Map<string, string> | undefined) ?? new Map<string, string>();
    state.bag.set('help.questions', questions);
    bag.seen++;
    if (input.type === PATH_ENDED_TYPE) return endPath(bag);
    const p = payloadOf(input);
    const helpId = str(p['help_id']);
    if (helpId === null) return [];
    if (input.type === HELP_REQUESTED_TYPE) {
      const q = str(p['question']);
      if (q !== null) questions.set(helpId, cap(q));
      return [];
    }
    if (input.type !== HELP_ANSWERED_TYPE) return [];
    // An absent outcome is an old row: `answered` (ASK-K3a, `#[serde(default)]`).
    const outcome = str(p['outcome']) ?? 'answered';
    if (outcome === 'answered') {
      const out: CheckOutput[] = [...bag.open.keys()].map((subject) => ({ op: 'clear', subject }));
      bag.open.clear();
      return out;
    }
    if (bag.ended) return [];
    const subject = `help:${helpId}:${str(p['answer_id']) ?? '-'}`;
    if (bag.open.has(subject)) return [];
    bag.open.set(subject, { slot: null });
    const by = str(p['by']);
    const why = NOT_ANSWERED[outcome] ?? outcome;
    const question = questions.get(helpId) ?? null;
    const who = by !== null && by !== 'engine' ? by : 'the helper';
    return [
      {
        op: 'raise',
        subject,
        sentence:
          outcome === 'no_member'
            ? `Asked for help; ${why}${question !== null ? `: "${question}"` : '.'}`
            : `Asked for help; ${who} did not answer (${why})${question !== null ? `: "${question}"` : '.'}`,
        facts: { help_id: helpId, outcome, question, error: str(p['error']) },
        ord: num(p['ord']),
        attempt: num(p['attempt']),
        re: `help.answered#${helpId}`,
      },
    ];
  },
  coverage: (state, run) => coverageOf(state.bag.get('help') as Bag | undefined, 'team help row', run),
  describe: () => 'When a help request on a team path ends without an answer (timed out, failed, or no helper)',
};
