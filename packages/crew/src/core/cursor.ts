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
  /** What runs the unit (crew #580 / #581, DES-L3 addendum): `tool` = the engine's own command
   *  (`tool_cmd` on the unit DTO — the deliver script, a wicked-estate index), `agent` = a CLI
   *  seat. The stall watchdog never fails a tool unit over to a seat — there is none to fail to. */
  executor: 'tool' | 'agent';
  /** The cursor's declared phase role when the def carries one (`evaluator` / `creator` / …);
   *  absent on free-text units. Read by the watchdog's role-aware failover (DES-L3 PR-3E). */
  role?: string;
}

/**
 * Resolves a run's cursor unit, or `undefined` when the view carries no units (older engines,
 * stub adapters) or `unit_ix` names no entry.
 */
export function resolveCursorUnit(view: SessionView): CursorUnit | undefined {
  const cursor = [...view.units].sort((a, b) => a.ord - b.ord)[view.session.unit_ix];
  if (cursor === undefined) return undefined;
  const role = (cursor as { role?: unknown }).role;
  return {
    ord: cursor.ord,
    ...(cursor.assigned_cli != null ? { cli: cursor.assigned_cli } : {}),
    executor: cursor.tool_cmd != null ? 'tool' : 'agent',
    ...(typeof role === 'string' ? { role } : {}),
  };
}
