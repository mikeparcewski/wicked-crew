/**
 * The `run-evals` workflow (DES-DEFAULT-EVALS-001 §7) is DATA: `packages/crew/workflows/run-evals.json`. This module
 * reads it, fills its host tokens (`{node}`, `{run_cli}`, `{runs_dir}`) and hands it to the engine, which validates it
 * (`adapter.registerWorkflow`), exactly as the run review's def is handled (`insights/workflow.ts`).
 *
 * The daemon runs the evals itself when it launches the workflow ({@link prepareRunEvalsLaunch}): every launch (a
 * schedule, `/workflow-run-evals`, `POST /runs`) scores this daemon's store in-process, keeps the report where
 * Evaluate reads it, and writes a copy to `<runs dir>/<run>/report.json`. The Tool step only reads that copy back
 * (`run-cli --runs-dir`, found by `$WICKED_RUN_ID`), so it needs no network, no daemon URL and no credentials: a Tool
 * step's environment is cleared to the validator allowlist, and a daemon with required auth would refuse an
 * unauthenticated call anyway.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LaunchRunInput, WorkflowDef } from '../core/types.js';
import type { DefaultEvalReport } from './types.js';

export const RUN_EVALS_WORKFLOW = 'run-evals';
export const RUN_EVALS_WORKFLOW_FILE = fileURLToPath(new URL('../../workflows/run-evals.json', import.meta.url));
/** The Tool step's script beside this module (`.js` in dist). */
export const RUN_EVALS_CLI = fileURLToPath(new URL('./run-cli.js', import.meta.url));

/** Where each run's report copy lives: outside the daemon state home (the worker fence), like the reviews. */
export function defaultEvalRunsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env['WICKED_CREW_EVAL_RUNS_DIR'] ?? join(homedir(), '.wicked', 'evals');
}

export interface RunEvalsTokens {
  node: string;
  runCli: string;
  runsDir: string;
}

const TOKEN = /\{[a-z_]+\}/u;

export function fillRunEvalsWorkflow(raw: unknown, tokens: RunEvalsTokens): WorkflowDef {
  for (const [k, v] of Object.entries(tokens)) {
    if (typeof v !== 'string' || v.trim() === '') throw new Error(`run-evals: the ${k} token is empty`);
  }
  const def = { ...(raw as Record<string, unknown>) };
  delete def['$comment'];
  const fill = (s: string): string =>
    s.replaceAll('{node}', tokens.node).replaceAll('{run_cli}', tokens.runCli).replaceAll('{runs_dir}', tokens.runsDir);
  const phases = (def['phases'] as Array<Record<string, unknown>>).map((p) => {
    const ex = p['executor'] as { type?: string; cmd?: string[] } | undefined;
    if (ex?.type !== 'tool' || !Array.isArray(ex.cmd)) return p;
    return { ...p, executor: { type: 'tool', cmd: ex.cmd.map(fill) } };
  });
  const out = { ...def, phases } as unknown as WorkflowDef;
  // Any {token} left (a misspelt one in the def included) is a packaging error, never a literal argument.
  const left = JSON.stringify(out.phases.map((p) => p.executor ?? null)).match(TOKEN);
  if (left !== null) throw new Error(`run-evals: token ${left[0]} was not filled`);
  return out;
}

export function loadRunEvalsWorkflow(tokens: RunEvalsTokens, file = RUN_EVALS_WORKFLOW_FILE): WorkflowDef {
  return fillRunEvalsWorkflow(JSON.parse(readFileSync(file, 'utf8')) as unknown, tokens);
}

/**
 * Prepare a `run-evals` launch: run the evals now (`run`, which also keeps the report), write the copy the Tool step
 * reads, and make the launch repo-less, delivering nothing, on no seat.
 */
export async function prepareRunEvalsLaunch(
  input: LaunchRunInput,
  run: () => Promise<DefaultEvalReport>,
  runsDir: string = defaultEvalRunsDir(),
): Promise<DefaultEvalReport> {
  const report = await run();
  const dir = join(runsDir, input.sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2));
  input.workflow = RUN_EVALS_WORKFLOW;
  input.clisJson = '[]';
  delete (input as { repoRef?: string }).repoRef;
  if (input.problem === undefined || input.problem.trim() === '') input.problem = 'Run the default evals across every project';
  return report;
}
