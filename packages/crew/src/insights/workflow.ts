/**
 * The `review-recent-work` workflow (DES-RUNS-REVIEW-001 §3) is DATA: `packages/crew/workflows/review-recent-work.json`.
 * This module only reads it, fills the three host tokens (`{node}`, `{analyze_cli}`, `{reviews_dir}`) and hands it to
 * the engine, which validates it (`adapter.registerWorkflow`) like the interactive seams' runtime defs.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { WorkflowDef } from '../core/types.js';
import { wickedHomeDir } from '../core/wicked-home.js';

export const REVIEW_WORKFLOW = 'review-recent-work';

/** The packaged def (`packages/crew/workflows/`), from `src/insights/` and from `dist/insights/` alike. */
export const REVIEW_WORKFLOW_FILE = fileURLToPath(new URL('../../workflows/review-recent-work.json', import.meta.url));
/** The analyze script beside this module (`.js` in dist; under vitest the `.ts` source sits here instead). */
export const ANALYZE_CLI = fileURLToPath(new URL('./analyze-cli.js', import.meta.url));

/** Where each review's run directory lives: outside the daemon state home (the worker fence), like walkthroughs.
 *  `WICKED_CREW_REVIEWS_DIR`, else `${WICKED_HOME:-~/.wicked}/reviews` (crew#1802). */
export function defaultReviewsDir(env: NodeJS.ProcessEnv = process.env): string {
  return wickedHomeDir('WICKED_CREW_REVIEWS_DIR', 'reviews', env);
}

export interface ReviewWorkflowTokens {
  node: string;
  analyzeCli: string;
  reviewsDir: string;
}

/** Fill the def's tokens. Only the Tool `cmd` carries them; anything else unfilled is a packaging error. */
export function fillReviewWorkflow(raw: unknown, tokens: ReviewWorkflowTokens): WorkflowDef {
  const def = { ...(raw as Record<string, unknown>) };
  delete def['$comment'];
  const fill = (s: string): string =>
    s.replaceAll('{node}', tokens.node).replaceAll('{analyze_cli}', tokens.analyzeCli).replaceAll('{reviews_dir}', tokens.reviewsDir);
  const phases = (def['phases'] as Array<Record<string, unknown>>).map((p) => {
    const ex = p['executor'] as { type?: string; cmd?: string[] } | undefined;
    if (ex?.type !== 'tool' || !Array.isArray(ex.cmd)) return p;
    return { ...p, executor: { type: 'tool', cmd: ex.cmd.map(fill) } };
  });
  const out = { ...def, phases } as unknown as WorkflowDef;
  const left = JSON.stringify(out.phases.map((p) => p.executor ?? null)).match(/\{(node|analyze_cli|reviews_dir)\}/u);
  if (left !== null) throw new Error(`review-recent-work: token ${left[0]} was not filled`);
  return out;
}

export function loadReviewWorkflow(tokens: ReviewWorkflowTokens, file = REVIEW_WORKFLOW_FILE): WorkflowDef {
  return fillReviewWorkflow(JSON.parse(readFileSync(file, 'utf8')) as unknown, tokens);
}
