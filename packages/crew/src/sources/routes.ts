/**
 * The `/api/v1/sources/*` routes and `POST /api/v1/apps/uploads` (DES-APPS-001 §5, §7.4, §7.6).
 * Sources are entries of crew's ONE connector registry (`/mcp/servers` previews and saves them);
 * these routes are what the source sheet needs beyond that:
 *
 *   GET  /sources/:name/catalog           observer, human only   structure only (`crew` = the built-in source)
 *   POST /sources/:name/describe          operator, human only   describe again now (catalog; Postgres privileges)
 *   POST /sources/:name/privileges        operator, human only   Postgres: the report, with the exact missing GRANTs per declared write
 *   POST /sources/:name/check             operator, human only   the per-kind check: read policy, then prepare/describe, never execute
 *   POST /sources/:name/safety            operator, human only   Postgres: the table safety check and its fingerprint
 *   PUT  /sources/:name/allow-writes      HUMAN      the Allow writes switch (audited; off withdraws row-write grants)
 *   POST /sources/:name/test-call         HUMAN      G6: name the one request, then send exactly it (reads only)
 *   POST /sources/:name/test              operator, human only   Test connection: connect, describe (saved) and a probe read check
 *   POST /sources/:name/ask               HUMAN      a seat drafts one read from the structure; crew checks it; nothing runs
 *   POST /sources/:name/query             HUMAN      check SQL, or run exactly the checked text: READ ONLY, 10 s, 50 rows
 *   POST /apps/uploads?name=&filename=    operator   a file becomes a `sql`/`sqlite` source (sample rows: humans only)
 *
 * Every connection is the dialer's, under the source's confirmed ranges; every secret is resolved at
 * the call and scrubbed from what is answered.
 *
 * (DES-KNOWLEDGE-DATA-001 §5.2, crew#1310) "Human only": the management reads (catalog, describe, privileges,
 * check, safety, test) keep their trust level AND are a HUMAN actor's only: `api/auth.ts` answers any other actor
 * 403 `human_only` before the route runs, whatever its trust (an operator-trust agent bearer included). Agents get
 * a source's structure only through estate and the gate.
 */

import { createHash } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { record, z } from '../zod.js';

import type { AuditLog } from '../api/audit.js';
import { trustAtLeast } from '../api/auth.js';
import { API_PREFIX } from '../api/api-prefix.js';
import type { Actor, SourceAllowWritesResponse, SourceAskResponse, SourceCatalogResponse, SourceConnectionTestResponse, SourceQueryResponse, SourceTestCallRequest, SourceTestCallResponse, SourceUploadResponse } from '../core/types.js';
import { canonicalJson, deriveToolClass, effectiveToolClass, MCP_SERVER_NAME_RE } from '../mcp/classify.js';
import { invokeMcpTool } from '../mcp/invoke.js';
import { McpRegistryError, type McpRegistry } from '../mcp/registry.js';
import { McpRegistryCorruptError } from '../mcp/registry-store.js';
import { buildRestRequest, invokeRestTool } from '../mcp/rest.js';
import { scrubSecrets } from '../mcp/secrets.js';
import type { SeatTurnInput, SeatTurnOutcome } from '../standing-orders/parse.js';
import { ASK_CELL_CHARS, ASK_DEADLINE_MS, ASK_QUESTION_MAX, ASK_RESULT_BYTES, ASK_ROW_CAP, ASK_STEP_ID, AskRunTokens, askCell, askPrompt, draftFromAnswer, draftHolds, rowsWithin } from './ask.js';
import { pgPrivileges } from './catalog/postgres.js';
import { testConnection } from './connection-test.js';
import { policyCatalog, type SqlCatalog } from './catalog/types.js';
import { crewSourceCatalog } from './crew-source.js';
import { type DialOptions, DialRedirectRefusedError, DialRefusedError } from './dialer.js';
import { SourceQueryError } from './drivers/types.js';
import { checkGraphqlRead, type GraphqlCheck, graphqlPost } from './graphql.js';
import { CREW_SOURCE, describeSource, graphqlSource, sqlConnectArgs } from './kinds.js';
import { pgTableSafety } from './safety/postgres.js';
import { checkReadPolicy } from './policy/index.js';
import { checkSqlQuery, readSqlQuery, SourcePolicyError, type SqlCheckResult, type SqlSourceHandle } from './sql.js';
import { ingestUpload, snapshotPath, UPLOAD_LIMITS, UploadError } from './uploads.js';
import { type DataGate } from '../knowledge/gate/gate.js';
import { GateBusyError } from '../knowledge/gate/scheduler.js';

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
  /**
   * "Ask a question of this data": ONE seat's one turn (`seatTurn`, standing-orders/parse.ts). Given
   * the question and the source's structure only; absent = no seat path on this daemon (503).
   */
  draft?: (input: SeatTurnInput) => Promise<SeatTurnOutcome>;
  /** The run tokens' key holder (tests share one across registrations). */
  runTokens?: AskRunTokens;
  /** TESTS ONLY: a shorter deadline for a person's query (production: K1's 10 s). */
  queryDeadlineMs?: number;
  /**
   * (DES-KNOWLEDGE-DATA-001 §7) The data gate: a person's query run on Postgres goes through it (the source's
   * scheduler, the LIMIT rewrite), and a Toolbox-runtime source's Test is its describe.
   */
  gate?: Pick<DataGate, 'personRead' | 'isToolbox' | 'describeToolbox'>;
}

const name = z.string().regex(MCP_SERVER_NAME_RE);
const RowWriteSchema = z.strictObject({
  schema: z.string().min(1).max(128),
  table: z.string().min(1).max(128),
  op: z.enum(['insert', 'update', 'delete']),
  set: z.array(z.string().min(1).max(128)).max(200),
  key: z.array(z.string().min(1).max(128)).min(1).max(32),
});
export const SourcePrivilegesSchema = z.strictObject({ writes: z.array(RowWriteSchema).max(50).optional() });
export const SourceCheckSchema = z.strictObject({ text: z.string().min(1).max(64 * 1024) });
export const SourceSafetySchema = z.strictObject({
  schema: z.string().min(1).max(128),
  table: z.string().min(1).max(128),
  write: z.strictObject({ op: z.enum(['insert', 'update', 'delete']), set: z.array(z.string().min(1).max(128)).max(200), key: z.array(z.string().min(1).max(128)).min(1).max(32) }).optional(),
});
export const SourceAllowWritesSchema = z.strictObject({ allowed: z.boolean() });
export const SourceAskSchema = z.strictObject({ question: z.string().trim().min(1).max(ASK_QUESTION_MAX) });
export const SourceQuerySchema = z.strictObject({ sql: z.string().min(1).max(64 * 1024), confirm: z.string().regex(/^[0-9a-f]{64}$/).optional() });
export const SourceTestCallSchema = z.strictObject({ target: z.string().min(1).max(64 * 1024), args: record(z.string(), z.unknown()).optional(), confirm: z.string().regex(/^[0-9a-f]{64}$/).optional() });

function isHumanOperator(actor: Actor): boolean {
  return actor.kind === 'human' && trustAtLeast(actor, 'operator');
}

function invalid(reply: FastifyReply, err: z.ZodError): FastifyReply {
  return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
}

/**
 * An error as the caller may see it. A source's own words (a Postgres cast error echoes the value it
 * could not cast) go to a HUMAN only, scrubbed of the source's secret; an agent gets the class, the
 * SQLSTATE and a fixed sentence (DES §5.2: "errors reach an agent as an error class, SQLSTATE and
 * identifiers only, never the message text").
 */
function fail(reply: FastifyReply, err: unknown, actor: Actor, secrets: readonly string[] = []): FastifyReply {
  const human = actor.kind === 'human';
  const say = (message: string, fixed: string): string => (human ? scrubSecrets(message, [...secrets]) : fixed);
  if (err instanceof McpRegistryError) return reply.code(err.status).send({ error: scrubSecrets(err.message, [...secrets]), code: err.code });
  if (err instanceof McpRegistryCorruptError) return reply.code(503).send({ error: err.message, code: 'registry_corrupt' });
  // A redirect's Location is upstream text: a human gets it, scrubbed; an agent gets the code.
  if (err instanceof DialRefusedError) {
    const where = err instanceof DialRedirectRefusedError && err.location !== null ? ` (to ${err.location})` : '';
    return reply.code(409).send({ error: say(`${err.message}${where}`, `the connection was refused (${err.code})`), code: err.code });
  }
  if (err instanceof UploadError) return reply.code(err.code === 'too_large' ? 413 : 400).send({ error: err.message, code: err.code });
  if (err instanceof SourceQueryError) {
    const status = err.errorClass === 'refused' ? 409 : err.errorClass === 'timeout' ? 504 : 502;
    const code = err.refusal ?? (err.errorClass === 'refused' ? 'refused' : `source_${err.errorClass}`);
    return reply.code(status).send({ error: say(err.message, `the source answered ${err.errorClass}${err.sqlstate !== null ? ` (SQLSTATE ${err.sqlstate})` : ''}`), code, ...(err.sqlstate !== null ? { sqlstate: err.sqlstate } : {}) });
  }
  throw err;
}

/**
 * The check route's answer for a SQL source (wire: `SourceCheckResponse`, asserted both ways in
 * wire-contract.test.ts). A policy refusal's words are crew's own; the source's own words (a prepare
 * error, which can echo a value) go to a human only.
 */
export function sqlCheckAnswer(c: SqlCheckResult, human: boolean, secrets: readonly string[]) {
  if (c.ok) return { ok: true as const, columns: c.describe.columns, params: c.describe.params, relations: c.relations };
  const fromSource = c.code === 'prepare' || c.code === 'authorizer';
  return { ok: false as const, code: c.code, detail: fromSource && !human ? `the source refused the query${c.sqlstate != null ? ` (SQLSTATE ${c.sqlstate})` : ''}` : scrubSecrets(c.detail, [...secrets]) };
}

/** The check route's answer for a GraphQL source (wire: `SourceCheckResponse`). */
export function graphqlCheckAnswer(c: GraphqlCheck) {
  return c.ok ? { ok: true as const, columns: [] as Array<{ name: string; type: string }>, params: c.variables, relations: [] as string[] } : { ok: false as const, code: c.code, detail: c.detail };
}

/** The test-call result handed back to the sheet: scrubbed and cut. */
const TEST_CALL_RESULT_MAX = 64 * 1024;

function capped(value: unknown): { result: unknown; truncated: boolean } {
  const text = JSON.stringify(value ?? null);
  if (text.length <= TEST_CALL_RESULT_MAX) return { result: value ?? null, truncated: false };
  return { result: text.slice(0, TEST_CALL_RESULT_MAX), truncated: true };
}

/** The secret a request resolved, so its errors can be scrubbed of it (set by `open`). */
const RESOLVED = new WeakMap<FastifyRequest, string[]>();
const secretsOf = (req: FastifyRequest): string[] => RESOLVED.get(req) ?? [];

/** One critical section per source for the Allow writes switch: on, off and the withdrawal never interleave. */
const switchLocks = new Map<string, Promise<void>>();
async function exclusiveSwitch<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = switchLocks.get(name) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // The tail stored is the one compared: the last waiter out removes the entry.
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  switchLocks.set(name, tail);
  try {
    return await next;
  } finally {
    if (switchLocks.get(name) === tail) switchLocks.delete(name);
  }
}

/** TESTS ONLY: how many sources hold a switch lock right now. */
export function switchLocksHeldForTests(): number {
  return switchLocks.size;
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

  /** A source's handles, its secret resolved now (and remembered for scrubbing this request's errors). */
  const open = async (r: McpRegistry, sourceName: string, req: FastifyRequest) => {
    const src = await r.source(sourceName);
    const { secret, missing } = await r.callSecret(src.config);
    if (missing) throw new McpRegistryError(409, 'secret_missing', `${src.config.auth?.ref ?? 'the secret'} resolves to no secret; set it first`);
    if (secret !== null) RESOLVED.set(req, [secret]);
    return { ...src, secret };
  };

  app.get<{ Params: { name: string } }>(
    `${V}/sources/:name/catalog`,
    { config: { manifest: { responseType: 'SourceCatalogResponse', statusCodes: [200, 400, 403, 404, 503] } } },
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
        return fail(reply, err, deps.actorOf(req), secretsOf(req));
      }
    },
  );

  app.post<{ Params: { name: string } }>(
    `${V}/sources/:name/describe`,
    { config: { manifest: { responseType: 'SourceCatalogResponse', statusCodes: [200, 400, 403, 404, 409, 502, 503, 504] } } },
    async (req, reply) => {
      const r = registry(reply);
      if (r === null) return reply;
      try {
        const src = await open(r, req.params.name, req);
        const d = scrubSecrets(await describeSource(src.config, src.secret, dial, deps.snapshotDir), src.secret === null ? [] : [src.secret]);
        await r.saveDescription(req.params.name, d, src.descriptorHash);
        const body: SourceCatalogResponse = { name: req.params.name, kind: src.config.kind as 'sql' | 'graphql', catalog: d.catalog, ...(d.privileges !== undefined ? { privileges: d.privileges } : {}), descriptorHash: src.descriptorHash };
        return body;
      } catch (err) {
        return fail(reply, err, deps.actorOf(req), secretsOf(req));
      }
    },
  );

  app.post<{ Params: { name: string } }>(
    `${V}/sources/:name/privileges`,
    { config: { manifest: { requestType: 'SourcePrivilegesBody', responseType: 'SourcePrivilegeReport', statusCodes: [200, 400, 403, 404, 409, 502, 503, 504] } } },
    async (req, reply) => {
      const parsed = SourcePrivilegesSchema.safeParse(req.body ?? {});
      if (!parsed.success) return invalid(reply, parsed.error);
      const r = registry(reply);
      if (r === null) return reply;
      try {
        const src = await open(r, req.params.name, req);
        if (src.config.kind !== 'sql' || src.config.sql?.driver !== 'postgres') return reply.code(400).send({ error: 'the privilege report is for a Postgres source', code: 'not_postgres' });
        return scrubSecrets(await pgPrivileges(sqlConnectArgs(src.config, src.secret, dial), parsed.data.writes ?? []), src.secret === null ? [] : [src.secret]);
      } catch (err) {
        return fail(reply, err, deps.actorOf(req), secretsOf(req));
      }
    },
  );

  app.post<{ Params: { name: string } }>(
    `${V}/sources/:name/check`,
    { config: { manifest: { requestType: 'SourceCheckBody', responseType: 'SourceCheckResponse', statusCodes: [200, 400, 403, 404, 409, 502, 503, 504] } } },
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
          return graphqlCheckAnswer(checkGraphqlRead(parsed.data.text, src.description.introspection));
        }
        const catalog = src.description.catalog as SqlCatalog;
        const sql = src.config.sql;
        let handle: SqlSourceHandle;
        if (sql?.driver === 'sqlite') handle = { driver: 'sqlite', snapshotPath: snapshotPath(sql.snapshot ?? '', deps.snapshotDir), catalog };
        else {
          // The secret is resolved only once the policy has passed (checkSqlQuery checks first).
          const { secret, missing } = await r.callSecret(src.config);
          if (missing) return reply.code(409).send({ error: 'the source secret resolves to nothing', code: 'secret_missing' });
          if (secret !== null) RESOLVED.set(req, [secret]);
          handle = { driver: sql?.driver === 'mysql' ? 'mysql' : 'postgres', connect: sqlConnectArgs(src.config, secret, dial), catalog, viewsAllowed: src.config.viewsAllowed ?? [] };
        }
        return sqlCheckAnswer(await checkSqlQuery(handle, parsed.data.text), deps.actorOf(req).kind === 'human', secretsOf(req));
      } catch (err) {
        return fail(reply, err, deps.actorOf(req), secretsOf(req));
      }
    },
  );

  app.post<{ Params: { name: string } }>(
    `${V}/sources/:name/safety`,
    { config: { manifest: { requestType: 'SourceSafetyBody', responseType: 'SourceSafetyResponse', statusCodes: [200, 400, 403, 404, 409, 502, 503, 504] } } },
    async (req, reply) => {
      const parsed = SourceSafetySchema.safeParse(req.body);
      if (!parsed.success) return invalid(reply, parsed.error);
      const r = registry(reply);
      if (r === null) return reply;
      try {
        const src = await open(r, req.params.name, req);
        if (src.config.kind !== 'sql' || src.config.sql?.driver !== 'postgres') return reply.code(400).send({ error: 'row writes (and their safety check) are Postgres only in v1', code: 'not_postgres' });
        const w = parsed.data.write;
        const safety = await pgTableSafety(sqlConnectArgs(src.config, src.secret, dial), parsed.data.schema, parsed.data.table, w === undefined ? null : { op: w.op, set: w.set, key: w.key });
        // The published answer (SourceSafetyResponse); the oid and column list are the write path's own.
        return scrubSecrets({ table: safety.table, safe: safety.safe, reasons: safety.reasons, fingerprint: safety.fingerprint }, secretsOf(req));
      } catch (err) {
        return fail(reply, err, deps.actorOf(req), secretsOf(req));
      }
    },
  );

  app.put<{ Params: { name: string } }>(
    `${V}/sources/:name/allow-writes`,
    { config: { manifest: { requestType: 'SourceAllowWritesBody', responseType: 'SourceAllowWritesResponse', statusCodes: [200, 400, 403, 404, 500, 503] } } },
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
        // One critical section per source: the switch, the withdrawal and the audit land together, and
        // a concurrent on/off cannot interleave with them.
        const source = req.params.name;
        const withdraw = async (): Promise<number> => (deps.rowWriteGrants === undefined ? 0 : deps.rowWriteGrants.withdrawForSource(source));
        const why = (err: unknown): string => (err instanceof Error ? err.message : String(err));
        return await exclusiveSwitch(source, async (): Promise<SourceAllowWritesResponse> => {
          if (parsed.data.allowed) {
            if ((await r.source(source)).allowWrites) return { name: source, allowWrites: true, withdrawnGrants: 0 }; // already on
            // Grants an earlier withdrawal failed to remove (or a crash interrupted) never come back on:
            // they are withdrawn BEFORE the switch turns on, and it stays off if that fails.
            let stale = 0;
            try {
              stale = await withdraw();
            } catch (err) {
              deps.audit.record('apps.source.writes_allowed', actor, { detail: { source, refused: true, withdrawFailed: true } });
              throw new McpRegistryError(500, 'withdraw_failed', `Allow writes stays off for ${source}: row-write grants left from before could not be withdrawn (${why(err)}); try again`);
            }
            await r.setAllowWrites(source, true);
            deps.audit.record('apps.source.writes_allowed', actor, { detail: { source, ...(stale > 0 ? { withdrawnStaleGrants: stale } : {}) } });
            return { name: source, allowWrites: true, withdrawnGrants: stale };
          }
          // Off is recorded first (the switch IS off: every grant is refused at prepare and run from now),
          // then the grants are withdrawn. Off ALWAYS withdraws, also when already off, so asking again
          // retries a withdrawal that failed; a failure is recorded too, never lost.
          const { before } = await r.setAllowWrites(source, false);
          let withdrawn = 0;
          try {
            withdrawn = await withdraw();
          } catch (err) {
            deps.audit.record('apps.source.writes_disallowed', actor, { detail: { source, withdrawnGrants: 0, withdrawFailed: true } });
            throw new McpRegistryError(500, 'withdraw_failed', `Allow writes is off for ${source}, but its row-write grants could not all be withdrawn (${why(err)}); they are refused while the switch is off, and turning it off again retries`);
          }
          if (before || withdrawn > 0) deps.audit.record('apps.source.writes_disallowed', actor, { detail: { source, withdrawnGrants: withdrawn } });
          return { name: source, allowWrites: false, withdrawnGrants: withdrawn };
        });
      } catch (err) {
        return fail(reply, err, deps.actorOf(req), secretsOf(req));
      }
    },
  );

  app.post<{ Params: { name: string } }>(
    `${V}/sources/:name/test-call`,
    { config: { manifest: { requestType: 'SourceTestCallBody', responseType: 'SourceTestCallResponse', statusCodes: [200, 400, 403, 404, 409, 502, 503, 504] } } },
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
        // Every SENT call is audited, whether it answered, failed or timed out (recorded where it is sent).
        return await testCall(r, req.params.name, parsed.data.target, parsed.data.args ?? {}, parsed.data.confirm ?? null, dial, deps.registry as McpRegistry, (detail) =>
          deps.audit.record('apps.source.test_call', actor, { detail: { source: req.params.name, ...detail } }),
        );
      } catch (err) {
        return fail(reply, err, deps.actorOf(req), secretsOf(req));
      }
    },
  );

  // ── Test connection; ask a question of the data (operator 2026-11-03) ─────────────────────────

  app.post<{ Params: { name: string } }>(
    `${V}/sources/:name/test`,
    { config: { manifest: { responseType: 'SourceConnectionTestResponse', statusCodes: [200, 400, 403, 404, 503] } } },
    async (req, reply) => {
      const r = registry(reply);
      if (r === null) return reply;
      try {
        // (DES-KNOWLEDGE-DATA-001 §6.3, §7.4) A Toolbox-runtime source is described through its own adapter.
        if (deps.gate !== undefined && (await deps.gate.isToolbox(req.params.name))) {
          const human = deps.actorOf(req).kind === 'human';
          const d = await deps.gate.describeToolbox(req.params.name);
          const testedAt = new Date().toISOString();
          const tested: SourceConnectionTestResponse = d.ok
            ? { name: req.params.name, kind: 'sql', driver: 'postgres', ok: true, ms: d.ms, testedAt, tls: d.tls, catalog: { name: req.params.name, kind: 'sql', catalog: d.catalog, descriptorHash: d.descriptorHash }, readCheck: null }
            : { name: req.params.name, kind: 'sql', driver: 'postgres', ok: false, ms: d.ms, testedAt, tls: d.tls, code: d.code, error: human ? d.error : `the test failed (${d.code})` };
          return tested;
        }
        return await testConnection({ registry: r, dial, ...(deps.snapshotDir !== undefined ? { snapshotDir: deps.snapshotDir } : {}) }, req.params.name, deps.actorOf(req).kind === 'human');
      } catch (err) {
        return fail(reply, err, deps.actorOf(req), secretsOf(req));
      }
    },
  );

  const tokens = deps.runTokens ?? new AskRunTokens();

  /**
   * A saved SQL source a person asks or queries: described and switched on (a switched-off source reads
   * nothing, a prepare included), with its handle (the secret resolved when it is asked for).
   */
  const askable = async (r: McpRegistry, sourceName: string, req: FastifyRequest) => {
    const src = await r.source(sourceName);
    if (src.config.kind !== 'sql') throw new McpRegistryError(400, 'not_sql', `${sourceName} is a GraphQL source: asking a question is for SQL sources; its test call reads it`);
    if (src.description === null) throw new McpRegistryError(409, 'not_described', `${sourceName} has not been described yet: test the connection first`);
    if (!src.enabled) throw new McpRegistryError(409, 'source_disabled', `${sourceName} is switched off: it reads nothing`);
    const catalog = src.description.catalog as SqlCatalog;
    const sql = src.config.sql;
    const views = src.config.viewsAllowed ?? [];
    let secret: string | null | undefined;
    /** The source's secret, resolved once per request (null: it has none). */
    const secretNow = async (): Promise<string | null> => {
      if (secret !== undefined) return secret;
      if (sql?.driver === 'sqlite') return (secret = null);
      const got = await r.callSecret(src.config);
      if (got.missing) throw new McpRegistryError(409, 'secret_missing', `${src.config.auth?.ref ?? 'the secret'} resolves to no secret; set it first`);
      if (got.secret !== null) RESOLVED.set(req, [got.secret]);
      return (secret = got.secret);
    };
    const handle = async (): Promise<SqlSourceHandle> => {
      if (sql?.driver === 'sqlite') return { driver: 'sqlite', snapshotPath: snapshotPath(sql.snapshot ?? '', deps.snapshotDir), catalog };
      return { driver: sql?.driver === 'mysql' ? 'mysql' : 'postgres', connect: sqlConnectArgs(src.config, await secretNow(), dial), catalog, viewsAllowed: views };
    };
    return { src, catalog, views, driver: sql?.driver ?? 'postgres', handle, secretNow };
  };

  /**
   * The check a person's SQL gets: K1's read policy, then a prepare (never executed). A text with
   * parameters is refused here: a person's query runs with none, so it could never run.
   */
  const personCheck = async (h: SqlSourceHandle, text: string, req: FastifyRequest) => {
    const c = await checkSqlQuery(h, text);
    if (c.ok && c.describe.params.length > 0) {
      return { ok: false as const, code: 'params', detail: `this query has ${c.describe.params.length} parameter${c.describe.params.length === 1 ? '' : 's'} ($1, ?): write the values into it, since a query you run here takes none` };
    }
    return sqlCheckAnswer(c, true, secretsOf(req));
  };

  app.post<{ Params: { name: string } }>(
    `${V}/sources/:name/ask`,
    { config: { manifest: { requestType: 'SourceAskBody', responseType: 'SourceAskResponse', statusCodes: [200, 400, 403, 404, 409, 422, 502, 503, 504] } } },
    async (req, reply) => {
      const parsed = SourceAskSchema.safeParse(req.body);
      if (!parsed.success) return invalid(reply, parsed.error);
      const actor = deps.actorOf(req);
      // Human-only, like Allow writes: an agent-kind token, whatever its trust, never asks for a draft.
      if (!isHumanOperator(actor)) return reply.code(403).send({ error: `only a human operator asks a question of a source; you are ${actor.kind}/${actor.trust}`, code: 'ask_human_only' });
      const source = req.params.name;
      // ONE trail entry per attempt, however it ends: THAT a person asked and how it went, never the
      // question, the SQL or a source's words.
      let recorded = false;
      let seat: string | null = null;
      const asked = (detail: Record<string, unknown>): void => {
        if (recorded) return;
        recorded = true;
        deps.audit.record('apps.source.asked', actor, { detail: { source, ...(seat !== null ? { seat } : {}), ...detail } });
      };
      if (deps.draft === undefined) {
        asked({ drafted: false, failed: 'ask_unavailable' });
        return reply.code(503).send({ error: 'this daemon has no seat path to draft a query: write the SQL yourself', code: 'ask_unavailable' });
      }
      const r = registry(reply);
      if (r === null) {
        asked({ drafted: false, failed: 'registry_unavailable' });
        return reply;
      }
      try {
        const a = await askable(r, source, req);
        // The seat gets the question and the STRUCTURE (the catalog holds no row value), nothing else.
        const turn = await deps.draft({
          problem: `Draft one read query for the data source ${source}`,
          stepId: ASK_STEP_ID,
          noSeat: 'no seat can take a turn to draft the query: sign a seat in from the Agents page, or write the SQL yourself',
          instructions: askPrompt(parsed.data.question, a.catalog, a.views),
        });
        if (!turn.ok) {
          asked({ drafted: false, failed: turn.code === 409 ? 'no_seat' : 'seat_failed' });
          return reply.code(turn.code).send({ error: turn.error, code: turn.code === 409 ? 'no_seat' : 'seat_failed' });
        }
        seat = turn.seat;
        // Defense in depth: a seat steered into reading the source's secret (schema-name injection on a
        // seat that can run commands) never gets it shown, checked or run.
        const secret = await a.secretNow();
        const d = draftFromAnswer(turn.answer);
        // Raw AND decoded: JSON escapes a quote or a backslash in a password, and decoding restores it.
        if (secret !== null && draftHolds(secret, turn.answer, d)) {
          asked({ drafted: false, failed: 'draft_holds_secret' });
          return reply.code(502).send({ error: `the ${turn.seat} seat's answer held this source's secret, so crew shows none of it: write the SQL yourself, and change the source's password`, code: 'draft_holds_secret' });
        }
        if (d === null) {
          asked({ drafted: false, failed: 'no_draft' });
          return reply.code(422).send({ error: `the ${turn.seat} seat did not answer with a query: ask again in other words, or write the SQL yourself`, code: 'no_draft' });
        }
        if (d.sql === '') {
          asked({ drafted: false, failed: 'cannot_answer' });
          const none: SourceAskResponse = { sql: '', explanation: d.explanation, seat: turn.seat, check: null, confirm: null };
          return none;
        }
        // K1's read policy, then a prepare at the source. Nothing executes.
        const check = await personCheck(await a.handle(), d.sql, req);
        asked({ drafted: true, check: check.ok ? 'ok' : check.code });
        const body: SourceAskResponse = { sql: d.sql, explanation: d.explanation, seat: turn.seat, check, confirm: check.ok ? tokens.mint(source, a.src.descriptorHash, d.sql) : null };
        return body;
      } catch (err) {
        asked({ drafted: seat !== null, failed: err instanceof McpRegistryError ? err.code : err instanceof SourceQueryError ? `source_${err.errorClass}` : 'failed' });
        return fail(reply, err, actor, secretsOf(req));
      }
    },
  );

  app.post<{ Params: { name: string } }>(
    `${V}/sources/:name/query`,
    { config: { manifest: { requestType: 'SourceQueryBody', responseType: 'SourceQueryResponse', statusCodes: [200, 400, 403, 404, 409, 502, 503, 504] } } },
    async (req, reply) => {
      const parsed = SourceQuerySchema.safeParse(req.body);
      if (!parsed.success) return invalid(reply, parsed.error);
      const actor = deps.actorOf(req);
      if (!isHumanOperator(actor)) return reply.code(403).send({ error: `only a human operator queries a source; you are ${actor.kind}/${actor.trust}`, code: 'query_human_only' });
      const source = req.params.name;
      const { sql, confirm } = parsed.data;
      // A RUN attempt (with `confirm`) leaves ONE trail entry, however it ends; a check alone, like the
      // source check route, leaves none. Never the SQL, a value or a source's words.
      let recorded = false;
      const queried = (detail: Record<string, unknown>): void => {
        if (recorded || confirm === undefined) return;
        recorded = true;
        deps.audit.record('apps.source.queried', actor, { detail: { source, ...detail } });
      };
      const r = registry(reply);
      if (r === null) {
        queried({ ok: false, failed: 'registry_unavailable' });
        return reply;
      }
      try {
        const a = await askable(r, source, req);
        if (confirm === undefined) {
          // The check only: the policy, then a prepare. A pass carries the token for exactly this text.
          const check = await personCheck(await a.handle(), sql, req);
          const checked: SourceQueryResponse = { ran: false, check, confirm: check.ok ? tokens.mint(source, a.src.descriptorHash, sql) : null };
          return checked;
        }
        // Only a text crew checked and answered, for this source as it is now, runs.
        if (!tokens.verify(confirm, source, a.src.descriptorHash, sql)) {
          queried({ ok: false, refused: 'query_changed' });
          return reply.code(409).send({ error: 'this is not the SQL crew checked for this source as it is now: check it again, then run it', code: 'query_changed' });
        }
        // The policy again (the catalog may have been described anew since the check); its relations are
        // what the trail names (identifiers, never a value).
        const pol = await checkReadPolicy(a.driver, sql, policyCatalog(a.catalog, a.driver === 'sqlite' ? [] : a.views));
        if (!pol.ok) {
          queried({ ok: false, refused: pol.code });
          return reply.code(409).send({ error: pol.detail, code: pol.code });
        }
        const handle = await a.handle();
        // The source as it is NOW, just before the read: a new connection descriptor, a switch-off, or
        // a view allowance withdrawn since the token was checked is a change, and nothing runs on the old.
        // (A change that completes between this read and the connect still races it: every check here
        // is a snapshot, and no lock serializes runs with saves. A person's own two clicks, ms apart.)
        const now = await r.source(source);
        const sameViews = JSON.stringify([...(now.config.viewsAllowed ?? [])].sort()) === JSON.stringify([...a.views].sort());
        if (now.descriptorHash !== a.src.descriptorHash || !now.enabled || !sameViews) {
          queried({ ok: false, refused: 'query_changed' });
          return reply.code(409).send({ error: `${source} changed (its connection, its allowed views) or was switched off since this SQL was checked: check it again, then run it`, code: 'query_changed' });
        }
        // The relations read, as the policy names them (identifiers). SQLite's policy is its authorizer at
        // prepare, which names none here: the entry then says nothing about them.
        const named = pol.relations.length > 0 ? { relations: pol.relations } : {};
        let res: Awaited<ReturnType<typeof readSqlQuery>>;
        try {
          // (DES-KNOWLEDGE-DATA-001 §7.4) Postgres: through the gate (the source's one scheduler, the LIMIT
          // rewrite), under Ask's caps; the answer below is unchanged.
          res =
            deps.gate !== undefined && handle.driver === 'postgres'
              ? await deps.gate.personRead(source, { connect: handle.connect, catalog: a.catalog, viewsAllowed: a.views, sql, rowCap: ASK_ROW_CAP, maxBytes: ASK_RESULT_BYTES, deadlineMs: deps.queryDeadlineMs ?? ASK_DEADLINE_MS })
              : await readSqlQuery(handle, sql, [], { maxRows: ASK_ROW_CAP, maxBytes: ASK_RESULT_BYTES, deadlineMs: deps.queryDeadlineMs ?? ASK_DEADLINE_MS, blobsAsHex: true, cellChars: ASK_CELL_CHARS });
        } catch (err) {
          if (err instanceof SourcePolicyError) {
            queried({ ok: false, ...named, refused: err.code });
            return reply.code(409).send({ error: err.message, code: err.code });
          }
          if (err instanceof GateBusyError) {
            queried({ ok: false, ...named, refused: err.code });
            return reply.code(503).send({ error: `${err.message}: ${err.remedy}`, code: err.code });
          }
          queried({ ok: false, ...named, ...(err instanceof SourceQueryError ? { errorClass: err.errorClass, ...(err.sqlstate !== null ? { sqlstate: err.sqlstate } : {}) } : { errorClass: 'failed' }) });
          throw err;
        }
        // Rows to this answer only, as JSON carries them, scrubbed of the source's secret (defense in
        // depth), and held to the byte budget as encoded (each cell is cut first).
        const secrets = secretsOf(req);
        const fit = rowsWithin(res.rows.map((raw) => scrubSecrets(raw.map(askCell), secrets)), ASK_RESULT_BYTES);
        const rows = fit.rows;
        const truncated = res.truncated || fit.cut;
        queried({ ok: true, ...named, rows: rows.length, truncated, ms: res.ms });
        const ran: SourceQueryResponse = { ran: true, columns: res.columns, rows, truncated, rowCap: ASK_ROW_CAP, ms: res.ms };
        return ran;
      } catch (err) {
        queried({ ok: false, failed: err instanceof McpRegistryError ? err.code : err instanceof SourceQueryError ? `source_${err.errorClass}` : 'failed' });
        return fail(reply, err, actor, secretsOf(req));
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
    scope.post<{ Querystring: { name?: string; filename?: string; header?: string } }>(
      `${V}/apps/uploads`,
      { config: { manifest: { responseType: 'SourceUploadResponse', statusCodes: [201, 400, 409, 413, 415, 502, 503, 504] } } },
      async (req, reply) => {
        const n = name.safeParse(req.query.name);
        if (!n.success) return reply.code(400).send({ error: 'name: a source name is 1-63 of a-z 0-9 _ -, starting with a letter or digit', code: 'bad_name' });
        const filename = typeof req.query.filename === 'string' && req.query.filename.length <= 255 ? req.query.filename : 'upload.csv';
        if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: 'send the file as application/octet-stream', code: 'upload_media_type' });
        const r = registry(reply);
        if (r === null) return reply;
        // The header is the person's to take: a first row promoted to column names becomes structure an
        // agent reads in the catalog, and a record (a name, an email) can look like a header. So only a
        // human's upload detects one or takes `header=yes`; an agent's always gets col_1… names.
        const choice = req.query.header === 'yes' || req.query.header === 'no' ? req.query.header : null;
        const header = deps.actorOf(req).kind === 'human' ? choice : 'no';
        try {
          const up = await ingestUpload(filename, req.body, { ...(deps.snapshotDir !== undefined ? { dir: deps.snapshotDir } : {}), header });
          const source = await r.registerSnapshotSource(n.data, up.digest, { catalog: up.catalog });
          const actor = deps.actorOf(req);
          deps.audit.record('apps.source.uploaded', actor, { detail: { source: n.data, kind: up.kind, digest: up.digest, bytes: up.bytes } });
          // The first rows go to a human only: an agent never receives values (DES §5.2).
          const body: SourceUploadResponse = {
            source,
            snapshot: { digest: up.digest, bytes: up.bytes, kind: up.kind },
            table: up.table,
            header: up.header,
            sample: actor.kind === 'human' ? up.sample : [],
            catalog: up.catalog,
          };
          return reply.code(201).send(body);
        } catch (err) {
          return fail(reply, err, deps.actorOf(req), secretsOf(req));
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
  audited: (detail: Record<string, unknown>) => void,
): Promise<SourceTestCallResponse> {
  // ONE read of the registry: the config, the tool's mapping and schema, its status, all of one record.
  const t0 = await registry.resolveCall(sourceName, target);
  const config = t0?.config ?? (await registry.inspectTarget(sourceName));
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
    const t = t0;
    if (t === null) throw new McpRegistryError(404, 'unknown_server', `no source named ${sourceName}`);
    if (!t.registered) throw new McpRegistryError(409, 'not_registered', `${sourceName}/${target} is not a registered, enabled tool`);
    if (config.kind === 'rest') {
      if (t.rest === null || (t.rest.method !== 'GET' && t.rest.method !== 'HEAD')) throw new McpRegistryError(400, 'not_a_read', `a test call sends a read: ${target} is ${t.rest?.method ?? 'not a REST operation'}`);
      const built = buildRestRequest(config, null, t.rest, args);
      request = {
        kind: 'rest',
        summary: `${t.rest.method} ${built.url.href}`,
        method: t.rest.method,
        url: built.url.href,
        headers: [...Object.keys(built.init.headers), ...(config.auth?.header !== undefined ? [config.auth.header] : [])],
        ...(built.init.body !== undefined ? { body: built.init.body } : {}),
      };
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
  // The hash binds what is sent AND where: the request (method, URL, header names and values but the
  // secret, the body), the server's WHOLE non-secret config (command, args, URL, address, the complete
  // auth: reference, env name, header, prefix), and the tool's saved schema hash and mapping. A re-save
  // that changes any of them changes the hash.
  const identity = config;
  const tool = t0 === null ? null : { rest: t0.rest, annotations: t0.annotations, classOverride: t0.classOverride, schemaHash: t0.schemaHash };
  const requestHash = createHash('sha256').update(canonicalJson({ source: sourceName, identity, tool, request, args })).digest('hex');
  if (confirm === null) return { sent: false, request, requestHash };
  if (confirm !== requestHash) throw new McpRegistryError(409, 'request_changed', 'the request is not the one confirmed: name it again, then confirm');
  let out: { ok: boolean; status: number | null; result: unknown };
  try {
    out = scrubSecrets(await send(), secrets);
  } catch (err) {
    // A failure's words (an RPC error, a server's stderr) can hold the secret this call injected.
    const failure = scrubbedFailure(err, secrets);
    audited({ summary: request.summary, ok: false, failed: (failure as { code?: unknown }).code ?? 'test_call_failed' });
    throw failure;
  }
  audited({ summary: request.summary, ok: out.ok, status: out.status });
  const c = capped(out.result);
  return { sent: true, request, ok: out.ok, status: out.status, result: c.result, truncated: c.truncated };
}

/** The same failure, its words scrubbed of `secrets` (its class and code kept). */
function scrubbedFailure(err: unknown, secrets: string[]): Error {
  const words = scrubSecrets(err instanceof Error ? err.message : String(err), secrets);
  if (err instanceof SourceQueryError) return new SourceQueryError(err.sqlstate, err.errorClass, words, err.refusal);
  if (err instanceof DialRedirectRefusedError) return new DialRedirectRefusedError(err.status, err.location === null ? null : scrubSecrets(err.location, secrets), words);
  if (err instanceof DialRefusedError) return new DialRefusedError(err.code, words);
  if (err instanceof McpRegistryError) return new McpRegistryError(err.status, err.code, words);
  return new McpRegistryError(502, 'test_call_failed', `the test call failed: ${words}`);
}

export { policyCatalog };
