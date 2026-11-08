/**
 * Skill usage (operator 2026-11-08: "we should be recording skills usage - that way we know which ones we can turn off
 * over time"). The engine reads each seat's own tool stream and reports, per unit attempt (a workflow step or a chat
 * turn):
 *
 *   skillsSnapshotHanded  the generation and the names the seat's lever delivered (`lever`, `skills`)
 *   skillUsed             `directed` (the directive named it), `opened` (the seat loaded it), `browsed` (one command
 *                         named files from more than three skills: looked over, not used) or `ran` (a garden script,
 *                         named `scripts/<rel>`, never attributed by core)
 *
 * The run's own event log is the record. This is crew's rollup of it, beside the catalog the operator will turn skills
 * off in: one JSON file in the state home (`daemon-skill-usage.json`, the `daemon-` prefix the state-home fence
 * classifies), written atomically (`writeFileAtomic`) and debounced. A file that does not validate in full starts empty
 * and never fails the boot.
 *
 * Every frame is validated before it changes anything (bounded identifiers, integer ordinals, a numeric generation
 * token, a `scripts/<rel>` script) and every retained set is bounded: daily counts per (skill, CLI, signal, origin) kept
 * {@link DAILY_KEEP_DAYS} days; per (skill, CLI) the newest handoff, and per (skill, CLI, signal) the newest use and the
 * highest generation it was used in; at most {@link KEYS_MAX} of each.
 *
 * A `ran` is credited to a skill only through the generation's own files: the handed skills whose files name the
 * script ({@link scriptIndexOf}). One owner is credited; several are narrowed to the ones the same attempt opened or was
 * directed to; anything else (a shared script like `scripts/_run.py`) is counted for the script alone. Never a naming
 * guess. A skill is counted once per attempt and signal, however many of its scripts ran.
 *
 * "Used" = opened, or a ran credited to the skill. Directed without an open is its own column (the seat was told and
 * did not load it); browsed is counted and is not use. "Unused since N" is said only of a skill handed since N to a CLI
 * whose use can be seen on this daemon's floor ({@link observable}): copilot never, opencode and agy only on the
 * container floor.
 */

import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { CoreEvent } from '../core/types.js';
import { crewStateHome } from '../projects/state-home.js';
import { writeFileAtomic } from './tree.js';

export const SKILL_USAGE_FILENAME = 'daemon-skill-usage.json';
/** Daily buckets kept: today and the 89 days before it — the report's 90-day window exactly. */
export const DAILY_KEEP_DAYS = 90;
/** Live attempts whose signals are held for attribution; the oldest is dropped past this. */
export const ATTEMPTS_HELD = 2000;
/** Distinct keys kept in each retained map (`last`, `handedLast`, `scriptLast`, `introduced`). */
export const KEYS_MAX = 20_000;
/** A file larger than this is not read (it starts empty). */
export const FILE_MAX_BYTES = 32 * 1024 * 1024;
export const FLUSH_DEBOUNCE_MS = 5000;
/** Generations whose script index is held. */
const INDEX_CACHE = 4;
/** One generation's index walk: files read, bytes read, directory depth. */
const INDEX_FILES_MAX = 4000;
const INDEX_BYTES_MAX = 16 * 1024 * 1024;
const FILE_READ_MAX = 512 * 1024;
const INDEX_DEPTH_MAX = 8;
/** Names one attempt's handoff / context may hold. */
const ATTEMPT_NAMES_MAX = 4000;
const DAY_MS = 86_400_000;

export type UsageSignal = 'directed' | 'opened' | 'browsed' | 'ran';
export type UsageOrigin = 'run' | 'chat' | 'member';
const SIGNALS: readonly UsageSignal[] = ['directed', 'opened', 'browsed', 'ran'];
const ORIGINS: readonly UsageOrigin[] = ['run', 'chat', 'member'];

const SKILL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CLI_RE = /^[A-Za-z0-9][A-Za-z0-9._#:-]{0,63}$/;
const SCRIPT_RE = /^scripts\/[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/;
const GEN_RE = /^\d{1,12}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day (`2026-99-99` is not). */
const isDay = (d: string): boolean => DAY_RE.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

const validScript = (s: string): boolean => SCRIPT_RE.test(s) && !s.split('/').some((c) => c === '..' || c === '.' || c === '');

/** What each CLI's stream lets the engine see (core `skill_use`). */
export const OBSERVABLE: Readonly<Record<string, { signals: UsageSignal[]; note: string | null }>> = {
  claude: { signals: ['opened', 'browsed', 'ran'], note: null },
  codex: { signals: ['opened', 'browsed', 'ran'], note: 'a $name mention codex injects itself is not seen (the engine never uses one)' },
  pi: { signals: ['opened', 'browsed', 'ran'], note: null },
  opencode: { signals: ['opened', 'browsed', 'ran'], note: 'seen on the container floor only; on the host floor its stream is text' },
  agy: { signals: ['opened', 'browsed', 'ran'], note: 'seen on the container floor only; handed no skills (no lever), so its reads and script runs are what is seen' },
  copilot: { signals: [], note: 'not observable: its stream is text only, so only what it was handed is recorded' },
};
/** CLIs whose structured stream is read only on the container floor. */
const CONTAINER_ONLY = new Set(['opencode', 'agy']);

/** The CLI family of a seat key (`codex`, `codex-2`, `codex#2` → `codex`). */
export function cliFamily(cli: string): string {
  const k = cli.toLowerCase();
  return Object.keys(OBSERVABLE).find((f) => k === f || k.startsWith(`${f}-`) || k.startsWith(`${f}_`) || k.startsWith(`${f}#`)) ?? k;
}

/** The daemon's seat floor (`WICKED_SEAT_FLOOR`, set at boot: `container` unless the operator chose `host`). */
export function seatFloor(env: NodeJS.ProcessEnv = process.env): 'container' | 'host' {
  return env['WICKED_SEAT_FLOOR'] === 'host' ? 'host' : 'container';
}

/** Whether a CLI's use can be seen on `floor`. */
export function observable(cli: string, floor: 'container' | 'host' = seatFloor()): boolean {
  const family = cliFamily(cli);
  if (!Object.hasOwn(OBSERVABLE, family) || (OBSERVABLE[family]?.signals.length ?? 0) === 0) return false;
  return !(floor === 'host' && CONTAINER_ONLY.has(family));
}

/** A dictionary with no prototype: a key named `constructor` or `__proto__` is just a key. */
function dict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

interface LastUse {
  at: number;
  /** The generation of the newest use; `null` = a live-cache fallback. */
  gen: number | null;
  /** The highest generation this was used in; `null` = never in a known generation. */
  maxGen: number | null;
  /** A use with no generation was seen (it cannot be placed: "unused since N" is never said of it). */
  unknownGen: boolean;
  origin: UsageOrigin;
}

export interface UsageFile {
  version: 2;
  /** When this daemon first recorded usage, and the first generation it saw: before it, use is unknown, not zero. */
  recordingSince: { gen: number | null; at: number } | null;
  /** `YYYY-MM-DD` → `<skill>|<cli>|<signal>|<origin>` → attempts. */
  daily: Record<string, Record<string, number>>;
  /** `<skill>|<cli>|<signal>` → the newest use. */
  last: Record<string, LastUse>;
  /** `<skill>|<cli>` → the newest generation it was handed in, and whether that CLI's use could be seen then (the
   *  floor at the time: a later floor change never makes an unseen handoff "unused"). */
  handedLast: Record<string, { gen: number; at: number; seen: boolean }>;
  /** `YYYY-MM-DD` → `<script>|<cli>` → runs not credited to one skill. */
  scriptDaily: Record<string, Record<string, number>>;
  /** `<script>` → the newest uncredited run and the skills whose files name it. */
  scriptLast: Record<string, { at: number; gen: number | null; owners: string[] }>;
  /** `<skill>` → the first generation it was seen in; `seeded` = it was already in the oldest generation on disk when
   *  recording began, so it may be older. */
  introduced: Record<string, { gen: number; seeded: boolean }>;
}

function emptyFile(): UsageFile {
  return { version: 2, recordingSince: null, daily: dict(), last: dict(), handedLast: dict(), scriptDaily: dict(), scriptLast: dict(), introduced: dict() };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isGen = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);

/** Every key and value checked; anything off and the whole file is refused. */
function parseFile(text: string): UsageFile {
  const raw: unknown = JSON.parse(text);
  const bad = (): never => {
    throw new Error('skill usage file does not validate');
  };
  if (!isObj(raw) || raw['version'] !== 2) bad();
  const r = raw as Record<string, unknown>;
  const f = emptyFile();
  const rs = r['recordingSince'];
  if (rs !== null && rs !== undefined) {
    if (!isObj(rs) || !isTime(rs['at']) || !isGen(rs['gen'] ?? null)) bad();
    f.recordingSince = { gen: ((rs as Record<string, unknown>)['gen'] as number | null) ?? null, at: (rs as Record<string, number>)['at'] as number };
  }
  const days = (v: unknown, out: Record<string, Record<string, number>>, key: (k: string) => boolean): void => {
    if (v === undefined) return;
    if (!isObj(v)) bad();
    for (const [day, bucket] of Object.entries(v as Record<string, unknown>)) {
      if (!isDay(day) || !isObj(bucket)) bad();
      const b = dict<number>();
      for (const [k, n] of Object.entries(bucket as Record<string, unknown>)) {
        if (!key(k) || !isCount(n)) bad();
        b[k] = n as number;
      }
      out[day] = b;
    }
  };
  const usageKey = (k: string): boolean => {
    const [s, c, sig, o, ...rest] = k.split('|');
    return rest.length === 0 && SKILL_RE.test(s ?? '') && CLI_RE.test(c ?? '') && SIGNALS.includes(sig as UsageSignal) && ORIGINS.includes(o as UsageOrigin);
  };
  const scriptKey = (k: string): boolean => {
    const [s, c, ...rest] = k.split('|');
    return rest.length === 0 && validScript(s ?? '') && CLI_RE.test(c ?? '');
  };
  days(r['daily'], f.daily, usageKey);
  days(r['scriptDaily'], f.scriptDaily, scriptKey);
  const map = <T>(v: unknown, key: (k: string) => boolean, val: (x: Record<string, unknown>) => T): Record<string, T> => {
    const out = dict<T>();
    if (v === undefined) return out;
    if (!isObj(v) || Object.keys(v).length > KEYS_MAX) bad();
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (!key(k) || !isObj(x)) bad();
      out[k] = val(x as Record<string, unknown>);
    }
    return out;
  };
  f.last = map(
    r['last'],
    (k) => {
      const [s, c, sig, ...rest] = k.split('|');
      return rest.length === 0 && SKILL_RE.test(s ?? '') && CLI_RE.test(c ?? '') && SIGNALS.includes(sig as UsageSignal);
    },
    (x) => {
      if (!isTime(x['at']) || !isGen(x['gen']) || !isGen(x['maxGen']) || typeof x['unknownGen'] !== 'boolean' || !ORIGINS.includes(x['origin'] as UsageOrigin)) bad();
      return { at: x['at'] as number, gen: x['gen'] as number | null, maxGen: x['maxGen'] as number | null, unknownGen: x['unknownGen'] as boolean, origin: x['origin'] as UsageOrigin };
    },
  );
  f.handedLast = map(
    r['handedLast'],
    (k) => {
      const [s, c, ...rest] = k.split('|');
      return rest.length === 0 && SKILL_RE.test(s ?? '') && CLI_RE.test(c ?? '');
    },
    (x) => {
      if (!isCount(x['gen']) || !isTime(x['at']) || typeof x['seen'] !== 'boolean') bad();
      return { gen: x['gen'] as number, at: x['at'] as number, seen: x['seen'] as boolean };
    },
  );
  f.scriptLast = map(r['scriptLast'], validScript, (x) => {
    const owners = x['owners'];
    if (!isTime(x['at']) || !isGen(x['gen']) || !Array.isArray(owners) || owners.length > 200 || !owners.every((o) => typeof o === 'string' && SKILL_RE.test(o))) bad();
    return { at: x['at'] as number, gen: x['gen'] as number | null, owners: owners as string[] };
  });
  f.introduced = map(
    r['introduced'],
    (k) => SKILL_RE.test(k),
    (x) => {
      if (!isCount(x['gen']) || typeof x['seeded'] !== 'boolean') bad();
      return { gen: x['gen'] as number, seeded: x['seeded'] as boolean };
    },
  );
  return f;
}

/** A core generation token (`"000042"`) as a number; `null` for a live-cache fallback or anything else. */
export function genNumber(gen: unknown): number | null {
  if (typeof gen === 'number' && Number.isSafeInteger(gen) && gen >= 0) return gen;
  if (typeof gen !== 'string' || !GEN_RE.test(gen)) return null;
  return Number.parseInt(gen, 10);
}

export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A real directory (never through a symlink at its last component). */
function isRealDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** One snapshot row as `snapshot.json` carries it: `dir` is plugin-relative (`skills/<dir>`). */
interface Row {
  name: string;
  /** The segments under `skills/`. */
  segs: string[];
}

function readRows(snapshotDir: string): Row[] | null {
  try {
    const file = join(snapshotDir, 'snapshot.json');
    const st = lstatSync(file);
    if (!st.isFile() || st.size > FILE_READ_MAX * 8) return null;
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isObj(raw) || !Array.isArray(raw['skills'])) return null;
    const rows: Row[] = [];
    for (const r of raw['skills'] as unknown[]) {
      if (!isObj(r) || typeof r['name'] !== 'string' || typeof r['dir'] !== 'string' || !SKILL_RE.test(r['name'])) continue;
      const segs = r['dir'].split('/');
      if (segs[0] !== 'skills' || segs.length < 2 || segs.slice(1).some((s) => s === '' || s === '.' || s === '..' || s.includes('\\'))) continue;
      rows.push({ name: r['name'], segs: segs.slice(1) });
    }
    return rows;
  } catch {
    return null;
  }
}

const SCRIPT_REF = /scripts\/[A-Za-z0-9_][A-Za-z0-9_./-]*/g;

/**
 * `scripts/<rel>` → the skills whose OWN files (a nested skill's subtree is its own) name it and which the generation
 * actually carries. Read from the immutable snapshot, once per generation, within a fixed budget (files, bytes,
 * depth); symlinks are never followed.
 */
export function scriptIndexOf(snapshotDir: string): Map<string, string[]> {
  return scriptIndexWithCoverage(snapshotDir).owners;
}

/** {@link scriptIndexOf}, and whether the walk read every file (no budget, depth or read failure cut it). */
export function scriptIndexWithCoverage(snapshotDir: string): { owners: Map<string, string[]>; complete: boolean } {
  const out = new Map<string, Set<string>>();
  let complete = true;
  if (!isRealDir(snapshotDir)) return { owners: new Map(), complete: false };
  const rows = readRows(snapshotDir) ?? [];
  const dirs = new Set(rows.map((r) => r.segs.join('/')));
  let files = 0;
  let bytes = 0;
  const exists = new Map<string, boolean>();
  for (const row of rows) {
    const stack: Array<{ path: string; rel: string; depth: number }> = [
      { path: join(snapshotDir, 'skills', ...row.segs), rel: row.segs.join('/'), depth: 0 },
    ];
    while (stack.length > 0) {
      const d = stack.pop() as { path: string; rel: string; depth: number };
      let entries: import('node:fs').Dirent[];
      try {
        entries = readdirSync(d.path, { withFileTypes: true });
      } catch {
        complete = false;
        continue;
      }
      for (const e of entries) {
        if (files >= INDEX_FILES_MAX || bytes >= INDEX_BYTES_MAX) {
          complete = false;
          break;
        }
        const rel = `${d.rel}/${e.name}`;
        if (e.isDirectory()) {
          if (dirs.has(rel)) continue;
          if (d.depth < INDEX_DEPTH_MAX) stack.push({ path: join(d.path, e.name), rel, depth: d.depth + 1 });
          else complete = false;
          continue;
        }
        if (!e.isFile()) continue;
        files += 1;
        let text: string;
        try {
          const p = join(d.path, e.name);
          const size = statSync(p).size;
          if (size > FILE_READ_MAX) {
            complete = false;
            continue;
          }
          bytes += size;
          text = readFileSync(p, 'utf8');
        } catch {
          continue;
        }
        for (const m of text.matchAll(SCRIPT_REF)) {
          const script = m[0].replace(/[./-]+$/, '');
          if (!validScript(script)) continue;
          let ok = exists.get(script);
          if (ok === undefined) {
            try {
              ok = lstatSync(join(snapshotDir, ...script.split('/'))).isFile();
            } catch {
              ok = false;
            }
            exists.set(script, ok);
          }
          if (!ok) continue;
          const set = out.get(script) ?? new Set<string>();
          set.add(row.name);
          out.set(script, set);
        }
      }
    }
  }
  return { owners: new Map([...out].map(([k, v]) => [k, [...v].sort()])), complete };
}

/** One live attempt's signals so far, for crediting a `ran` and counting each skill once. */
interface Attempt {
  gen: string | null;
  handed: Set<string> | null;
  context: Set<string>;
  /** `<signal>|<skill>` already counted for this attempt. */
  counted: Set<string>;
}

export interface SkillUsageOptions {
  path?: string;
  now?: () => number;
  /** `<skills root>/snapshots`: where a generation's own files are read from. */
  snapshotsDir?: () => string | null;
  /** The chat a session's run IS (an ask path), when it is one. */
  chatOf?: (session: string) => string | undefined;
  /** The seat floor whose streams are read (default `WICKED_SEAT_FLOOR`). */
  floor?: () => 'container' | 'host';
  /** `false` = write synchronously on every change (tests). */
  debounce?: boolean;
  log?: (msg: string) => void;
}

type Cell = { d30: number; d90: number; lastAt: number | null; lastGen: number | null };

/** The rollup's answer for one skill (`GET /skills/usage`). */
export interface SkillUsageRow {
  name: string;
  enabled: boolean | null;
  introduced: { gen: number; seeded: boolean } | null;
  byCli: Record<string, { handedLastGen: number | null } & Record<UsageSignal, Cell>>;
  lastUsed: { at: number; gen: number | null; cli: string } | null;
  /** Handed since the generation asked about to an observable CLI and not used since on any. */
  unusedSince: { all: boolean; byCli: string[]; notObservable: boolean };
}

export interface SkillUsageReport {
  currentGen: number | null;
  recordingSince: { gen: number | null; at: number } | null;
  sinceGen: number | null;
  sinceGenClamped: boolean;
  observable: Record<string, { signals: UsageSignal[]; note: string | null }>;
  skills: SkillUsageRow[];
  scripts: Array<{ script: string; owners: string[]; d30: number; d90: number; lastAt: number | null }>;
}

export function defaultSkillUsagePath(env: NodeJS.ProcessEnv = process.env): string {
  return env['WICKED_CREW_SKILL_USAGE'] ?? join(crewStateHome(), SKILL_USAGE_FILENAME);
}

/** A frame's fields, validated; `null` when it is not a usage frame this rollup accepts. */
type Frame =
  | { kind: 'handed'; key: string; session: string; cli: string; gen: number | null; genToken: string | null; skills: string[] }
  | { kind: 'used'; key: string; session: string; cli: string; gen: number | null; genToken: string | null; signal: UsageSignal; skill: string | null; script: string | null };

function frameOf(event: CoreEvent): Frame | null {
  const e = event as CoreEvent & Record<string, unknown>;
  if (e.type !== 'skillsSnapshotHanded' && e.type !== 'skillUsed') return null;
  const session = e.session;
  const cli = e['cli'];
  const ord = e.ord;
  const attempt = e['attempt'];
  if (typeof session !== 'string' || session.length === 0 || session.length > 200) return null;
  if (typeof cli !== 'string' || !CLI_RE.test(cli) || cli === 'tool') return null;
  if (!isCount(ord) || !isCount(attempt)) return null;
  // A generation is a numeric token or an explicit null (a live-cache fallback); anything else is refused.
  if (e['gen'] !== null && !(typeof e['gen'] === 'string' && GEN_RE.test(e['gen']))) return null;
  const genToken = typeof e['gen'] === 'string' ? (e['gen'] as string) : null;
  const gen = genNumber(genToken);
  const key = `${session}|${ord}|${attempt}`;
  if (e.type === 'skillsSnapshotHanded') {
    const raw = Array.isArray(e['skills']) ? (e['skills'] as unknown[]).slice(0, ATTEMPT_NAMES_MAX) : [];
    const skills = raw.filter((s): s is string => typeof s === 'string' && SKILL_RE.test(s));
    return { kind: 'handed', key, session, cli, gen, genToken, skills };
  }
  const signal = e['signal'];
  if (typeof signal !== 'string' || !SIGNALS.includes(signal as UsageSignal)) return null;
  if (signal === 'ran') {
    const script = e['script'];
    if (typeof script !== 'string' || !validScript(script)) return null;
    return { kind: 'used', key, session, cli, gen, genToken, signal: 'ran', skill: null, script };
  }
  const skill = e['skill'];
  if (typeof skill !== 'string' || !SKILL_RE.test(skill)) return null;
  return { kind: 'used', key, session, cli, gen, genToken, signal: signal as UsageSignal, skill, script: null };
}

export class SkillUsageRecorder {
  private readonly path: string;
  private readonly now: () => number;
  private readonly snapshotsDir: () => string | null;
  private readonly chatOf: (session: string) => string | undefined;
  private readonly floor: () => 'container' | 'host';
  private readonly debounce: boolean;
  private readonly log: (msg: string) => void;
  private file: UsageFile;
  private readonly attempts = new Map<string, Attempt>();
  private readonly scriptIndexes = new Map<string, { owners: Map<string, string[]>; complete: boolean }>();
  private readonly genSeen = new Set<number>();
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  /** Running sizes of the retained maps (no `Object.keys` scan per frame). */
  private readonly sizes = { last: 0, handedLast: 0, scriptLast: 0, introduced: 0 };
  /** Every (script, CLI) pair in the daily script buckets. */
  private readonly scriptPairs = new Set<string>();

  constructor(opts: SkillUsageOptions = {}) {
    this.path = opts.path ?? defaultSkillUsagePath();
    this.now = opts.now ?? Date.now;
    this.snapshotsDir = opts.snapshotsDir ?? (() => null);
    this.chatOf = opts.chatOf ?? (() => undefined);
    this.floor = opts.floor ?? (() => seatFloor());
    this.debounce = opts.debounce ?? true;
    this.log = opts.log ?? (() => undefined);
    this.file = emptyFile();
    try {
      const st = statSync(this.path);
      if (st.isFile() && st.size <= FILE_MAX_BYTES) this.file = parseFile(readFileSync(this.path, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log(`[skills] skill usage file not read, starting empty: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.sizes.last = Object.keys(this.file.last).length;
    this.sizes.handedLast = Object.keys(this.file.handedLast).length;
    this.sizes.scriptLast = Object.keys(this.file.scriptLast).length;
    this.sizes.introduced = Object.keys(this.file.introduced).length;
    for (const bucket of Object.values(this.file.scriptDaily)) for (const k of Object.keys(bucket)) this.scriptPairs.add(k);
  }

  /** The rollup as it stands (tests, the rebuild). */
  snapshot(): UsageFile {
    return JSON.parse(JSON.stringify(this.file)) as UsageFile;
  }

  /** Fold one engine frame. Anything that is not a valid usage frame is ignored; nothing here throws. */
  ingest(event: CoreEvent): void {
    try {
      this.fold(event);
    } catch (err) {
      this.log(`[skills] skill usage frame not folded: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private fold(event: CoreEvent): void {
    const f = frameOf(event);
    if (f === null) return;
    const at = this.now();
    if (this.file.recordingSince === null) this.file.recordingSince = { gen: f.gen, at };
    else if (this.file.recordingSince.gen === null && f.gen !== null) this.file.recordingSince.gen = f.gen;
    if (f.gen !== null) this.noteGeneration(f.gen);
    const att = this.attempt(f.key, f.genToken);
    if (f.kind === 'handed') {
      att.handed = new Set(f.skills);
      if (f.gen !== null) {
        for (const skill of f.skills) {
          const k = `${skill}|${f.cli}`;
          const h = this.file.handedLast[k];
          const seen = observable(f.cli, this.floor());
          if (h === undefined) {
            if (this.sizes.handedLast >= KEYS_MAX) continue;
            this.sizes.handedLast += 1;
            this.file.handedLast[k] = { gen: f.gen, at, seen };
          } else if (f.gen > h.gen) {
            // The newest generation wins.
            this.file.handedLast[k] = { gen: f.gen, at, seen };
          } else if (f.gen === h.gen) {
            // Within one generation an unseen handoff stays unseen.
            h.at = at;
            h.seen = h.seen && seen;
          }
        }
      }
      this.changed();
      return;
    }
    const origin = this.originOf(f.session);
    if (f.signal === 'ran') {
      const script = f.script as string;
      // Resolved in THIS frame's generation (a relaunch may run on a newer one).
      const { owners, complete } = this.ownersOf(f.genToken ?? att.gen, script, att.handed);
      const narrowed = owners.filter((o) => att.context.has(o));
      // One owner is credited only when the index saw every file; else only what the attempt opened or was told.
      const credited = owners.length === 1 && complete ? owners : narrowed;
      if (credited.length === 1) this.count(att, credited[0] as string, f.cli, 'ran', origin, f.gen, at);
      else if (this.once(att, `script|${script}`)) this.countScript(script, owners, f.cli, f.gen, at);
      this.changed();
      return;
    }
    const skill = f.skill as string;
    if ((f.signal === 'opened' || f.signal === 'directed') && att.context.size < ATTEMPT_NAMES_MAX) att.context.add(skill);
    this.count(att, skill, f.cli, f.signal, origin, f.gen, at);
    this.changed();
  }

  private originOf(session: string): UsageOrigin {
    if (session.startsWith('member-')) return 'member';
    return this.chatOf(session) !== undefined ? 'chat' : 'run';
  }

  private attempt(key: string, gen: string | null): Attempt {
    let a = this.attempts.get(key);
    if (a === undefined) {
      a = { gen, handed: null, context: new Set(), counted: new Set() };
      this.attempts.set(key, a);
      if (this.attempts.size > ATTEMPTS_HELD) this.attempts.delete(this.attempts.keys().next().value as string);
    } else if (a.gen === null && gen !== null) a.gen = gen;
    return a;
  }

  /** First time this attempt records `key`; a saturated attempt records nothing more. */
  private once(att: Attempt, key: string): boolean {
    if (att.counted.has(key) || att.counted.size >= ATTEMPT_NAMES_MAX) return false;
    att.counted.add(key);
    return true;
  }

  /** The handed skills whose files name `script` in generation `gen` (a validated numeric token), and whether the
   *  index read every file of that generation. */
  private ownersOf(gen: string | null, script: string, handed: Set<string> | null): { owners: string[]; complete: boolean } {
    if (gen === null || !GEN_RE.test(gen)) return { owners: [], complete: false };
    let index = this.scriptIndexes.get(gen);
    if (index === undefined) {
      // The snapshots dir itself must be a real directory, as `noteGeneration` requires.
      const dir = this.snapshotsDir();
      index = dir === null || !isRealDir(dir) ? { owners: new Map(), complete: false } : scriptIndexWithCoverage(join(dir, gen));
      this.scriptIndexes.set(gen, index);
      if (this.scriptIndexes.size > INDEX_CACHE) this.scriptIndexes.delete(this.scriptIndexes.keys().next().value as string);
    }
    const owners = index.owners.get(script) ?? [];
    return { owners: handed === null ? owners : owners.filter((o) => handed.has(o)), complete: index.complete };
  }

  private count(att: Attempt, skill: string, cli: string, signal: UsageSignal, origin: UsageOrigin, gen: number | null, at: number): void {
    const lk = `${skill}|${cli}|${signal}`;
    const prev = this.file.last[lk];
    if (prev === undefined && this.sizes.last >= KEYS_MAX) return;
    if (prev === undefined) this.sizes.last += 1;
    // One attempt counts a skill once per signal, however many of its scripts ran; its newest use and highest
    // generation are kept whatever the count does.
    if (this.once(att, `${signal}|${skill}`)) {
      const bucket = (this.file.daily[dayOf(at)] ??= dict<number>());
      const k = `${skill}|${cli}|${signal}|${origin}`;
      bucket[k] = (bucket[k] ?? 0) + 1;
    }
    this.file.last[lk] = {
      at,
      gen,
      maxGen: gen === null ? (prev?.maxGen ?? null) : Math.max(gen, prev?.maxGen ?? gen),
      unknownGen: gen === null || (prev?.unknownGen ?? false),
      origin,
    };
  }

  private countScript(script: string, owners: string[], cli: string, gen: number | null, at: number): void {
    const k = `${script}|${cli}`;
    // Bounded per (script, CLI): the daily buckets are keyed by the pair, not the script alone.
    if (!this.scriptPairs.has(k)) {
      if (this.scriptPairs.size >= KEYS_MAX) return;
      this.scriptPairs.add(k);
    }
    if (this.file.scriptLast[script] === undefined && this.sizes.scriptLast >= KEYS_MAX) return;
    if (this.file.scriptLast[script] === undefined) this.sizes.scriptLast += 1;
    const bucket = (this.file.scriptDaily[dayOf(at)] ??= dict<number>());
    bucket[k] = (bucket[k] ?? 0) + 1;
    this.file.scriptLast[script] = { at, gen, owners: owners.slice(0, 200) };
  }

  /**
   * Record which skills generation `gen` carries (from its `snapshot.json`): a name seen for the first time was
   * introduced there. The first time anything is noted, every generation still on disk is read oldest first, and the
   * names already in the oldest one are marked `seeded` (they may be older than it). Never throws.
   */
  noteGeneration(gen: number): void {
    if (this.genSeen.has(gen)) return;
    const dir = this.snapshotsDir();
    if (dir === null || !isRealDir(dir)) return;
    let names: Map<number, string>;
    try {
      names = new Map(
        readdirSync(dir)
          .filter((n) => GEN_RE.test(n))
          .map((n) => [genNumber(n) as number, n] as [number, string]),
      );
    } catch {
      return;
    }
    if (Object.keys(this.file.introduced).length === 0) {
      const gens = [...names.keys()].sort((a, b) => a - b);
      const oldest = gens[0];
      for (const g of gens) {
        this.introduce(join(dir, names.get(g) as string), g, g === oldest);
        this.genSeen.add(g);
      }
    }
    const name = names.get(gen);
    if (name === undefined) return;
    this.introduce(join(dir, name), gen, false);
    this.genSeen.add(gen);
    if (this.genSeen.size > 10_000) this.genSeen.clear();
    this.changed();
  }

  private introduce(snapshotDir: string, gen: number, seeded: boolean): void {
    if (!isRealDir(snapshotDir)) return;
    for (const row of readRows(snapshotDir) ?? []) {
      if (this.file.introduced[row.name] !== undefined) continue;
      if (this.sizes.introduced >= KEYS_MAX) return;
      this.sizes.introduced += 1;
      this.file.introduced[row.name] = { gen, seeded };
    }
  }

  private changed(): void {
    this.dirty = true;
    if (!this.debounce) {
      this.flush();
      return;
    }
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, FLUSH_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  /** Prune and write now (the debounce, the daemon's close). */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.prune();
    try {
      writeFileAtomic(this.path, JSON.stringify(this.file));
    } catch (err) {
      // A failed write costs the rollup's freshness on disk, never a run; the next change retries.
      this.dirty = true;
      this.log(`[skills] skill usage not written: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The first day the windows and the file keep: today and the {@link DAILY_KEEP_DAYS} − 1 days before it. */
  private firstKeptDay(): string {
    return dayOf(this.now() - (DAILY_KEEP_DAYS - 1) * DAY_MS);
  }

  private prune(): void {
    const cutoff = this.firstKeptDay();
    for (const day of Object.keys(this.file.daily)) if (day < cutoff) delete this.file.daily[day];
    for (const day of Object.keys(this.file.scriptDaily)) if (day < cutoff) delete this.file.scriptDaily[day];
    this.scriptPairs.clear();
    for (const bucket of Object.values(this.file.scriptDaily)) for (const k of Object.keys(bucket)) this.scriptPairs.add(k);
  }

  /**
   * The rollup for `GET /skills/usage`: per skill, last used, uses in the last 30 / 90 days per CLI and signal, and
   * whether it was handed since `sinceGen` (default: when recording began) to a CLI whose use can be seen and not used
   * since on any. `catalog` is the manifest's skills (enabled or not); a skill seen in usage or handoffs but no longer
   * in the catalog is still listed (`enabled: null`).
   */
  report(opts: { sinceGen?: number; currentGen: number | null; catalog: ReadonlyArray<{ name: string; enabled: boolean }> }): SkillUsageReport {
    const now = this.now();
    const d30 = dayOf(now - 29 * DAY_MS);
    const d90 = this.firstKeptDay();
    const floor = this.floor();
    const recordedFrom = this.file.recordingSince?.gen ?? null;
    let sinceGen = opts.sinceGen ?? recordedFrom;
    let clamped = false;
    if (sinceGen !== null && recordedFrom !== null && sinceGen < recordedFrom) {
      sinceGen = recordedFrom;
      clamped = true;
    }
    const enabled = new Map(opts.catalog.map((c) => [c.name, c.enabled]));
    const rows = new Map<string, SkillUsageRow>();
    const rowOf = (name: string): SkillUsageRow => {
      let row = rows.get(name);
      if (row === undefined) {
        row = {
          name,
          enabled: enabled.get(name) ?? null,
          introduced: this.file.introduced[name] ?? null,
          byCli: dict(),
          lastUsed: null,
          unusedSince: { all: false, byCli: [], notObservable: false },
        };
        rows.set(name, row);
      }
      return row;
    };
    const cliOf = (row: SkillUsageRow, cli: string) =>
      (row.byCli[cli] ??= {
        handedLastGen: null,
        directed: { d30: 0, d90: 0, lastAt: null, lastGen: null },
        opened: { d30: 0, d90: 0, lastAt: null, lastGen: null },
        browsed: { d30: 0, d90: 0, lastAt: null, lastGen: null },
        ran: { d30: 0, d90: 0, lastAt: null, lastGen: null },
      });
    for (const c of opts.catalog) rowOf(c.name);
    const today = dayOf(now);
    for (const [day, bucket] of Object.entries(this.file.daily)) {
      if (day < d90 || day > today) continue;
      for (const [k, n] of Object.entries(bucket)) {
        const [skill, cli, signal] = k.split('|') as [string, string, UsageSignal];
        const c = cliOf(rowOf(skill), cli)[signal];
        c.d90 += n;
        if (day >= d30) c.d30 += n;
      }
    }
    // Used since N, per skill and CLI: the highest generation it was used in, or a use that cannot be placed.
    const usedSince = new Map<string, Set<string>>();
    for (const [k, last] of Object.entries(this.file.last)) {
      const [skill, cli, signal] = k.split('|') as [string, string, UsageSignal];
      const row = rowOf(skill);
      const c = cliOf(row, cli)[signal];
      c.lastAt = last.at;
      c.lastGen = last.gen;
      if (signal !== 'opened' && signal !== 'ran') continue;
      if (row.lastUsed === null || last.at > row.lastUsed.at) row.lastUsed = { at: last.at, gen: last.gen, cli };
      if (last.unknownGen || sinceGen === null || (last.maxGen !== null && last.maxGen >= sinceGen)) {
        const set = usedSince.get(skill) ?? new Set<string>();
        set.add(cli);
        usedSince.set(skill, set);
      }
    }
    // Handed since N, per CLI, and whether that handoff's use could be seen.
    const handedSince = new Map<string, Set<string>>();
    const unseen = new Set<string>();
    for (const [k, h] of Object.entries(this.file.handedLast)) {
      const [skill, cli] = k.split('|') as [string, string];
      const cell = cliOf(rowOf(skill), cli);
      cell.handedLastGen = h.gen;
      if (sinceGen !== null && h.gen < sinceGen) continue;
      if (!h.seen) unseen.add(k);
      const set = handedSince.get(skill) ?? new Set<string>();
      set.add(cli);
      handedSince.set(skill, set);
    }
    for (const row of rows.values()) {
      const clis = [...(handedSince.get(row.name) ?? [])].sort();
      const seen = clis.filter((c) => observable(c, floor) && !unseen.has(`${row.name}|${c}`));
      const used = usedSince.get(row.name) ?? new Set<string>();
      row.unusedSince = {
        all: seen.length > 0 && used.size === 0,
        byCli: seen.filter((c) => !used.has(c)),
        notObservable: clis.length > 0 && seen.length === 0,
      };
    }
    const scripts = new Map<string, { script: string; owners: string[]; d30: number; d90: number; lastAt: number | null }>();
    for (const [day, bucket] of Object.entries(this.file.scriptDaily)) {
      if (day < d90 || day > today) continue;
      for (const [k, n] of Object.entries(bucket)) {
        const script = k.slice(0, k.lastIndexOf('|'));
        const last = this.file.scriptLast[script];
        const s = scripts.get(script) ?? { script, owners: last?.owners ?? [], d30: 0, d90: 0, lastAt: last?.at ?? null };
        s.d90 += n;
        if (day >= d30) s.d30 += n;
        scripts.set(script, s);
      }
    }
    const observableNow: Record<string, { signals: UsageSignal[]; note: string | null }> = {};
    for (const [family, o] of Object.entries(OBSERVABLE)) {
      observableNow[family] = observable(family, floor) ? o : { signals: [], note: o.note };
    }
    const toPlain = (row: SkillUsageRow): SkillUsageRow => ({ ...row, byCli: { ...row.byCli } });
    return {
      currentGen: opts.currentGen,
      recordingSince: this.file.recordingSince,
      sinceGen,
      sinceGenClamped: clamped,
      observable: observableNow,
      skills: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)).map(toPlain),
      scripts: [...scripts.values()].sort((a, b) => b.d90 - a.d90 || a.script.localeCompare(b.script)),
    };
  }
}
