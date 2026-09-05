// The CURSOR unit of a run (crew#442): the one `reassignUnit` validates against, resolved
// exactly the way the engine resolves it (`session_units` sorts by `ord`, then indexes
// `unit_ix`). Shared by the stall watchdog's automatic escalation (`server.ts`'s
// `listExecuting` mapper) and the manual `POST /runs/:id/reassign` operator lever
// (`routes.ts`) so the two paths can never disagree on which unit "the cursor" is.
import type { SessionView } from './types.js';

export interface CursorUnit {
  ord: number;
  /** The cursor's assigned seat — absent when the engine hasn't assigned one yet. */
  cli?: string;
}

/**
 * Resolves a run's cursor unit, or `undefined` when the view carries no units (older engines,
 * stub adapters) or `unit_ix` names no entry.
 */
export function resolveCursorUnit(view: SessionView): CursorUnit | undefined {
  const cursor = [...view.units].sort((a, b) => a.ord - b.ord)[view.session.unit_ix];
  if (cursor === undefined) return undefined;
  return { ord: cursor.ord, ...(cursor.assigned_cli != null ? { cli: cursor.assigned_cli } : {}) };
}
