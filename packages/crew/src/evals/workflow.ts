/**
 * The `run-evals` workflow (DES-DEFAULT-EVALS-001 §7) is DATA: `packages/crew/workflows/run-evals.json`. This module
 * reads it, fills its three host tokens (`{node}`, `{run_cli}`, `{daemon}`: the bound URL, since a Tool step's
 * environment is cleared and never carries `WICKED_CREW_URL`) and hands it to the engine, which validates it
 * (`adapter.registerWorkflow`), exactly as the run review's def is handled (`insights/workflow.ts`).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { WorkflowDef } from '../core/types.js';

export const RUN_EVALS_WORKFLOW = 'run-evals';
export const RUN_EVALS_WORKFLOW_FILE = fileURLToPath(new URL('../../workflows/run-evals.json', import.meta.url));
/** The Tool step's script beside this module (`.js` in dist). */
export const RUN_EVALS_CLI = fileURLToPath(new URL('./run-cli.js', import.meta.url));

export interface RunEvalsTokens {
  node: string;
  runCli: string;
  /** The daemon's own URL (`brokerUrlFor` of the bound address). */
  daemon: string;
}

export function fillRunEvalsWorkflow(raw: unknown, tokens: RunEvalsTokens): WorkflowDef {
  const def = { ...(raw as Record<string, unknown>) };
  delete def['$comment'];
  const fill = (s: string): string => s.replaceAll('{node}', tokens.node).replaceAll('{run_cli}', tokens.runCli).replaceAll('{daemon}', tokens.daemon);
  const phases = (def['phases'] as Array<Record<string, unknown>>).map((p) => {
    const ex = p['executor'] as { type?: string; cmd?: string[] } | undefined;
    if (ex?.type !== 'tool' || !Array.isArray(ex.cmd)) return p;
    return { ...p, executor: { type: 'tool', cmd: ex.cmd.map(fill) } };
  });
  const out = { ...def, phases } as unknown as WorkflowDef;
  const left = JSON.stringify(out.phases.map((p) => p.executor ?? null)).match(/\{(node|run_cli|daemon)\}/u);
  if (left !== null) throw new Error(`run-evals: token ${left[0]} was not filled`);
  return out;
}

export function loadRunEvalsWorkflow(tokens: RunEvalsTokens, file = RUN_EVALS_WORKFLOW_FILE): WorkflowDef {
  return fillRunEvalsWorkflow(JSON.parse(readFileSync(file, 'utf8')) as unknown, tokens);
}
