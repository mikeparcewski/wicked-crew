/**
 * The web source's sheet routes (CS9), registered with the source routes:
 *
 *   GET  /sources/web/setup     observer   what the install puts on this computer (shown BEFORE consent) and its state
 *   POST /sources/web/install   HUMAN      the consented install: the body echoes the lock and image the person saw
 *   GET  /runs/:id/web-receipts observer, HUMAN only   (CS3's ask) the run's web receipts (a unit reads its own run's as
 *                                                     `mcp:web/receipts`, bound to the run the engine bound its token to)
 *
 * "Agents can query" is the source's ordinary switch (`PUT /sources/web/agents`), OFF after every install.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { trustAtLeast } from '../../../api/auth.js';
import { API_PREFIX } from '../../../api/api-prefix.js';
import type { Actor, RunWebReceiptsResponse, WebSourceInstallResponse, WebSourceSetupResponse } from '../../../core/types.js';
import { McpRegistryError, type McpRegistry } from '../../../mcp/registry.js';
import { z } from '../../../zod.js';
import { WebInstallError, readLock } from './fetch.js';
import { type WebGate, WEB_SOURCE } from './gate-web.js';
import { SEARXNG_DIGEST, SearchUnavailableError } from './searxng.js';
import { type WebSource, WebSourceRefusal } from './source.js';

const V = API_PREFIX;

export const WebSourceInstallSchema = z.strictObject({
  consent: z.strictObject({ lock: z.string().regex(/^[0-9a-f]{64}$/), image: z.string().regex(/^sha256:[0-9a-f]{64}$/) }),
});

export interface WebSourceRouteDeps {
  registry?: Pick<McpRegistry, 'registerWebSource'>;
  gate?: Pick<WebGate, 'entry' | 'receipts'>;
  web?: Pick<WebSource, 'setup' | 'install' | 'isInstalling' | 'stop'>;
  audit: { record(action: string, actor: Actor, fields?: { runId?: string; detail?: Record<string, unknown> }): unknown };
  actorOf: (req: FastifyRequest) => Actor;
}

export function registerWebSourceRoutes(app: FastifyInstance, deps: WebSourceRouteDeps): void {
  const setup = async (): Promise<WebSourceSetupResponse> => {
    const e = deps.gate === undefined ? null : await deps.gate.entry();
    return (deps.web as NonNullable<typeof deps.web>).setup(e !== null, e === null ? null : e.access);
  };

  if (deps.web !== undefined) {
    const web = deps.web;
    app.addHook('onClose', async () => {
      await web.stop();
    });
  }

  app.get(`${V}/sources/${WEB_SOURCE}/setup`, { config: { manifest: { responseType: 'WebSourceSetupResponse', statusCodes: [200, 503] } } }, async (_req, reply) => {
    if (deps.web === undefined || deps.gate === undefined) return reply.code(503).send({ error: 'the web source is not available on this daemon', code: 'web_unavailable' });
    return setup();
  });

  app.get<{ Params: { id: string } }>(
    `${V}/runs/:id/web-receipts`,
    { config: { manifest: { responseType: 'RunWebReceiptsResponse', statusCodes: [200, 403, 503] } } },
    async (req, reply) => {
      // Any run id may be asked for here, so only a person may ask: a non-human actor reads its own run's receipts
      // through the gate, where the engine binds the run.
      const actor = deps.actorOf(req);
      if (actor.kind !== 'human') return reply.code(403).send({ error: `only a person reads a run's web receipts here; you are ${actor.kind}`, code: 'human_only' });
      if (deps.gate === undefined) return reply.code(503).send({ error: 'the web source is not available on this daemon', code: 'web_unavailable' });
      try {
        const r = await deps.gate.receipts(req.params.id);
        const body: RunWebReceiptsResponse = { runId: req.params.id, known: true, complete: r.complete, receipts: r.receipts };
        return body;
      } catch {
        // An unreadable record is UNKNOWN, never "no web reads".
        const body: RunWebReceiptsResponse = { runId: req.params.id, known: false, complete: false, receipts: [] };
        return body;
      }
    },
  );

  app.post(
    `${V}/sources/${WEB_SOURCE}/install`,
    { config: { manifest: { requestType: 'WebSourceInstallBody', responseType: 'WebSourceInstallResponse', statusCodes: [200, 400, 403, 409, 422, 502, 503] } } },
    async (req, reply) => {
      const actor = deps.actorOf(req);
      // A person's consent: an agent-kind actor, whatever its trust, never installs software on this computer.
      if (!(actor.kind === 'human' && trustAtLeast(actor, 'operator'))) {
        return reply.code(403).send({ error: `only a human operator can install the web source; you are ${actor.kind}/${actor.trust}`, code: 'web_install_human_only' });
      }
      const parsed = WebSourceInstallSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), code: 'bad_request' });
      if (deps.web === undefined || deps.registry === undefined || deps.gate === undefined) return reply.code(503).send({ error: 'the web source is not available on this daemon', code: 'web_unavailable' });
      const lock = readLock();
      // Consent is to exactly what the sheet showed: another lock or image (a crew upgrade in between) asks again.
      if (parsed.data.consent.lock !== lock.sha256 || parsed.data.consent.image !== SEARXNG_DIGEST) {
        return reply.code(409).send({ error: 'what you consented to is not what this crew installs (it was upgraded meanwhile): review the sheet again', code: 'consent_stale' });
      }
      if (deps.web.isInstalling) return reply.code(409).send({ error: 'the web source is being installed already', code: 'install_running' });
      deps.audit.record('knowledge.source.web_install_started', actor, { detail: { lock: lock.sha256, image: SEARXNG_DIGEST } });
      try {
        await deps.web.install(parsed.data.consent.lock);
        await deps.registry.registerWebSource(WEB_SOURCE);
      } catch (err) {
        const code = err instanceof WebSourceRefusal || err instanceof WebInstallError || err instanceof SearchUnavailableError || err instanceof McpRegistryError ? err.code : 'install_failed';
        deps.audit.record('knowledge.source.web_install_failed', actor, { detail: { code } });
        if (err instanceof WebSourceRefusal) return reply.code(err.code === 'consent_stale' ? 409 : 422).send({ error: err.message, code });
        if (err instanceof McpRegistryError) return reply.code(err.status).send({ error: err.message, code });
        if (err instanceof WebInstallError || err instanceof SearchUnavailableError) return reply.code(502).send({ error: err.message, code });
        if (err instanceof Error && err.message === 'an install is already running') return reply.code(409).send({ error: 'the web source is being installed already', code: 'install_running' });
        throw err;
      }
      deps.audit.record('knowledge.source.web_installed', actor, { detail: { lock: lock.sha256, image: SEARXNG_DIGEST, query: false } });
      const body: WebSourceInstallResponse = { setup: await setup() };
      return body;
    },
  );
}
