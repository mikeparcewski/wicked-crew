// (crew#1884, DES-STANDIN-001 §4 K2a scope) Which launches take stand-ins: one classifier for POST /runs, a schedule
// and a chat job's card. A review, the evals and a demo keep their own checks; everything else may be stand-in-aware.
import { RUN_EVALS_WORKFLOW } from '../evals/workflow.js';
import { REVIEW_WORKFLOW } from '../insights/workflow.js';
import type { NoStandInLaunch } from '../core/stand-in.js';
import { DEMO_PRESETS } from './recording.js';
import { REVIEW_CHANGE_WORKFLOW } from './review-change.js';

/** Why a workflow takes no stand-ins (`null`: it may). */
export function noStandInsKind(workflow: string | null | undefined): NoStandInLaunch | null {
  if (workflow === null || workflow === undefined) return null;
  if (workflow === REVIEW_CHANGE_WORKFLOW || workflow === REVIEW_WORKFLOW) return 'review';
  if (workflow === RUN_EVALS_WORKFLOW) return 'evals';
  if (DEMO_PRESETS.includes(workflow)) return 'demo';
  return null;
}
