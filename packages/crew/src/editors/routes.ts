/**
 * `/api/v1/editors` (DES-artifact-editor-plugins §6, §8.2, §9.1; EP-C1).
 *
 *  - `GET /editors` (operator+): the registry, as Settings → Editors renders it.
 *  - `POST /editors {packRoot}` (HUMAN-only): garden's fail-closed gate, the approval list, then 501
 *    `third_party_editors_not_available` — every pack editor is third-party and EP-C8 has not shipped.
 *  - `DELETE /editors/:id` (HUMAN-only): a first-party editor ships with studio and cannot be removed
 *    (409; disable it instead); no other editor can exist before EP-C8 (404).
 *  - `POST /editors/:id/enabled {enabled}` (HUMAN-only): the operator's switch.
 *  - `GET /editors/:id/grants?project=` (operator+): the engine's decided set
 *    (`evaluate_editor_grants`: EDITOR-GRANTS ledger + EDITOR-BUILTIN posture, deny dominates), with
 *    the token an "allow" would add. The host fetches it before `host.hello` and enforces it.
 *  - `GET /editors/:id/:version/entry`: the bundle, with exactly the §8.2 headers. The file path comes
 *    from the registry record — never from the URL — and the bytes are re-hashed on every serve: a
 *    changed file answers 409 `bundle_hash_mismatch`, never the changed bundle.
 *
 * Human-only means `actor.kind === 'human'` (the DC `remember()` check). Under `auth=off` every
 * same-uid caller is the local human actor — the honest limit §6.4 states; refusing a worker token
 * is a tripwire, not a control.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { LOCAL_ACTOR, trustAtLeast } from '../api/auth.js';
import type { Actor, EditorGrantsResponse, ListEditorsResponse } from '../core/types.js';
import { bundleHeaders } from './csp.js';
import { PackInstallError, previewPackInstall, type PackCheckRunner } from './pack-install.js';
import { EDITOR_ID, EDITOR_VERSION, EditorRegistry, type EditorRecord } from './registry.js';

const V = '/api/v1';

/** The slice of the adapter the grants route needs; every method optional so a stub never throws. */
export interface EditorGrantsAdapter {
  editorGrantsSupported?(): boolean;
  evaluateEditorGrants?(request: {
    editorId: string;
    version: string;
    sha256: string;
    permissions: string[];
    project?: string;
    firstParty: boolean;
  }): Promise<EditorGrantsResponse>;
}

export interface EditorRoutesDeps {
  registry: EditorRegistry;
  adapter: EditorGrantsAdapter;
  packCheck: PackCheckRunner;
  log?: (msg: string) => void;
}

export function registerEditorRoutes(app: FastifyInstance, deps: EditorRoutesDeps): void {
  const { registry } = deps;
  const actorOf = (req: { actor?: Actor }): Actor => req.actor ?? LOCAL_ACTOR;
  const operatorOnly = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const actor = actorOf(req);
    if (trustAtLeast(actor, 'operator')) return true;
    void reply.code(403).send({ error: `Insufficient trust: editors require 'operator' (you are '${actor.trust}')` });
    return false;
  };
  const humanOnly = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const actor = actorOf(req);
    if (actor.kind === 'human' && trustAtLeast(actor, 'operator')) return true;
    void reply
      .code(403)
      .send({ error: `only a human operator can install, remove, enable or disable an editor (you are ${actor.kind}/${actor.trust})` });
    return false;
  };
  const idOf = (req: FastifyRequest): string => (req.params as { id: string }).id;

  app.get(
    `${V}/editors`,
    { config: { manifest: { responseType: 'ListEditorsResponse', statusCodes: [200, 403] } } },
    async (req, reply) => {
      if (!operatorOnly(req, reply)) return reply;
      const body: ListEditorsResponse = { editors: registry.list().map((r) => EditorRegistry.view(r)), installs: 'refused_until_conformance' };
      return body;
    },
  );

  const InstallSchema = z.object({ packRoot: z.string().min(1) }).strict();
  app.post(
    `${V}/editors`,
    { config: { manifest: { responseType: 'InstallEditorRefusal', statusCodes: [400, 403, 404, 422, 501] } } },
    async (req, reply) => {
      if (!humanOnly(req, reply)) return reply;
      const parsed = InstallSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'body must be { packRoot: <absolute path> }' });
      try {
        const refusal = await previewPackInstall(parsed.data.packRoot, deps.packCheck);
        return reply.code(501).send(refusal);
      } catch (err) {
        if (err instanceof PackInstallError) {
          return reply.code(err.status).send({ error: err.message, ...(err.check !== undefined ? { check: err.check } : {}) });
        }
        throw err;
      }
    },
  );

  app.delete(
    `${V}/editors/:id`,
    { config: { manifest: { statusCodes: [403, 404, 409] } } },
    async (req, reply) => {
      if (!humanOnly(req, reply)) return reply;
      const id = idOf(req);
      const record = EDITOR_ID.test(id) ? registry.get(id) : null;
      if (record === null) return reply.code(404).send({ error: `no editor '${id}' is installed` });
      // The only editors that can exist before EP-C8 ship inside studio's bundle.
      return reply.code(409).send({ error: `${id} ships with studio and cannot be removed — disable it instead (POST /editors/${id}/enabled)` });
    },
  );

  const EnabledSchema = z.object({ enabled: z.boolean() }).strict();
  app.post(
    `${V}/editors/:id/enabled`,
    { config: { manifest: { responseType: 'EditorView', statusCodes: [200, 400, 403, 404] } } },
    async (req, reply) => {
      if (!humanOnly(req, reply)) return reply;
      const parsed = EnabledSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'body must be { enabled: boolean }' });
      const id = idOf(req);
      const next = EDITOR_ID.test(id) ? registry.setEnabled(id, parsed.data.enabled) : null;
      if (next === null) return reply.code(404).send({ error: `no editor '${id}' is installed` });
      return EditorRegistry.view(next);
    },
  );

  app.get(
    `${V}/editors/:id/grants`,
    { config: { manifest: { responseType: 'EditorGrantsResponse', statusCodes: [200, 400, 403, 404, 501, 502] } } },
    async (req, reply) => {
      if (!operatorOnly(req, reply)) return reply;
      const id = idOf(req);
      const record = EDITOR_ID.test(id) ? registry.get(id) : null;
      if (record === null) return reply.code(404).send({ error: `no editor '${id}' is installed` });
      const q = req.query as { project?: string | string[] };
      const projectRaw = Array.isArray(q.project) ? q.project[0] : q.project;
      const project = typeof projectRaw === 'string' && projectRaw.trim() !== '' ? projectRaw.trim() : undefined;
      const { adapter } = deps;
      if (typeof adapter.editorGrantsSupported !== 'function' || !adapter.editorGrantsSupported() || typeof adapter.evaluateEditorGrants !== 'function') {
        return reply.code(501).send({
          error: 'the installed wicked-core-ts has no editor grants (needs wicked-core-ts >= 0.7.35 with the editor-defaults pack)',
        });
      }
      try {
        return await adapter.evaluateEditorGrants({
          editorId: record.manifest.id,
          version: record.manifest.version,
          sha256: record.sha256,
          permissions: record.manifest.permissions.map((p) => p.id),
          ...(project !== undefined ? { project } : {}),
          firstParty: record.firstParty,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(/bad_request/u.test(msg) ? 400 : 502).send({ error: msg });
      }
    },
  );

  app.get(
    `${V}/editors/:id/:version/entry`,
    { config: { manifest: { statusCodes: [200, 404, 409] } } },
    async (req, reply) => {
      const { id, version } = req.params as { id: string; version: string };
      // The URL only SELECTS a record; it never builds a path.
      if (!EDITOR_ID.test(id) || !EDITOR_VERSION.test(version)) return reply.code(404).send({ error: 'no such editor bundle' });
      const record = registry.get(id);
      if (record === null || record.manifest.version !== version) return reply.code(404).send({ error: 'no such editor bundle' });
      if (!record.enabled) return reply.code(404).send({ error: `${id} is disabled` });
      return serveBundle(record, reply, deps.log);
    },
  );
}

/** Re-hash on every serve: a bundle that changed on disk is refused, never served. */
export function serveBundle(record: EditorRecord, reply: FastifyReply, log?: (msg: string) => void): FastifyReply {
  let buf: Buffer;
  try {
    buf = readFileSync(record.entryPath);
  } catch (err) {
    log?.(`[editors] ${record.manifest.id}: entry unreadable at serve time (${err instanceof Error ? err.message : String(err)})`);
    return reply.code(404).send({ error: 'no such editor bundle' });
  }
  const actual = createHash('sha256').update(buf).digest('hex');
  if (actual !== record.sha256) {
    log?.(`[editors] ${record.manifest.id}@${record.manifest.version}: bundle hash changed on disk (pinned ${record.sha256.slice(0, 12)}…, found ${actual.slice(0, 12)}…); refused`);
    return reply.code(409).send({ code: 'bundle_hash_mismatch', error: `the ${record.manifest.id} bundle on disk no longer matches its pinned hash; restart the daemon to re-pin it` });
  }
  for (const [k, v] of Object.entries(bundleHeaders(record))) reply.header(k, v);
  return reply.type('text/html; charset=utf-8').send(buf);
}
