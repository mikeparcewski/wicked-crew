/**
 * `GET /api/v1/setup/known` (program DES-LEARN §4): what the first run shows before it asks — the git
 * identity, the registered repositories' languages, the git checkouts near them, and (crew#1527) whether
 * delivery can push ({@link readDeliveryReadiness}). Operator trust: it names folders in the home directory.
 */

import type { FastifyInstance } from 'fastify';
import type { CoreAdapter } from '../core/adapter.js';
import type { Actor } from '../core/types.js';
import { API_PREFIX } from '../api/api-prefix.js';
import { LOCAL_ACTOR, trustAtLeast } from '../api/auth.js';
import { setupKnown, type SetupKnown } from './known.js';
import { readDeliveryReadiness } from './delivery-readiness.js';

const V = API_PREFIX;

export function registerSetupRoutes(
  app: FastifyInstance,
  deps: { adapter: Pick<CoreAdapter, 'listRepos' | 'getSettings'>; known?: typeof setupKnown; delivery?: typeof readDeliveryReadiness },
): void {
  const known = deps.known ?? setupKnown;
  const delivery = deps.delivery ?? readDeliveryReadiness;
  app.get(
    `${V}/setup/known`,
    { config: { manifest: { responseType: 'SetupKnown', statusCodes: [200, 403] } } },
    async (req, reply) => {
      const actor = (req as { actor?: Actor }).actor ?? LOCAL_ACTOR;
      if (!trustAtLeast(actor, 'operator')) return reply.code(403).send({ error: 'what this computer holds is an operator read' });
      const [facts, ready] = await Promise.all([
        deps.adapter.listRepos().then((repos) => known(repos)),
        deps.adapter.getSettings().then((settings) => delivery(settings)),
      ]);
      const body: SetupKnown = { ...facts, delivery: ready };
      return body;
    },
  );
}
