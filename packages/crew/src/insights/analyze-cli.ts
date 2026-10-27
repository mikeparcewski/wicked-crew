#!/usr/bin/env node
/**
 * The `review-recent-work` workflow's `analyze` Tool phase (DES-RUNS-REVIEW-001 §3): reads the snapshot crew
 * prepared for this run and writes `facts.json` beside it. Deterministic; the model never runs here.
 *
 *   node analyze-cli.js --reviews-dir <dir>      # the run's dir is <dir>/$WICKED_RUN_ID (the engine sets it)
 *   node analyze-cli.js --dir <run dir>          # explicit (tests, by hand)
 *
 * Exit 0 with a one-paragraph summary on stdout; exit 1 with the reason on stderr.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { analyze, type Facts, type Snapshot } from './analyze.js';

export const SNAPSHOT_FILE = 'snapshot.json';
export const FACTS_FILE = 'facts.json';
export const REPORT_FILE = 'report.json';
/** A run id is one plain path segment (never `..`, never a separator). */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function runDirFrom(argv: readonly string[], env: NodeJS.ProcessEnv): string {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dir = flag('--dir');
  if (dir !== undefined) return resolve(dir);
  const reviews = flag('--reviews-dir');
  if (reviews === undefined) throw new Error('give --dir <run dir> or --reviews-dir <dir> (with WICKED_RUN_ID set)');
  const runId = env['WICKED_RUN_ID'] ?? '';
  if (!RUN_ID.test(runId) || runId.includes('..')) throw new Error(`WICKED_RUN_ID is not a run id: ${JSON.stringify(runId)}`);
  return join(resolve(reviews), runId);
}

export function summaryOf(f: Facts): string {
  const t = f.totals;
  return [
    `analyzed ${t.runs} runs in the window (${t.passed} passed, ${t.failed} failed, ${t.cancelled} cancelled, ${t.open} open) against ${t.baselineRuns} baseline runs`,
    `${f.metrics.length} metric cells, ${f.improvements.length} improvements, ${f.regressions.length} regressions`,
    `${f.candidates.length} candidates: ${f.recommended.length} recommended, ${f.watching.length} watching`,
  ].join('; ');
}

export function runAnalyze(dir: string): Facts {
  const snapPath = join(dir, SNAPSHOT_FILE);
  if (!existsSync(snapPath)) throw new Error(`no ${SNAPSHOT_FILE} in ${dir}: crew prepares it when it launches the review`);
  const snapshot = JSON.parse(readFileSync(snapPath, 'utf8')) as Snapshot;
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.runs)) throw new Error(`${SNAPSHOT_FILE} is not a version-1 snapshot`);
  const facts = analyze(snapshot);
  const out = join(dir, FACTS_FILE);
  const tmp = `${out}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(facts, null, 2), 'utf8');
  renameSync(tmp, out);
  return facts;
}

function main(): void {
  try {
    const dir = runDirFrom(process.argv.slice(2), process.env);
    const facts = runAnalyze(dir);
    process.stdout.write(`${summaryOf(facts)}\nwrote ${join(dir, FACTS_FILE)}\n`);
  } catch (err) {
    process.stderr.write(`review analyze failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
