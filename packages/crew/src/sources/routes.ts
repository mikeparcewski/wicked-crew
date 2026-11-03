/**
 * The `/api/v1/sources/*` routes and `POST /api/v1/apps/uploads` (DES-APPS-001 §5, §7.4, §7.6).
 * Sources are entries of crew's ONE connector registry (`/mcp/servers` previews and saves them);
 * these routes are what the source sheet needs beyond that:
 *
 *   GET  /sources/:name/catalog           observer   structure only (`crew` = the built-in source)
 *   POST /sources/:name/describe          operator   describe again now (catalog; Postgres privileges)
 *   POST /sources/:name/privileges        operator   Postgres: the report, with the exact missing GRANTs per declared write
 *   POST /sources/:name/check             operator   the per-kind check: read policy, then prepare/describe, never execute
 *   POST /sources/:name/safety            operator   Postgres: the table safety check and its fingerprint
 *   PUT  /sources/:name/allow-writes      HUMAN      the Allow writes switch (audited; off withdraws row-write grants)
 *   POST /sources/:name/test-call         HUMAN      G6: name the one request, then send exactly it (reads only)
 *   POST /apps/uploads?name=&filename=    operator   a file becomes a `sql`/`sqlite` source (sample rows: humans only)
 *
 * Every connection is the dialer's, under the source's confirmed ranges; every secret is resolved at
 * the call and scrubbed from what is answered.
 */

import { createHash } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AuditLog } from '../api/audit.js';
import { trustAtLeast } from '../api/auth.js';
import { API_PREFIX } from '../api/api-prefix.js';
import type { Actor, SourceCatalogResponse, SourceTestCallRequest, SourceTestCallResponse } from '../core/types.js';
import { canonicalJson, deriveToolClass, effectiveToolClass, MCP_SERVER_NAME_RE } from '../mcp/classify.js';
import { invokeMcpTool } from '../mcp/invoke.js';
import { McpRegistryError, type McpRegistry } from '../mcp/registry.js';
import { McpRegistryCorruptError } from '../mcp/registry-store.js';
import { buildRestRequest, invokeRestTool } from '../mcp/rest.js';
import { scrubSecrets } from '../mcp/secrets.js';
import { pgPrivileges } from './catalog/postgres.js';
import { policyCatalog, type SqlCatalog } from './catalog/types.js';
import { crewSourceCatalog } from './crew-source.js';
import { type DialOptions, DialRefusedError } from './dialer.js';
import { SourceQueryError } from './drivers/types.js';
import { checkGraphqlRead, graphqlPost } from './graphql.js';
import { CREW_SOURCE, describeSource, graphqlSource, sqlConnectArgs } from './kinds.js';
import { pgTableSafety } from './safety/postgres.js';
import { checkSqlQuery, type SqlSourceHandle } from './sql.js';
import { ingestUpload, snapshotPath, UPLOAD_LIMITS, UploadError } from './uploads.js';

const V = API_PREFIX;

/** What turning Allow writes off must reach: the row-write grants on the source (K2b's store). */
export interface RowWriteGrants {
  /** Withdraw every row-write grant on `source`; answers how many were withdrawn. */
  withdrawForSource(source: string): Promise<number>;
}

export interface SourceRouteDeps {
  registry?: McpRegistry;
  audit: Pick<AuditLog, 'record'>;
  actorOf: (req: FastifyRequest) => Actor;
  /** K2b's grant store; absent until it exists (nothing to withdraw yet). */
  rowWriteGrants?: RowWriteGrants;
  /** Tests: where snapshots are stored, and how connections resolve. */
  snapshotDir?: string;
  dial?: DialOptions;
}

const name = z.string().regex(MCP_SERVER_NAME_RE);
const RowWriteSchema = z
  .object({
    schema: z.string().min(1).max(128),
    table: z.string().min(1).max(128),
    op: z.enum(['insert', 'update', 'delete']),
    set: z.array(z.string().min(1).max(128)).max(200),
    key: z.array(z.string().min(1).max(128)).min(1).max(32),
  })
  .strict();
export const SourcePrivilegesSchema = z.object({ writes: z.array(RowWriteSchema).max(50).optional() }).strict();
export const SourceCheckSchema = z.object({ text: z.string().min(1).max(64 * 1024) }).strict();
export const SourceSafetySchema = z
  .object({
    schema: z.string().min(1).max(128),
    table: z.string().min(1).max(128),
    write: z.object({ op: z.enum(['insert', 'update', 'delete']), set: z.array(z.string().min(1).max(128)).max(200), key: z.array(z.string().min(1).max(128)).min(1).max(32) }).strict().optional(),
  })
  .strict();
export const SourceAllowWritesSchema = z.object({ allowed: z.boolean() }).strict();
export const SourceTestCallSchema = z
  .object({ target: z.string().min(1).max(64 * 1024), args: z.record(z.string(), z.unknown()).optional(), confirm: z.string().regex(/^[0-9a-f]{64}$/).optional() })
  .strict();

function isHumanOperator(actor: Actor): boolean {
  return actor.kind === 'human' && trustAtLeast(actor, 'operator');
}

function invalid(reply: FastifyReply, err: z.ZodError): FastifyReply {
  return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
}

function fail(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof McpRegistryError) return reply.code(err.status).send({ error: err.message, code: err.code });
  if (err instanceof McpRegistryCorruptError) return reply.code(503).send({ error: err.message, code: 'registry_corrupt' });
  if (err instanceof DialRefusedError) return reply.code(409).send({ error: err.message, code: err.code });
  if (err instanceof UploadError) return reply.code(err.code === 'too_large' ? 413 : 400).send({ error: err.message, code: err.code });
  if (err instanceof SourceQueryError) {
    const status = err.errorClass === 'refused' ? 409 : err.errorClass === 'timeout' ? 504 : 502;
    return reply.code(status).send({ error: err.message, code: err.errorClass === 'refused' ? 'refused' : `source_${err.errorClass}`, ...(err.sqlstate !== null ? { sqlstate: err.sqlstate } : {}) });
  }
  throw err;
}

/** The test-call result handed back to the sheet: scrubbed and cut. */
const TEST_CALL_RESULT_MAX = 64 * 1024;

function capped(value: unknown): { result: unknown; truncated: boolean } {
  const text = JSON.stringify(value ?? null);
  if (text.length <= TEST_CALL_RESULT_MAX) return { result: value ?? null, truncated: false };
  return { result: text.slice(0, TEST_CALL_RESULT_MAX), truncated: true };
}

export function registerSourceRoutes(app: FastifyInstance, deps: SourceRouteDeps): void {
  const registry = (reply: FastifyReply): McpRegistry | null => {
    if (deps.registry === undefined) {
      void reply.code(503).send({ error: 'the connector registry is not available on this daemon', code: 'registry_unavailable' });
      return null;
    }
    return deps.registry;
  };
  const dial = deps.dial ?? {};

  /** A source's handles, its secret resolved now. */
  const open = async (r: McpRegistry, sourceName: string) => {
    const src = await r.source(sourceName);
    const { secret, missing } = await r.callSecret(src.config);
    if (missing) throw new McpRegistryError(409, 'secret_missing', `${src.config.auth?.ref ?? 'the secret'} resolves to no secret; set it first`);
    return { ...src, secret };
  };

  app.get<{ Params: { name: string } }>(
    `${V}/sources/:name/catalog`,
    { config: { manifest: { responseType: 'SourceCatalogResponse', statusCodes: [200, 400, 404, 503] } } },
    async (req, reply) => {
      if (req.params.name === CREW_SOURCE) {
        const body: SourceCatalogResponse = { name: CREW_SOURCE, kind: 'crew', catalog: crewSourceCatalog(), descriptorHash: null };
        return body;
      }
      const r = registry(reply);
      if (r === null) return reply;
      try {
        const src = await r.source(req.params.name);
        if (src.description === null) return reply.code(404).send({ error: `${req.params.name} has not been described yet`, code: 'not_described' });
        const body: SourceCatalogResponse = {
          name: req.params.name,
          kind: src.config.kind as 'sql' | 'graphql',
          catalog: src.description.catalog,
          ...(src.description.privileges !== undefined ? { privileges: src.description.privileges } : {}),
          descriptorHash: src.descriptorHash,
        };
        return body;
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.post<{ Params: { name: string } }>(
    `${V}/sources/:name/describe`,
    { config: { manifest: { responseType: 'SourceCatalogResponse', statusCodes: [200, 400, 404, 409, 502, 503, 504] } } },
    async (req, reply) => {
      const r = registry(reply);
      if (r === null) return reply;
      try {
        const src = await open(r, req.params.name);
        const d = scrubSecrets(await describeSource(src.config, src.secret, dial), src.secret === null ? [] : [src.secret]);
        await r.saveDescription(req.params.name, d, src.descriptorHash);
        const body: SourceCatalogResponse = { name: req.params.name, kind: src.config.kind as 'sql' | 'graphql', catalog: d.catalog, ...(d.privileges !== undefined ? { privileges: d.privileges } : {}), descriptorHash: src.descriptorHash };
        return body;
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.post<{ Params: { name: string } }>(
    `${V}/sources/:name/privileges`,
    { config: { manifest: { requestType: 'SourcePrivilegesBody', responseType: 'SourcePrivilegeReport', statusCodes: [200, 400, 404, 409, 502, 503, 504] } } },
    async (req, reply) => {
      const parsed = SourcePrivilegesSchema.safeParse(req.body ?? {});
      if (!parsed.success) return invalid(reply, parsed.error);
      const r = registry(reply);
      if (r === null) return reply;
      try {
        const src = await open(r, req.params.name);
        if (src.config.kind !== 'sql' || src.config.sql?.driver !== 'postgres') return reply.code(400).send({ error: 'the privilege report is for a Postgres source', code: 'not_postgres' });
        return scrubSecrets(await pgPrivileges(sqlConnectArgs(src.config, src.secret, dial), parsed.data.writes ?? []), src.secret === null ? [] : [src.secret]);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.post<{ Params: { name: string } }>(
    `${V}/sources/:name/check`,
    { config: { manifest: { requestType: 'SourceCheckBody', responseType: 'SourceCheckResponse', statusCodes: [200, 400, 404, 409, 502, 503, 504] } } },
    async (req, reply) => {
      const parsed = SourceCheckSchema.safeParse(req.body);
      if (!parsed.success) return invalid(reply, parsed.error);
      const r = registry(reply);
      if (r === null) return reply;
      try {
        const src = await r.source(req.params.name);
        if (src.description === null) return reply.code(409).send({ error: `${req.params.name} has not been described yet: describe it first`, code: 'not_described' });
        if (src.config.kind === 'graphql') {
          if (src.description.introspection === undefined) return reply.code(409).send({ error: 'describe the source again', code: 'not_described' });
          const c = checkGraphqlRead(parsed.data.text, src.description.introspection);
          return c.ok ? { ok: true, columns: [], params: c.variables, relations: [] } : c;
        }
        const catalog = src.description.catalog as SqlCatalog;
        const sql = src.config.sql;
        let handle: SqlSourceHandle;
        if (sql?.driver === 'sqlite') handle = { driver: 'sqlite', snapshotPath: snapshotPath(sql.snapshot ?? '', deps.snapshotDir), catalog };
        else {
          // The secret is resolved only once the policy has passed (checkSqlQuery checks first).
          const { secret, missing } = await r.callSecret(src.config);
          if (missing) return reply.code(409).send({ error: 'the source secret resolves to nothing', code: 'secret_missing' });
          handle = { driver: sql?.driver === 'mysql' ? 'mysql' : 'postgres', connect: sqlConnectArgs(src.config, secret, dial), catalog, viewsAllowed: src.config.viewsAllowed ?? [] };
        }
        const c = await checkSqlQuery(handle, parsed.data.text);
        return c.ok ? { ok: true, columns: c.describe.columns, params: c.describe.params, relations: c.relations } : c;
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.post<{ Params: { name: string } }>(
    `${V}/sources/:name/safety`,
    { config: { manifest: { requestType: 'SourceSafetyBody', responseType: 'SourceSafetyResponse', statusCodes: [200, 400, 404, 409, 502, 503, 504] } } },
    async (req, reply) => {
      const parsed = SourceSafetySchema.safeParse(req.body);
      if (!parsed.success) return invalid(reply, parsed.error);
      const r = registry(reply);
      if (r === null) return reply;
      try {
        const src = await open(r, req.params.name);
        if (src.config.kind !== 'sql' || src.config.sql?.driver !== 'postgres') return reply.code(400).send({ error: 'row writes (and their safety check) are Postgres only in v1', code: 'not_postgres' });
        const w = parsed.data.write;
        return await pgTableSafety(sqlConnectArgs(src.config, src.secret, dial), parsed.data.schema, parsed.data.table, w === undefined ? null : { op: w.op, set: w.set, key: w.key });
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.put<{ Params: { name: string } }>(
    `${V}/sources/:name/allow-writes`,
    { config: { manifest: { requestType: 'SourceAllowWritesBody', responseType: 'SourceAllowWritesResponse', statusCodes: [200, 400, 403, 404, 503] } } },
    async (req, reply) => {
      const parsed = SourceAllowWritesSchema.safeParse(req.body);
      if (!parsed.success) return invalid(reply, parsed.error);
      const actor = deps.actorOf(req);
      // (DES §7.4) Human-only: an agent-kind token, whatever its trust, can never turn writes on (or off).
      if (!isHumanOperator(actor)) {
        return reply.code(403).send({ error: `only a human operator can change a source's Allow writes switch; you are ${actor.kind}/${actor.trust}`, code: 'writes_switch_human_only' });
      }
      const r = registry(reply);
      if (r === null) return reply;
      try {
        const { before, after } = await r.setAllowWrites(req.params.name, parsed.data.allowed);
        let withdrawn = 0;
        if (!after && deps.rowWriteGrants !== undefined) withdrawn = await deps.rowWriteGrants.withdrawForSource(req.params.name);
        if (before !== after || !after) {
          deps.audit.record(after ? 'apps.source.writes_allowed' : 'apps.source.writes_disallowed', actor, { detail: { source: req.params.name, withdrawnGrants: withdrawn } });
        }
        return { name: req.params.name, allowWrites: after, withdrawnGrants: withdrawn };
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.post<{ Params: { name: string } }>(
    `${V}/sources/:name/test-call`,
    { config: { manifest: { requestType: 'SourceTestCallBody', responseType: 'SourceTestCallResponse', statusCodes: [200, 400, 403, 404, 409, 502, 503] } } },
    async (req, reply) => {
      const parsed = SourceTestCallSchema.safeParse(req.body);
      if (!parsed.success) return invalid(reply, parsed.error);
      const actor = deps.actorOf(req);
      if (!isHumanOperator(actor)) {
        return reply.code(403).send({ error: `only a human operator sends a test call; you are ${actor.kind}/${actor.trust}`, code: 'test_call_human_only' });
      }
      const r = registry(reply);
      if (r === null) return reply;
      try {
        const out = await testCall(r, req.params.name, parsed.data.target, parsed.data.args ?? {}, parsed.data.confirm ?? null, dial, deps.registry as McpRegistry);
        if (out.sent) deps.audit.record('apps.source.test_call', actor, { detail: { source: req.params.name, summary: out.request.summary, ok: out.ok, status: out.status } });
        return out;
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // Uploads: raw bytes, buffered by a parser scoped to this route alone.
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: UPLOAD_LIMITS.fileBytes + 1 }, (_req, body, done) => done(null, body));
    scope.setErrorHandler((err, _req, reply) => {
      const code = (err as { code?: unknown }).code;
      if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send({ error: `an upload is at most ${UPLOAD_LIMITS.fileBytes / (1024 * 1024)} MB`, code: 'too_large' });
      if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return reply.code(415).send({ error: 'send the file as application/octet-stream', code: 'upload_media_type' });
      return reply.send(err);
    });
    scope.post<{ Querystring: { name?: string; filename?: string } }>(
      `${V}/apps/uploads`,
      { config: { manifest: { responseType: 'SourceUploadResponse', statusCodes: [201, 400, 409, 413, 415, 503] } } },
      async (req, reply) => {
        const n = name.safeParse(req.query.name);
        if (!n.success) return reply.code(400).send({ error: 'name: a source name is 1-63 of a-z 0-9 _ -, starting with a letter or digit', code: 'bad_name' });
        const filename = typeof req.query.filename === 'string' && req.query.filename.length <= 255 ? req.query.filename : 'upload.csv';
        if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: 'send the file as application/octet-stream', code: 'upload_media_type' });
        const r = registry(reply);
        if (r === null) return reply;
        try {
          const up = await ingestUpload(filename, req.body, deps.snapshotDir !== undefined ? { dir: deps.snapshotDir } : {});
          const source = await r.registerSnapshotSource(n.data, up.digest, { catalog: up.catalog });
          const actor = deps.actorOf(req);
          deps.audit.record('apps.source.uploaded', actor, { detail: { source: n.data, kind: up.kind, digest: up.digest, bytes: up.bytes } });
          // The first rows go to a human only: an agent never receives values (DES §5.2).
          return reply.code(201).send({
            source,
            snapshot: { digest: up.digest, bytes: up.bytes, kind: up.kind },
            table: up.table,
            header: up.header,
            sample: actor.kind === 'human' ? up.sample : [],
            catalog: up.catalog,
          });
        } catch (err) {
          return fail(reply, err);
        }
      },
    );
  });
}

/**
 * G6: the one live request a test call would send — named first (nothing sent), then sent exactly
 * when `confirm` is that request's hash. Reads only.
 */
async function testCall(
  r: McpRegistry,
  sourceName: string,
  target: string,
  args: Record<string, unknown>,
  confirm: string | null,
  dial: DialOptions,
  registry: McpRegistry,
): Promise<SourceTestCallResponse> {
  const config = await registry.inspectTarget(sourceName);
  if (config === null) throw new McpRegistryError(404, 'unknown_server', `no source named ${sourceName}`);
  if (config.kind === 'sql') throw new McpRegistryError(400, 'no_test_call', 'a SQL source is tested by describing it and checking a query, not by a call');
  const { secret, missing } = await r.callSecret(config);
  if (missing) throw new McpRegistryError(409, 'secret_missing', `${config.auth?.ref ?? 'the secret'} resolves to no secret; set it first`);
  const secrets = secret === null ? [] : [secret];
  let request: SourceTestCallRequest;
  let send: () => Promise<{ ok: boolean; status: number | null; result: unknown }>;
  if (config.kind === 'graphql') {
    const src = await r.source(sourceName);
    const introspection = src.description?.introspection;
    if (introspection === undefined) throw new McpRegistryError(409, 'not_described', 'describe the source first');
    const c = checkGraphqlRead(target, introspection);
    if (!c.ok) throw new McpRegistryError(400, 'not_a_read', `a test call is one query: ${c.detail}`);
    request = { kind: 'graphql', summary: `POST ${config.url ?? ''}`, method: 'POST', url: config.url ?? '', headers: ['content-type', ...(config.auth?.header !== undefined ? [config.auth.header] : [])], body: { query: target, variables: args } };
    send = async () => {
      const res = await graphqlPost(graphqlSource(config, dial), secret, { query: target, variables: args });
      return { ok: res.status < 400, status: res.status, result: res.json };
    };
  } else {
    const t = await registry.resolveCall(sourceName, target);
    if (t === null) throw new McpRegistryError(404, 'unknown_server', `no source named ${sourceName}`);
    if (!t.registered) throw new McpRegistryError(409, 'not_registered', `${sourceName}/${target} is not a registered, enabled tool`);
    if (config.kind === 'rest') {
      if (t.rest === null || (t.rest.method !== 'GET' && t.rest.method !== 'HEAD')) throw new McpRegistryError(400, 'not_a_read', `a test call sends a read: ${target} is ${t.rest?.method ?? 'not a REST operation'}`);
      const built = buildRestRequest(config, null, t.rest, args);
      request = { kind: 'rest', summary: `${t.rest.method} ${built.url.href}`, method: t.rest.method, url: built.url.href, headers: [...Object.keys(built.init.headers), ...(config.auth?.header !== undefined ? [config.auth.header] : [])] };
      const mapping = t.rest;
      send = async () => {
        const res = await invokeRestTool(config, secret, mapping, args, mapping.timeoutMs);
        const meta = (res['_meta'] as { 'wicked/rest'?: { status?: number } } | undefined)?.['wicked/rest'];
        return { ok: res['isError'] !== true, status: meta?.status ?? null, result: res['structuredContent'] ?? res['content'] };
      };
    } else {
      if (effectiveToolClass(deriveToolClass(t.annotations), t.classOverride) !== 'read') throw new McpRegistryError(400, 'not_a_read', `a test call sends a read: ${target} is not a read tool`);
      request = { kind: 'mcp', summary: `${sourceName}/${target}`, tool: target, args };
      send = async () => {
        const res = await invokeMcpTool(config, secret, target, args, 30_000);
        return { ok: res['isError'] !== true, status: null, result: res['structuredContent'] ?? res['content'] };
      };
    }
  }
  const requestHash = createHash('sha256').update(canonicalJson({ source: sourceName, request, args })).digest('hex');
  if (confirm === null) return { sent: false, request, requestHash };
  if (confirm !== requestHash) throw new McpRegistryError(409, 'request_changed', 'the request is not the one confirmed: name it again, then confirm');
  const out = scrubSecrets(await send(), secrets);
  const c = capped(out.result);
  return { sent: true, request, ok: out.ok, status: out.status, result: c.result, truncated: c.truncated };
}

export { policyCatalog };
