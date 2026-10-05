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
  /** The engine's persisted attempt counter for the unit (0-based), when the run view carries it:
   *  the durable half of the attempt boundary (codex on #810 r4, 2). */
  last_attempt?: number;
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
  /** Runs a terminal frame has ended: no later fold, row, grace or read continuation may speak
   *  for them (codex on #810 r10, 2). */
  private readonly ended = new Set<string>();
  /** `${run}:${ord}` whose reply was actually FOLDED (a reservation in `replied` may still be in
   *  flight — a terminal must speak for it, r11, 1). */
  private readonly spoken = new Set<string>();
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
        if (this.waiting.has(key) && ref.attempt >= (this.attemptOf(runId, ref.ord) ?? ref.attempt)) {
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
    if (this.ended.has(runId) && event.type !== 'runCancelled' && event.type !== 'sessionFailed') return;
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
    if (this.superseded(runId, ord, attempt)) return;
    if (event.type === 'unitOutputCaptured') {
      const stepStatus = typeof f['stepStatus'] === 'string' ? f['stepStatus'] : 'ok';
      this.nestedOne(this.captured, runId).set(ord, { attempt: attempt ?? this.attemptOf(runId, ord) ?? 0, stepStatus });
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
    if (this.ended.has(runId)) return; // a terminal frame settled the turn during the read (r10, 2)
    if (unit === undefined) {
      // The run view did not answer. Live typing is best-effort (dropped); a FOLD is not — it is
      // held for its row / the grace, whose reply re-reads the record (r7, 1).
      if (event.type === 'unitDone') this.awaitRow(runId, chatId, ord);
      return;
    }
    if (unit === null || answerStepOf(runId, unit.id) === null) return; // not the PA's answer: no chat frame
    // Superseded during the await: neither streamed nor allowed to name the PA (r3, 2).
    if (this.superseded(runId, ord, attempt)) return;
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
    this.awaitRow(runId, chatId, ord);
  }

  /** A fold with no row of its attempt yet: wait for the row (the bus poll is 2 s) — bounded by
   *  `rowGraceMs`, after which the reply is read from the record anyway. */
  private awaitRow(runId: string, chatId: string, ord: number): void {
    const key = `${runId}:${ord}`;
    if (this.ended.has(runId) || this.waiting.has(key) || this.replied.has(key)) return;
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
    for (const key of [...this.spoken]) if (key.startsWith(prefix)) this.spoken.delete(key);
    this.ended.delete(runId);
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
        // The previous attempt's capture status must not grade this one's reply (r5, 2).
        const cap = this.captured.get(runId)?.get(ord);
        if (cap !== undefined && cap.attempt < attempt) this.captured.get(runId)?.delete(ord);
      }
    }
  }

  /** The attempt the fold settles for (run, ord): the latest the engine's frames, the team rows or
   *  the unit's persisted counter named — one monotonic boundary (r3, 1); attempts are 0-based
   *  (r4, 1), so `undefined` = nothing has named one yet. */
  private attemptOf(runId: string, ord: number): number | undefined {
    const seen = this.attempts.get(runId)?.get(ord);
    const rows = this.rows.get(runId)?.get(ord);
    const fromRows = rows !== undefined && rows.size > 0 ? Math.max(...rows.keys()) : undefined;
    if (seen === undefined) return fromRows;
    return fromRows === undefined ? seen : Math.max(seen, fromRows);
  }

  /** Whether a frame labelled `attempt` belongs to an attempt the boundary has moved past. */
  private superseded(runId: string, ord: number, attempt: number | undefined): boolean {
    if (attempt === undefined) return false;
    const boundary = this.attemptOf(runId, ord);
    return boundary !== undefined && attempt < boundary;
  }

  private rowFor(runId: string, ord: number): CompletedRow | undefined {
    const boundary = this.attemptOf(runId, ord);
    return boundary === undefined ? undefined : this.rows.get(runId)?.get(ord)?.get(boundary);
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

  /** The PA: the unit's seat for the CURRENT attempt (the cache is dropped per attempt, so a read
   *  unit is this attempt's — a re-pick shows here before its bus row does; r4, 3); the team rows
   *  (`path.started` / `path.repicked`) when the unit names no seat yet. */
  private paOf(runId: string, chatId: string, unit: RelayUnit): string {
    const path = this.deps.paths.get(chatId);
    if (unit.assigned_cli !== null) {
      if (path !== undefined && path.pa !== unit.assigned_cli) {
        this.learnPa(runId, chatId, unit.assigned_cli, path.pa === null ? path.selection : 'random');
      }
      return unit.assigned_cli;
    }
    return path?.pa ?? 'pa';
  }

  /** `undefined`: a FRESH read failed — the durable record could not be certified (the caller
   *  must not answer from the cache; r6, 1). `null`: no such unit. */
  private async unit(runId: string, ord: number, fresh = false): Promise<RelayUnit | null | undefined> {
    const byOrd = this.nestedOne(this.units, runId);
    const cached = byOrd.get(ord);
    // A unit with no seat yet is re-read (the seat is assigned at dispatch). A FRESH read (the
    // fold / reply boundary) bypasses the cache: the engine's live queue is bounded and may have
    // dropped the frames of a retry, so the durable record decides the attempt and the seat (r5, 1).
    if (!fresh && cached !== undefined && (cached === null || cached.assigned_cli !== null)) return cached;
    const startedUnder = this.attemptOf(runId, ord);
    let found: RelayUnit | null = null;
    try {
      found = (await this.deps.units(runId)).find((u) => u.ord === ord) ?? null;
    } catch (err) {
      this.log(`[ask-relay] cannot read the units of ${runId}: ${err instanceof Error ? err.message : String(err)}`);
      // `undefined` = the read failed (nothing certified); a cache is good enough for a non-fresh
      // caller; `null` is reserved for "no such unit" (r7, 1).
      return fresh ? undefined : (cached ?? undefined);
    }
    // Not found: not cached (the unit may be planned later — a continuation adds answer-N). A run
    // forgotten during the read (End) stays forgotten (r2, 4); a read that started under an attempt
    // the engine has since superseded is not cached either — it may name the old seat (r3, 2).
    if (found !== null && this.units.has(runId) && this.attemptOf(runId, ord) === startedUnder) {
      this.nestedOne(this.units, runId).set(ord, found);
    }
    // The unit's persisted attempt is the durable half of the boundary (r4, 2): a row for an older
    // attempt cannot decide a fold whose stored output is this attempt's.
    if (found?.last_attempt !== undefined) this.noteAttempt(runId, ord, found.last_attempt);
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
    const unit = await this.unit(runId, ord, true);
    if (this.deps.paths.chatOf(runId) !== chatId) return; // ended meanwhile: nothing lands on a reuse
    if (this.ended.has(runId)) return; // a terminal frame settled the turn during the read (r10, 2)
    if (unit === null || (unit !== undefined && answerStepOf(runId, unit.id) === null)) {
      // No such unit, or not the PA's answer (a waiter armed on a failed read for a reviewer's
      // ord — r8, 1): nothing went out, nothing to say.
      this.replied.delete(key);
      this.stopWaiting(key);
      return;
    }
    // The fresh read may have moved the boundary (a retry whose frames were missed): the row of
    // THAT attempt decides, or none yet — then the reply waits for it like any other (r5, 1; the
    // guard holds for every path but the grace, r6, 2). A read that could not certify the record
    // (`undefined`) waits too: never an answer from an uncertified cache (r6, 1).
    const row = unit === undefined ? undefined : this.rowFor(runId, ord);
    if ((row === undefined || unit === undefined) && via !== 'grace') {
      this.replied.delete(key);
      this.awaitRow(runId, chatId, ord);
      return;
    }
    if (unit === undefined) {
      // The grace expired and the record still cannot be read: say so once rather than answer
      // from a cache the fresh read could not certify — for every seat the turn waits on, so the
      // turn ends (a reply ends a turn only for a seat it names).
      this.spoken.add(key);
      for (const seat of this.voicesFor(chatId)) {
        this.deps.fold({
          type: 'chatReply',
          chat: chatId,
          cliKey: seat,
          text: `the answer's record could not be read (the run view did not answer); see run ${runId}, unit ${ord}`,
          ok: false,
          run_id: runId,
          ord,
        } as CoreEvent);
      }
      return;
    }
    const pa = this.paOf(runId, chatId, unit);
    const boundary = this.attemptOf(runId, ord);
    const cap = this.captured.get(runId)?.get(ord);
    const capturedStatus = cap !== undefined && (boundary === undefined || cap.attempt === boundary) ? cap.stepStatus : undefined;
    let text: string | null = null;
    try {
      text = await this.deps.workOutput(unit.id);
    } catch (err) {
      this.log(`[ask-relay] work_output(${unit.id}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.deps.paths.chatOf(runId) !== chatId) return; // r1, 4
    if (this.ended.has(runId)) return; // r10, 2
    const status = row?.status ?? capturedStatus ?? (text !== null ? 'ok' : 'failed');
    const ok = status === 'ok' && text !== null;
    const stepId = row?.stepId ?? answerStepOf(runId, unit.id) ?? `answer (ord ${ord})`;
    const shown =
      text !== null ? stripControlLines(text) : `${pa} did not answer (${status}): the engine stored no output for ${stepId}`;
    if (via === 'grace') this.log(`[ask-relay] ${key}: replied from the record without a team row (status ${status})`);
    this.spoken.add(key);
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

  /** The seats a failure must be said for: the PA when the path knows it, else every seat the
   *  chat's live turns still wait on (the reserved audience of a random pick), else `pa`. */
  private voicesFor(chatId: string): string[] {
    const pa = this.deps.paths.get(chatId)?.pa ?? null;
    if (pa !== null) return [pa];
    const pending = [...new Set(this.deps.turns.turnsOf(chatId).flatMap((t) => t.pending))];
    return pending.length > 0 ? pending : ['pa'];
  }

  /** The run view, retried a few times — a terminal fact must not be lost to one failed read. */
  private async unitsRetrying(runId: string): Promise<RelayUnit[] | undefined> {
    for (let i = 0; i < 3; i += 1) {
      try {
        return await this.deps.units(runId);
      } catch (err) {
        this.log(`[ask-relay] cannot read the units of ${runId} (${i + 1}/3): ${err instanceof Error ? err.message : String(err)}`);
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    return undefined;
  }

  /** A terminal frame with no fold: the answer unit(s) still pending end the turn with `ok:false`.
   *  The run view is read with a bounded retry; if it still cannot be read, the turn is ended
   *  without the unit's facts rather than left pending (r8, 2). */
  private async terminal(runId: string, chatId: string, ord: number | undefined, why: string): Promise<void> {
    // The run is over: the fence goes up first — no armed waiter answers from the record meanwhile
    // (its grace could fire during the retry below), no read continuation arms a new one, no later
    // fold or row speaks (r10, 2).
    this.ended.add(runId);
    const runPrefix = `${runId}:`;
    for (const key of [...this.waiting.keys()]) if (key.startsWith(runPrefix)) this.stopWaiting(key);
    const all = await this.unitsRetrying(runId);
    if (this.deps.paths.chatOf(runId) !== chatId) return;
    // The answer units the run view names for this terminal (none when it could not be read, when
    // the run died before its units existed, or when the ord is not an answer).
    // Answer units of the run view for this terminal that have not actually SPOKEN (a reservation
    // still in flight is dropped by the fence, so it is spoken for here — r11, 1).
    const named =
      all === undefined
        ? []
        : all.filter((u) => answerStepOf(runId, u.id) !== null && (ord === undefined || u.ord === ord) && !this.spoken.has(`${runId}:${u.ord}`));
    let spoke = false;
    for (const unit of named) {
      const key = `${runId}:${unit.ord}`;
      // The unit's seat, the path's PA, else every seat the turn still waits on (a random pick
      // cancelled before its seat was assigned names none — r10, 1); only a seat a live turn still
      // waits on is spoken for (a turn an earlier answer ended is not re-ended — r11, 3).
      const voices = (unit.assigned_cli !== null ? [this.paOf(runId, chatId, unit)] : this.voicesFor(chatId)).filter(
        (seat) => this.deps.turns.inFlight(chatId, [seat]) !== null,
      );
      if (voices.length === 0) continue;
      this.replied.add(key);
      this.spoken.add(key);
      this.tails.delete(key);
      for (const seat of voices) {
        this.deps.fold({ type: 'chatReply', chat: chatId, cliKey: seat, text: `${seat} did not answer: ${why}`, ok: false, run_id: runId, ord: unit.ord } as CoreEvent);
      }
      spoke = true;
    }
    if (spoke) return;
    // No answer unit could speak (unreadable run view, a run that died before its units existed,
    // a terminal for a non-answer ord): every LIVE turn of the chat still ends — once per turn, for
    // the seats it waits on (an earlier turn's answer says nothing about this one — r11, 2);
    // nothing pending, nothing to say (r9 2+3, r10 1).
    const detail = all === undefined ? ' (the run view could not be read)' : '';
    for (const turn of this.deps.turns.turnsOf(chatId)) {
      const turnKey = `${runId}:terminal:${turn.turnId}`;
      if (this.replied.has(turnKey)) continue;
      this.replied.add(turnKey);
      if (ord !== undefined) this.replied.add(`${runId}:${ord}`);
      for (const seat of turn.pending) {
        this.deps.fold({
          type: 'chatReply',
          chat: chatId,
          cliKey: seat,
          text: `${seat} did not answer: ${why}${detail}`,
          ok: false,
          run_id: runId,
          ...(ord !== undefined ? { ord } : {}),
        } as CoreEvent);
      }
    }
  }
}
