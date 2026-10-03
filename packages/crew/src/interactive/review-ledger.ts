/**
 * The review verdict store of the interactive-review seam (DES-artifact-editor-plugins §7.6, EP-C2).
 *
 * "There is no crew review ledger" (rev 2, review S6): every verdict on a document is a wicked-ledger
 * row stamped with the crew run that produced it (E16). A review's rows live in the DOCUMENT'S
 * REVIEW ROOT — `<handoff root>/_reviews/<project partition>/<doc>/` — as a wicked-ledger store (`.wicked-qe/`, canonical
 * JSON: `projects/`, `scenarios/`, `runs/`, `verdicts/`, one file per record), read back through the
 * same canonical reader the acceptance gate uses (`qe/ledger.ts` `readDocReviewVerdicts`).
 *
 * WHO WRITES. The spec has the review phase write its own rows; the engine does not allow it: the
 * review phase is read-only (core `write_posture.rs`: an Evaluator or Neutral unit gets no write
 * tools), which is the point of a review. So the phase REPORTS (its engine-captured output, which no
 * seat can reach afterwards) and crew is the scribe: one verdict row per requested reviewer, written
 * here, then read back before anything is announced.
 *
 * WHY NOT `DomainStore`. wicked-ledger's `DomainStore.create` spawns the `wicked-bus` CLI against the
 * machine's default bus on every write — a blocking child process inside the daemon, emitting onto a
 * bus that is not this daemon's. Canonical JSON is the ledger's authoritative form (the SQLite index
 * is a derived cache it rebuilds), so the rows are written in that form directly: complete records
 * with their parent project / scenario / run, atomically (tmp + rename), with deterministic ids so a
 * replayed finalize rewrites the same files.
 *
 * `_reviews` can never be a handoff directory: a handoff key starts with a document id, and a
 * document id cannot start with `_` (interactive's DOC_NAME grammar).
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CREW_RUN_ID_FIELD, DEFAULT_QE_LEDGER_DIRNAME } from '../qe/ledger.js';

/** The directory, under the seams' handoff root, that holds every document's review root. */
export const REVIEWS_DIRNAME = '_reviews';

export type ReviewVerdict = 'pass' | 'changes' | 'error';
export type ReviewSeverity = 'low' | 'medium' | 'high';

export interface ReviewFinding {
  /** The `data-wid` the finding is about; absent = unanchored. */
  wid?: string;
  severity: ReviewSeverity;
  sentence: string;
}

/** One reviewer's result, as recorded. */
export interface ReviewVerdictWrite {
  runId: string;
  doc: string;
  version: number;
  /** The reviewer's schema id (`match` | `a11y` | `copy` | `qe`). */
  reviewer: string;
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
  /** One plain sentence: why this verdict. */
  reason: string;
  /** The seat that ran the review; `null` when the run named none. */
  seat: string | null;
  excludedSeats: string[];
  authorKnown: boolean;
  /** The skill the reviewer loaded; `null` when it worked from the built-in rubric. */
  skill: string | null;
  projectId?: string | undefined;
}

/** The partition of the reviews dir a project's documents live under (docs roots are per project too). */
export function reviewPartitionOf(projectId: string | undefined): string {
  if (projectId === undefined || projectId === '' || projectId === 'default') return '_unfiled';
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(projectId) ? `p-${projectId}` : `x-${Buffer.from(projectId, 'utf8').toString('hex')}`;
}

/** A document's review root: `<reviewsDir>/<project partition>/<doc>` (its ledger is `<root>/.wicked-qe/`). */
export function reviewRootOf(reviewsDir: string, projectId: string | undefined, documentId: string): string {
  return join(reviewsDir, reviewPartitionOf(projectId), documentId);
}

/** `pass` → PASS, `changes` → FAIL, `error` → INCONCLUSIVE: the ledger's own verdict enum. */
export function ledgerVerdictOf(verdict: ReviewVerdict): 'PASS' | 'FAIL' | 'INCONCLUSIVE' {
  return verdict === 'pass' ? 'PASS' : verdict === 'changes' ? 'FAIL' : 'INCONCLUSIVE';
}

function writeRecord(root: string, table: string, id: string, record: Record<string, unknown>): void {
  const dir = join(root, table);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.json`);
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

const base = (id: string, at: string): Record<string, unknown> => ({ id, created_at: at, updated_at: at, deleted: 0, deleted_at: null });

/**
 * Record one review run's verdicts — one `verdicts` row per reviewer, with its `runs` row and the
 * document's `projects` / per-reviewer `scenarios` rows — in the document's review root. Throws on
 * a write failure (the caller announces nothing it could not record). Returns the verdict ids.
 */
export function writeReviewVerdicts(reviewRoot: string, rows: ReviewVerdictWrite[], now: () => Date = () => new Date()): string[] {
  const root = join(reviewRoot, DEFAULT_QE_LEDGER_DIRNAME);
  const ids: string[] = [];
  for (const row of rows) {
    const at = now().toISOString();
    const projectId = `doc-${row.doc}`;
    const scenarioId = `review-${row.reviewer}`;
    const runRowId = `review-${row.runId}-${row.reviewer}`;
    const verdictId = `verdict-${row.runId}-${row.reviewer}`;
    // The parents are written once: a later review must not move their `created_at`.
    if (!existsSync(join(root, 'projects', `${projectId}.json`))) {
      writeRecord(root, 'projects', projectId, { ...base(projectId, at), name: `interactive document ${row.doc}`, description: 'Reviews of a wicked-interactive document (wicked-crew interactive-review seam)' });
    }
    if (!existsSync(join(root, 'scenarios', `${scenarioId}.json`))) {
      writeRecord(root, 'scenarios', scenarioId, { ...base(scenarioId, at), project_id: projectId, name: `review:${row.reviewer}`, format_version: '1' });
    }
    writeRecord(root, 'runs', runRowId, {
      ...base(runRowId, at),
      project_id: projectId,
      scenario_id: scenarioId,
      started_at: at,
      finished_at: at,
      status: row.verdict === 'pass' ? 'passed' : row.verdict === 'changes' ? 'failed' : 'errored',
      [CREW_RUN_ID_FIELD]: row.runId,
    });
    writeRecord(root, 'verdicts', verdictId, {
      ...base(verdictId, at),
      run_id: runRowId,
      verdict: ledgerVerdictOf(row.verdict),
      reviewer: row.reviewer,
      reason: row.reason,
      evidence_path: null,
      // Beyond the typed schema — canonical JSON keeps them, as it keeps `crew_run_id` ([A12]).
      [CREW_RUN_ID_FIELD]: row.runId,
      doc: row.doc,
      version: row.version,
      review_verdict: row.verdict,
      findings: row.findings,
      seat: row.seat,
      excluded_seats: row.excludedSeats,
      author_known: row.authorKnown,
      skill: row.skill,
      ...(row.projectId !== undefined ? { crew_project_id: row.projectId } : {}),
    });
    ids.push(verdictId);
  }
  return ids;
}

/**
 * Drop a deleted document's recorded reviews, so a later document of the same name does not inherit
 * them. Like the handoff-ledger sweep it rides beside (`doc-ledger-sweep.ts`), it is keyed by the
 * document NAME alone — every project partition's `<doc>` root goes. Idempotent.
 */
export function removeDocReviews(reviewsDir: string, documentId: string): void {
  let partitions: string[];
  try {
    partitions = readdirSync(reviewsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const partition of partitions) rmSync(join(reviewsDir, partition, documentId), { recursive: true, force: true });
}
