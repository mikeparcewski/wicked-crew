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
 *  - `POST /editors/:id/grants {permission, allow, version, sha256, project?}` (HUMAN-only, §6.4; F37):
 *    the person's allow or revoke of one permission the editor declares, for the build they were shown
 *    (`version` + `sha256` must still be the installed build, else 409 `build_changed`). Allow writes
 *    that build's token (built from crew's own record) into the EDITOR-GRANTS ledger, for every project;
 *    revoke drops every token of that editor and permission. `mcp.session` is the install consent's
 *    alone (409 `install_only`). Under `auth=off` a request carrying a governed unit's token is refused
 *    (403 `seat_token`; 503 when the engine cannot tell; under `auth=required` such a token is no identity
 *    at all: 401). An install, update or removal drops every grant of the editor. `project` only
 *    scopes the answer: the decided set after the write, so a project deny that dominates shows as deny.
 *  - `GET /editors/:id/:version/entry`: the bundle, with exactly the §8.2 headers. The file path comes
 *    from the registry record — never from the URL — and the bytes are re-hashed on every serve: a
 *    changed file answers 409 `bundle_hash_mismatch`, never the changed bundle. The pinned bytes are
 *    served with the WebRTC prelude at the start of each inline script (`webrtc-guard.ts`); a third-party
 *    bundle with more than 200 inline script elements (repeats count: each gains the prelude) answers 409
 *    `bundle_too_many_scripts`.
 *
 * Human-only means `actor.kind === 'human'` (the DC `remember()` check). Under `auth=off` every
 * same-uid caller is the local human actor — the honest limit §6.4 states; refusing a worker token
 * is a tripwire, not a control.
 */

import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from '../zod.js';

import { LOCAL_ACTOR, trustAtLeast } from '../api/auth.js';
import type { Actor, ConformanceRule, EditorGrantsResponse, ListEditorsResponse } from '../core/types.js';
import { bundleHeaders } from './csp.js';
import { installPack, PackInstallError, type ConformanceRunner, type PackCheckRunner } from './pack-install.js';
import { EDITOR_ID, EDITOR_VERSION, EditorRegistry, HOST_BUNDLE_CAP_BYTES, notRealEntry, readCapped, type EditorRecord } from './registry.js';
import { guardBundle, MAX_INLINE_SCRIPTS, type GuardedBundle } from './webrtc-guard.js';

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
  /** The rule store, for the install consent's `mcp.session` grant (DES-MCP-INSPECTOR-001 §6) and the
   *  person's allow / revoke (`POST /editors/:id/grants`). */
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
 * Rewrite the ledger's tokens for the editors `builds` just installed: EVERY token of those editors is
 * dropped (F37: an install or update asks again for what the person allowed, the same build included,
 * and nothing piles up), and `add` (this install's `mcp.session` consent tokens, for the builds that
 * declare it) is written. One read-modify-write;
 * nothing is written when the list is unchanged. With nothing to add, an engine with no ledger has
 * no grant to withdraw, so that is no change; with something to add it is an error (it would ask).
 *
 * The edit is serialized against the other editor routes only. A governance write landing between
 * the read and the upsert is not covered, the same limit as the MCP approvals ledger (`mcp/policies.ts`).
 */
export async function editInstallGrants(
  adapter: EditorGrantsAdapter,
  builds: ReadonlyArray<{ id: string; version: string; sha256: string }>,
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
  // Every earlier grant of an installed editor goes (codex r2: a same-build "keep" let a failed cleanup resurrect an
  // old build's allow on its reinstall); only this install's consent tokens are written back.
  const owned = (t: string): boolean => builds.some((b) => t.startsWith(`editor:${b.id}@`));
  const before = ledger.excludes ?? [];
  const dedup = [...new Set([...before.filter((t) => !owned(t)), ...add])];
  if (dedup.length === before.length && dedup.every((t, i) => t === before[i])) return;
  await adapter.upsertConformanceRule({ ...ledger, excludes: dedup });
}

/** Every ledger token of editor `id` (any build), optionally only those of one permission. */
function tokenOf(id: string, permission?: string): (t: string) => boolean {
  return (t) => t.startsWith(`editor:${id}@`) && (permission === undefined || t.endsWith(`/${permission}`));
}

/**
 * The person's allow or revoke of one permission (F37). One read-modify-write of the ledger: `add` (the
 * build's token, or null to revoke) replaces every token of `id` + `permission`; or, with `permission`
 * undefined and `add` null, every token of `id` goes (a removal). Throws when the ledger cannot be
 * written for an allow; nothing is written when the list is unchanged. Serialized against the other
 * editor routes only: a governance rule write landing between the read and the upsert is not covered,
 * the same stated limit as {@link editInstallGrants} and the MCP approvals ledger.
 */
export async function editGrant(adapter: EditorGrantsAdapter, id: string, permission: string | undefined, add: string | null): Promise<void> {
  // With nothing to add, an engine with no ledger has no grant to withdraw: that is no change.
  const unavailable = (why: string): void => {
    if (add !== null) throw new Error(why);
  };
  if (typeof adapter.listConformanceRules !== 'function' || typeof adapter.upsertConformanceRule !== 'function') {
    return unavailable('this engine cannot write editor grants');
  }
  const rules = await adapter.listConformanceRules();
  const ledger = rules.find((r) => r.id === EDITOR_GRANTS_LEDGER);
  if (ledger === undefined) return unavailable(`the ${EDITOR_GRANTS_LEDGER} ledger is not in the policy store; restart the daemon to seed it`);
  const before = ledger.excludes ?? [];
  const owned = tokenOf(id, permission);
  const next = [...new Set([...before.filter((t) => !owned(t)), ...(add !== null ? [add] : [])])];
  if (next.length === before.length && next.every((t, i) => t === before[i])) return;
  await adapter.upsertConformanceRule({ ...ledger, excludes: next });
}

/** The bearer a request carries, if any (`Authorization: Bearer <token>`). */
function bearerOf(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(\S+)\s*$/iu.exec(h);
  return m === null ? null : m[1]!;
}

/**
 * A governed unit's token → true (the engine's `resolveEstateScope` names its unit), anything else → false.
 * The §6.4 tripwire for the grant write: under `auth=off` every caller is the local human, so a worker
 * that SENDS its token is caught here; one that omits it is the stated honest limit.
 */
export type UnitTokenVerdict = 'unit' | 'not_unit' | 'unknown';

/**
 * The engine's word on a bearer: `unit` (it names the unit), `not_unit` (it refused the token as
 * `invalid_token:`), or `unknown` (any other failure, or an answer without a unit): the tripwire then
 * fails CLOSED, so a resolver fault never waves a worker's token through (codex r1).
 */
export function unitTokenProbe(resolve: ((requestJson: string) => Promise<string>) | null): ((token: string) => Promise<UnitTokenVerdict>) | undefined {
  if (resolve === null) return undefined;
  return async (token) => {
    let raw: string;
    try {
      raw = await resolve(JSON.stringify({ token }));
    } catch (err) {
      return /^invalid_token\b/u.test(err instanceof Error ? err.message : String(err)) ? 'not_unit' : 'unknown';
    }
    try {
      const unit = (JSON.parse(raw) as { unit?: { runId?: unknown } }).unit;
      return typeof unit?.runId === 'string' ? 'unit' : 'unknown';
    } catch {
      return 'unknown';
    }
  };
}

export interface EditorRoutesDeps {
  registry: EditorRegistry;
  adapter: EditorGrantsAdapter;
  packCheck: PackCheckRunner;
  /** The install-time conformance run (garden's runner against this daemon's conformance host page). */
  conformance: ConformanceRunner;
  /** The §6.4 tripwire: is this bearer a governed unit's token? Absent = no engine to ask (nothing refused on it). */
  isUnitToken?: (token: string) => Promise<UnitTokenVerdict>;
  log?: (msg: string) => void;
}

export function registerEditorRoutes(app: FastifyInstance, deps: EditorRoutesDeps): void {
  const { registry } = deps;
  // An install or a removal is ONE serialized step with its ledger edit (codex r2): the ledger edit is
  // read-modify-write, and a removal interleaved with an install could otherwise remove the new
  // build while the install still writes its grant.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
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
      .send({ error: `only a human operator can install, remove, enable or disable an editor, or allow what it asks for (you are ${actor.kind}/${actor.trust})` });
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

  const InstallSchema = z.strictObject({ packRoot: z.string().min(1), enabled: z.boolean().optional() });
  app.post(
    `${V}/editors`,
    { config: { manifest: { responseType: 'InstallEditorResponse', statusCodes: [200, 400, 403, 404, 409, 422, 501] } } },
    async (req, reply) => {
      if (!humanOnly(req, reply)) return reply;
      const parsed = InstallSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'body must be { packRoot: <absolute path>, enabled?: boolean }' });
      try {
        return await serial(async () => {
          const installed = await installPack(parsed.data.packRoot, parsed.data.enabled, { check: deps.packCheck, conformance: deps.conformance, registry });
          deps.log?.(`[editors] installed ${installed.editors.map((e) => `${e.id}@${e.version}`).join(', ')}${installed.updated ? ' (update)' : ''}`);
          // The install consent IS the mcp.session grant (DES-MCP-INSPECTOR-001 §6): this human-only
          // call, after the operator approved the install, writes each declaring editor's per-build
          // token. Every installed editor's earlier tokens are dropped first (codex r1: an update that
          // no longer declares it keeps none), and an editor that does not declare it gets none.
          const declaring = installed.editors.filter((e) => e.permissions.some((p) => p.id === INSTALL_GRANTED));
          const tokens = declaring.map((e) => grantToken(e.id, e.version, e.sha256, INSTALL_GRANTED));
          try {
            await editInstallGrants(deps.adapter, installed.editors, tokens);
            if (declaring.length === 0) return installed;
            deps.log?.(`[editors] install consent granted ${INSTALL_GRANTED} to ${declaring.map((e) => `${e.id}@${e.version}`).join(', ')}`);
            return { ...installed, granted: tokens };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            deps.log?.(`[editors] installed, but the ${INSTALL_GRANTED} grants were not written: ${msg}`);
            // Said either way (codex r2): with nothing to grant, an earlier build's token was not withdrawn.
            const what = declaring.length > 0
              ? `${INSTALL_GRANTED} was not granted (it asks), and its earlier grants were not withdrawn`
              : `its earlier grants (any permission you allowed) were not withdrawn`;
            return { ...installed, grantError: `installed, but ${what}: ${msg}` };
          }
        });
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
      return serial(async () => {
        // Installed = served or skipped at boot (codex r2: a skipped one has no live record but is removable).
        if (!registry.isInstalled(id)) return reply.code(404).send({ error: `no editor '${id}' is installed` });
        // Its grants go first (codex r1): a failed withdrawal keeps the editor installed, so a retry of
        // this DELETE can still reach it, and never leaves a grant behind a removed editor. Every grant,
        // not only the install's (F37): a reinstall of the same build asks again for what the person allowed.
        try {
          await editGrant(deps.adapter, id, undefined, null);
        } catch (err) {
          return reply.code(503).send({ error: `${id} was not removed: its grants could not be withdrawn (${err instanceof Error ? err.message : String(err)}); try again` });
        }
        if (!registry.removeInstalled(id)) return reply.code(404).send({ error: `no editor '${id}' is installed` });
        return { removed: true, id };
      });
    },
  );

  const EnabledSchema = z.strictObject({ enabled: z.boolean() });
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

  const grantsSupported = (): boolean => {
    const { adapter } = deps;
    return typeof adapter.editorGrantsSupported === 'function' && adapter.editorGrantsSupported() && typeof adapter.evaluateEditorGrants === 'function';
  };
  const NO_GRANTS = 'the installed wicked-core-ts has no editor grants (needs wicked-core-ts >= 0.7.35 with the editor-defaults pack)';
  /** The engine's decided set for this record (its pinned version + hash), or the reply that says why not. */
  const decide = async (record: EditorRecord, project: string | undefined, reply: FastifyReply): Promise<EditorGrantsResponse | FastifyReply> => {
    try {
      return await deps.adapter.evaluateEditorGrants!({
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
  };
  const projectOf = (raw: unknown): string | undefined => {
    const v = Array.isArray(raw) ? raw[0] : raw;
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  };

  app.get(
    `${V}/editors/:id/grants`,
    { config: { manifest: { responseType: 'EditorGrantsResponse', statusCodes: [200, 400, 403, 404, 501, 502] } } },
    async (req, reply) => {
      if (!operatorOnly(req, reply)) return reply;
      const id = idOf(req);
      const record = EDITOR_ID.test(id) ? registry.get(id) : null;
      if (record === null) return reply.code(404).send({ error: `no editor '${id}' is installed` });
      if (!grantsSupported()) return reply.code(501).send({ error: NO_GRANTS });
      return decide(record, projectOf((req.query as { project?: unknown }).project), reply);
    },
  );

  // F37: the person's allow / revoke of one permission (§6.2 ledger, §6.4 human-only).
  const GrantSchema = z.strictObject({
    permission: z.string().min(1),
    allow: z.boolean(),
    version: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    project: z.string().optional(),
  });
  app.post(
    `${V}/editors/:id/grants`,
    { config: { manifest: { requestType: 'SetEditorGrantBody', responseType: 'EditorGrantsResponse', statusCodes: [200, 400, 403, 404, 409, 501, 502, 503] } } },
    async (req, reply) => {
      if (!humanOnly(req, reply)) return reply;
      // The tripwire (§6.4): a request that carries a governed unit's token is a worker's, whatever the auth mode says.
      // Under auth=required the bearer already proved a human operator (a unit token is no identity there: 401), so
      // only the local actor of auth=off is checked; with no engine to ask, a bearer cannot be cleared (codex r2).
      const bearer = actorOf(req) === LOCAL_ACTOR ? bearerOf(req) : null;
      const verdict: UnitTokenVerdict = bearer === null ? 'not_unit' : deps.isUnitToken !== undefined ? await deps.isUnitToken(bearer) : 'unknown';
      if (verdict === 'unit') {
        deps.log?.(`[editors] refused a grant write carrying a governed unit's token (${idOf(req)})`);
        return reply.code(403).send({ code: 'seat_token', error: 'a governed worker cannot allow or revoke an editor permission; only the person can, in studio' });
      }
      if (verdict === 'unknown') {
        return reply.code(503).send({ error: 'could not tell whether this request carries a governed worker\'s token, so nothing was changed; try again' });
      }
      const parsed = GrantSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'body must be { permission: <permission id>, allow: boolean, version: <the version shown>, sha256: <the hash shown>, project?: <project id> }' });
      const { permission, allow } = parsed.data;
      const id = idOf(req);
      if (!EDITOR_ID.test(id) || registry.get(id) === null) return reply.code(404).send({ error: `no editor '${id}' is installed` });
      if (!grantsSupported()) return reply.code(501).send({ error: NO_GRANTS });
      return serial(async () => {
        // Read the record INSIDE the chain: a removal or an update queued before this press has landed.
        const record = registry.get(id);
        if (record === null) return reply.code(404).send({ error: `no editor '${id}' is installed` });
        // The press is for the build the person was shown (codex r1): an update in between asks again.
        if (record.manifest.version !== parsed.data.version || record.sha256 !== parsed.data.sha256) {
          return reply.code(409).send({ code: 'build_changed', error: `${id} changed to version ${record.manifest.version} since this was shown; nothing was changed: look again and decide for the new version` });
        }
        if (!record.manifest.permissions.some((p) => p.id === permission)) {
          return reply.code(400).send({ error: `${id} does not ask for '${permission}'` });
        }
        if (permission === INSTALL_GRANTED) {
          return reply.code(409).send({ code: 'install_only', error: `${INSTALL_GRANTED} is granted only by the editor's install consent; reinstall it to grant it, remove it to withdraw it` });
        }
        // The token is crew's own measurement of this build, never the caller's.
        const token = grantToken(record.manifest.id, record.manifest.version, record.sha256, permission);
        try {
          await editGrant(deps.adapter, id, permission, allow ? token : null);
        } catch (err) {
          return reply.code(503).send({ error: `not ${allow ? 'allowed' : 'revoked'}: ${err instanceof Error ? err.message : String(err)}` });
        }
        deps.log?.(`[editors] ${allow ? 'allowed' : 'revoked'} ${permission} for ${id}@${record.manifest.version}`);
        return decide(record, projectOf(parsed.data.project), reply);
      });
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

/** The guarded form of each pinned bundle, built once per hash (a few entries: one per installed editor build). */
const guardedByHash = new Map<string, GuardedBundle>();
const GUARDED_KEPT = 32;
function guardedFor(record: EditorRecord, buf: Buffer): GuardedBundle {
  const key = `${record.firstParty ? '1' : '3'}:${record.sha256}`;
  const kept = guardedByHash.get(key);
  if (kept !== undefined) return kept;
  const built = guardBundle(buf, record.firstParty ? Number.POSITIVE_INFINITY : MAX_INLINE_SCRIPTS);
  if (guardedByHash.size >= GUARDED_KEPT) guardedByHash.delete(guardedByHash.keys().next().value!);
  guardedByHash.set(key, built);
  return built;
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
  // The prelude goes into every inline script, and a third-party bundle may run only those (`webrtc-guard.ts`). Each
  // script gains the prelude and a hash in the policy header: past the budget crew refuses, and says why, rather than
  // build a body many times the pinned size or a header the browser refuses. The bytes are pinned by their hash, so
  // the guarded form is kept per hash and built once.
  const guarded = guardedFor(record, buf);
  if (guarded.tooMany !== undefined) {
    log?.(`[editors] ${record.manifest.id}@${record.manifest.version}: ${guarded.tooMany} inline scripts, over ${MAX_INLINE_SCRIPTS}; refused`);
    return reply.code(409).send({ code: 'bundle_too_many_scripts', error: `the ${record.manifest.id} bundle has ${guarded.tooMany} inline scripts; an editor bundle may have at most ${MAX_INLINE_SCRIPTS} (merge them into fewer scripts)` });
  }
  for (const [k, v] of Object.entries(bundleHeaders(record, guarded.scriptHashes))) reply.header(k, v);
  return reply.type('text/html; charset=utf-8').send(guarded.body);
}
