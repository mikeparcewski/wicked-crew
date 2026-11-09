/**
 * The repo watcher's routes (crew-0183):
 *
 *   GET  /repo-watch                every watched repo's code map standing (`RepoWatchStatus`)
 *   PUT  /repos/:id/watch           the per-repo off switch `{ enabled }` (`SetRepoWatchBody`)
 *   POST /repos/:id/graph/reindex   Re-index now: queued past the quiet window (202); while runs hold the map, 409
 *                                   naming them, and the request is kept: it runs when they let go
 *
 * `/repo-watch`, not `/repos/watch`: a repo registered under the id `watch` would be shadowed by a static segment.
 * With the watcher off for the daemon (`WICKED_CREW_REPO_WATCH=off`) the status still answers (`enabled: false`)
 * and the writes answer 409 saying so.
 */

import type { FastifyInstance } from 'fastify';
import { z } from '../zod.js';

import type { RepoWatcher } from './repo-watch.js';

const V = '/api/v1';

const SetWatchBody = z.object({ enabled: z.boolean() }).strict();

export function registerRepoWatchRoutes(app: FastifyInstance, watcher: RepoWatcher): void {
  app.get(`${V}/repo-watch`, { config: { manifest: { responseType: 'RepoWatchStatus', statusCodes: [200] } } }, async () => {
    await watcher.syncRepos().catch(() => undefined);
    return watcher.status();
  });

  app.put(
    `${V}/repos/:id/watch`,
    { config: { manifest: { requestType: 'SetRepoWatchBody', responseType: 'RepoGraphWatch', statusCodes: [200, 400, 404, 409] } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = SetWatchBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
      if (!watcher.status().enabled) return reply.code(409).send({ error: 'The repo watcher is off for this daemon (WICKED_CREW_REPO_WATCH=off).' });
      const known = await watcher.setEnabled(id, body.data.enabled);
      const row = watcher.status().repos.find((r) => r.repoId === id);
      if (!known || row === undefined) return reply.code(404).send({ error: `no watched repository '${id}' (only onboarded repositories with a code map are kept current)` });
      return row;
    },
  );

  app.post(
    `${V}/repos/:id/graph/reindex`,
    { config: { manifest: { responseType: 'RepoReindexResult', statusCodes: [202, 404, 409] } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!watcher.status().enabled) return reply.code(409).send({ error: 'The repo watcher is off for this daemon (WICKED_CREW_REPO_WATCH=off).' });
      const out = await watcher.reindexNow(id);
      if (out.unknown === true) return reply.code(404).send({ error: `no watched repository '${id}' (only onboarded repositories with a code map are kept current)` });
      if (!out.queued) {
        return reply.code(409).send({
          error: `${out.waitingOn.length === 1 ? 'A job on this repository is' : `${out.waitingOn.length} jobs on this repository are`} using its code map; it is re-indexed when ${out.waitingOn.length === 1 ? 'it finishes' : 'they finish'}.`,
          queued: false,
          waitingOn: out.waitingOn,
        });
      }
      return reply.code(202).send({ queued: true, waitingOn: [] });
    },
  );
}
