/**
 * The in-flight check's routes (service.ts): `POST /runs/:id/units/:ord/inspect` starts one (a human operator only,
 * audited `unit.inspected`), `GET /runs/:id/units/:ord/inspections` reads them back, newest first. Starting a check
 * never changes the run it looks at.
 */

import type { FastifyInstance } from 'fastify';

import { API_PREFIX as V } from '../api/api-prefix.js';
import type { AuditLog } from '../api/audit.js';
import { LOCAL_ACTOR } from '../api/auth.js';
import { isHumanOperator } from '../api/watch-routes.js';
import type { Actor } from '../core/types.js';
import { InspectError, type InspectService } from './service.js';

export interface InspectRoutesDeps {
  service: Pick<InspectService, 'start' | 'settle'>;
  audit: AuditLog;
}

const ordOf = (raw: string): number | null => (/^\d{1,6}$/.test(raw) ? Number(raw) : null);

export function registerInspectRoutes(app: FastifyInstance, deps: InspectRoutesDeps): void {
  const actorOf = (req: { actor?: Actor }): Actor => req.actor ?? LOCAL_ACTOR;

  app.post(
    `${V}/runs/:id/units/:ord/inspect`,
    { config: { manifest: { responseType: 'UnitInspectionResponse', statusCodes: [202, 400, 403, 404, 409] } } },
    async (req, reply) => {
      const { id, ord: rawOrd } = req.params as { id: string; ord: string };
      const actor = actorOf(req);
      if (!isHumanOperator(actor)) {
        return reply.code(403).send({ error: `Only a person can ask for a check on a step (you are ${actor.kind}/${actor.trust})` });
      }
      const ord = ordOf(rawOrd);
      if (ord === null) return reply.code(400).send({ error: '`ord` must be a step number' });
      try {
        const inspection = await deps.service.start(id, ord, actor.id);
        deps.audit.record('unit.inspected', actor, {
          runId: id,
          detail: { ord, inspection: inspection.id, seat: inspection.seat, checkRunId: inspection.checkRunId, source: inspection.source },
        });
        return reply.code(202).send({ inspection });
      } catch (err) {
        if (err instanceof InspectError) return reply.code(err.status).send({ code: err.code, error: err.message });
        throw err;
      }
    },
  );

  app.get(
    `${V}/runs/:id/units/:ord/inspections`,
    { config: { manifest: { responseType: 'UnitInspectionsResponse', statusCodes: [200, 400] } } },
    async (req, reply) => {
      const { id, ord: rawOrd } = req.params as { id: string; ord: string };
      const ord = ordOf(rawOrd);
      if (ord === null) return reply.code(400).send({ error: '`ord` must be a step number' });
      return { inspections: deps.service.settle(id).filter((r) => r.ord === ord) };
    },
  );
}
