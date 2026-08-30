/**
 * The `/api/v1/campaigns` surface (crew#342 + TH-9; DES-CAMPAIGN-001 §8).
 *
 * Thin by design: validation is zod (strict, unknown keys named — the FINDING-031 doctrine),
 * scenario→node mapping is `plan.ts` (pure), and the scheduler is the ENGINE's (durable,
 * single-writer, crash-resumable) — the daemon keeps no shadow campaign state, so a restarted
 * daemon and a second daemon over the same db answer these routes identically. Campaign
 * progress is NOT polled from here: the 11 `campaign*` CoreEvents ride the daemon's existing
 * allowlist-free `/ws` relay the moment the engine emits them.
 *
 * Error posture mirrors the chat/elicitation surfaces: a build whose engine addon lacks the
 * campaign bindings answers 501 (`CampaignsUnsupportedError` — "upgrade the engine"), never
 * 400 ("fix your request").
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { CampaignsUnsupportedError, type CoreAdapter } from '../core/adapter.js';
import type { Actor, LaunchCampaignBody } from '../core/types.js';
import type { AuditLog } from '../api/audit.js';
import { API_PREFIX } from '../api/api-prefix.js';
import { buildCampaign } from './plan.js';

const V = API_PREFIX;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Same unknown-key-naming 400 body builder as api/routes.ts (restated because that module
 *  does not export it and importing routes.ts here would be a cycle through registerRoutes). */
function invalidBody(err: z.ZodError, what: string): { error: string; details: z.ZodIssue[] } {
  const unknown = err.issues.flatMap((i) => (i.code === 'unrecognized_keys' ? i.keys : []));
  const error =
    unknown.length > 0
      ? `${what}: unknown field${unknown.length > 1 ? 's' : ''} ${unknown
          .map((k) => `\`${k}\``)
          .join(', ')} — this endpoint does not accept ${
          unknown.length > 1 ? 'them' : 'it'
        }, and ignoring ${unknown.length > 1 ? 'them' : 'it'} would run a different request than you sent`
      : what;
  return { error, details: err.issues };
}

const ScenarioSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().optional(),
    deps: z.array(z.string()).optional(),
    depsCondition: z.enum(['on_success', 'on_terminal']).optional(),
    tool: z.object({ cmd: z.array(z.string()).min(1) }).strict().optional(),
    agent: z
      .object({ problem: z.string().min(1), workflow: z.string().optional() })
      .strict()
      .optional(),
    repoRef: z.string().optional(),
  })
  .strict();

const LaunchCampaignSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().max(200).optional(),
    scenarios: z.array(ScenarioSchema).min(1),
    policy: z.enum(['fail_fast', 'continue_independent', 'human_gate_on_failure']).optional(),
    maxConcurrency: z.number().int().min(1).max(64).optional(),
    clisJson: z.string().optional(),
  })
  .strict();

export interface CampaignRoutesDeps {
  audit: AuditLog;
  actorOf: (req: FastifyRequest & { actor?: Actor }) => Actor;
  /** The default council roster for agent scenarios (already parsed). */
  roster: () => unknown[];
}

export function registerCampaignRoutes(
  app: FastifyInstance,
  adapter: CoreAdapter,
  deps: CampaignRoutesDeps,
): void {
  app.post(
    `${V}/campaigns`,
    {
      config: {
        manifest: {
          requestType: 'LaunchCampaignBody',
          responseType: '{ campaignId: string }',
          // 400: zod reject / mapping reject (inline-byte rule, unknown dep, …) / engine def
          // reject (cycle, empty); 409: campaign id already exists; 501: engine addon lacks
          // the campaign bindings.
          statusCodes: [201, 400, 409, 501],
        },
      },
    },
    async (req, reply) => {
      const parsed = LaunchCampaignSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send(invalidBody(parsed.error, 'Invalid request body'));
      }
      const body = parsed.data as LaunchCampaignBody;
      try {
        const clis: unknown[] =
          body.clisJson !== undefined ? (JSON.parse(body.clisJson) as unknown[]) : deps.roster();
        if (!Array.isArray(clis)) {
          return reply
            .code(400)
            .send({ error: 'clisJson must be a JSON array of AgenticCli seats' });
        }
        const built = buildCampaign(body, clis);
        const campaignId = await adapter.launchCampaign(built.def, built.workflows);
        deps.audit.record('campaign.launched', deps.actorOf(req), {
          detail: {
            campaignId,
            nodes: built.def.nodes.length,
            edges: built.def.edges.length,
            policy: built.def.policy,
            maxConcurrency: built.def.max_concurrency,
          },
        });
        return reply.code(201).send({ campaignId });
      } catch (err) {
        if (err instanceof CampaignsUnsupportedError) {
          return reply.code(501).send({ error: err.message });
        }
        const msg = message(err);
        // A campaign id that already exists is a state conflict on a real resource.
        if (/already exists|already launched/i.test(msg)) {
          return reply.code(409).send({ error: msg });
        }
        return reply.code(400).send({ error: msg });
      }
    },
  );

  app.get(
    `${V}/campaigns`,
    {
      config: {
        manifest: { responseType: '{ campaigns: Campaign[] }', statusCodes: [200, 501] },
      },
    },
    async (_req, reply) => {
      try {
        return { campaigns: await adapter.campaignList() };
      } catch (err) {
        if (err instanceof CampaignsUnsupportedError) {
          return reply.code(501).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.get(
    `${V}/campaigns/:id`,
    {
      config: {
        manifest: { responseType: '{ campaign: Campaign }', statusCodes: [200, 404, 501] },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const campaign = await adapter.campaignDetail(id);
        if (campaign === null) {
          return reply.code(404).send({ error: `unknown campaign: ${id}` });
        }
        return { campaign };
      } catch (err) {
        if (err instanceof CampaignsUnsupportedError) {
          return reply.code(501).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  // Resume / cancel share one wrapper: both resolve the campaign status token, both 404 on an
  // id the engine does not know, and both are actor-audited state transitions.
  const transition = (
    action: 'resume' | 'cancel',
    run: (id: string) => Promise<string>,
  ) => {
    app.post(
      `${V}/campaigns/:id/${action}`,
      {
        config: {
          manifest: {
            responseType: '{ campaignId: string; status: CampaignStatus }',
            statusCodes: [200, 404, 409, 501],
          },
        },
      },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        try {
          const status = await run(id);
          deps.audit.record(`campaign.${action === 'resume' ? 'resumed' : 'cancelled'}`, deps.actorOf(req), {
            detail: { campaignId: id, status },
          });
          return { campaignId: id, status };
        } catch (err) {
          if (err instanceof CampaignsUnsupportedError) {
            return reply.code(501).send({ error: err.message });
          }
          const msg = message(err);
          if (/not found|unknown campaign/i.test(msg)) {
            return reply.code(404).send({ error: msg });
          }
          return reply.code(409).send({ error: msg });
        }
      },
    );
  };
  transition('resume', (id) => adapter.resumeCampaign(id));
  transition('cancel', (id) => adapter.cancelCampaign(id));
}
