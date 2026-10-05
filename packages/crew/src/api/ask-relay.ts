/**
 * DES-ASK-TEAM-CHAT-001 §5.2 (ASK-C2) — the ask relay, crew's READ side of an ask path.
 *
 * After ASK-C1 an ask is a team run: the PA answers in an `understand` step `answer-N`, and the
 * engine publishes the run's unit frames (`unitDispatched`, `unitOutputDelta`, `unitOutputCaptured`,
 * `unitDone`, …) and team rows (`wicked.team.*`) — none of them a chat frame. This relay is the ONE
 * producer of chat frames for a path: it folds the answer unit's `unitOutputDelta` into
 * `chatDelta{chat, cliKey:<PA>}` (live typing only) and folds one `chatReply{chat, cliKey:<PA>, text,
 * ok, run_id, ord}` per answer unit whose text is the output the team row
 * `step.completed{step_id:"answer-N"}.output_ref` names — read through the engine's `work_output` at
 * the FOLD (`unitDone{ord}`), not at the row (the row is published by the worker before the actor
 * folds; the record exists once the fold ran — §5.2 "when the text is readable, verified").
 *
 * The join is by ATTEMPT (codex on #810 r1, 2): `output_ref` is `unit:<run>:<ord>:<attempt>`, and the
 * attempt the fold settles is the latest the engine dispatched for that ord (`unitDispatched`,
 * `unitOutputDelta`, `unitOutputCaptured` all carry it) — a failed attempt's row never decides a
 * successful retry. A fold whose row has not arrived (the bus poll is 2 s) waits for it; past
 * `rowGraceMs` the reply is read from the record anyway, with `ok` from the engine's own
 * `unitOutputCaptured.stepStatus` — the un-teamed run of §8 F7 publishes no team row at all, and its
 * answer still arrives (r1, 5). A RUN-terminal frame with no fold (`sessionFailed{ord}`,
 * `runCancelled`) ends the turn with `ok:false` (r1, 6); `stepFailed` / `unitDenied` are NOT
 * terminal — the engine fails over (a re-pick re-dispatches the ord, §8 F2) or opens an escalation
 * gate whose Approve re-dispatches it, and a failed run says so with `sessionFailed` (r2, 1).
 *
 * The PA: the team rows (`path.started`, `path.repicked`) are authoritative; the unit's assigned seat
 * is the fallback while none has arrived, and the unit record is re-read on every new attempt (a
 * re-pick re-dispatches the same ord on another seat — r1, 1). Control lines (`HELP:`, `PLAN+`,
 * `PLAN <id>:`, `ADVICE <id>:`, `STEP <id>:`, `SCOPE`, `RISK`) are stripped from the displayed text
 * (§4.7); a delta stream that disagrees with the record is overwritten by it (the transcript's
 * `seat` record is written from the reply).
 *
 * Every frame goes through the server's event fold (`fold`), so the turn index stamps `turn_id`, the
 * transcript persists the reply, the decision recorder and the citation verifier see what they saw
 * for a pool chat, and /ws fans it out — unchanged consumers (§5.2, codex #4). Every await is
 * followed by a re-check that the run still belongs to the chat (End forgets it — r1, 4). Crew
 * publishes no bus row (T2 §7 assertion 4). The relay is in-memory: a daemon restart forgets which
 * run is which chat (the ask-path index is in-memory too), so a path that outlives the daemon is
 * read from the run view, not relayed.
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
  /** The run's units (the run view) — resolved per (run, ord, attempt) and cached. */
  units: (runId: string) => Promise<RelayUnit[]>;
  /** Where frames go: the server's event fold (stamp → transcript → recorder → /ws). Not a bus
   *  publish — crew puts no row on the bus (tests/team-no-publish.test.ts). */
  fold: (frame: CoreEvent) => void;
  /** The voice of a turn was learned (a random pick, a re-pick): the decision recorder's audience
   *  follows the turn index's (r1, 7). */
  recorderReconcile?: (chat: string, turnId: string, seats: readonly string[]) => void;
  /** How long a fold waits for its `step.completed` row before the reply is read from the record
   *  anyway (the un-teamed run publishes none). Default 5 s. */
  rowGraceMs?: number;
  log?: (msg: string) => void;
}

/** The `step.completed` row's facts the reply needs. */
interface CompletedRow {
  stepId: string;
  status: string;
  attempt: number;
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

/** `unit:<run>:<ord>:<attempt>` → `{ord, attempt}`, or `null` for any other shape. */
export function refOf(ref: string): { ord: number; attempt: number } | null {
  const m = /^unit:(.+):(\d+):(\d+)$/u.exec(ref);
  if (m === null) return null;
  const ord = Number(m[2]);
  const attempt = Number(m[3]);
  return Number.isInteger(ord) && Number.isInteger(attempt) ? { ord, attempt } : null;
}

/** `unit:<run>:<ord>:<attempt>` → the ord, or `null` for any other shape. */
export function ordOfOutputRef(ref: string): number | null {
  return refOf(ref)?.ord ?? null;
}

/** The step id an answer unit's id carries (`<run>:answer-N` → `answer-N`), or `null`. */
export function answerStepOf(runId: string, unitId: string): string | null {
  const prefix = `${runId}:`;
  if (!unitId.startsWith(prefix)) return null;
  const step = unitId.slice(prefix.length);
  return /^answer-\d+$/u.test(step) ? step : null;
}

/** The frames the relay reads, besides the team rows. */
const UNIT_FRAMES: ReadonlySet<string> = new Set([
  'unitDispatched',
  'unitOutputDelta',
  'unitOutputCaptured',
  'unitDone',
  'stepFailed',
  'unitDenied',
  'sessionFailed',
  'runCancelled',
]);

interface Pending {
  timer: ReturnType<typeof setTimeout>;
}

export class AskRelay {
  /** run → ord → attempt → the `step.completed` row. */
  private readonly rows = new Map<string, Map<number, Map<number, CompletedRow>>>();
  /** run → ord → the latest attempt the engine dispatched / streamed / captured. */
  private readonly attempts = new Map<string, Map<number, number>>();
  /** run → ord → the engine's own status of the latest captured attempt (`unitOutputCaptured`). */
  private readonly captured = new Map<string, Map<number, { attempt: number; stepStatus: string }>>();
  /** run → ord → the unit (id + seat), resolved lazily from the run view; re-read per attempt. */
  private readonly units = new Map<string, Map<number, RelayUnit | null>>();
  /** `${run}:${ord}` → a fold waiting for its row (bounded by `rowGraceMs`). */
  private readonly waiting = new Map<string, Pending>();
  /** `${run}:${ord}` whose reply went out (or is going out) — exactly one per answer unit. */
  private readonly replied = new Set<string>();
  /** `${run}:${ord}` → the partial last line of the delta stream (a control line may split). */
  private readonly tails = new Map<string, string>();
  private readonly rowGraceMs: number;

  constructor(private readonly deps: AskRelayDeps) {
    this.rowGraceMs = deps.rowGraceMs ?? 5_000;
  }

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
        // The same ord is re-dispatched on another seat: every cached unit of the run is stale.
        this.units.delete(runId);
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
        const ref = refOf(outputRef);
        if (ref === null) return;
        this.nested(this.rows, runId, ref.ord).set(ref.attempt, { stepId, status, attempt: ref.attempt });
        this.noteAttempt(runId, ref.ord, ref.attempt); // one monotonic boundary across rows and frames (r3, 1)
        // A fold is waiting for this very row (the row came late on the poll): the reply is due.
        const key = `${runId}:${ref.ord}`;
        if (this.waiting.has(key) && ref.attempt >= this.attemptOf(runId, ref.ord)) {
          this.stopWaiting(key);
          void this.reply(runId, chatId, ref.ord, 'row');
        }
        return;
      }
      default:
        return;
    }
  }

  /** A CoreEvent of the engine's stream — only the unit / terminal frames are read. */
  async onCoreEvent(event: CoreEvent): Promise<void> {
    if (!UNIT_FRAMES.has(event.type)) return;
    const f = event as CoreEvent & Record<string, unknown>;
    const runId = typeof f['session'] === 'string' ? f['session'] : undefined;
    if (runId === undefined) return;
    const chatId = this.deps.paths.chatOf(runId);
    if (chatId === undefined) return;
    if (event.type === 'runCancelled') {
      await this.terminal(runId, chatId, undefined, 'the run was cancelled');
      return;
    }
    const ord = typeof f['ord'] === 'number' ? f['ord'] : undefined;
    if (ord === undefined) return;
    const attempt = typeof f['attempt'] === 'number' ? f['attempt'] : undefined;
    if (attempt !== undefined) this.noteAttempt(runId, ord, attempt);
    if (event.type === 'unitDispatched') return; // the attempt is noted; the seat is re-read on use
    // A straggler of a superseded attempt (the engine drains a replaced worker's buffered output
    // with its original label): not the voice any more (r2, 2).
    if (attempt !== undefined && attempt < this.attemptOf(runId, ord)) return;
    if (event.type === 'unitOutputCaptured') {
      const stepStatus = typeof f['stepStatus'] === 'string' ? f['stepStatus'] : 'ok';
      this.nestedOne(this.captured, runId).set(ord, { attempt: attempt ?? this.attemptOf(runId, ord), stepStatus });
      return;
    }
    if (event.type === 'stepFailed' || event.type === 'unitDenied') {
      // An ATTEMPT ended badly — not the answer's end: the engine fails over to another seat
      // (`path.repicked` + attempt+1) or opens an escalation gate whose Approve re-dispatches the
      // ord; a run that gives up says so with `sessionFailed`. The stream of this attempt is over.
      this.tails.delete(`${runId}:${ord}`);
      return;
    }
    if (event.type === 'sessionFailed') {
      await this.terminal(runId, chatId, ord, 'the run failed at this step');
      return;
    }
    const unit = await this.unit(runId, ord);
    if (this.deps.paths.chatOf(runId) !== chatId) return; // ended meanwhile (r1, 4)
    if (unit === null || answerStepOf(runId, unit.id) === null) return; // not the PA's answer: no chat frame
    // Superseded during the await: neither streamed nor allowed to name the PA (r3, 2).
    if (attempt !== undefined && attempt < this.attemptOf(runId, ord)) return;
    const pa = this.paOf(runId, chatId, unit);
    if (event.type === 'unitOutputDelta') {
      const text = typeof f['text'] === 'string' ? f['text'] : '';
      const shown = this.deltaText(`${runId}:${ord}`, text);
      if (shown !== '') this.deps.fold({ type: 'chatDelta', chat: chatId, cliKey: pa, text: shown } as CoreEvent);
      return;
    }
    // `unitDone`: the record exists now (the same fold wrote it). The text is the row's — the row
    // of THIS attempt; a late row is waited for, bounded.
    this.tails.delete(`${runId}:${ord}`);
    const key = `${runId}:${ord}`;
    if (this.replied.has(key)) return;
    if (this.rowFor(runId, ord) !== undefined) {
      await this.reply(runId, chatId, ord, 'fold');
      return;
    }
    if (this.waiting.has(key)) return;
    const timer = setTimeout(() => {
      this.waiting.delete(key);
      if (this.deps.paths.chatOf(runId) !== chatId) return;
      this.log(`[ask-relay] ${key}: no step.completed row within ${this.rowGraceMs} ms — answering from the record (un-teamed run?)`);
      void this.reply(runId, chatId, ord, 'grace');
    }, this.rowGraceMs);
    timer.unref?.();
    this.waiting.set(key, { timer });
  }

  /** Forget a run (its chat closed). */
  forget(runId: string): void {
    this.rows.delete(runId);
    this.attempts.delete(runId);
    this.captured.delete(runId);
    this.units.delete(runId);
    const prefix = `${runId}:`;
    for (const key of [...this.waiting.keys()]) if (key.startsWith(prefix)) this.stopWaiting(key);
    for (const key of [...this.tails.keys()]) if (key.startsWith(prefix)) this.tails.delete(key);
    for (const key of [...this.replied]) if (key.startsWith(prefix)) this.replied.delete(key);
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────

  private nested<T>(map: Map<string, Map<number, Map<number, T>>>, runId: string, ord: number): Map<number, T> {
    let byOrd = map.get(runId);
    if (byOrd === undefined) {
      byOrd = new Map();
      map.set(runId, byOrd);
    }
    let byAttempt = byOrd.get(ord);
    if (byAttempt === undefined) {
      byAttempt = new Map();
      byOrd.set(ord, byAttempt);
    }
    return byAttempt;
  }

  private nestedOne<T>(map: Map<string, Map<number, T>>, runId: string): Map<number, T> {
    let byOrd = map.get(runId);
    if (byOrd === undefined) {
      byOrd = new Map();
      map.set(runId, byOrd);
    }
    return byOrd;
  }

  private noteAttempt(runId: string, ord: number, attempt: number): void {
    const byOrd = this.nestedOne(this.attempts, runId);
    const prev = byOrd.get(ord);
    if (prev === undefined || attempt > prev) {
      byOrd.set(ord, attempt);
      // A new attempt may sit on another seat (a re-pick): the cached unit is stale, and the
      // previous attempt's partial line must not complete a line of this one (r2, 2).
      if (prev !== undefined) {
        this.units.get(runId)?.delete(ord);
        this.tails.delete(`${runId}:${ord}`);
      }
    }
  }

  /** The attempt the fold settles for (run, ord): the latest the engine's frames OR the team rows
   *  named — one monotonic boundary (r3, 1) — else 1. */
  private attemptOf(runId: string, ord: number): number {
    const seen = this.attempts.get(runId)?.get(ord) ?? 0;
    const rows = this.rows.get(runId)?.get(ord);
    const fromRows = rows !== undefined && rows.size > 0 ? Math.max(...rows.keys()) : 0;
    return Math.max(seen, fromRows, 1);
  }

  private rowFor(runId: string, ord: number): CompletedRow | undefined {
    return this.rows.get(runId)?.get(ord)?.get(this.attemptOf(runId, ord));
  }

  private stopWaiting(key: string): void {
    const w = this.waiting.get(key);
    if (w !== undefined) clearTimeout(w.timer);
    this.waiting.delete(key);
  }

  private learnPa(runId: string, chatId: string, cli: string, selection: 'chosen' | 'random'): void {
    this.deps.paths.observe(runId, { pa: cli, selection });
    // The turn was reserved for the eligible roster (a random pick names nobody at send time):
    // narrow it to the voice, so the PA's frames are stamped and nobody else is "pending". The
    // decision recorder's audience follows (r1, 7).
    for (const turn of this.deps.turns.turnsOf(chatId)) {
      if (!turn.seats.includes(cli) || turn.seats.length > 1) this.deps.turns.reconcile(chatId, turn.turnId, [cli]);
      // Always told (idempotent): the recorder's turn may be created after this (the route
      // records an accepted send after its engine awaits) and then reads the turn index (r2, 3).
      this.deps.recorderReconcile?.(chatId, turn.turnId, [cli]);
    }
  }

  /** The PA: the team rows are authoritative; the unit's seat stands in until one has named it. */
  private paOf(runId: string, chatId: string, unit: RelayUnit): string {
    const path = this.deps.paths.get(chatId);
    if (path !== undefined && path.pa !== null) return path.pa;
    if (unit.assigned_cli !== null) {
      this.learnPa(runId, chatId, unit.assigned_cli, path?.selection ?? 'random');
      return unit.assigned_cli;
    }
    return 'pa';
  }

  private async unit(runId: string, ord: number): Promise<RelayUnit | null> {
    const byOrd = this.nestedOne(this.units, runId);
    const cached = byOrd.get(ord);
    // A unit with no seat yet is re-read (the seat is assigned at dispatch).
    if (cached !== undefined && (cached === null || cached.assigned_cli !== null)) return cached;
    const startedUnder = this.attemptOf(runId, ord);
    let found: RelayUnit | null = null;
    try {
      found = (await this.deps.units(runId)).find((u) => u.ord === ord) ?? null;
    } catch (err) {
      this.log(`[ask-relay] cannot read the units of ${runId}: ${err instanceof Error ? err.message : String(err)}`);
      return cached ?? null;
    }
    // Not found: not cached (the unit may be planned later — a continuation adds answer-N). A run
    // forgotten during the read (End) stays forgotten (r2, 4); a read that started under an attempt
    // the engine has since superseded is not cached either — it may name the old seat (r3, 2).
    if (found !== null && this.units.has(runId) && this.attemptOf(runId, ord) === startedUnder) {
      this.nestedOne(this.units, runId).set(ord, found);
    }
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

  /** ONE reply per answer unit: the key is reserved before the first await (r1, 8). */
  private async reply(runId: string, chatId: string, ord: number, via: 'fold' | 'row' | 'grace'): Promise<void> {
    const key = `${runId}:${ord}`;
    if (this.replied.has(key)) return;
    this.replied.add(key);
    const unit = await this.unit(runId, ord);
    if (this.deps.paths.chatOf(runId) !== chatId) return; // ended meanwhile: nothing lands on a reuse
    if (unit === null) {
      this.replied.delete(key); // nothing went out: a later fold may still answer
      return;
    }
    const pa = this.paOf(runId, chatId, unit);
    const row = this.rowFor(runId, ord);
    const capturedStatus = this.captured.get(runId)?.get(ord)?.stepStatus;
    let text: string | null = null;
    try {
      text = await this.deps.workOutput(unit.id);
    } catch (err) {
      this.log(`[ask-relay] work_output(${unit.id}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.deps.paths.chatOf(runId) !== chatId) return; // r1, 4
    const status = row?.status ?? capturedStatus ?? (text !== null ? 'ok' : 'failed');
    const ok = status === 'ok' && text !== null;
    const stepId = row?.stepId ?? answerStepOf(runId, unit.id) ?? `answer (ord ${ord})`;
    const shown =
      text !== null ? stripControlLines(text) : `${pa} did not answer (${status}): the engine stored no output for ${stepId}`;
    if (via === 'grace') this.log(`[ask-relay] ${key}: replied from the record without a team row (status ${status})`);
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

  /** A terminal frame with no fold: the answer unit(s) still pending end the turn with `ok:false`. */
  private async terminal(runId: string, chatId: string, ord: number | undefined, why: string): Promise<void> {
    let targets: number[];
    if (ord !== undefined) targets = [ord];
    else {
      // The run ended: every answer unit of the run that has not replied.
      let all: RelayUnit[] = [];
      try {
        all = await this.deps.units(runId);
      } catch {
        all = [];
      }
      if (this.deps.paths.chatOf(runId) !== chatId) return;
      targets = all.filter((u) => answerStepOf(runId, u.id) !== null && !this.replied.has(`${runId}:${u.ord}`)).map((u) => u.ord);
    }
    for (const o of targets) {
      const key = `${runId}:${o}`;
      if (this.replied.has(key)) continue;
      const unit = await this.unit(runId, o);
      if (this.deps.paths.chatOf(runId) !== chatId) return;
      if (unit === null || answerStepOf(runId, unit.id) === null) continue;
      if (this.replied.has(key)) continue;
      this.replied.add(key);
      this.stopWaiting(key);
      this.tails.delete(key);
      const pa = this.paOf(runId, chatId, unit);
      this.deps.fold({
        type: 'chatReply',
        chat: chatId,
        cliKey: pa,
        text: `${pa} did not answer: ${why}`,
        ok: false,
        run_id: runId,
        ord: o,
      } as CoreEvent);
    }
  }
}
