/**
 * Standing orders — the seat's parse of plain words into a rule (behaviour 10).
 *
 * ONE seat, ONE step (DES-ASK-TEAM-CHAT-001 §10 ASK-C4): a one-step team path — a user-composed
 * plan of one `understand` step carrying the prompt, `primary` = the chosen seat, `monitors.asked:0`
 * (nobody reviews a parse) — launched on the run engine, never the warm chat pool. The step's
 * stored output (`work_output(<run>:parse-1)`) is the answer once the run's terminal frame arrives;
 * a run that does not end in time is cancelled. The answer is a proposal the person confirms — crew
 * stores only the confirmed rule — so a seat that answers badly costs a retry, never a wrong order.
 */

import { randomUUID } from 'node:crypto';
import type { CoreAdapter } from '../core/adapter.js';
import type { CoreEvent, RosterSeat } from '../core/types.js';
import { parsePrompt, ruleFromAnswer, type ParseOutcome } from './routes.js';

export interface SeatParserDeps {
  adapter: Pick<CoreAdapter, 'launchRun' | 'cancelRun' | 'workOutput' | 'onEvent' | 'projectsSupported' | 'projectList'>;
  roster: () => RosterSeat[];
  /** How long the seat has to answer (default 120 s). */
  timeoutMs?: number;
}

/** The one step of a parse path. */
export const PARSE_STEP_ID = 'parse-1';

/** The first seat the daemon would seat for an unscoped turn. */
function chatSeat(roster: RosterSeat[]): RosterSeat | undefined {
  return roster.find(
    (s) => (s as { chat_admission?: { unscoped?: { ok?: boolean } } }).chat_admission?.unscoped?.ok === true,
  );
}

export function seatParser(deps: SeatParserDeps): (text: string) => Promise<ParseOutcome> {
  const { adapter } = deps;
  const timeoutMs = deps.timeoutMs ?? 120_000;
  return async (text) => {
    const entry = chatSeat(deps.roster());
    if (entry === undefined) {
      return { ok: false, code: 409, error: 'no seat can take a turn to read the order — sign a seat in from the System page' };
    }
    const seat = String(entry.key);
    // The run id IS the session id the launch names, so the frames are filtered on it from before
    // the launch: a fast run's terminal frame may land before `launchRun` resolves.
    const sessionId = randomUUID();
    let runId: string | undefined;
    let off: () => void = () => undefined;
    // Cleared in `finally`: an early return must not leave it armed.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let timedOut = false;
    try {
      let end: { ok: boolean } | null = null;
      // The step's own status, the latest the engine captured (read when the run has ended).
      let stepStatus: string | undefined;
      let wake: (() => void) | null = null;
      off = adapter.onEvent((e: CoreEvent) => {
        const ev = e as unknown as { type?: string; session?: string; stepStatus?: string };
        if (ev.session !== sessionId && (runId === undefined || ev.session !== runId)) return;
        if (ev.type === 'unitOutputCaptured' && typeof ev.stepStatus === 'string') stepStatus = ev.stepStatus;
        else if (end === null && (ev.type === 'sessionCompleted' || ev.type === 'sessionFailed' || ev.type === 'runCancelled')) {
          end = { ok: ev.type === 'sessionCompleted' };
          wake?.();
        }
      });
      // Inside the try: a project list that fails is the parse's 502, never an unhandled 500.
      const projects = adapter.projectsSupported()
        ? (await adapter.projectList()).map((p) => ({ id: p.id, name: p.name }))
        : [];
      // ONE deadline over the launch and the answer: a launch that hangs is the same 502.
      const deadline = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve('timeout');
          wake?.();
        }, timeoutMs);
      });
      const launch = adapter.launchRun({
        problem: "Read a standing order: turn the person's words into one rule.",
        sessionId,
        clisJson: JSON.stringify([entry]),
        primary: seat,
        plan: {
          steps: [{ catalog: 'understand', id: PARSE_STEP_ID, budget_secs: Math.max(1, Math.ceil(timeoutMs / 1000)), instructions: parsePrompt(text, projects) }],
          monitors: { asked: 0 },
        },
      });
      // A launch that resolves after the deadline must not outlive the parse.
      launch.then(
        (id) => {
          if (timedOut) void adapter.cancelRun(id).catch(() => undefined);
        },
        () => undefined,
      );
      let launched: string | 'timeout';
      try {
        launched = await Promise.race([launch, deadline]);
      } catch (err) {
        return { ok: false, code: 502, error: `the ${seat} seat could not open: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (launched === 'timeout') return { ok: false, code: 502, error: `the ${seat} seat did not answer in ${timeoutMs / 1000} s` };
      runId = launched;
      const id = launched;
      const ended = await new Promise<{ ok: boolean } | null>((resolve) => {
        wake = () => resolve(timedOut ? null : end);
        if (end !== null || timedOut) wake();
      });
      if (ended === null) return { ok: false, code: 502, error: `the ${seat} seat did not answer in ${timeoutMs / 1000} s` };
      settled = true;
      const answer = await adapter.workOutput(`${id}:${PARSE_STEP_ID}`).catch(() => null);
      // A failed step is a failure, whatever its text holds — never a rule to confirm (codex on #686).
      if (!ended.ok || answer === null || (stepStatus !== undefined && stepStatus !== 'ok')) {
        return { ok: false, code: 502, error: `the ${seat} seat's turn failed`, ...(answer !== null ? { answer } : {}) };
      }
      const rule = ruleFromAnswer(answer);
      if (rule === undefined) {
        return { ok: false, code: 422, error: 'the seat could not turn the words into a rule — try plainer words', answer };
      }
      return { ok: true, rule, seat };
    } catch (err) {
      return { ok: false, code: 502, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
      off();
      // A path that has not ended (the seat went quiet, or the launch hung past the deadline — the
      // run id is the session id it was launched under) must not outlive the parse.
      if (!settled && (runId !== undefined || timedOut)) await adapter.cancelRun(runId ?? sessionId).catch(() => undefined);
    }
  };
}
