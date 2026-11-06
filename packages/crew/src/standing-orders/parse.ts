/**
 * Standing orders — the seat's parse of plain words into a rule (behaviour 10).
 *
 * ONE seat, ONE step (DES-ASK-TEAM-CHAT-001 §10 ASK-C4): a one-step team path — a user-composed
 * plan of one `understand` step carrying the prompt, `primary` = the chosen seat, `monitors.asked:0`
 * (nobody reviews a parse) — launched on the run engine, never the warm chat pool. The step's
 * stored output (`work_output(<run>:parse-1)`) is the answer once the run's terminal frame arrives;
 * a run that does not end in time is cancelled. The answer is a proposal the person confirms — crew
 * stores only the confirmed rule — so a seat that answers badly costs a retry, never a wrong order.
 *
 * {@link seatTurn} is that one-shot on its own (crew's smallest path to one seat's one answer, no
 * chat history, no repository); the parse and the data-source ask (`sources/ask.ts`) both use it.
 *
 * The step declares `answer_only` (crew#1311, wicked-core): its output is an answer crew reads, not
 * work a later step builds on, so the engine's substance floor asks only that an answer exists. A
 * correct short answer (a 192-character drafted query) used to fail the floor's 200 characters.
 * And a run that parks for a human ends the turn at once: nobody sees a one-shot turn's gate.
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

export type SeatTurnDeps = Omit<SeatParserDeps, 'adapter'> & {
  adapter: Pick<CoreAdapter, 'launchRun' | 'cancelRun' | 'workOutput' | 'onEvent'>;
  /** (DES-CATALOG-002 §2.3) The answer of a turn launched under a registered `workflow` (its one unit's output: the
   *  engine names a def's units, so crew reads the run). Required for a {@link SeatTurnInput.workflow} turn. */
  outputOf?: (runId: string) => Promise<string | null>;
  /** Pick the seat: the roster's first unscoped-chat seat by default. */
  pickSeat?: (roster: RosterSeat[]) => RosterSeat | undefined;
};

/** One seat's one turn: its answer text, or why there is none (`409` no seat, `502` it failed or went quiet). */
export type SeatTurnOutcome = { ok: true; answer: string; seat: string } | { ok: false; code: 409 | 502; error: string; answer?: string };

export interface SeatTurnInput {
  /** The run's problem line (what the runs list shows). */
  problem: string;
  /** The step's instructions, or a builder run once the turn is armed (its failure is the turn's 502). */
  instructions: string | (() => Promise<string>);
  stepId: string;
  /** What the person is told when no seat can take the turn. */
  noSeat: string;
  /**
   * (DES-CATALOG-002 §2.3) Launch under this registered workflow (a system def whose identity is its capability fence,
   * `detect-shape`) instead of an inline one-step plan: `instructions` is then the run's problem (the def's phase
   * carries its own instructions), and `stepId` is the def's phase id.
   */
  workflow?: string;
  /** The run id to launch under (default a fresh one): a caller that must know it before the launch (a fence, a
   *  cancel) passes its own. */
  sessionId?: string;
  /** Called with the run id once the launch is armed (before it resolves), so a newer request can cancel it. */
  onRun?: (runId: string) => void;
}

/**
 * ONE seat, ONE `understand` step on the run engine (never the warm chat pool): the step's stored
 * output is the answer once the run ends; one deadline covers the launch and the answer, and a run
 * that has not ended by then is cancelled. A run that parks for a human has not ended either, and
 * nobody can answer a one-shot turn's gate: the turn ends at once and the run is cancelled.
 */
export function seatTurn(deps: SeatTurnDeps): (input: SeatTurnInput) => Promise<SeatTurnOutcome> {
  const { adapter } = deps;
  const timeoutMs = deps.timeoutMs ?? 120_000;
  return async (input) => {
    const entry = (deps.pickSeat ?? chatSeat)(deps.roster());
    if (entry === undefined) {
      return { ok: false, code: 409, error: input.noSeat };
    }
    const seat = String(entry.key);
    // The run id IS the session id the launch names, so the frames are filtered on it from before
    // the launch: a fast run's terminal frame may land before `launchRun` resolves.
    const sessionId = input.sessionId ?? randomUUID();
    let runId: string | undefined;
    let off: () => void = () => undefined;
    // Cleared in `finally`: an early return must not leave it armed.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let deadlineAt = Date.now() + timeoutMs;
    // How the run's turn came out, the first frame that decides it: a terminal frame, or a park
    // (`parked`: the run stopped at a gate and has NOT ended).
    type TurnEnd = { ok: boolean; parked?: true };
    let end: TurnEnd | null = null;
    // The run reached a terminal frame (also after a park): there is nothing left to cancel.
    let runEnded = false;
    const parked = (): boolean => end?.parked === true;
    try {
      // The step's own status, the latest the engine captured (read when the run has ended).
      let stepStatus: string | undefined;
      // The engine's kind for the step's failure (`substanceRejected`, `workerError`, …). Never its
      // `detail`: for a worker error that is the seat's raw output, which the person must not see.
      let failureKind: string | undefined;
      // Resolves once: the turn's end, or `null` at the deadline.
      let decide: (v: TurnEnd | null) => void = () => undefined;
      const decided = new Promise<TurnEnd | null>((resolve) => {
        decide = resolve;
      });
      // Resolves at the deadline or a park, never at a terminal frame: what may end the turn while the
      // launch is still pending (an early terminal frame must not disarm the deadline, codex r2).
      let stop: () => void = () => undefined;
      const stopped = new Promise<null>((resolve) => {
        stop = () => resolve(null);
      });
      off = adapter.onEvent((e: CoreEvent) => {
        const ev = e as unknown as { type?: string; session?: string; stepStatus?: string; failureKind?: string };
        if (ev.session !== sessionId && (runId === undefined || ev.session !== runId)) return;
        if (ev.type === 'unitOutputCaptured' && typeof ev.stepStatus === 'string') stepStatus = ev.stepStatus;
        else if (ev.type === 'stepFailed' && typeof ev.failureKind === 'string') failureKind = ev.failureKind;
        else if (ev.type === 'sessionCompleted' || ev.type === 'sessionFailed' || ev.type === 'runCancelled') {
          runEnded = true;
          if (end === null) {
            end = { ok: ev.type === 'sessionCompleted' };
            decide(end);
          }
        } else if (ev.type === 'awaitingHuman' && end === null) {
          // Waiting out the deadline would only turn "the step failed" into "the seat did not
          // answer" (crew#1311).
          end = { ok: false, parked: true };
          decide(end);
          stop();
        }
      });
      // Inside the try: instructions that fail to build (a project list) are the turn's 502, never an unhandled 500.
      const instructions = typeof input.instructions === 'string' ? input.instructions : await input.instructions();
      // ONE deadline over the launch and the answer: a launch that hangs is the same 502.
      deadlineAt = Date.now() + timeoutMs;
      timer = setTimeout(() => {
        timedOut = true;
        decide(null);
        stop();
      }, timeoutMs);
      input.onRun?.(sessionId);
      const launch = input.workflow !== undefined
        // A registered def: its phase carries the instructions, so the turn's own text is the run's task.
        ? adapter.launchRun({ problem: instructions, sessionId, clisJson: JSON.stringify([entry]), primary: seat, workflow: input.workflow })
        : adapter.launchRun({
          problem: input.problem,
          sessionId,
          clisJson: JSON.stringify([entry]),
          primary: seat,
          plan: {
            // `answer_only`: the turn's one step is its last, runs no code, and crew reads its answer.
            steps: [{ catalog: 'understand', id: input.stepId, budget_secs: Math.max(1, Math.ceil(timeoutMs / 1000)), instructions, answer_only: true }],
            monitors: { asked: 0 },
          },
        });
      // A launch that resolves after the turn gave up (the deadline, or a park) must not outlive it.
      launch.then(
        (id) => {
          if ((timedOut || parked()) && !runEnded) void adapter.cancelRun(id).catch(() => undefined);
        },
        () => undefined,
      );
      const parkedMessage = (): string =>
        `the ${seat} seat's turn failed (${failureKind ?? 'it stopped for a decision'})`;
      let launched: string | null;
      try {
        // The deadline or a park ends the turn even while the launch is pending; a terminal frame
        // waits for the launch, which names the run (and the deadline still bounds that wait).
        launched = await Promise.race([launch, stopped]);
      } catch (err) {
        return { ok: false, code: 502, error: `the ${seat} seat could not open: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (launched === null) {
        return timedOut ? { ok: false, code: 502, error: `the ${seat} seat did not answer in ${timeoutMs / 1000} s` } : { ok: false, code: 502, error: parkedMessage() };
      }
      runId = launched;
      const id = launched;
      const ended = await decided;
      if (ended === null) return { ok: false, code: 502, error: `the ${seat} seat did not answer in ${timeoutMs / 1000} s` };
      // A parked turn's answer is not read: it is a failure, and the read must not hold the cancel.
      if (ended.parked === true) return { ok: false, code: 502, error: parkedMessage() };
      // The answer's read is inside the same deadline (at least a second for a fast local read): a stalled read is the
      // turn's failure, never a hang past its budget (codex r1 on DES-CATALOG-002 Lane D).
      const read = input.workflow !== undefined
        ? (deps.outputOf?.(id) ?? Promise.resolve(null)).catch(() => null)
        : adapter.workOutput(`${id}:${input.stepId}`).catch(() => null);
      let readTimer: ReturnType<typeof setTimeout> | undefined;
      const answer = await Promise.race([
        read,
        new Promise<null>((resolve) => {
          readTimer = setTimeout(() => resolve(null), Math.max(1000, deadlineAt - Date.now()));
        }),
      ]).finally(() => clearTimeout(readTimer));
      // A failed step is a failure, whatever its text holds — never a rule to confirm (codex on #686).
      if (!ended.ok || answer === null || (stepStatus !== undefined && stepStatus !== 'ok')) {
        const why = failureKind !== undefined ? ` (${failureKind})` : '';
        return { ok: false, code: 502, error: `the ${seat} seat's turn failed${why}`, ...(answer !== null ? { answer } : {}) };
      }
      return { ok: true, answer, seat };
    } catch (err) {
      return { ok: false, code: 502, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
      off();
      // A run that has not ended (the seat went quiet, it parked, or the launch hung past the
      // deadline — the run id is the session id it was launched under) must not outlive the turn.
      // The cancel is bounded too: the turn answers within its budget, and the cancel goes on without it.
      if (!runEnded && (runId !== undefined || timedOut || parked())) {
        let cancelTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          adapter.cancelRun(runId ?? sessionId).catch(() => undefined),
          new Promise<void>((resolve) => {
            cancelTimer = setTimeout(resolve, 5000);
          }),
        ]).finally(() => clearTimeout(cancelTimer));
      }
    }
  };
}

export function seatParser(deps: SeatParserDeps): (text: string) => Promise<ParseOutcome> {
  const { adapter } = deps;
  const turn = seatTurn(deps);
  return async (text) => {
    const out = await turn({
      problem: "Read a standing order: turn the person's words into one rule.",
      stepId: PARSE_STEP_ID,
      noSeat: 'no seat can take a turn to read the order — sign a seat in from the Agents page',
      instructions: async () => {
        const projects = adapter.projectsSupported()
          ? (await adapter.projectList()).map((p) => ({ id: p.id, name: p.name }))
          : [];
        return parsePrompt(text, projects);
      },
    });
    if (!out.ok) return out;
    const rule = ruleFromAnswer(out.answer);
    if (rule === undefined) {
      return { ok: false, code: 422, error: 'the seat could not turn the words into a rule — try plainer words', answer: out.answer };
    }
    return { ok: true, rule, seat: out.seat };
  };
}
