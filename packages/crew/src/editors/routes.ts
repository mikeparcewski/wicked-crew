/**
 * `/api/v1/editors` (DES-artifact-editor-plugins §6, §8.2, §9.1; EP-C1).
 *
 *  - `GET /editors` (operator+): the registry, as Settings → Editors renders it.
 *  - `POST /editors {packRoot, enabled?}` (HUMAN-only): install or update a pack's editors — garden's
 *    fail-closed gate, then crew's own conformance run, then the registry (`pack-install.ts`). 200 with
 *    the installed editors; 422 with the verdict or the conformance report; 501 with the approval list
 *    for a pack that also ships skills or blocks; 409 for an id another pack or a first-party editor holds.
 *  - `DELETE /editors/:id` (HUMAN-only): an installed pack editor is removed from the registry (the
 *    installer deletes its files); a first-party editor ships with studio and cannot be removed (409;
 *    disable it instead).
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
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { LOCAL_ACTOR, trustAtLeast } from '../api/auth.js';
import type { Actor, ConformanceRule, EditorGrantsResponse, ListEditorsResponse } from '../core/types.js';
import { bundleHeaders } from './csp.js';
import { installPack, PackInstallError, type ConformanceRunner, type PackCheckRunner } from './pack-install.js';
import { EDITOR_ID, EDITOR_VERSION, EditorRegistry, HOST_BUNDLE_CAP_BYTES, notRealEntry, readCapped, type EditorRecord } from './registry.js';

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
  /** The rule store, for the install consent's `mcp.session` grant (DES-MCP-INSPECTOR-001 §6). */
  listConformanceRules?(): Promise<ConformanceRule[]>;
  upsertConformanceRule?(rule: ConformanceRule): Promise<void>;
}

/** The approvals ledger the engine reads (core `editor_gate.rs` GRANTS_LEDGER). */
export const EDITOR_GRANTS_LEDGER = 'EDITOR-GRANTS';
/** The permission only an install consent grants: no posture or allow rule can (core LEDGER_ONLY_PERMISSIONS). */
export const INSTALL_GRANTED = 'mcp.session';

export function grantToken(id: string, version: string, sha256: string, permission: string): string {
  return `editor:${id}@${version}#${sha256}/${permission}`;
}

/**
 * Rewrite the ledger's `mcp.session` tokens for `ids`: every token of those editors is dropped, and
 * `add` (this install's tokens, for the builds that declare it) is written. One read-modify-write;
 * nothing is written when the list is unchanged. With nothing to add, an engine with no ledger has
 * no grant to withdraw, so that is no change; with something to add it is an error (it would ask).
 *
 * The edit is serialized against the other editor routes only. A governance write landing between
 * the read and the upsert is not covered, the same limit as the MCP approvals ledger (`mcp/policies.ts`).
 */
export async function editInstallGrants(
  adapter: EditorGrantsAdapter,
  ids: readonly string[],
  add: readonly string[],
): Promise<void> {
  const unavailable = (why: string): void => {
    if (add.length > 0) throw new Error(why);
  };
  if (typeof adapter.listConformanceRules !== 'function' || typeof adapter.upsertConformanceRule !== 'function') {
    return unavailable('this engine cannot write editor grants');
  }
  const rules = await adapter.listConformanceRules();
  const ledger = rules.find((r) => r.id === EDITOR_GRANTS_LEDGER);
  if (ledger === undefined) return unavailable(`the ${EDITOR_GRANTS_LEDGER} ledger is not in the policy store; restart the daemon to seed it`);
  const owned = (t: string): boolean => ids.some((id) => t.startsWith(`editor:${id}@`) && t.endsWith(`/${INSTALL_GRANTED}`));
  const before = ledger.excludes ?? [];
  const dedup = [...new Set([...before.filter((t) => !owned(t)), ...add])];
  if (dedup.length === before.length && dedup.every((t, i) => t === before[i])) return;
  await adapter.upsertConformanceRule({ ...ledger, excludes: dedup });
}

export function registerEditorRoutes(app: FastifyInstance, deps: EditorRoutesDeps): void {
  const { registry } = deps;
  // Ledger edits are read-modify-write: serialize them so two installs never drop each other's token.
  let chain: Promise<unknown> = Promise.resolve();
  const grantChain = <T>(f: () => Promise<T>): Promise<T> => {
    const r = chain.then(f, f);
    chain = r.catch(() => undefined);
    return r;
  };
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
      const body: ListEditorsResponse = { editors: registry.list().map((r) => EditorRegistry.view(r)), installs: 'conformance_required' };
      return body;
    },
  );

  const InstallSchema = z.object({ packRoot: z.string().min(1), enabled: z.boolean().optional() }).strict();
  app.post(
    `${V}/editors`,
    { config: { manifest: { responseType: 'InstallEditorResponse', statusCodes: [200, 400, 403, 404, 409, 422, 501] } } },
    async (req, reply) => {
      if (!humanOnly(req, reply)) return reply;
      const parsed = InstallSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'body must be { packRoot: <absolute path>, enabled?: boolean }' });
      try {
        const installed = await installPack(parsed.data.packRoot, parsed.data.enabled, { check: deps.packCheck, conformance: deps.conformance, registry });
        deps.log?.(`[editors] installed ${installed.editors.map((e) => `${e.id}@${e.version}`).join(', ')}${installed.updated ? ' (update)' : ''}`);
        // The install consent IS the mcp.session grant (DES-MCP-INSPECTOR-001 §6): this human-only
        // call, after the operator approved the install, writes each declaring editor's per-build
        // token. Every installed editor's earlier tokens are dropped first (codex r1: an update that
        // no longer declares it keeps none), and an editor that does not declare it gets none.
        const declaring = installed.editors.filter((e) => e.permissions.some((p) => p.id === INSTALL_GRANTED));
        const tokens = declaring.map((e) => grantToken(e.id, e.version, e.sha256, INSTALL_GRANTED));
        try {
          await grantChain(() => editInstallGrants(deps.adapter, installed.editors.map((e) => e.id), tokens));
          if (declaring.length === 0) return installed;
          deps.log?.(`[editors] install consent granted ${INSTALL_GRANTED} to ${declaring.map((e) => `${e.id}@${e.version}`).join(', ')}`);
          return { ...installed, granted: tokens };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          deps.log?.(`[editors] installed, but the ${INSTALL_GRANTED} grants were not written: ${msg}`);
          if (declaring.length === 0) return installed;
          return { ...installed, grantError: `installed, but ${INSTALL_GRANTED} was not granted (it asks): ${msg}` };
        }
      } catch (err) {
        if (err instanceof PackInstallError) {
          return reply.code(err.status).send({ error: err.message, ...(err.check !== undefined ? { check: err.check } : {}), ...(err.body ?? {}) });
        }
        throw err;
      }
    },
  );

  app.delete(
    `${V}/editors/:id`,
    { config: { manifest: { statusCodes: [200, 403, 404, 409, 503] } } },
    async (req, reply) => {
      if (!humanOnly(req, reply)) return reply;
      const id = idOf(req);
      if (!EDITOR_ID.test(id)) return reply.code(404).send({ error: `no editor '${id}' is installed` });
      if (registry.get(id)?.firstParty === true) {
        return reply.code(409).send({ error: `${id} ships with studio and cannot be removed — disable it instead (POST /editors/${id}/enabled)` });
      }
      if (registry.get(id) === null) return reply.code(404).send({ error: `no editor '${id}' is installed` });
      // Its install grant goes first (codex r1): a failed withdrawal keeps the editor installed, so a
      // retry of this DELETE can still reach it, and never leaves a grant behind a removed editor.
      try {
        await grantChain(() => editInstallGrants(deps.adapter, [id], []));
      } catch (err) {
        return reply.code(503).send({ error: `${id} was not removed: its ${INSTALL_GRANTED} grant could not be withdrawn (${err instanceof Error ? err.message : String(err)}); try again` });
      }
      if (!registry.removeInstalled(id)) return reply.code(404).send({ error: `no editor '${id}' is installed` });
      return { removed: true, id };
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
  // The same fence as discovery, re-applied per serve (codex r1): an entry swapped for a link after
  // boot is refused before a byte is read.
  const problem = notRealEntry(record.entryPath, 'file');
  if (problem !== null) {
    log?.(`[editors] ${record.manifest.id}: entry is ${problem} at serve time; refused`);
    return reply.code(404).send({ error: 'no such editor bundle' });
  }
  let buf: Buffer | null;
  try {
    buf = readCapped(record.entryPath, record.manifest.limits?.bundleBytes ?? HOST_BUNDLE_CAP_BYTES);
  } catch (err) {
    log?.(`[editors] ${record.manifest.id}: entry unreadable at serve time (${err instanceof Error ? err.message : String(err)})`);
    return reply.code(404).send({ error: 'no such editor bundle' });
  }
  if (buf === null) {
    log?.(`[editors] ${record.manifest.id}@${record.manifest.version}: entry grew over its cap on disk; refused`);
    return reply.code(409).send({ code: 'bundle_hash_mismatch', error: `the ${record.manifest.id} bundle on disk no longer matches its pinned hash; restart the daemon to re-pin it` });
  }
  const actual = createHash('sha256').update(buf).digest('hex');
  if (actual !== record.sha256) {
    log?.(`[editors] ${record.manifest.id}@${record.manifest.version}: bundle hash changed on disk (pinned ${record.sha256.slice(0, 12)}…, found ${actual.slice(0, 12)}…); refused`);
    return reply.code(409).send({ code: 'bundle_hash_mismatch', error: `the ${record.manifest.id} bundle on disk no longer matches its pinned hash; restart the daemon to re-pin it` });
  }
  for (const [k, v] of Object.entries(bundleHeaders(record))) reply.header(k, v);
  return reply.type('text/html; charset=utf-8').send(buf);
}
