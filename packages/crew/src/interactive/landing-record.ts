/**
 * WHAT CREW CHECKED ON EACH RUN'S DOCUMENT BEFORE IT LANDED (DES-CHAT-ARTIFACTS-001 §11.2, slice A6; PLAN G12).
 *
 * One record per run that announced a document (a first draft or a refine): the floor crew re-derived on the exact file
 * it announced (its sha256, the verdict, the page count and whether a renderer MEASURED it), and the writer's
 * `notes.json` (what it left out, which sources it used, its assumptions) with the sources crew struck before the run.
 *
 * Keyed by run, never by version: interactive's I1 contract records the run on the version it lands (`run_id`), so the
 * checks read maps a version to its run, and a run that never landed is simply never read. A version a person made by
 * hand has no run: it shows the notes of its nearest ancestor that has them (labelled "from vN") and "not measured" for
 * the floor (§11.2; PLAN G12).
 *
 * In crew's own state (the registered `chats` entry: no worker reads or writes it), one JSON file per document,
 * written atomically. This is a host measurement and the writer's own list, so it is not a reviewer's verdict and is
 * not written into the review ledger (a row there would read as a review).
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DocFloorCheck, DocNotes } from 'wicked-crew-api-types';
import { refStem } from './doc-binding.js';

/** The record of one run's announced document. */
export interface LandingRecord {
  runId: string;
  /** ISO-8601: when crew checked it. */
  at: string;
  /** sha256 of the file crew announced (the floor judged exactly these bytes). */
  sha256: string;
  floor: Omit<DocFloorCheck, 'version' | 'run_id' | 'source' | 'at' | 'sha256'>;
  /** The writer's notes, as validated; `null` = this run recorded none (a run from before notes were required). */
  notes: Omit<DocNotes, 'from_version' | 'run_id'> | null;
}

interface File {
  ref: string;
  runs: Record<string, LandingRecord>;
}

const MAX_RUNS_PER_DOC = 500;

export class LandingRecordStore {
  constructor(private readonly dir: string) {}

  private file(ref: string): string | null {
    const stem = refStem(ref);
    return stem === null ? null : join(this.dir, `${stem}.json`);
  }

  private read(ref: string): File {
    const path = this.file(ref);
    if (path === null || !existsSync(path)) return { ref, runs: {} };
    try {
      const f = JSON.parse(readFileSync(path, 'utf8')) as File;
      return f !== null && typeof f === 'object' && f.ref === ref && typeof f.runs === 'object' && f.runs !== null ? f : { ref, runs: {} };
    } catch {
      return { ref, runs: {} };
    }
  }

  /** Record (or replace: a re-announce of the same run) one run's record. Never throws: a lost record reads "not measured". */
  put(ref: string, rec: LandingRecord, log?: (m: string) => void): void {
    const path = this.file(ref);
    if (path === null) return;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const st = lstatSync(this.dir);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${this.dir} is not a real directory`);
      const f = this.read(ref);
      f.runs[rec.runId] = rec;
      const ids = Object.keys(f.runs);
      // Bounded: the oldest records go first (a document refined hundreds of times keeps its recent history).
      if (ids.length > MAX_RUNS_PER_DOC) {
        for (const id of ids.sort((a, b) => f.runs[a]!.at.localeCompare(f.runs[b]!.at)).slice(0, ids.length - MAX_RUNS_PER_DOC)) delete f.runs[id];
      }
      const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      writeFileSync(tmp, JSON.stringify(f), { mode: 0o600, flag: 'wx' });
      renameSync(tmp, path);
    } catch (err) {
      log?.(`[landing-record] ${ref} run ${rec.runId}: not recorded: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The record of one run of a document, or `null`. */
  get(ref: string, runId: string): LandingRecord | null {
    return this.read(ref).runs[runId] ?? null;
  }
}

/** The fields a valid `notes.json` holds, or `null` when it is not that (the floor already refused an invalid one). */
export function parseNotes(raw: unknown): Pick<DocNotes, 'left_out' | 'sources' | 'assumptions'> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= 1000;
  if (!Array.isArray(o['left_out']) || !Array.isArray(o['sources']) || !Array.isArray(o['assumptions'])) return null;
  const leftOut = (o['left_out'] as unknown[]).slice(0, 200).flatMap((x) => {
    const r = x as Record<string, unknown> | null;
    return r !== null && typeof r === 'object' && str(r['claim']) && str(r['why']) ? [{ claim: r['claim'], why: r['why'] }] : [];
  });
  const sources = (o['sources'] as unknown[]).slice(0, 200).flatMap((x) => {
    const r = x as Record<string, unknown> | null;
    return r !== null && typeof r === 'object' && str(r['token']) && typeof r['used'] === 'boolean' ? [{ token: r['token'], used: r['used'] }] : [];
  });
  const assumptions = (o['assumptions'] as unknown[]).slice(0, 200).filter(str);
  return { left_out: leftOut, sources, assumptions };
}

/** The size a `notes.json` may have before it is not read (the floor's own cap is the same). */
const MAX_NOTES_BYTES = 256 * 1024;

/**
 * Record what crew checked on a run's announced file: its sha256, the floor verdict (never a failing one: that lands
 * nothing) and the writer's notes from `notesPath`, plus the sources crew struck before the run. Never throws.
 */
export function recordLanding(
  store: LandingRecordStore | undefined,
  input: {
    ref: string;
    runId: string;
    outPath: string;
    notesPath: string;
    floor: { verdict: 'pass' | 'fail' | 'unverified' | 'unavailable'; summary: string; pages?: DocFloorCheck['pages'] | undefined };
    struck?: ReadonlyArray<{ token: string; reason: string }>;
  },
  log?: (m: string) => void,
): void {
  if (store === undefined || input.floor.verdict === 'fail') return;
  let sha256: string;
  try {
    sha256 = createHash('sha256').update(readFileSync(input.outPath)).digest('hex');
  } catch (err) {
    log?.(`[landing-record] run ${input.runId}: the announced file could not be read: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  let notes: LandingRecord['notes'] = null;
  try {
    const st = lstatSync(input.notesPath);
    if (st.isFile() && st.size <= MAX_NOTES_BYTES) {
      const parsed = parseNotes(JSON.parse(readFileSync(input.notesPath, 'utf8')));
      if (parsed !== null) notes = { ...parsed, struck: [...(input.struck ?? [])] };
    }
  } catch {
    notes = null; // no notes, or not readable: the record says none were recorded
  }
  if (notes === null && (input.struck ?? []).length > 0) notes = { left_out: [], sources: [], assumptions: [], struck: [...input.struck!] };
  store.put(
    input.ref,
    {
      runId: input.runId,
      at: new Date().toISOString(),
      sha256,
      floor: { verdict: input.floor.verdict, pages: input.floor.pages ?? null, summary: input.floor.summary },
      notes,
    },
    log,
  );
}
