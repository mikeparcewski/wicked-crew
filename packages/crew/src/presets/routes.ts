/**
 * `/api/v1/presets` — saved phase selections (DES-TEAMING-002 §8.4, seam C2):
 *
 *   GET    /presets[?projectId=]         the presets a launch in that project sees, by name
 *   GET    /presets/:name[?projectId=]   one preset (the project's row, else the global one)
 *   PUT    /presets/:name                save {steps, projectId?} (global when projectId is absent)
 *   DELETE /presets/:name[?projectId=]   delete in that scope
 *
 * A preset is launched by NAME: `POST /runs {workflow: "<name>"}`. The ENGINE resolves it (the
 * launch's project row, then the global row, then a registered workflow of that name), so the same
 * name launches the same selection from a campaign node or a bus `wicked.crew.run.requested` with
 * no crew involvement. These routes are commands and reads over the engine's store (§4.0); crew
 * keeps no copy and publishes no event.
 *
 * Engine error → status: the engine's message leads with a reason token.
 * `preset_builtin_readonly` 409 · `preset_unknown_project` 404 · any other `preset_*` 400.
 * An addon without the bindings answers 501 (PresetsUnsupportedError), never 400.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CoreAdapter } from '../core/adapter.js';
import { PresetsUnsupportedError } from '../core/adapter.js';
import type { Actor, Preset, PresetListResponse, PresetResponse, PresetStep } from '../core/types.js';
import { API_PREFIX } from '../api/api-prefix.js';
import { AuditLog } from '../api/audit.js';
import { LOCAL_ACTOR } from '../api/auth.js';

const V = API_PREFIX;

/** One plan step. The engine owns the step rules (`plan::compose`, `deny_unknown_fields`), so
 *  this layer checks only the two keys every step carries and passes the rest through. */
const PresetStepSchema = z.object({ catalog: z.string().min(1), id: z.string().min(1) }).passthrough();

// Exported for tests/wire-contract.test.ts (the request-direction drift guard).
export const PutPresetSchema = z
  .object({
    steps: z.array(PresetStepSchema).min(1),
    projectId: z.string().min(1).optional(),
  })
  .strict();

const ScopeQuerySchema = z.object({ projectId: z.string().min(1).optional() }).strict();

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Engine error → HTTP status (the mapping in the module doc). */
export function presetErrorStatus(err: unknown): number {
  if (err instanceof PresetsUnsupportedError) return 501;
  const msg = message(err);
  if (msg.startsWith('preset_builtin_readonly')) return 409;
  if (msg.startsWith('preset_unknown_project')) return 404;
  return 400;
}

export function registerPresetRoutes(
  app: FastifyInstance,
  adapter: CoreAdapter,
  // Defaulted to a NOOP trail so a directly-driven route set never writes the real audit log.
  security: { audit: AuditLog } = { audit: AuditLog.noop() },
): void {
  const { audit } = security;
  const actorOf = (req: { actor?: Actor }): Actor => req.actor ?? LOCAL_ACTOR;

  app.get(`${V}/presets`, async (req, reply) => {
    const q = ScopeQuerySchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'Invalid query', details: q.error.issues });
    try {
      const body: PresetListResponse = { presets: await adapter.listPresets(q.data.projectId) };
      return body;
    } catch (err) {
      return reply.code(presetErrorStatus(err)).send({ error: message(err) });
    }
  });

  app.get<{ Params: { name: string } }>(`${V}/presets/:name`, async (req, reply) => {
    const q = ScopeQuerySchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'Invalid query', details: q.error.issues });
    try {
      const preset: Preset | undefined = (await adapter.listPresets(q.data.projectId)).find(
        (p) => p.name === req.params.name,
      );
      if (preset === undefined) return reply.code(404).send({ error: `no preset \`${req.params.name}\`` });
      const body: PresetResponse = { preset };
      return body;
    } catch (err) {
      return reply.code(presetErrorStatus(err)).send({ error: message(err) });
    }
  });

  app.put<{ Params: { name: string } }>(`${V}/presets/:name`, async (req, reply) => {
    const parsed = PutPresetSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    }
    try {
      const preset = await adapter.putPreset(
        req.params.name,
        parsed.data.steps as PresetStep[],
        parsed.data.projectId,
        'api',
      );
      audit.record('preset.saved', actorOf(req), { detail: { name: preset.name, scope: preset.scope } });
      const body: PresetResponse = { preset };
      return body;
    } catch (err) {
      return reply.code(presetErrorStatus(err)).send({ error: message(err) });
    }
  });

  app.delete<{ Params: { name: string } }>(`${V}/presets/:name`, async (req, reply) => {
    const q = ScopeQuerySchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'Invalid query', details: q.error.issues });
    try {
      const deleted = await adapter.deletePreset(req.params.name, q.data.projectId);
      if (!deleted) return reply.code(404).send({ error: `no preset \`${req.params.name}\` in that scope` });
      audit.record('preset.deleted', actorOf(req), {
        detail: { name: req.params.name, projectId: q.data.projectId ?? null },
      });
      return reply.code(204).send();
    } catch (err) {
      return reply.code(presetErrorStatus(err)).send({ error: message(err) });
    }
  });
}
