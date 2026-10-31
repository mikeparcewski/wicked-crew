/**
 * CREW'S OWN READING of a working step (operator 2026-10-30: "if it's been running long you can have an agent analyze
 * right there, to make sure no tokens are wasted and no problems are occurring"). Pure and deterministic: the unit's
 * newest attempt, read off its recorded frames, and nothing else.
 *
 * What it reads (the run's own log, `GET /runs/:id/events`):
 *  - `toolActivity` (core#1207): each tool call, started and finished, with its target; a `working` frame is a quiet
 *    seat's heartbeat and is not a call;
 *  - `powerActivity`: power mode's edits and commits, read off git;
 *  - `unitOutputDelta`: what the seat said;
 *  - `usageProgress` (live) and `cliUsage` (at the attempt's end): its tokens.
 *
 * What it says, in this order (the first that holds):
 *  - **stuck**: a call open for {@link STUCK_OPEN_CALL_MS} (a hung process), or nothing at all for
 *    {@link STUCK_QUIET_MS} (no call, no words, no tokens);
 *  - **looping**: the same call (tool + target) {@link LOOP_SAME_CALL} times, the same failing command
 *    {@link LOOP_FAILING_RERUN} times, or the same file edited {@link LOOP_SAME_FILE_EDITS} times; with the evidence;
 *  - **wasteful**: {@link WASTE_TOKENS} tokens or more since its last new words or edit, at least
 *    {@link WASTE_MIN_MS} ago;
 *  - else **progressing**.
 *
 * The seat that checks on a step (service.ts) gets this reading and the step's recent frames; this reading stands on
 * its own when no such seat can answer.
 */

export type InspectVerdict = 'progressing' | 'looping' | 'stuck' | 'wasteful';
export type InspectAction = 'let_run' | 'steer' | 'stop';

/** A call open this long is a hung process. */
export const STUCK_OPEN_CALL_MS = 10 * 60_000;
/** Nothing at all this long (no call, no words, no tokens): stuck. */
export const STUCK_QUIET_MS = 5 * 60_000;
/** The same call (tool + target) this many times: a loop. */
export const LOOP_SAME_CALL = 4;
/** The same command failing this many times: a loop. */
export const LOOP_FAILING_RERUN = 3;
/** The same file edited this many times: a loop. */
export const LOOP_SAME_FILE_EDITS = 6;
/** Tokens spent since the last new words or edit that read as waste... */
export const WASTE_TOKENS = 400_000;
/** ...when that last new output is at least this old. */
export const WASTE_MIN_MS = 3 * 60_000;

type Frame = Record<string, unknown>;

export interface ReadingCall {
  tool: string;
  kind: string;
  target: string | null;
  at: number | null;
  ok: boolean | null;
  durationMs: number | null;
  open: boolean;
}

export interface ReadingUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  /** `live` (a `usageProgress` total while it works) or `final` (the attempt's `cliUsage`). */
  source: 'live' | 'final';
}

export interface UnitReading {
  ord: number;
  attempt: number;
  /** When the attempt was dispatched (unix ms), null when the log has no dispatch for it. */
  startedAt: number | null;
  elapsedMs: number | null;
  calls: number;
  openCalls: Array<{ tool: string; target: string | null; forMs: number }>;
  /** `read 4 · search 2 · run 3 · test 1 · edit 2`. */
  byKind: Record<string, number>;
  /** Files edited or written, with how often. */
  edits: Array<{ path: string; count: number }>;
  /** Words said: deltas and characters. */
  said: { deltas: number; chars: number; lastAt: number | null; newest: string | null };
  usage: ReadingUsage | null;
  /** The newest frame of any kind but a heartbeat (unix ms). */
  lastSignAt: number | null;
  verdict: InspectVerdict;
  /** One line per piece of evidence, in plain words ("Ran `npm test` 5 times, 4 failed"). */
  evidence: string[];
  /** What it is doing now, in one line ("Running `npm test -- jpy`", "Edited src/a.ts"). */
  doing: string | null;
  action: InspectAction;
  /** The note crew would suggest sending the seat (`action: steer`), else null. */
  note: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const timeOf = (e: Frame): number | null => num(e['ts']) ?? num(e['at']);
const oneLine = (s: string, max = 90): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const mins = (ms: number): string => {
  const m = Math.round(ms / 60_000);
  return m < 1 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${m} min`;
};
const tokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** The frames of the unit's newest attempt: from its last `unitDispatched`, this ord only. */
export function attemptFrames(events: readonly Frame[], ord: number): { frames: Frame[]; attempt: number; startedAt: number | null } {
  let from = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]!;
    if (e['ord'] === ord && e['type'] === 'unitDispatched') { from = i; break; }
  }
  const start = from >= 0 ? events[from]! : null;
  const attempt = start !== null ? num(start['attempt']) ?? 0 : 0;
  const frames = events.slice(Math.max(0, from)).filter((e) => e['ord'] === ord
    // A frame stamped with another attempt is not this one's.
    && (typeof e['attempt'] !== 'number' || e['attempt'] === attempt));
  return { frames, attempt, startedAt: start !== null ? timeOf(start) : null };
}

/** A call's identity for repeat counting: the tool and its target, whitespace folded. */
const callKey = (c: ReadingCall): string => `${c.tool}\u0000${(c.target ?? '').replace(/\s+/g, ' ').trim()}`;

function callWords(c: ReadingCall): string {
  const t = c.target !== null ? oneLine(c.target, 80) : null;
  switch (c.kind) {
    case 'read': return t !== null ? `${c.open ? 'Reading' : 'Read'} ${t}` : c.open ? 'Reading a file' : 'Read a file';
    case 'search': return t !== null ? `${c.open ? 'Searching' : 'Searched'} ${t}` : c.open ? 'Searching the code' : 'Searched the code';
    case 'test': return c.open ? `Running the tests${t !== null ? ` \`${t}\`` : ''}` : `Ran the tests${t !== null ? ` \`${t}\`` : ''}${c.ok === false ? ' (failed)' : ''}`;
    case 'run': return t !== null ? `${c.open ? 'Running' : 'Ran'} \`${t}\`${!c.open && c.ok === false ? ' (failed)' : ''}` : c.open ? 'Running a command' : 'Ran a command';
    case 'edit': return t !== null ? `${c.open ? 'Editing' : 'Edited'} ${t}` : c.open ? 'Editing a file' : 'Edited a file';
    case 'write': return t !== null ? `${c.open ? 'Writing' : 'Wrote'} ${t}` : c.open ? 'Writing a file' : 'Wrote a file';
    default: return `${c.open ? 'Using' : 'Used'} ${c.tool}${t !== null ? ` on ${t}` : ''}`;
  }
}

/** Crew's reading of the unit's newest attempt at `now`. */
export function readUnit(events: readonly Frame[] | null | undefined, ord: number, now: number): UnitReading {
  const { frames, attempt, startedAt } = attemptFrames(events ?? [], ord);
  const calls: ReadingCall[] = [];
  const byId = new Map<string, number>();
  const edits = new Map<string, number>();
  const editTimes: number[] = [];
  let deltas = 0;
  let chars = 0;
  let saidAt: number | null = null;
  let newest: string | null = null;
  const seenText = new Set<string>();
  let usage: ReadingUsage | null = null;
  /** Live usage totals in time order, to measure the tokens spent since the last new output. */
  const usageAt: Array<{ at: number; total: number }> = [];
  let lastSignAt: number | null = null;
  const sign = (t: number | null): void => { if (t !== null && (lastSignAt === null || t > lastSignAt)) lastSignAt = t; };
  const edited = (path: string | null, at: number | null): void => {
    if (path === null) return;
    edits.set(path, (edits.get(path) ?? 0) + 1);
    if (at !== null) editTimes.push(at);
  };

  for (const e of frames) {
    const at = timeOf(e);
    switch (e['type']) {
      case 'toolActivity': {
        if (e['state'] === 'working' || e['kind'] === 'working') continue;
        sign(at);
        const id = str(e['id']);
        const prev = id !== null ? byId.get(id) : undefined;
        const ok = typeof e['ok'] === 'boolean' ? e['ok'] : null;
        if (e['state'] === 'finished' && prev !== undefined) {
          calls[prev] = { ...calls[prev]!, open: false, ok, durationMs: num(e['durationMs']) };
          continue;
        }
        const call: ReadingCall = {
          tool: str(e['tool']) ?? 'tool', kind: str(e['kind']) ?? 'other', target: str(e['target']), at, ok,
          durationMs: num(e['durationMs']), open: e['state'] === 'started',
        };
        if (id !== null) byId.set(id, calls.length);
        calls.push(call);
        if (call.kind === 'edit' || call.kind === 'write') edited(call.target, at);
        break;
      }
      case 'powerActivity':
        sign(at);
        if (e['kind'] === 'edit') edited(str(e['path']), at);
        break;
      case 'unitOutputDelta': {
        const text = str(e['text']);
        if (text === null) break;
        sign(at);
        deltas += 1;
        chars += text.length;
        // New words, not a repeat of something it already said.
        const key = text.replace(/\s+/g, ' ');
        if (!seenText.has(key)) {
          seenText.add(key);
          saidAt = at ?? saidAt;
          const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
          newest = lines.length > 0 ? oneLine(lines[lines.length - 1]!, 140) : newest;
        }
        break;
      }
      case 'usageProgress': {
        const i = num(e['inputTokens']);
        const o = num(e['outputTokens']);
        if (i === null || o === null) break;
        sign(at);
        usage = { inputTokens: i, outputTokens: o, costUsd: num(e['costUsd']), source: 'live' };
        if (at !== null) usageAt.push({ at, total: i + o });
        break;
      }
      case 'cliUsage': {
        const i = num(e['inputTokens']);
        const o = num(e['outputTokens']);
        if (i === null || o === null) break;
        usage = { inputTokens: i, outputTokens: o, costUsd: num(e['costUsd']), source: 'final' };
        break;
      }
      default:
        break;
    }
  }

  const byKind: Record<string, number> = {};
  for (const c of calls) byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
  const open = calls.filter((c) => c.open).map((c) => ({ tool: c.tool, target: c.target, forMs: c.at !== null ? Math.max(0, now - c.at) : 0 }));
  const editList = [...edits.entries()].map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  const newestCall = calls.at(-1);
  const doing = newestCall !== undefined ? callWords(newestCall) : newest;

  const evidence: string[] = [];
  let verdict: InspectVerdict = 'progressing';
  let action: InspectAction = 'let_run';
  let note: string | null = null;

  // ── stuck ──
  const hung = open.filter((o) => o.forMs >= STUCK_OPEN_CALL_MS).sort((a, b) => b.forMs - a.forMs)[0];
  const quietFor = lastSignAt !== null ? now - lastSignAt : startedAt !== null ? now - startedAt : null;
  if (hung !== undefined) {
    verdict = 'stuck';
    const what = hung.target !== null ? `\`${oneLine(hung.target, 80)}\`` : hung.tool;
    evidence.push(`${what} has been running for ${mins(hung.forMs)} with no result`);
    action = 'stop';
    note = null;
  } else if (quietFor !== null && quietFor >= STUCK_QUIET_MS && open.length === 0) {
    verdict = 'stuck';
    evidence.push(lastSignAt !== null
      ? `Nothing for ${mins(quietFor)}: no tool call, no words and no tokens since then`
      : `Nothing since it started ${mins(quietFor)} ago: no tool call, no words and no tokens`);
    action = 'steer';
    note = `You have been quiet for ${mins(quietFor)}. Say where you are, what you are waiting on, and what you will do next.`;
  }

  // ── looping ──
  if (verdict === 'progressing') {
    const counts = new Map<string, { call: ReadingCall; n: number; failed: number }>();
    for (const c of calls) {
      if (c.kind === 'skill' || c.kind === 'task') continue;
      const k = callKey(c);
      const cur = counts.get(k) ?? { call: c, n: 0, failed: 0 };
      cur.n += 1;
      if (c.ok === false) cur.failed += 1;
      counts.set(k, cur);
    }
    const loops: string[] = [];
    for (const { call, n, failed } of counts.values()) {
      const what = call.target !== null ? `\`${oneLine(call.target, 80)}\`` : call.tool;
      if ((call.kind === 'run' || call.kind === 'test') && failed >= LOOP_FAILING_RERUN) loops.push(`Ran ${what} ${n} times, ${failed} failed`);
      else if (n >= LOOP_SAME_CALL) loops.push(`${call.kind === 'read' ? 'Read' : call.kind === 'search' ? 'Searched' : call.kind === 'edit' || call.kind === 'write' ? 'Edited' : 'Ran'} ${what} ${n} times`);
    }
    for (const { path, count } of editList) {
      if (count >= LOOP_SAME_FILE_EDITS && !loops.some((l) => l.includes(path))) loops.push(`Edited ${path} ${count} times`);
    }
    if (loops.length > 0) {
      verdict = 'looping';
      evidence.push(...loops.slice(0, 4));
      action = 'steer';
      note = `You seem to be repeating yourself (${loops[0]!.replace(/`/g, '')}). Stop repeating it: say what you learned from the last attempts and try a different approach, or say what blocks you.`;
    }
  }

  // ── wasteful ──
  if (verdict === 'progressing' && usageAt.length > 0) {
    const lastOutput = Math.max(saidAt ?? -Infinity, editTimes.length > 0 ? Math.max(...editTimes) : -Infinity, startedAt ?? -Infinity);
    const latest = usageAt[usageAt.length - 1]!;
    // The total when it last said or changed something (the newest snapshot at or before it; none = 0).
    const before = [...usageAt].reverse().find((u) => u.at <= lastOutput)?.total ?? 0;
    const spent = latest.total - before;
    if (Number.isFinite(lastOutput) && spent >= WASTE_TOKENS && now - lastOutput >= WASTE_MIN_MS) {
      verdict = 'wasteful';
      evidence.push(`${tokens(spent)} tokens in the ${mins(now - lastOutput)} since it last said or changed anything`);
      action = 'steer';
      note = `You have used ${tokens(spent)} tokens since your last new output. Summarise what you have and finish, or name exactly what is missing.`;
    }
  }

  if (verdict === 'progressing') {
    const did = [
      byKind['read'] ? `read ${plural(byKind['read'], 'file')}` : null,
      byKind['search'] ? `searched ${plural(byKind['search'], 'time')}` : null,
      byKind['run'] ? `ran ${plural(byKind['run'], 'command')}` : null,
      byKind['test'] ? `ran the tests ${plural(byKind['test'], 'time')}` : null,
      editList.length > 0 ? `edited ${plural(editList.length, 'file')}` : null,
    ].filter((x): x is string => x !== null);
    if (did.length > 0) evidence.push(`So far it ${did.join(', ')}`);
    if (doing !== null) evidence.push(`Now: ${doing}`);
  }

  return {
    ord, attempt, startedAt,
    elapsedMs: startedAt !== null ? Math.max(0, now - startedAt) : null,
    calls: calls.length, openCalls: open, byKind, edits: editList,
    said: { deltas, chars, lastAt: saidAt, newest },
    usage, lastSignAt, verdict, evidence, doing, action, note,
  };
}

/** The step's recent frames for the checking seat, compact and bounded: one line each, newest last. */
export function timeline(events: readonly Frame[] | null | undefined, ord: number, max = 80): string[] {
  const { frames, startedAt } = attemptFrames(events ?? [], ord);
  const t0 = startedAt ?? (frames.length > 0 ? timeOf(frames[0]!) : null) ?? 0;
  const at = (e: Frame): string => {
    const t = timeOf(e);
    return t === null ? '?' : `+${Math.max(0, Math.round((t - t0) / 1000))}s`;
  };
  const out: string[] = [];
  for (const e of frames) {
    switch (e['type']) {
      case 'toolActivity':
        if (e['state'] === 'working') { out.push(`${at(e)} quiet: ${str(e['target']) ?? ''}`); break; }
        out.push(`${at(e)} ${e['state'] === 'started' ? 'start' : `done${e['ok'] === false ? ' FAILED' : ''}`} ${str(e['tool']) ?? '?'} ${oneLine(str(e['target']) ?? '', 120)}`.trim());
        break;
      case 'powerActivity':
        out.push(`${at(e)} ${e['kind'] === 'commit' ? `commit ${str(e['subject']) ?? ''}` : `edit ${str(e['path']) ?? ''} +${num(e['added']) ?? 0} -${num(e['removed']) ?? 0}`}`);
        break;
      case 'unitOutputDelta':
        if (str(e['text']) !== null) out.push(`${at(e)} said: ${oneLine(str(e['text'])!, 200)}`);
        break;
      case 'usageProgress':
        out.push(`${at(e)} tokens: ${num(e['inputTokens']) ?? 0} in, ${num(e['outputTokens']) ?? 0} out`);
        break;
      default:
        break;
    }
  }
  // Heartbeats repeat: keep the newest of a run of them.
  const folded = out.filter((l, i) => !(l.includes(' quiet: ') && out[i + 1]?.includes(' quiet: ')));
  return folded.slice(-max);
}
