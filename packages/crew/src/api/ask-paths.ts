/**
 * The daemon's record of each chat's ASK PATH (DES-ASK-TEAM-CHAT-001 §5.1): who was eligible when
 * the chat opened, the seat the operator chose (if any), and — once the first message launched it —
 * the run the conversation IS and the answer steps it has added. In memory, like the chat scope
 * index it sits beside: a chat is a session of this daemon; the run and its transcript are durable.
 *
 * Crew owns ELIGIBILITY and the launch COMMAND; the engine owns the PICK (`path.started.cli`,
 * `selection`) and every fact after it. `pa` here is what this daemon has seen of the engine's
 * pick (the relay fills it from `path.started`; a chosen seat is known at once).
 */
export interface AskPath {
  chatId: string;
  /** Seats admitted to the chat at open (signed in, not benched, allowed for the scope). */
  eligible: string[];
  /** The operator's choice, one of `eligible`; `undefined` ⇒ the engine picks at random. */
  primary?: string;
  /** The run the conversation is, once the first message launched it. */
  runId?: string;
  /** The first message is launching the run right now (a second one meanwhile is `turn_in_flight`). */
  launching?: boolean;
  /** The answer steps added so far (`answer-1`, `answer-2`, …). */
  steps: string[];
  /** The engine's pick as this daemon has seen it. */
  pa: string | null;
  selection: 'chosen' | 'random';
  reviewer: string | null;
  helpers: string[];
}

export class AskPathIndex {
  private readonly paths = new Map<string, AskPath>();

  /** Record an opened chat's eligibility and the operator's choice. */
  open(chatId: string, eligible: readonly string[], primary?: string): AskPath {
    const path: AskPath = {
      chatId,
      eligible: [...eligible],
      ...(primary !== undefined ? { primary } : {}),
      steps: [],
      // One eligible seat is a certain voice (the engine's random pick over a roster of one):
      // the turn index and the transcript can name it before `path.started` lands.
      pa: primary ?? (eligible.length === 1 ? eligible[0]! : null),
      selection: primary !== undefined ? 'chosen' : 'random',
      reviewer: null,
      helpers: [],
    };
    this.paths.set(chatId, path);
    return path;
  }

  get(chatId: string): AskPath | undefined {
    return this.paths.get(chatId);
  }

  /** The chat a run was launched from, if it is an ask path of this daemon. */
  chatOf(runId: string): string | undefined {
    for (const p of this.paths.values()) if (p.runId === runId) return p.chatId;
    return undefined;
  }

  /** The first message is launching the run: reserve the path until `started` / `launchFailed`. */
  launching(chatId: string): boolean {
    const p = this.paths.get(chatId);
    if (p === undefined || p.runId !== undefined || p.launching === true) return false;
    p.launching = true;
    return true;
  }

  launchFailed(chatId: string): void {
    const p = this.paths.get(chatId);
    if (p !== undefined) p.launching = false;
  }

  /** The first message launched the run; `stepId` is its answer step. */
  started(chatId: string, runId: string, stepId: string): void {
    const p = this.paths.get(chatId);
    if (p === undefined) return;
    p.launching = false;
    p.runId = runId;
    p.steps.push(stepId);
  }

  /** A later message added an answer step. Returns the new step id. */
  nextStep(chatId: string): string {
    const p = this.paths.get(chatId);
    const n = (p?.steps.length ?? 0) + 1;
    const stepId = `answer-${n}`;
    p?.steps.push(stepId);
    return stepId;
  }

  /** A re-seat: the named seats are eligible (a sign-in fixed). */
  admit(chatId: string, seats: readonly string[]): string[] {
    const p = this.paths.get(chatId);
    if (p === undefined) return [];
    for (const s of seats) if (!p.eligible.includes(s)) p.eligible.push(s);
    return [...p.eligible];
  }

  /** What the relay learned from the run's `path.started` / `member.joined` / `help.answered`. */
  observe(runId: string, fact: { pa?: string; selection?: 'chosen' | 'random'; reviewer?: string | null; helper?: string }): void {
    const chatId = this.chatOf(runId);
    const p = chatId !== undefined ? this.paths.get(chatId) : undefined;
    if (p === undefined) return;
    if (fact.pa !== undefined) p.pa = fact.pa;
    if (fact.selection !== undefined) p.selection = fact.selection;
    if (fact.reviewer !== undefined) p.reviewer = fact.reviewer;
    if (fact.helper !== undefined && !p.helpers.includes(fact.helper)) p.helpers.push(fact.helper);
  }

  close(chatId: string): AskPath | undefined {
    const p = this.paths.get(chatId);
    this.paths.delete(chatId);
    return p;
  }

  /** The wire view (`ChatDetailResponse.path`). */
  view(chatId: string): { runId: string; pa: string | null; selection: 'chosen' | 'random'; reviewer: string | null; helpers: string[]; stepId: string } | undefined {
    const p = this.paths.get(chatId);
    if (p?.runId === undefined) return undefined;
    return {
      runId: p.runId,
      pa: p.pa,
      selection: p.selection,
      reviewer: p.reviewer,
      helpers: [...p.helpers],
      stepId: p.steps[p.steps.length - 1] ?? 'answer-1',
    };
  }
}

/** The one answer step shape an ask adds per message (DES-ASK-TEAM-CHAT-001 §3, §4.4). */
export const ASK_TURN_BUDGET_SECS = 600;
export function answerStep(stepId: string, text: string): { catalog: string; id: string; [k: string]: unknown } {
  return {
    catalog: 'understand',
    id: stepId,
    gate: { human_confirm: { unconditional: true } },
    budget_secs: ASK_TURN_BUDGET_SECS,
    instructions: text,
  };
}
