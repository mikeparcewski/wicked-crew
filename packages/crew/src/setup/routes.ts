/**
 * `GET /api/v1/setup/known` (program DES-LEARN §4): what the first run shows before it asks — the git
 * identity, the registered repositories' languages, and the git checkouts near them. Operator trust:
 * it names folders in the home directory.
 */

import type { FastifyInstance } from 'fastify';
import type { CoreAdapter } from '../core/adapter.js';
import type { Actor } from '../core/types.js';
import { API_PREFIX } from '../api/api-prefix.js';
import { LOCAL_ACTOR, trustAtLeast } from '../api/auth.js';
import { setupKnown, type SetupKnown } from './known.js';

const V = API_PREFIX;

export function registerSetupRoutes(
  app: FastifyInstance,
  deps: { adapter: Pick<CoreAdapter, 'listRepos'>; known?: typeof setupKnown },
): void {
  const known = deps.known ?? setupKnown;
  app.get(
    `${V}/setup/known`,
    { config: { manifest: { responseType: 'SetupKnown', statusCodes: [200, 403] } } },
    async (req, reply) => {
      const actor = (req as { actor?: Actor }).actor ?? LOCAL_ACTOR;
      if (!trustAtLeast(actor, 'operator')) return reply.code(403).send({ error: 'what this computer holds is an operator read' });
      const body: SetupKnown = await known(await deps.adapter.listRepos());
      return body;
    },
  );
}
