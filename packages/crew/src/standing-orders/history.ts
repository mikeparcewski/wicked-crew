/**
 * The decided-gate history — `GET /gates/decided?since=<unix ms>`.
 *
 * What a skin needs to show a seat's track record on a kind of step (brainstorm-actionable idea 7)
 * and to offer "make it a rule" with a preview of what the order would have done (idea 8). Read,
 * never stored: every row is one `gate.decided` line of the daemon's audit trail (WHO decided, and
 * what), joined to the engine's gate row for the same `(run, ord)` (the gate's kind and the unit it
 * reviewed) and to the run (its project, its accepted plan band, the seat that created the work).
 *
 * `phase` and `orderApprovable` are the standing-order evaluator's own readings (`gatePhase`,
 * `orderMayApprove`), so a preview counts exactly the gates an order would have matched.
 */

import type { FastifyInstance } from 'fastify';
import { API_PREFIX } from '../api/api-prefix.js';
import type { AuditLog } from '../api/audit.js';
import type { AuditEntry, SessionView } from '../core/types.js';
import { gatePhase, orderMayApprove } from './evaluator.js';

/** One engine gate row, as far as the history reads it. */
export interface GateRowFact {
  session_id: string;
  ord: number | null;
  reviewing_ord: number | null;
  [k: string]: unknown;
}

export interface DecidedGateRow {
  runId: string;
  ord: number | null;
  decidedAt: number;
  decision: 'approve' | 'request_changes' | 'reject' | 'edit_plan';
  actor: string;
  byOrder: boolean;
  gateKind: string | null;
  phase: string | null;
  projectId: string | null;
  band: string | null;
  creator: { seat: string; phase: string | null; ord: number } | null;
  orderApprovable: boolean;
}

export interface GateHistoryDeps {
  audit: Pick<AuditLog, 'read'>;
  views: () => Promise<SessionView[]>;
  /** Every engine gate row (any status); `null`/`[]` when the engine cannot say. */
  gateRows: () => Promise<GateRowFact[] | null>;
  projectOf: (runId: string) => string | undefined;
  /** Approving this run's gate would land doctrine (a steering-author run). */
  landsDoctrine: (view: SessionView) => boolean;
}

/** The band the run's accepted plan landed in (`team_plan.accepted.band`), or undefined. */
export function runBand(view: SessionView): string | undefined {
  const plan = (view.session as { team_plan?: { accepted?: { band?: unknown } | null } | null }).team_plan;
  const band = plan?.accepted?.band;
  return typeof band === 'string' && band !== '' ? band : undefined;
}

/** The preset the run's launch named (`team_plan.preset`); undefined on a user plan or a workflow. */
export function runPreset(view: SessionView): string | undefined {
  const preset = (view.session as { team_plan?: { preset?: unknown } | null }).team_plan?.preset;
  return typeof preset === 'string' && preset !== '' ? preset : undefined;
}

/** The run's project: its own filing, else the membership index (the evaluator's reading). */
export function runProject(view: SessionView | undefined, runId: string, projectOf: (id: string) => string | undefined): string | undefined {
  const own = view?.session.project_id;
  return typeof own === 'string' && own !== 'default' ? own : projectOf(runId);
}

/**
 * The unit whose work a gate before `ord` judges: the newest unit before it whose role is
 * `creator`, else the newest non-evaluator `build`-stage unit before it (studio's `creatorUnitBefore`).
 */
function creatorBefore(units: SessionView['units'], ord: number): SessionView['units'][number] | undefined {
  const before = units.filter((u) => u.ord < ord).sort((a, b) => b.ord - a.ord);
  return (
    before.find((u) => (u as { role?: string }).role === 'creator') ??
    before.find((u) => u.stage === 'build' && (u as { role?: string }).role !== 'evaluator')
  );
}

/**
 * The decision a `gate.decided` line records. A token outside the four named arms falls back on
 * `approve`: an `action` the engine added later reads by its `approve` flag — `floor_fix`
 * (crew#891, wicked-core#782: an approve with a note at a read-only phase's floor gate) IS an
 * approve, and the escalation arms (`extend`, `targeted`, `accept_partial`, `accept_suggestion`,
 * `amend_intent`) are all approve-shaped.
 */
export function decisionOf(detail: Record<string, unknown>): DecidedGateRow['decision'] {
  const action = detail['action'];
  if (action === 'request_changes' || action === 'reject' || action === 'edit_plan' || action === 'approve') return action;
  return detail['approve'] === true ? 'approve' : 'reject';
}

export async function decidedGates(deps: GateHistoryDeps, since: number | undefined): Promise<DecidedGateRow[]> {
  const entries: AuditEntry[] = await deps.audit.read({
    action: 'gate.decided',
    limit: 1000,
    ...(since !== undefined ? { since } : {}),
  });
  if (entries.length === 0) return [];
  const [views, rows] = await Promise.all([deps.views(), deps.gateRows().catch(() => null)]);
  const byRun = new Map(views.map((v) => [v.session.id, v]));
  const rowOf = new Map<string, GateRowFact>();
  for (const r of rows ?? []) if (typeof r.ord === 'number') rowOf.set(`${r.session_id}:${r.ord}`, r);

  return entries
    .filter((e) => typeof e.runId === 'string')
    .map((e): DecidedGateRow => {
      const runId = e.runId as string;
      const detail = (e.detail ?? {}) as Record<string, unknown>;
      const ord = typeof detail['ord'] === 'number' ? detail['ord'] : null;
      const decision = decisionOf(detail);
      const view = byRun.get(runId);
      const row = ord !== null ? rowOf.get(`${runId}:${ord}`) : undefined;
      const kind = typeof row?.['gate_kind'] === 'string' && row['gate_kind'] !== '' ? (row['gate_kind'] as string) : null;
      // A plan edit is only ever a plan gate's answer, and it names no ord.
      const gateKind = kind ?? (decision === 'edit_plan' || detail['planSteps'] !== undefined ? 'plan_approval' : null);
      const units = view?.units ?? [];
      const facts = {
        phaseOf: (o: number) => units.find((u) => u.ord === o)?.phase_ref ?? undefined,
        firstOrd: units.length === 0 ? undefined : Math.min(...units.map((u) => u.ord)),
        landsDoctrine: view !== undefined && deps.landsDoctrine(view),
      };
      // Without the engine's row the reviewed unit is unknown, so the phase is too (never guessed
      // from the gate's own ord, which would name the NEXT phase).
      const phase = row !== undefined && ord !== null && view !== undefined ? gatePhase(facts, ord, row.reviewing_ord).phase || null : null;
      const creatorUnit = ord !== null && gateKind !== 'plan_approval' ? creatorBefore(units, ord) : undefined;
      const actorId = e.actor?.id ?? '';
      return {
        runId,
        ord,
        decidedAt: e.ts,
        decision,
        actor: actorId,
        byOrder: actorId.startsWith('standing-order:'),
        gateKind,
        phase,
        projectId: runProject(view, runId, deps.projectOf) ?? null,
        band: view !== undefined ? runBand(view) ?? null : null,
        creator:
          creatorUnit !== undefined && typeof creatorUnit.assigned_cli === 'string' && creatorUnit.assigned_cli !== ''
            ? { seat: creatorUnit.assigned_cli, phase: creatorUnit.phase_ref ?? null, ord: creatorUnit.ord }
            : null,
        orderApprovable: gateKind !== null && view !== undefined && orderMayApprove(gateKind, facts),
      };
    });
}

export function registerGateHistoryRoute(app: FastifyInstance, deps: GateHistoryDeps): void {
  app.get(
    `${API_PREFIX}/gates/decided`,
    { config: { manifest: { responseType: 'DecidedGatesResponse', statusCodes: [200, 400, 500] } } },
    async (req, reply) => {
      const raw = (req.query as { since?: string | string[] }).since;
      const sinceRaw = (Array.isArray(raw) ? raw[0] : raw)?.trim() || undefined;
      const since = sinceRaw !== undefined ? Number(sinceRaw) : undefined;
      if (sinceRaw !== undefined && (!Number.isInteger(since) || (since as number) < 0)) {
        return reply.code(400).send({ error: '`since` must be a non-negative integer (unix millis)' });
      }
      try {
        return { gates: await decidedGates(deps, since) };
      } catch (err) {
        return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}
