/**
 * The crew-side eval RUN history — the durable store behind the studio's Evals section.
 *
 * # Why this store exists
 *
 * `POST /testing/evals/run` computes a report and answers it, but the daemon kept NOTHING: the
 * engine's eval path is read-only over the steering store (it writes no claim — `conform` is the
 * live gate's recorder, not the eval's), and studio held the last report only in a session-local
 * store that a reload lost. So the Evals section could show ONE ephemeral report, never a history.
 * This store closes that gap: every run is recorded here, so "are the gaps shrinking?" becomes a
 * question the section can actually answer.
 *
 * # Why crew-side, and why not the QE ledger
 *
 * Eval runs judge a STORE, not a workspace — they take no repo/project (the recon route is the
 * only testing route that is workspace-scoped). So they are DAEMON-scoped state, and they live
 * where crew's other daemon-scoped durable state lives: under the resolved state home
 * (`state-home.ts`, the seam project graphs and settings already resolve through), so a `--db`
 * isolated daemon keeps its eval history isolated too. They are deliberately NOT in the wicked-
 * ledger `DomainStore` (`.wicked-qe/`): that store is repo-scoped QE ACCEPTANCE evidence with a
 * fixed table set (`runs`/`verdicts` carry a `scenario_id` FK and an acceptance verdict enum) —
 * reusing it for governance-eval runs would mean the wrong semantics, not reuse.
 *
 * # Shape: a rollup INDEX plus per-run DETAIL files
 *
 *   <home>/evals/runs.jsonl        — one {@link EvalRunSummary} per line, append order (the LIST).
 *   <home>/evals/results/<id>.json — one run's full per-sample results (the DRILLDOWN).
 *
 * Listing parses one file (the rollups) — cheap no matter how large a custom corpus's results
 * are; a drilldown loads exactly one detail file. The detail file is written FIRST, then the index
 * line is appended, so every listed row has a readable detail (a crash between the two leaves an
 * orphan detail file, which is harmless and self-garbage-collecting, never a dangling row).
 *
 * Posture matches the daemon's other sidecars: LOUD-NON-FATAL. Persisting a run must never fail
 * the run itself (the report is the contract; the history is additive), and a torn or missing file
 * degrades one row, never the store — reads skip what does not parse, exactly like the audit trail.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { crewStateHome } from '../projects/state-home.js';
import type { EvalRunDetail, EvalRunSummary, GovernanceEvalResult } from '../core/types.js';

/**
 * Where the store's root lives. Precedence mirrors the other crew stores exactly: the explicit
 * `WICKED_CREW_EVAL_STORE` env override (the more specific instruction the tests pin), then the
 * daemon's state home — the `--db` parent when the bootstrap configured one, the historical
 * `~/.wicked-crew` default otherwise (byte-identical without `--db`).
 */
export function defaultEvalStoreRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['WICKED_CREW_EVAL_STORE'];
  if (override !== undefined) return override;
  return join(crewStateHome(), 'evals');
}

/** The input a run persists: its rollup provenance plus the results the detail file will hold. */
export interface RecordEvalRunInput extends Omit<EvalRunSummary, 'id' | 'created_at'> {
  results: GovernanceEvalResult[];
}

export class EvalRunStore {
  private readonly indexPath: string;
  private readonly resultsDir: string;

  constructor(
    root: string = defaultEvalStoreRoot(),
    private readonly warn: (msg: string) => void = (m) => console.warn(m),
    // `now`/`mintId` are seams so a test can pin a deterministic id + timestamp.
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly mintId: () => string = () => randomUUID().replace(/-/g, ''),
  ) {
    this.indexPath = join(root, 'runs.jsonl');
    this.resultsDir = join(root, 'results');
  }

  /**
   * Record one eval run: write the detail file, then append the rollup index line. Returns the
   * recorded {@link EvalRunSummary} (with its minted id + timestamp). Throws only on a hard write
   * failure — the caller records best-effort and never fails the run on a persistence miss.
   */
  record(input: RecordEvalRunInput): EvalRunSummary {
    const { results, ...rest } = input;
    const summary: EvalRunSummary = { id: this.mintId(), created_at: this.now(), ...rest };
    const detail: EvalRunDetail = { ...summary, results };
    // Detail first, so a listed row always resolves to a readable drilldown (an orphan detail after
    // a crash before the index append is harmless).
    mkdirSync(this.resultsDir, { recursive: true });
    const tmp = join(this.resultsDir, `${summary.id}.json.tmp-${process.pid}`);
    writeFileSync(tmp, JSON.stringify(detail), 'utf8');
    renameSync(tmp, this.detailPath(summary.id));
    appendFileSync(this.indexPath, `${JSON.stringify(summary)}\n`, 'utf8');
    return summary;
  }

  /**
   * The run history, newest first. Optional equality filters (`type_filter`, `corpus`) narrow it.
   * A line that does not parse is skipped (a torn final line after a crash is expected once) — the
   * rest of the history still lists.
   */
  list(filter?: { type_filter?: string | null; corpus?: string | null }): EvalRunSummary[] {
    let raw: string;
    try {
      raw = readFileSync(this.indexPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; // nothing recorded yet
      this.warn(`[eval-store] could not read ${this.indexPath}: ${message(err)} — the history reads empty`);
      return [];
    }
    const rows: EvalRunSummary[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const row = JSON.parse(line) as EvalRunSummary;
        if (typeof row.id !== 'string' || typeof row.created_at !== 'number') continue;
        if (filter?.type_filter !== undefined && row.type_filter !== filter.type_filter) continue;
        if (filter?.corpus !== undefined && row.corpus !== filter.corpus) continue;
        rows.push(row);
      } catch {
        /* torn line — skip it, keep the history readable */
      }
    }
    rows.reverse(); // file order is append order; the history answers newest first
    return rows;
  }

  /** One run WITH its full results, or null when the id is unknown (or its detail file is gone). */
  get(id: string): EvalRunDetail | null {
    // The `:id` route param is user-controlled: reject anything that is not a safe id token BEFORE
    // it touches the filesystem, so an encoded separator / traversal id (`../…`, `%2e%2e%2f…`)
    // can never escape the results dir to read an unintended `.json` (Copilot #467). Minted ids are
    // hex; the `-` allows the test-shaped `run-1` ids — no `.`, `/`, or other path syntax gets through.
    if (!EVAL_RUN_ID_RE.test(id)) return null;
    let raw: string;
    try {
      raw = readFileSync(this.detailPath(id), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      this.warn(`[eval-store] could not read detail for ${id}: ${message(err)}`);
      return null;
    }
    try {
      const detail = JSON.parse(raw) as EvalRunDetail;
      if (typeof detail.id !== 'string' || !Array.isArray(detail.results)) return null;
      return detail;
    } catch {
      return null;
    }
  }

  private detailPath(id: string): string {
    return join(this.resultsDir, `${id}.json`);
  }
}

/** A safe eval-run id: the minted hex ids plus the `-`/`_` a test id uses — no path syntax. Used to
 *  reject a user-controlled `:id` before it reaches the filesystem (path-traversal guard). */
const EVAL_RUN_ID_RE = /^[A-Za-z0-9_-]+$/;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
