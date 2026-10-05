/**
 * DES-ASK-TEAM-CHAT-001 §5.2 (ASK-C2) — the ask relay, crew's READ side of an ask path.
 *
 * After ASK-C1 an ask is a team run: the PA answers in an `understand` step `answer-N`, and the
 * engine publishes the run's unit frames (`unitOutputDelta`, `unitDone`) and team rows
 * (`wicked.team.*`) — none of them a chat frame. This relay is the ONE producer of chat frames for
 * a path: it folds the answer unit's `unitOutputDelta` into `chatDelta{chat, cliKey:<PA>}` (live
 * typing only) and emits one `chatReply{chat, cliKey:<PA>, text, ok, run_id, ord}` whose text is
 * the output the team row `step.completed{step_id:"answer-N"}.output_ref` names — read through the
 * engine's `work_output` at the FOLD (`unitDone{ord}`), not at the row (the row is published by
 * the worker before the actor folds; the record exists once the fold ran — §5.2 "when the text is
 * readable, verified"). Control lines (`HELP:`, `PLAN+`, `PLAN <id>:`, `ADVICE <id>:`, `STEP <id>:`,
 * `SCOPE`, `RISK`) are stripped from the displayed text (§4.7); a delta stream that disagrees with
 * the record is overwritten by it (the transcript's `seat` record is written from the reply).
 *
 * Every frame goes through the server's event fold (`fold`), so the turn index stamps `turn_id`,
 * the transcript persists the reply, the decision recorder and the citation verifier see what they
 * saw for a pool chat, and /ws fans it out — unchanged consumers (§5.2, codex #4). Crew publishes
 * no bus row (T2 §7 assertion 4). The relay is in-memory: a daemon restart forgets which run is
 * which chat (the ask-path index is in-memory too), so a path that outlives the daemon is read from
 * the run view, not relayed.
 */

import type { AskPathIndex } from './ask-paths.js';
import type { ChatTurnIndex } from './chat-turns.js';
import type { BusEvent } from '../core/bus.js';
import type { CoreEvent } from '../core/types.js';

/** A unit as the relay needs it (the run view's `WorkUnit`, narrowed). */
export interface RelayUnit {
  id: string;
  ord: number;
  status: string;
  assigned_cli: string | null;
}

export interface AskRelayDeps {
  paths: AskPathIndex;
  turns: ChatTurnIndex;
  /** `Core::work_output(unit_id)` — the stored output of an approved unit, `null` when none. */
  workOutput: (unitId: string) => Promise<string | null>;
  /** The run's units (the run view) — resolved once per (run, ord) and cached. */
  units: (runId: string) => Promise<RelayUnit[]>;
  /** Where frames go: the server's event fold (stamp → transcript → recorder → /ws). Not a bus
   *  publish — crew puts no row on the bus (tests/team-no-publish.test.ts). */
  fold: (frame: CoreEvent) => void;
  log?: (msg: string) => void;
}

/** The `step.completed` row's facts the reply needs. */
interface CompletedRow {
  stepId: string;
  status: string;
  outputRef: string;
}

/** `^` a control line of the team grammar (DES-TEAMING-002 §8.8; §4.7 of the ask design). */
const CONTROL_LINE = /^\s*(?:HELP:|PLAN\+|PLAN\s+\S+\s*:|ADVICE\s+\S+\s*:|STEP\s+\S+\s*:|SCOPE\b|RISK\b|DONE\s*$)/u;

/** The displayed text: every control line removed, surrounding blank lines trimmed. */
export function stripControlLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !CONTROL_LINE.test(line))
    .join('\n')
    .trim();
}

/** `unit:<run>:<ord>:<attempt>` → the ord, or `null` for any other shape. */
export function ordOfOutputRef(ref: string): number | null {
  const m = /^unit:(.+):(\d+):(\d+)$/u.exec(ref);
  if (m === null) return null;
  const ord = Number(m[2]);
  return Number.isInteger(ord) ? ord : null;
}

/** The step id an answer unit's id carries (`<run>:answer-N` → `answer-N`), or `null`. */
export function answerStepOf(runId: string, unitId: string): string | null {
  const prefix = `${runId}:`;
  if (!unitId.startsWith(prefix)) return null;
  const step = unitId.slice(prefix.length);
  return /^answer-\d+$/u.test(step) ? step : null;
}

export class AskRelay {
  /** run → ord → the `step.completed` row (the reply's text source and status). */
  private readonly rows = new Map<string, Map<number, CompletedRow>>();
  /** run → ord → the unit (id + seat), resolved lazily from the run view. */
  private readonly units = new Map<string, Map<number, RelayUnit | null>>();
  /** run → ords whose `unitDone` arrived before the row. */
  private readonly doneBeforeRow = new Map<string, Set<number>>();
  /** `${run}:${ord}` whose reply was emitted — exactly one per answer unit. */
  private readonly replied = new Set<string>();
  /** `${run}:${ord}` → the partial last line of the delta stream (a control line may split). */
  private readonly tails = new Map<string, string>();

  constructor(private readonly deps: AskRelayDeps) {}

  private log(msg: string): void {
    this.deps.log?.(msg);
  }

  /** A `teamEvent` frame's bus row (the team /ws relay hands every row here). */
  onTeamRow(row: BusEvent | undefined): void {
    if (row === undefined || typeof row.event_type !== 'string') return;
    const p = (row.payload ?? {}) as Record<string, unknown>;
    const runId = typeof p['run_id'] === 'string' ? p['run_id'] : undefined;
    if (runId === undefined) return;
    const chatId = this.deps.paths.chatOf(runId);
    if (chatId === undefined) return;
    switch (row.event_type) {
      case 'wicked.team.path.started': {
        const cli = typeof p['cli'] === 'string' ? p['cli'] : undefined;
        const selection = p['selection'] === 'chosen' ? 'chosen' : 'random';
        if (cli !== undefined) this.learnPa(runId, chatId, cli, selection);
        return;
      }
      case 'wicked.team.path.repicked': {
        const to = typeof p['to'] === 'string' ? p['to'] : undefined;
        if (to !== undefined) this.learnPa(runId, chatId, to, 'random');
        return;
      }
      case 'wicked.team.member.joined': {
        const seat = typeof p['seat'] === 'string' ? p['seat'] : null;
        const role = typeof p['role'] === 'string' ? p['role'] : '';
        if (role === 'monitor' || role === 'reviewer') this.deps.paths.observe(runId, { reviewer: seat });
        else if (role === 'helper' && seat !== null) this.deps.paths.observe(runId, { helper: seat });
        return;
      }
      case 'wicked.team.help.answered': {
        const by = typeof p['member'] === 'string' ? p['member'] : typeof p['seat'] === 'string' ? p['seat'] : undefined;
        if (by !== undefined) this.deps.paths.observe(runId, { helper: by });
        return;
      }
      case 'wicked.team.step.completed': {
        const stepId = typeof p['step_id'] === 'string' ? p['step_id'] : undefined;
        const outputRef = typeof p['output_ref'] === 'string' ? p['output_ref'] : undefined;
        const status = typeof p['status'] === 'string' ? p['status'] : 'ok';
        if (stepId === undefined || outputRef === undefined || !/^answer-\d+$/u.test(stepId)) return;
        const ord = ordOfOutputRef(outputRef);
        if (ord === null) return;
        let byOrd = this.rows.get(runId);
        if (byOrd === undefined) {
          byOrd = new Map();
          this.rows.set(runId, byOrd);
        }
        byOrd.set(ord, { stepId, status, outputRef });
        // The fold already ran (the row came late on the poll): the reply is due now.
        if (this.doneBeforeRow.get(runId)?.delete(ord) === true) void this.reply(runId, chatId, ord);
        return;
      }
      default:
        return;
    }
  }

  /** A CoreEvent of the engine's stream — only `unitOutputDelta` / `unitDone` are read. */
  async onCoreEvent(event: CoreEvent): Promise<void> {
    if (event.type !== 'unitOutputDelta' && event.type !== 'unitDone') return;
    const f = event as CoreEvent & Record<string, unknown>;
    const runId = typeof f['session'] === 'string' ? f['session'] : undefined;
    const ord = typeof f['ord'] === 'number' ? f['ord'] : undefined;
    if (runId === undefined || ord === undefined) return;
    const chatId = this.deps.paths.chatOf(runId);
    if (chatId === undefined) return;
    const unit = await this.unit(runId, ord);
    if (unit === null || answerStepOf(runId, unit.id) === null) return; // not the PA's answer: no chat frame
    const pa = this.paOf(runId, chatId, unit);
    if (event.type === 'unitOutputDelta') {
      const text = typeof f['text'] === 'string' ? f['text'] : '';
      const shown = this.deltaText(`${runId}:${ord}`, text);
      if (shown !== '') this.deps.fold({ type: 'chatDelta', chat: chatId, cliKey: pa, text: shown } as CoreEvent);
      return;
    }
    // `unitDone`: the record exists now (the same fold wrote it). The text is the row's.
    this.tails.delete(`${runId}:${ord}`);
    if (this.rows.get(runId)?.has(ord) === true) await this.reply(runId, chatId, ord);
    else {
      let pending = this.doneBeforeRow.get(runId);
      if (pending === undefined) {
        pending = new Set();
        this.doneBeforeRow.set(runId, pending);
      }
      pending.add(ord);
    }
  }

  /** Forget a run (its chat closed). */
  forget(runId: string): void {
    this.rows.delete(runId);
    this.units.delete(runId);
    this.doneBeforeRow.delete(runId);
    for (const key of [...this.tails.keys()]) if (key.startsWith(`${runId}:`)) this.tails.delete(key);
  }

  private learnPa(runId: string, chatId: string, cli: string, selection: 'chosen' | 'random'): void {
    this.deps.paths.observe(runId, { pa: cli, selection });
    // The turn was reserved for the eligible roster (a random pick names nobody at send time):
    // narrow it to the voice, so the PA's frames are stamped and nobody else is "pending".
    for (const turn of this.deps.turns.turnsOf(chatId)) {
      if (!turn.seats.includes(cli) || turn.seats.length > 1) this.deps.turns.reconcile(chatId, turn.turnId, [cli]);
    }
  }

  private paOf(runId: string, chatId: string, unit: RelayUnit): string {
    const path = this.deps.paths.get(chatId);
    if (unit.assigned_cli !== null) {
      if (path !== undefined && path.pa !== unit.assigned_cli) this.learnPa(runId, chatId, unit.assigned_cli, path.selection);
      return unit.assigned_cli;
    }
    return path?.pa ?? 'pa';
  }

  private async unit(runId: string, ord: number): Promise<RelayUnit | null> {
    let byOrd = this.units.get(runId);
    if (byOrd === undefined) {
      byOrd = new Map();
      this.units.set(runId, byOrd);
    }
    const cached = byOrd.get(ord);
    // A unit with no seat yet is re-read (the seat is assigned at dispatch).
    if (cached !== undefined && (cached === null || cached.assigned_cli !== null)) return cached;
    let found: RelayUnit | null = null;
    try {
      found = (await this.deps.units(runId)).find((u) => u.ord === ord) ?? null;
    } catch (err) {
      this.log(`[ask-relay] cannot read the units of ${runId}: ${err instanceof Error ? err.message : String(err)}`);
      return cached ?? null;
    }
    byOrd.set(ord, found);
    return found;
  }

  /** The complete lines of the stream so far, control lines removed; the partial tail is held. */
  private deltaText(key: string, chunk: string): string {
    const buf = (this.tails.get(key) ?? '') + chunk;
    const nl = buf.lastIndexOf('\n');
    if (nl === -1) {
      this.tails.set(key, buf);
      return '';
    }
    this.tails.set(key, buf.slice(nl + 1));
    const lines = buf.slice(0, nl).split('\n').filter((l) => !CONTROL_LINE.test(l));
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  }

  private async reply(runId: string, chatId: string, ord: number): Promise<void> {
    const key = `${runId}:${ord}`;
    if (this.replied.has(key)) return;
    const row = this.rows.get(runId)?.get(ord);
    const unit = await this.unit(runId, ord);
    if (row === undefined || unit === null) return;
    this.replied.add(key);
    const pa = this.paOf(runId, chatId, unit);
    let text: string | null = null;
    try {
      text = await this.deps.workOutput(unit.id);
    } catch (err) {
      this.log(`[ask-relay] work_output(${unit.id}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const ok = row.status === 'ok' && text !== null;
    const shown =
      text !== null
        ? stripControlLines(text)
        : `${pa} did not answer (${row.status}): the engine stored no output for ${row.stepId}`;
    this.deps.fold({
      type: 'chatReply',
      chat: chatId,
      cliKey: pa,
      text: shown,
      ok,
      run_id: runId,
      ord,
    } as CoreEvent);
  }
}
