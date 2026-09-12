/**
 * Read-only view over a repo's QE evidence ledger (wicked-ledger).
 *
 * The ledger is the data contract between the QE pipeline (wicked-garden's qe
 * skills, formerly the retired wicked-testing package) and the acceptance gate
 * this daemon owns: a DomainStore rooted at `<repo>/.wicked-qe/` (legacy
 * `<repo>/.wicked-testing/` — see qeLedgerRoot) holding `runs` and
 * `verdicts`, plus the public evidence manifest at
 * `<root>/evidence/<run-id>/manifest.json`.
 *
 * READ-ONLY means read-only (F-E2E-013). This module reads the ledger's
 * CANONICAL JSON files directly and never opens a `DomainStore`: opening one
 * is a write — `new DomainStore(root)` mkdirs the root, reaps `.tmp.*` files,
 * creates `wicked-qe.db` (+ WAL/SHM) inside the checkout, runs migrations and
 * a stale-run UPDATE sweep — and the index-healing `rebuildIndex()` this
 * module used to call on top of that bulk-inserted every canonical row into
 * the fresh index, which is where a legacy ledger's scenarios without
 * `format_version` failed ("SQLite write failed … NOT NULL constraint"). A
 * GET must leave the repository byte-identical. Canonical JSON is
 * authoritative by the ledger's own schema contract (the SQLite index is a
 * derived cache), so reading it directly loses nothing — and a record that
 * cannot be parsed is surfaced as a read failure (`error`), never skipped
 * into a cleaner answer.
 *
 * ATTRIBUTION (F-E2E-013): the gate answers about ONE crew run, so a verdict
 * is served only when it can be tied to that run — see {@link ReadSubject}.
 * "The newest PASS in the store" is not evidence about a run that recorded
 * none (the regression: an onboarding run that failed at plan time was shown a
 * two-month-old PASS from the repo's committed legacy ledger).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { EvidenceManifest, RunRecord, VerdictRecord } from 'wicked-ledger';

/**
 * The ledger root directory name under a repo root.
 *
 * Phase 6c (the wicked-testing retirement) renamed the wire contract to
 * `.wicked-qe`; `.wicked-testing` is the legacy dirname repos written by the
 * retired package (and pre-6c garden qe skills) still carry. Resolution is
 * dual-read and mirrors wicked-ledger's `resolveLedgerRoot`: the new name
 * wins, an existing legacy root is honored, fresh repos get the new name.
 */
export const DEFAULT_QE_LEDGER_DIRNAME = '.wicked-qe';
export const LEGACY_QE_LEDGER_DIRNAME = '.wicked-testing';

/**
 * The field a QE writer running INSIDE a governed run stamps on the ledger run
 * (and/or verdict) it records: the crew run id the engine hands every worker as
 * `WICKED_RUN_ID`. Canonical JSON preserves any field a writer supplies, so this
 * needs no ledger schema change; a record carrying it is attributed to that run
 * regardless of timing.
 */
export const CREW_RUN_ID_FIELD = 'crew_run_id';

/** The configured ledger dir name: `WICKED_QE_LEDGER_DIR` env override, else the default. */
export function qeLedgerDirName(): string {
  const env = process.env['WICKED_QE_LEDGER_DIR']?.trim();
  return env !== undefined && env !== '' ? env : DEFAULT_QE_LEDGER_DIRNAME;
}

/**
 * Absolute ledger root for a repo (dual-read, Phase 6c).
 *
 * An explicit `WICKED_QE_LEDGER_DIR` pins the root exactly — the operator is
 * driving, no fallback probing. An absolute value IS the root; a relative
 * value is a dirname under `repoRoot`. Otherwise: `<repo>/.wicked-qe` when it
 * exists; else an existing legacy `<repo>/.wicked-testing` (that ledger keeps
 * its root — a store must never split across two dirs); else `.wicked-qe`.
 */
export function qeLedgerRoot(repoRoot: string): string {
  const env = process.env['WICKED_QE_LEDGER_DIR']?.trim();
  if (env !== undefined && env !== '') return isAbsolute(env) ? env : join(repoRoot, env);
  const current = join(repoRoot, DEFAULT_QE_LEDGER_DIRNAME);
  if (existsSync(current)) return current;
  const legacy = join(repoRoot, LEGACY_QE_LEDGER_DIRNAME);
  if (existsSync(legacy)) return legacy;
  return current;
}

/**
 * The crew run a ledger read is FOR — what a verdict has to be tied to before
 * it is served as that run's acceptance evidence.
 */
export interface RunLinkage {
  /** The crew run id (what a QE writer inside the run sees as `WICKED_RUN_ID`). */
  runId: string;
  /**
   * Epoch millis the crew run started — its `sessionStarted` capture time from
   * the durable event log. `null` when the log records no start (an unknown
   * window links nothing: evidence that cannot be placed inside the run is not
   * the run's evidence).
   */
  startedAt: number | null;
  /** Epoch millis the run reached a terminal state; `null` while it is live (window open). */
  finishedAt: number | null;
}

/**
 * What a read is scoped to: an explicit QE run (`?qeRun=<id>` — the caller
 * asserts the linkage), or the crew run whose evidence is wanted.
 */
export type ReadSubject = { qeRunId: string } | { run: RunLinkage };

/**
 * How the served verdict was tied to the crew run — or why none was. Always
 * populated on a found ledger; the route serves it so the answer explains itself.
 */
export type QeAttribution =
  /** The caller pinned the QE run (`?qeRun=`); its newest verdict is served. */
  | { kind: 'pinned'; qeRunId: string }
  /** The ledger run (or verdict) carries `crew_run_id` naming this crew run. */
  | { kind: 'stamped'; qeRunId: string }
  /** The QE run started inside this crew run's recorded lifetime. */
  | { kind: 'run-window'; qeRunId: string; qeRunStartedAt: string }
  /** Nothing in the ledger is this run's evidence; `reason` says what the ledger does hold. */
  | { kind: 'none'; reason: string };

/**
 * The acceptance-relevant slice of a repo's ledger, scoped to one subject.
 *
 * `found: false` means the repo has no ledger at all (the dir is absent) —
 * a distinct fact from "a ledger with no verdicts", and the gate treats both
 * as a deny with different reasons. `error` carries a read-layer failure
 * (unreadable dir, a record that is not valid JSON); it is never set on an
 * ordinary empty ledger.
 */
export interface QeAcceptanceState {
  /** Absolute ledger root that was read (or probed). */
  root: string;
  /** Whether the ledger root exists on disk. */
  found: boolean;
  /** The QE run the served verdict belongs to, when resolvable. */
  run: RunRecord | null;
  /** The governing verdict row for the subject — the newest among those attributed to it. */
  verdict: VerdictRecord | null;
  /** The public evidence manifest for that run, when present and parseable. */
  manifest: EvidenceManifest | null;
  /** Absolute path the manifest was read from (null when absent). */
  manifestPath: string | null;
  /** How `verdict` was tied to the subject, or why nothing was. */
  attribution: QeAttribution;
  /** How many live verdicts the ledger holds in total — the repo-level picture the scoped read was carved from. */
  ledgerVerdicts: number;
  /** Read-layer failure detail (a record could not be read or parsed). */
  error?: string;
}

/** Fields every canonical record carries (the store stamps them); the rest is table-specific. */
interface CanonicalRecord {
  id: string;
  created_at: string;
  deleted?: 0 | 1;
}

/** Read one canonical JSON record file; throws a message naming the file on anything but a valid record. */
function readRecordFile(path: string, label: string): CanonicalRecord {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label}: not a record object`);
  }
  const rec = parsed as Record<string, unknown>;
  if (typeof rec['id'] !== 'string' || rec['id'] === '') {
    throw new Error(`${label}: record has no id`);
  }
  return rec as unknown as CanonicalRecord;
}

/**
 * Every live record of a table, newest first — the canonical JSON files, read
 * as the ledger's own JSON-only mode reads them (`*.json`, in-flight `.tmp.*`
 * files skipped, soft-deleted rows dropped, `created_at` descending). A table
 * dir that does not exist is an empty table; a file that cannot be parsed is a
 * read FAILURE the caller must surface, not a row to skip.
 */
function listCanonical<T extends CanonicalRecord>(root: string, table: string): T[] {
  const dir = join(root, table);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`${table}/: ${err instanceof Error ? err.message : String(err)}`);
  }
  const rows: T[] = [];
  for (const name of names) {
    if (!name.endsWith('.json') || /\.tmp\.\d+$/.test(name)) continue;
    const rec = readRecordFile(join(dir, name), `${table}/${name}`);
    if (rec.deleted) continue;
    rows.push(rec as T);
  }
  return rows.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}

/** One live record by id, or null when its file is absent (soft-deleted reads as absent too). */
function getCanonical<T extends CanonicalRecord>(root: string, table: string, id: string): T | null {
  const path = join(root, table, `${id}.json`);
  if (!existsSync(path)) return null;
  const rec = readRecordFile(path, `${table}/${id}.json`);
  return rec.deleted ? null : (rec as T);
}

/** The `crew_run_id` a writer stamped on a record, when it carries one (the typed schema has no such column; canonical JSON keeps it). */
function stampedCrewRun(rec: object | null): string | null {
  const v = (rec as Record<string, unknown> | null)?.[CREW_RUN_ID_FIELD];
  return typeof v === 'string' && v !== '' ? v : null;
}

/** Epoch millis of an ISO timestamp, or null when it does not parse. */
function epoch(iso: unknown): number | null {
  if (typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

interface Picked {
  verdict: VerdictRecord | null;
  run: RunRecord | null;
  attribution: QeAttribution;
}

/**
 * Pick the verdict attributable to `subject` from the ledger's live verdicts
 * (newest first), resolving each verdict's run lazily.
 *
 * An explicit pin serves that QE run's newest verdict. Otherwise a verdict is
 * ATTRIBUTED when its run (or the verdict itself) is stamped with this crew
 * run's id, or when its QE run started inside the crew run's lifetime; among
 * everything attributed the NEWEST governs — a QE run re-reviewed after its
 * manifest was built keeps the newer verdict row, as before. Nothing else in
 * the store is this run's evidence, however recent or however green.
 */
function attribute(root: string, verdicts: VerdictRecord[], subject: ReadSubject): Picked {
  if ('qeRunId' in subject) {
    const verdict = verdicts.find((v) => v.run_id === subject.qeRunId) ?? null;
    if (verdict === null) {
      return {
        verdict: null,
        run: null,
        attribution: { kind: 'none', reason: `QE run ${subject.qeRunId} has no verdict recorded` },
      };
    }
    return {
      verdict,
      run: getCanonical<RunRecord>(root, 'runs', verdict.run_id),
      attribution: { kind: 'pinned', qeRunId: verdict.run_id },
    };
  }

  const { runId, startedAt, finishedAt } = subject.run;
  if (verdicts.length === 0) {
    return { verdict: null, run: null, attribution: { kind: 'none', reason: 'the ledger records no verdict' } };
  }

  // Resolve each verdict's run once.
  const runs = new Map<string, RunRecord | null>();
  const runOf = (v: VerdictRecord): RunRecord | null => {
    if (!runs.has(v.run_id)) runs.set(v.run_id, getCanonical<RunRecord>(root, 'runs', v.run_id));
    return runs.get(v.run_id) ?? null;
  };

  const windowEnd = finishedAt ?? Date.now();
  // `verdicts` is newest first, so the first attributed one is the governing one.
  for (const v of verdicts) {
    const run = runOf(v);
    if (stampedCrewRun(run) === runId || stampedCrewRun(v) === runId) {
      return { verdict: v, run, attribution: { kind: 'stamped', qeRunId: v.run_id } };
    }
    if (startedAt === null) continue;
    // The QE run's own start is the linkage instant; a run row that is missing or undated
    // falls back to when the verdict was recorded, which is necessarily later than the QE
    // run started and so can only make the check STRICTER, never attribute too eagerly.
    const at = epoch(run?.started_at) ?? epoch(run?.created_at) ?? epoch(v.created_at);
    if (at !== null && at >= startedAt && at <= windowEnd) {
      return {
        verdict: v,
        run,
        attribution: {
          kind: 'run-window',
          qeRunId: v.run_id,
          qeRunStartedAt: new Date(at).toISOString(),
        },
      };
    }
  }

  // Nothing attributed. Say what the ledger DOES hold, so the answer is checkable.
  const newest = verdicts[0]!;
  const held =
    `the ledger holds ${verdicts.length} verdict${verdicts.length === 1 ? '' : 's'}, ` +
    `newest ${newest.verdict} (${newest.id}) at ${newest.created_at}`;
  if (startedAt === null) {
    return {
      verdict: null,
      run: null,
      attribution: {
        kind: 'none',
        reason:
          `${held}; none is stamped with run ${runId}, and the run's start is not recorded ` +
          `(no sessionStarted in its event log), so no verdict can be placed inside it`,
      },
    };
  }
  const started = new Date(startedAt).toISOString();
  const newestAt = epoch(newest.created_at);
  const placement =
    newestAt !== null && newestAt < startedAt
      ? `before this run started (${started})`
      : `outside this run's lifetime (started ${started}${
          finishedAt !== null ? `, finished ${new Date(finishedAt).toISOString()}` : ', still live'
        })`;
  return {
    verdict: null,
    run: null,
    attribution: {
      kind: 'none',
      reason: `${held}, recorded ${placement}; none is stamped with run ${runId}`,
    },
  };
}

/**
 * Read the ledger's acceptance state for a repo, scoped to `subject`.
 *
 * The verdicts TABLE is the system of record — the manifest is the public
 * artifact built from it at run finalization, returned here as display
 * evidence, never as a gate input: a run can legitimately be re-reviewed
 * after its manifest was built, and the newer verdict row wins.
 *
 * Reads canonical JSON only (see the module header): nothing under the ledger
 * root is created, modified or removed by this call.
 */
export async function readAcceptanceState(
  repoRoot: string,
  subject: ReadSubject,
): Promise<QeAcceptanceState> {
  const root = qeLedgerRoot(repoRoot);
  const state: QeAcceptanceState = {
    root,
    found: false,
    run: null,
    verdict: null,
    manifest: null,
    manifestPath: null,
    attribution: { kind: 'none', reason: 'no ledger' },
    ledgerVerdicts: 0,
  };
  // Probe before reading: a read must not install an empty ledger into a repo
  // that never had one, and a missing root is its own answer.
  if (!existsSync(root)) return state;
  state.found = true;

  try {
    const verdicts = listCanonical<VerdictRecord>(root, 'verdicts');
    state.ledgerVerdicts = verdicts.length;
    const picked = attribute(root, verdicts, subject);
    state.verdict = picked.verdict;
    state.run = picked.run;
    state.attribution = picked.attribution;
    if (picked.verdict !== null) {
      state.manifestPath = join(root, 'evidence', picked.verdict.run_id, 'manifest.json');
      state.manifest = await readManifest(state.manifestPath);
    }
  } catch (err) {
    // A ledger that exists but cannot be read is NOT "no evidence" — the gate
    // still denies (deny-dominates), but the reason must name the read failure
    // so an operator fixes the store instead of hunting for a missing run.
    state.error = err instanceof Error ? err.message : String(err);
    state.verdict = null;
    state.run = null;
    state.manifest = null;
    state.manifestPath = null;
    state.attribution = { kind: 'none', reason: `the ledger could not be read: ${state.error}` };
  }
  return state;
}

/** Parse the public manifest, or null when absent/malformed (display evidence only). */
async function readManifest(path: string): Promise<EvidenceManifest | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as EvidenceManifest;
    // Minimal shape check — enough to know this is a manifest and not stray JSON.
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (typeof parsed.run_id !== 'string' || typeof parsed.manifest_version !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** The summary of a manifest the acceptance route serves (never the full artifact list). */
export interface QeManifestSummary {
  manifestVersion: string;
  runId: string;
  scenarioName: string | null;
  status: string;
  artifactCount: number;
  verdict: { value: string; reviewer: string; recordedAt: string | null };
}

/** Reduce a manifest to the route's summary shape. */
export function summarizeManifest(manifest: EvidenceManifest): QeManifestSummary {
  return {
    manifestVersion: manifest.manifest_version,
    runId: manifest.run_id,
    scenarioName: typeof manifest.scenario_name === 'string' ? manifest.scenario_name : null,
    status: manifest.status,
    artifactCount: Array.isArray(manifest.artifacts) ? manifest.artifacts.length : 0,
    verdict: {
      value: manifest.verdict?.value ?? 'INCONCLUSIVE',
      reviewer: manifest.verdict?.reviewer ?? '',
      recordedAt: manifest.verdict?.recorded_at ?? null,
    },
  };
}
