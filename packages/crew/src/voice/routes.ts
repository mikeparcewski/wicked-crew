/**
 * Voice mode's routes (program DES-VOICE §3, §6; api-types `VoiceStatus`, `VoiceTranscribeResponse`,
 * `VoiceDashboard`):
 *
 *   GET    /voice/status       the engine and the model on this machine, and a download in progress
 *   POST   /voice/model        {consent: true} → start fetching the model (202); audited
 *   DELETE /voice/model        remove the model; audited
 *   POST   /voice/transcribe   audio/wav body → {text, ms, model}; the audio is never stored
 *   GET    /voice/dashboard    this person's dashboard layout and user widgets
 *   PUT    /voice/dashboard    {layout, widgets} → the same shape
 *
 * Every voice route is the human operator's alone and answers only a loopback caller: a worker's bearer (a
 * non-human actor) gets 403, and a request from another host gets 403 even on a daemon bound wider.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AuditLog } from '../api/audit.js';
import { API_PREFIX } from '../api/api-prefix.js';
import { LOCAL_ACTOR } from '../api/auth.js';
import { isHumanOperator } from '../api/watch-routes.js';
import type { Actor } from '../core/types.js';
import { PutVoiceDashboardSchema, type VoiceDashboardStore } from './dashboard.js';
import { VOICE_MAX_AUDIO_BYTES, VoiceError, type VoiceService } from './service.js';

const V = API_PREFIX;

export const PostVoiceModelSchema = z.object({ consent: z.literal(true) }).strict();

export interface VoiceRouteDeps {
  voice: VoiceService;
  dashboard: VoiceDashboardStore | null;
  audit: Pick<AuditLog, 'record'>;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** The loopback, human-operator fence every voice route shares; null = allowed. */
export function voiceRefusal(req: FastifyRequest & { actor?: Actor }): { error: string; code: string } | null {
  const ip = req.socket?.remoteAddress ?? req.ip;
  if (ip !== undefined && !LOOPBACK.has(ip)) {
    return { error: 'Voice is answered only on this machine (a loopback caller).', code: 'voice_loopback_only' };
  }
  const actor = req.actor ?? LOCAL_ACTOR;
  if (!isHumanOperator(actor)) {
    return { error: `Voice is the human operator's alone (you are ${actor.kind}/${actor.trust}).`, code: 'human_operator_only' };
  }
  return null;
}

function fail(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof VoiceError) return reply.code(e.status).send(e.body());
  return reply.code(500).send({ error: e instanceof Error ? e.message : String(e), code: 'voice_failed' });
}

export function registerVoiceRoutes(app: FastifyInstance, deps: VoiceRouteDeps): void {
  const actorOf = (req: { actor?: Actor }): Actor => req.actor ?? LOCAL_ACTOR;

  void app.register(async (scope) => {
    // The recording arrives as raw bytes, buffered by a parser scoped to these routes alone.
    for (const type of ['audio/wav', 'audio/x-wav', 'audio/wave']) {
      scope.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: VOICE_MAX_AUDIO_BYTES + 1024 }, (_req, body, done) => done(null, body));
    }
    scope.setErrorHandler((err, _req, reply) => {
      const code = (err as { code?: unknown }).code;
      if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
        return reply.code(413).send({ error: `The recording is over ${Math.round(VOICE_MAX_AUDIO_BYTES / 1048576)} MiB; speak in shorter turns.`, code: 'voice_audio_too_large' });
      }
      if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
        return reply.code(415).send({ error: 'Send the recording as audio/wav.', code: 'voice_audio_invalid' });
      }
      return reply.send(err);
    });
    scope.addHook('preHandler', async (req, reply) => {
      const refused = voiceRefusal(req as FastifyRequest & { actor?: Actor });
      if (refused !== null) return reply.code(403).send(refused);
      return undefined;
    });

    scope.get(
      `${V}/voice/status`,
      { config: { manifest: { responseType: 'VoiceStatus', statusCodes: [200, 403] } } },
      async () => deps.voice.status(),
    );

    scope.post(
      `${V}/voice/model`,
      { config: { manifest: { requestType: 'PostVoiceModelBody', responseType: 'VoiceStatus', statusCodes: [200, 202, 400, 403, 409] } } },
      async (req, reply) => {
        const parsed = PostVoiceModelSchema.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'Downloading the speech model needs your consent: send {"consent": true}.', code: 'voice_consent_required' });
        }
        try {
          const { started } = deps.voice.startDownload();
          if (started) deps.audit.record('voice.model.download_started', actorOf(req), { detail: { model: deps.voice.status().model.name } });
          return reply.code(started ? 202 : 200).send(deps.voice.status());
        } catch (e) {
          return fail(reply, e);
        }
      },
    );

    scope.delete(
      `${V}/voice/model`,
      { config: { manifest: { responseType: 'VoiceStatus', statusCodes: [200, 403] } } },
      async (req) => {
        const { removed } = deps.voice.removeModel();
        if (removed) deps.audit.record('voice.model.removed', actorOf(req), { detail: { model: deps.voice.status().model.name } });
        return deps.voice.status();
      },
    );

    scope.post(
      `${V}/voice/transcribe`,
      { config: { manifest: { requestType: 'audio/wav', responseType: 'VoiceTranscribeResponse', statusCodes: [200, 400, 403, 409, 413, 415, 429, 500, 504] } } },
      async (req, reply) => {
        if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: 'Send the recording as audio/wav.', code: 'voice_audio_invalid' });
        try {
          // Nothing about the audio is logged or audited: not its bytes, not its words.
          return await deps.voice.transcribe(req.body);
        } catch (e) {
          return fail(reply, e);
        }
      },
    );

    scope.get(
      `${V}/voice/dashboard`,
      { config: { manifest: { responseType: 'VoiceDashboard', statusCodes: [200, 403, 503] } } },
      async (req, reply) => {
        if (deps.dashboard === null) return reply.code(503).send({ error: 'This daemon keeps no dashboard store.', code: 'voice_dashboard_unavailable' });
        return deps.dashboard.get(actorOf(req).id);
      },
    );

    scope.put(
      `${V}/voice/dashboard`,
      { config: { manifest: { requestType: 'PutVoiceDashboardBody', responseType: 'VoiceDashboard', statusCodes: [200, 400, 403, 503] } } },
      async (req, reply) => {
        if (deps.dashboard === null) return reply.code(503).send({ error: 'This daemon keeps no dashboard store.', code: 'voice_dashboard_unavailable' });
        const parsed = PutVoiceDashboardSchema.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'Invalid dashboard', details: parsed.error.issues });
        return deps.dashboard.put(actorOf(req).id, parsed.data);
      },
    );
  });
}
