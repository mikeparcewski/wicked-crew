/**
 * `/api/v1/apps` (DES-APPS-001 §7.6), the app store's routes.
 *
 *  - `GET /apps[?project=]` (observer), `POST /apps {slug, name?, projectId}` (operator): list; add an app.
 *  - `GET /apps/:app` (observer): the spec at head, the versions with their receipts, the undo pointer.
 *  - `POST /apps/:app/edits`, `/undo`, `/redo`, `/restore` (HUMAN operator): each carries the version it was
 *    made on (`409 stale_base`); while a turn runs, `409 turn_in_flight`.
 *  - `POST /apps/:app/query` (observer, a person): the executor (K2b, `exec/executor.ts`) runs one named
 *    query of an accepted version; without one, the receipt and the query are checked, then `501`.
 *  - actions (prepare, run, records, grant, revoke) and publish (HUMAN operator): `501` after the human check.
 *  - `POST /apps/:app/turns` (operator): launch an `apps-turn` run and hold the app (`501` while this daemon
 *    has no launcher).
 *  - `POST /apps/check {token, app, commit}`: the `apps_check` Tool's route, authenticated by the unit's
 *    capability token (bearer-exempt like `/mcp/call`); `503` while the engine cannot verify one.
 *
 * Human-only means an actor of kind `human` at operator trust or above (the editors routes' rule): an
 * authenticated `kind: agent, trust: operator` caller cannot mint a receipt. Under `auth=off` every
 * same-user caller is the local human: Apps guards against frames, other origins and agent seats, not the
 * person's own processes (DES §7.3).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { LOCAL_ACTOR, trustAtLeast } from '../api/auth.js';
import type { AuditLog } from '../api/audit.js';
import type { Actor, AppEditOp, AppErrorBody } from '../core/types.js';
import { APP_NAMED_ID_RE, parseSpec } from './spec.js';
import { APP_SLUG_RE, AppStore, AppStoreError } from './store.js';
import { QUERY_TEXT_MAX_BYTES } from './check.js';
import { AppExecError, type AppExecutor } from './exec/executor.js';
import { AppGitError } from './git.js';

const V = '/api/v1';

/**
 * An edit body holds a whole spec (2 MB) and up to 50 query texts (64 KB each): 12 MB covers every edit the
 * contract allows, JSON escaping included, and is published on `AppEditsBody` (codex r1 on the store).
 */
const EDIT_BODY_LIMIT = 12 * 1024 * 1024;

export interface AppRoutesDeps {
  store: AppStore;
  audit: Pick<AuditLog, 'record'>;
  /** Whether a project exists; absent = not checked (an engine without projects). */
  projectExists?: (id: string) => Promise<boolean>;
  /**
   * Verifies a unit's capability token for `POST /apps/check` and answers the run it belongs to. Absent
   * until the engine carries one: the route answers 503 and does nothing.
   */
  verifyUnitToken?: (token: string) => Promise<{ runId: string } | null>;
  /** (K2b) The executor; absent = the query route checks the receipt and answers 501. */
  executor?: AppExecutor;
}

const actorOf = (req: FastifyRequest): Actor => req.actor ?? LOCAL_ACTOR;

function refuse(reply: FastifyReply, status: number, body: AppErrorBody): FastifyReply {
  return reply.code(status).send(body);
}

function badRequest(reply: FastifyReply, err: z.ZodError): FastifyReply {
  return refuse(reply, 400, { code: 'bad_request', error: err.issues.slice(0, 10).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
}

/**
 * Zod reports an over-long array and still parses every element (codex r2 on the store), so a body's
 * arrays are measured before the schema sees it.
 */
function overLong(body: unknown, key: string, max: number): boolean {
  const v = body !== null && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;
  return Array.isArray(v) && v.length > max;
}

function fail(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof AppStoreError) return reply.code(err.status).send({ code: err.code, error: err.message, ...err.extra });
  if (err instanceof AppExecError) {
    if (err.extra.retryAfterMs !== undefined) void reply.header('retry-after', String(Math.max(1, Math.ceil(err.extra.retryAfterMs / 1000))));
    return reply.code(err.status).send({ code: err.code, error: err.message, ...err.extra });
  }
  // The app repo was changed in a way crew refuses to read or write through (a link, a commondir file, an
  // object that does not hash to its id): nothing landed.
  if (err instanceof AppGitError && err.code === 'corrupt') return refuse(reply, 409, { code: 'unreadable_tree', error: err.message });
  throw err;
}

const base = z.number().int().min(1);
const slugParam = z.string().regex(APP_SLUG_RE);
export const AppCreateSchema = z.object({ slug: z.string().min(1).max(64), name: z.string().min(1).max(120).optional(), projectId: z.string().min(1).max(128) }).strict();
// The spec rides as `unknown` and is parsed by `parseSpec` (the structure bound, then the schema) in the
// handler, so an over-large document never reaches zod whole (codex r1 on the schema PR).
const EditOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('spec'), spec: z.unknown() }).strict(),
  z.object({ op: z.literal('query-text'), query: z.string().regex(APP_NAMED_ID_RE), text: z.string().max(QUERY_TEXT_MAX_BYTES) }).strict(),
]);
export const AppEditsSchema = z.object({ base, ops: z.array(EditOpSchema).min(1).max(50), summary: z.string().min(1).max(200).optional() }).strict();
export const AppHistoryMoveSchema = z.object({ base }).strict();
const version = z.union([z.number().int().min(1), z.string().regex(/^[0-9a-fA-F]{40}$/)]);
export const AppRestoreSchema = z.object({ base, version }).strict();
export const AppQuerySchema = z.object({ version, query: z.string().regex(APP_NAMED_ID_RE), params: z.record(z.unknown()).optional() }).strict();
export const AppTurnSchema = z.object({ base, message: z.string().min(1).max(8000), about: z.array(z.string().min(1).max(64)).max(20).optional() }).strict();
/** `commit`: the builder's candidate COMMIT in the app repo (crew reads its tree and writes the lock on it). */
export const AppsCheckSchema = z.object({ token: z.string().min(1).max(4096), app: slugParam, commit: z.string().regex(/^[0-9a-fA-F]{40}$/), manifest: z.unknown().optional() }).strict();

export function registerAppRoutes(app: FastifyInstance, deps: AppRoutesDeps): void {
  const { store } = deps;

  const humanOnly = (req: FastifyRequest, reply: FastifyReply, what: string): boolean => {
    const actor = actorOf(req);
    if (actor.kind === 'human' && trustAtLeast(actor, 'operator')) return true;
    void refuse(reply, 403, { code: 'human_only', error: `only a human operator can ${what} (you are ${actor.kind}/${actor.trust})` });
    return false;
  };
  const slugOf = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const parsed = slugParam.safeParse((req.params as { app?: string }).app);
    if (parsed.success && store.has(parsed.data)) return parsed.data;
    void refuse(reply, 404, { code: 'unknown_app', error: `no app ${JSON.stringify((req.params as { app?: string }).app)}` });
    return null;
  };
  const landed = async (slug: string, v: Awaited<ReturnType<AppStore['edit']>>) => ({ app: await store.detail(slug), landed: v });
  const audited = (req: FastifyRequest, slug: string, v: { version: number; receipt: { kind: string } | null; base: number | null }, how: string): void => {
    deps.audit.record('apps.version.landed', actorOf(req), { detail: { app: slug, version: v.version, base: v.base, receipt: v.receipt?.kind ?? null, how } });
  };

  app.get(`${V}/apps`, { config: { manifest: { responseType: 'AppsListResponse', statusCodes: [200, 400] } } }, async (req, reply) => {
    const q = z.object({ project: z.string().min(1).max(128).optional() }).safeParse(req.query ?? {});
    if (!q.success) return badRequest(reply, q.error);
    return { apps: store.list(q.data.project) };
  });

  app.post(`${V}/apps`, { config: { manifest: { requestType: 'CreateAppBody', responseType: 'AppDetailResponse', statusCodes: [201, 400, 404, 409, 422, 503] } } }, async (req, reply) => {
    const parsed = AppCreateSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const { slug, projectId } = parsed.data;
    try {
      await store.assertNewSlug(slug);
      if (deps.projectExists !== undefined && !(await deps.projectExists(projectId))) {
        return refuse(reply, 404, { code: 'unknown_project', error: `no project ${JSON.stringify(projectId)}` });
      }
      const detail = await store.create({ slug, name: parsed.data.name ?? slug, projectId, actor: actorOf(req) });
      deps.audit.record('apps.app.created', actorOf(req), { detail: { app: slug, projectId, repoId: detail.repoId, receipt: detail.head.receipt } });
      return reply.code(201).send({ app: detail });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get(`${V}/apps/:app`, { config: { manifest: { responseType: 'AppDetailResponse', statusCodes: [200, 404, 409, 503] } } }, async (req, reply) => {
    const slug = slugOf(req, reply);
    if (slug === null) return reply;
    try {
      return { app: await store.detail(slug) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post(
    `${V}/apps/:app/edits`,
    { bodyLimit: EDIT_BODY_LIMIT, config: { manifest: { requestType: 'AppEditsBody', responseType: 'AppLandedResponse', statusCodes: [200, 400, 403, 404, 409, 422, 503] } } },
    async (req, reply) => {
      if (!humanOnly(req, reply, 'edit an app')) return reply;
      const slug = slugOf(req, reply);
      if (slug === null) return reply;
      if (overLong(req.body, 'ops', 50)) return refuse(reply, 400, { code: 'bad_request', error: 'an edit holds at most 50 ops' });
      const parsed = AppEditsSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const ops: AppEditOp[] = [];
      for (const [i, op] of parsed.data.ops.entries()) {
        if (op.op === 'query-text') {
          ops.push(op);
          continue;
        }
        const spec = parseSpec(op.spec);
        if (spec.spec === null) {
          const findings = spec.findings.map((f) => ({ ...f, path: `$.ops[${i}].spec${f.path.slice(1)}` }));
          return refuse(reply, 422, { code: 'check_failed', error: findings.map((f) => f.message).slice(0, 5).join('; '), findings });
        }
        ops.push({ op: 'spec', spec: spec.spec });
      }
      try {
        const v = await store.edit(slug, { base: parsed.data.base, ops, summary: parsed.data.summary, actor: actorOf(req) });
        audited(req, slug, v, 'edit');
        return await landed(slug, v);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  for (const direction of ['undo', 'redo'] as const) {
    app.post(
      `${V}/apps/:app/${direction}`,
      { config: { manifest: { requestType: 'AppHistoryMoveBody', responseType: 'AppLandedResponse', statusCodes: [200, 400, 403, 404, 409, 422, 503] } } },
      async (req, reply) => {
        if (!humanOnly(req, reply, `${direction} an app version`)) return reply;
        const slug = slugOf(req, reply);
        if (slug === null) return reply;
        const parsed = AppHistoryMoveSchema.safeParse(req.body);
        if (!parsed.success) return badRequest(reply, parsed.error);
        try {
          const v = await store.move(slug, direction, { base: parsed.data.base, actor: actorOf(req) });
          audited(req, slug, v, direction);
          return await landed(slug, v);
        } catch (err) {
          return fail(reply, err);
        }
      },
    );
  }

  app.post(
    `${V}/apps/:app/restore`,
    { config: { manifest: { requestType: 'AppRestoreBody', responseType: 'AppLandedResponse', statusCodes: [200, 400, 403, 404, 409, 422, 503] } } },
    async (req, reply) => {
      if (!humanOnly(req, reply, 'restore an app version')) return reply;
      const slug = slugOf(req, reply);
      if (slug === null) return reply;
      const parsed = AppRestoreSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const v = await store.restore(slug, { base: parsed.data.base, version: parsed.data.version, actor: actorOf(req) });
        audited(req, slug, v, 'restore');
        return await landed(slug, v);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.post(
    `${V}/apps/:app/query`,
    { config: { manifest: { requestType: 'AppQueryBody', responseType: 'AppQueryResponse', statusCodes: [200, 400, 403, 404, 409, 422, 429, 501, 502, 503, 504] } } },
    async (req, reply) => {
      // An app's live data reaches a person through the app's host only: never a plugin actor, and never an
      // agent seat (no value read from a row goes to a model, DES §5.2), whatever its trust.
      const actor = actorOf(req);
      if (actor.kind === 'plugin' || actor.kind === 'agent') return refuse(reply, 403, { code: 'human_only', error: `an app's query answers a person through the app; a ${actor.kind} actor cannot run one` });
      const slug = slugOf(req, reply);
      if (slug === null) return reply;
      const parsed = AppQuerySchema.safeParse(req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      if (deps.executor !== undefined) {
        try {
          const auth = req.headers.authorization;
          return await deps.executor.runQuery({ app: slug, version: parsed.data.version, query: parsed.data.query, ...(parsed.data.params !== undefined ? { params: parsed.data.params } : {}), actor, ...(typeof auth === 'string' ? { authorization: auth } : {}) });
        } catch (err) {
          return fail(reply, err);
        }
      }
      try {
        // DES §7.2 steps 1-2: an accepted receipt for (app, tree), and the query in that tree.
        const { spec } = await store.acceptedSpec(slug, parsed.data.version);
        if (!spec.queries.some((q) => q.id === parsed.data.query)) {
          return refuse(reply, 404, { code: 'unknown_query', error: `this version of ${slug} has no query ${parsed.data.query}` });
        }
        return refuse(reply, 501, { code: 'not_implemented', error: 'queries do not run on this daemon yet; nothing was sent to a source' });
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // The write path and publish are later slices; the boundary already holds: a human operator only.
  const stub = (method: 'POST' | 'GET' | 'DELETE', path: string, what: string): void => {
    app.route({
      method,
      url: `${V}/apps/:app${path}`,
      config: { manifest: { statusCodes: [403, 404, 501] } },
      handler: async (req, reply) => {
        if (!humanOnly(req, reply, what)) return reply;
        if (slugOf(req, reply) === null) return reply;
        return refuse(reply, 501, { code: 'not_implemented', error: `${what} is not served by this daemon yet; nothing happened` });
      },
    });
  };
  stub('POST', '/actions/:id/prepare', 'prepare an action');
  stub('POST', '/actions/:id/run', 'run an action');
  stub('GET', '/actions/records/:id', 'read an action record');
  stub('POST', '/actions/:id/grant', 'grant an action');
  stub('DELETE', '/actions/:id/grant', 'revoke an action');
  stub('POST', '/publish', 'publish an app');

  app.post(
    `${V}/apps/:app/turns`,
    { config: { manifest: { requestType: 'AppTurnBody', responseType: 'AppTurnResponse', statusCodes: [202, 400, 404, 409, 501, 503] } } },
    async (req, reply) => {
      const slug = slugOf(req, reply);
      if (slug === null) return reply;
      if (overLong(req.body, 'about', 20)) return refuse(reply, 400, { code: 'bad_request', error: 'a turn is about at most 20 components' });
      const parsed = AppTurnSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const turn = await store.beginTurn(slug, { base: parsed.data.base, message: parsed.data.message, about: parsed.data.about ?? [], actor: actorOf(req) });
        deps.audit.record('apps.turn.launched', actorOf(req), { runId: turn.runId, detail: { app: slug, base: turn.base } });
        return reply.code(202).send({ runId: turn.runId, turn });
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // WORKER-FACING (bearer-exempt, `isUnitTokenRoute`): the capability token in the body is the credential,
  // verified on every call. Nothing here reads `req.actor`.
  app.post(
    `${V}/apps/check`,
    { config: { manifest: { requestType: 'AppsCheckBody', responseType: 'AppsCheckResponse', statusCodes: [200, 400, 401, 404, 409, 503] } } },
    async (req, reply) => {
    if (deps.verifyUnitToken === undefined) {
      return refuse(reply, 503, { code: 'apps_unavailable', error: "this engine cannot verify a unit's token for apps_check yet; nothing was checked" });
    }
    const parsed = AppsCheckSchema.safeParse(req.body);
    if (!parsed.success) return refuse(reply, 400, { code: 'bad_request', error: 'body must be { token, app, commit }' });
    const unit = await deps.verifyUnitToken(parsed.data.token);
    if (unit === null) return reply.code(401).send({ code: 'invalid_token', error: 'the unit token is not valid' });
    if (!store.has(parsed.data.app)) return refuse(reply, 404, { code: 'unknown_app', error: `no app ${parsed.data.app}` });
    try {
      return await store.checkTurn(parsed.data.app, unit.runId, parsed.data.commit);
    } catch (err) {
      return fail(reply, err);
    }
    },
  );
}
