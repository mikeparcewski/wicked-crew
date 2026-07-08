import { execa } from 'execa';
import type { WorkerConfig, DispatchResult } from './types.js';
import { parseWorkerOutput } from './parser.js';

const DEFAULT_TIMEOUT_MS = 120_000;

export async function dispatch(worker: WorkerConfig, prompt: string, context: string): Promise<DispatchResult> {
  const startedAt = new Date().toISOString();
  const args = [...worker.args, prompt, context];
  const timeoutMs = worker.timeout_ms ?? DEFAULT_TIMEOUT_MS;

  let exitCode: number;
  let stdout: string;
  let stderr: string;

  try {
    const result = await execa(worker.command, args, {
      timeout: timeoutMs,
      forceKillAfterDelay: 5000,
      reject: false,
    });
    // reject: false — timedOut flag is on the result, not thrown as error
    if ((result as unknown as { timedOut?: boolean }).timedOut) {
      exitCode = -1;
    } else {
      exitCode = result.exitCode ?? 1;
    }
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err) {
    const e = err as { exitCode?: number; stdout?: string; stderr?: string; timedOut?: boolean };
    exitCode = e.timedOut ? -1 : (e.exitCode ?? 1);
    stdout = e.stdout ?? '';
    stderr = e.stderr ?? '';
  }

  const completedAt = new Date().toISOString();
  const output = parseWorkerOutput(stdout);

  return {
    workerId: worker.id,
    exitCode,
    stdout,
    stderr,
    startedAt,
    completedAt,
    output,
    parseError: output === null && stdout.trim() ? 'Failed to parse worker output' : null,
  };
}

export async function dispatchCouncil(
  workers: WorkerConfig[],
  prompt: string,
  context: string,
): Promise<import('./types.js').CouncilResult> {
  const results = await Promise.all(
    workers.map((worker) => dispatch(worker, prompt, context)),
  );

  return synthesizeCouncil(results);
}

function synthesizeCouncil(results: DispatchResult[]): import('./types.js').CouncilResult {
  const votingResults = results.filter((r) => r.output?.votes != null);

  if (votingResults.length === 0) {
    return {
      workerResults: results,
      synthesisScore: 0,
      recommendation: '',
      dimensionAgreements: {},
    };
  }

  // Collect all dimension keys across all votes
  const allDimensions = new Set<string>();
  for (const r of votingResults) {
    const dims = r.output?.votes?.dimensions;
    if (dims) Object.keys(dims).forEach((k) => allDimensions.add(k));
  }

  // Per dimension: count 'agree' responses; agreement = count / total voters
  const dimensionAgreements: Record<string, number> = {};
  for (const dim of allDimensions) {
    let agreeCount = 0;
    for (const r of votingResults) {
      if (r.output?.votes?.dimensions[dim] === 'agree') agreeCount++;
    }
    dimensionAgreements[dim] = votingResults.length > 0 ? agreeCount / votingResults.length : 0;
  }

  const scores = Object.values(dimensionAgreements);
  const synthesisScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

  // Plurality recommendation
  const recCounts = new Map<string, number>();
  for (const r of votingResults) {
    const rec = r.output?.votes?.recommendation ?? '';
    if (rec) recCounts.set(rec, (recCounts.get(rec) ?? 0) + 1);
  }
  let recommendation = '';
  let maxCount = 0;
  for (const [rec, count] of recCounts) {
    if (count > maxCount) { maxCount = count; recommendation = rec; }
  }

  return { workerResults: results, synthesisScore, recommendation, dimensionAgreements };
}
