import Fastify from 'fastify';
import { isUnitTokenRoute } from './auth.js';
import { registerJsonParser } from './json-parser.js';
import { registerUnitRoutes, type UnitRouteDeps } from './mcp.js';

/** Mutable boot state: routes read the bound port, never a pre-listen snapshot. */
export interface UnitListenerState {
  port?: number;
  close?: () => Promise<void>;
}

export function unitPortFromEnv(value: string | undefined): number {
  if (value === undefined) return 0;
  if (!/^[0-9]+$/.test(value) || !Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error('WICKED_CREW_UNIT_PORT must be a decimal integer from 1 to 65535');
  }
  return Number(value);
}

/** No operator routes, SPA fallback, CORS, or automatic HEAD registration. */
export function createUnitListener(deps: UnitRouteDeps): ReturnType<typeof Fastify> {
  const app = Fastify({ exposeHeadRoutes: false });
  app.addHook('onRequest', async (req, reply) => {
    if (!isUnitTokenRoute(req.method, req.url.split('?')[0] ?? req.url)) {
      return reply.code(404).send({ error: 'not found' });
    }
  });
  registerJsonParser(app);
  registerUnitRoutes(app, deps);
  app.setNotFoundHandler(async (_req, reply) => reply.code(404).send({ error: 'not found' }));
  return app;
}
