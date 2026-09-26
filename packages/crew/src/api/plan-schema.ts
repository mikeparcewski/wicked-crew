/**
 * The plan command body shared by `POST /runs {plan}`, `POST /runs/:id/gate {plan}`,
 * `POST /runs/:id/plan` and `POST /plans/preview` (DES-TEAMING-002 T3/T8).
 */

import { z } from 'zod';
import type { LaunchPlan } from '../core/types.js';

/** DES-TEAMING-002 §8.4 (seam T3) — a USER-COMPOSED plan: `steps[]` over the phase catalog (a
 *  step's `id` defaults to its catalog id), the predicted `touch` set (the intent score's input)
 *  and an optional MANUAL-mode floor `override`. The ENGINE validates every step key and every rule
 *  (compose, the floor, the override in auto mode); this schema only shapes the command. */
export const PlanSchema = z.object({
  steps: z
    .array(z.object({ catalog: z.string().min(1), id: z.string().min(1).optional() }).passthrough())
    .min(1),
  touch: z.array(z.string().min(1)).max(64).optional(),
  override: z.object({ remove: z.array(z.string().min(1)).min(1), reason: z.string().min(1) }).strict().optional(),
}).strict();

/** The parsed plan as the engine command's `LaunchPlan` (an absent optional stays absent). */
export function toLaunchPlan(p: z.infer<typeof PlanSchema>): LaunchPlan {
  const plan: LaunchPlan = { steps: p.steps };
  if (p.touch !== undefined) plan.touch = p.touch;
  if (p.override !== undefined) plan.override = p.override;
  return plan;
}
