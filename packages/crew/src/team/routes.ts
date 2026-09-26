/**
 * The crew team surface (DES-TEAMING-002 T8): reads and commands over the engine. Commands go
 * through the API, facts go on the bus (§4.0); crew publishes no team row.
 *
 *   GET  /runs/:id/team         the engine's persisted team state (`Core.runTeam`) joined with the
 *                               run's `wicked.team.*` bus rows and the folded ledger each gate read
 *   POST /runs/:id/plan         a plan edit at a `plan_approval` gate (`confirmGate … edit_plan`)
 *   POST /team/outbox/replay    `Core.replayTeamOutbox`: the team outbox onto the bus
 *   GET  /catalog               the engine's phase catalog
 *   POST /plans/preview         the engine's floor fill of a draft plan
 *
 * The live stream is the relay (`team/ws-relay.ts`). An addon without a binding answers 501.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CoreAdapter } from '../core/adapter.js';
import { PlanLaunchUnsupportedError, TeamUnsupportedError } from '../core/adapter.js';
import { crewBusHandle } from '../core/bus-handle.js';
import type {
  Actor,
  SessionStatus,
  CatalogResponse,
  RunTeamResponse,
  RunTeamUnit,
  RunTeamView,
  TeamLedger,
  TeamRow,
} from '../core/types.js';
import { API_PREFIX } from '../api/api-prefix.js';
import { AuditLog } from '../api/audit.js';
import { LOCAL_ACTOR } from '../api/auth.js';
import { PlanSchema, toLaunchPlan } from '../api/plan-schema.js';

const V = API_PREFIX;

// Exported for tests/wire-contract.test.ts (the request-direction drift guard).
export const EditPlanSchema = z
  .object({ plan: PlanSchema, requestId: z.string().min(1).max(128).optional() })
  .strict();

/** The 501 for a plan edit off a `plan_approval` gate: the engine has no mid-run edit command yet. */
const MID_RUN_EDIT =
  "mid-run plan edits need the engine's proposePlan (not in wicked-core-ts yet); today a plan edit " +
  'answers a plan_approval gate';
/** The engine's refusal of an edit when the paused run's open gate is not a plan approval. */
const NO_PLAN_GATE = /no plan_approval gate open/;
export const PlanPreviewSchema = z
  .object({
    plan: PlanSchema,
    projectId: z.string().min(1).optional(),
    humanConfirm: z.string().min(1).optional(),
  })
  .strict();

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const TERMINAL: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['completed', 'cancelled', 'failed']);

/** A run that is not a team run: no transport at all (not the "none" fallback), nothing to join. */
function unteamed(runId: string, status: SessionStatus): RunTeamResponse {
  return {
    runId,
    teamed: false,
    transport: null,
    reason: null,
    streamFloor: null,
    planRev: null,
    pending: null,
    ended: TERMINAL.has(status),
    units: [],
    rows: [],
  };
}

/** The run's `wicked.team.*` rows, by `event_id`; `[]` when the bus is absent or unreadable. */
function busRows(busDbPath: string | undefined, runId: string): TeamRow[] {
  if (busDbPath === undefined) return [];
  try {
    // The daemon's ONE long-lived crew handle on the bus (core/bus-handle.ts), never a
    // per-request open/close, which would release the locks the engine's connection holds.
    const rows = crewBusHandle(busDbPath, { create: false })
      .prepare(
        `SELECT event_id, event_type, payload, emitted_at FROM events
          WHERE event_type LIKE 'wicked.team.%' AND json_extract(payload, '$.run_id') = ?
          ORDER BY event_id`,
      )
      .all(runId) as Array<{ event_id: number; event_type: string; payload: string; emitted_at: number }>;
    return rows.map(
      (r) =>
        ({
          event_id: r.event_id,
          event_type: r.event_type,
          payload: JSON.parse(r.payload) as unknown,
          emitted_at: r.emitted_at,
        }) as TeamRow,
    );
  } catch {
    // No bus file / no events table: the engine's snapshot still answers.
    return [];
  }
}

const fold = (ord: unknown, attempt: unknown) => `ledger.folded#${String(ord)}:${String(attempt)}`;

/**
 * Join the bus rows onto the engine's snapshot. Rows with `ord: null` are the run's; the rest go
 * to their unit. `gate.opened{kind:"unit_review"}.ledger_ref` is the only authority on which
 * ledger a gate read: the `ledger.folded` row it names is the unit's `ledger`, and a fold for an
 * attempt whose gate named another ledger is labelled `unused`.
 */
export function joinTeam(view: RunTeamView, rows: TeamRow[]): RunTeamResponse {
  const read = new Map<string, string | null>(); // "<ord>:<attempt>" → the ledger_ref its gate read
  for (const r of rows) {
    if (r.event_type === 'wicked.team.gate.opened' && r.payload.kind === 'unit_review') {
      read.set(`${String(r.payload.ord)}:${String(r.payload.attempt)}`, r.payload.ledger_ref);
    }
  }
  const labelled = rows.map((r): TeamRow => {
    if (r.event_type !== 'wicked.team.ledger.folded') return r;
    const key = `${String(r.payload.ord)}:${String(r.payload.attempt)}`;
    return read.has(key) && read.get(key) !== fold(r.payload.ord, r.payload.attempt) ? { ...r, unused: true } : r;
  });
  const units: RunTeamUnit[] = view.units.map((u) => {
    const own = labelled.filter((r) => r.payload.ord === u.ord);
    const used = own.find(
      (r) => r.event_type === 'wicked.team.ledger.folded' && fold(r.payload.ord, r.payload.attempt) === u.ledgerRef,
    );
    const ledger: TeamLedger | null =
      used !== undefined && used.event_type === 'wicked.team.ledger.folded' ? used.payload.ledger : null;
    return { ...u, rows: own, ledger };
  });
  return { ...view, teamed: true, units, rows: labelled.filter((r) => r.payload.ord === null) };
}

export function registerTeamRoutes(
  app: FastifyInstance,
  adapter: CoreAdapter,
  // Defaulted to a NOOP trail so a directly-driven route set never writes the real audit log.
  security: { audit: AuditLog } = { audit: AuditLog.noop() },
): void {
  const { audit } = security;
  const actorOf = (req: { actor?: Actor }): Actor => req.actor ?? LOCAL_ACTOR;
  const unsupported = (err: unknown) => err instanceof TeamUnsupportedError || err instanceof PlanLaunchUnsupportedError;
  const findRun = async (id: string) => (await adapter.sessionsDetail()).find((v) => v.session.id === id);

  app.get<{ Params: { id: string } }>(
    `${V}/runs/:id/team`,
    { config: { manifest: { responseType: 'RunTeamResponse', statusCodes: [200, 404, 501] } } },
    async (req, reply) => {
      const { id } = req.params;
      try {
        const run = await findRun(id);
        if (run === undefined) return reply.code(404).send({ error: 'Run not found' });
        const view = await adapter.runTeam(id);
        if (view === null) return unteamed(id, run.session.status);
        return joinTeam(view, busRows(adapter.busDbPath, id));
      } catch (err) {
        return reply.code(unsupported(err) ? 501 : 500).send({ error: message(err) });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    `${V}/runs/:id/plan`,
    {
      config: {
        manifest: {
          requestType: 'EditPlanBody',
          responseType: '{ status: SessionStatus }',
          // 501: off a plan_approval gate (a mid-run edit needs proposePlan) or no plan gate in the
          // addon; 409: the engine refused the edit.
          statusCodes: [200, 400, 404, 409, 501],
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const parsed = EditPlanSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
      }
      const run = await findRun(id);
      if (run === undefined) return reply.code(404).send({ error: 'Run not found' });
      if (run.session.status !== 'awaiting_human') {
        return reply.code(501).send({ error: `${MID_RUN_EDIT} (status: ${run.session.status})` });
      }
      try {
        // The edit IS the gate answer (T3): the engine proposes it (`plan.proposed{by:"human",
        // kind:"edit"}`), floor-fills and accepts it, or refuses it and re-opens the gate.
        const status = await adapter.confirmGate(id, true, undefined, 'edit_plan', undefined, toLaunchPlan(parsed.data.plan));
        // WHO answered the gate, like every other gate answer (POST /runs/:id/gate).
        audit.record('gate.decided', actorOf(req), {
          runId: id,
          detail: { approve: true, action: 'edit_plan', planSteps: parsed.data.plan.steps.length, status },
        });
        return { status };
      } catch (err) {
        if (NO_PLAN_GATE.test(message(err))) return reply.code(501).send({ error: `${MID_RUN_EDIT}: ${message(err)}` });
        return reply.code(unsupported(err) ? 501 : 409).send({ error: message(err) });
      }
    },
  );

  app.post(
    `${V}/team/outbox/replay`,
    { config: { manifest: { responseType: 'TeamOutboxReplayReport', statusCodes: [200, 409, 501] } } },
    async (req, reply) => {
      try {
        const report = await adapter.replayTeamOutbox();
        audit.record('team.outbox.replayed', actorOf(req), {
          detail: { published: report.published.length, remaining: report.remaining },
        });
        return report;
      } catch (err) {
        // The engine refuses when it has no bus or no state home: a state, not a bad request.
        return reply.code(unsupported(err) ? 501 : 409).send({ error: message(err) });
      }
    },
  );

  app.get(
    `${V}/catalog`,
    { config: { manifest: { responseType: 'CatalogResponse', statusCodes: [200, 501] } } },
    async (_req, reply) => {
      try {
        const body: CatalogResponse = { entries: await adapter.catalog() };
        return body;
      } catch (err) {
        return reply.code(unsupported(err) ? 501 : 500).send({ error: message(err) });
      }
    },
  );

  app.post(
    `${V}/plans/preview`,
    {
      config: {
        manifest: { requestType: 'PlanPreviewBody', responseType: 'PlanPreviewResponse', statusCodes: [200, 400, 501] },
      },
    },
    async (req, reply) => {
      const parsed = PlanPreviewSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
      }
      try {
        return await adapter.previewPlan(
          toLaunchPlan(parsed.data.plan),
          parsed.data.projectId,
          parsed.data.humanConfirm,
        );
      } catch (err) {
        // The engine's refusal of the draft (compose, the override in auto mode, …) is the answer.
        return reply.code(unsupported(err) ? 501 : 400).send({ error: message(err) });
      }
    },
  );
}
