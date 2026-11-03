/**
 * The query executor (DES-APPS-001 §7.2): one named read of an accepted version, the library crew's
 * `POST /apps/:app/query` serves and the app server (K6) reuses.
 *
 *  1. (app, version) holds an accepted receipt; the spec, texts and lock are read at that tree;
 *  2. the query exists in that tree;
 *  3. parameters are validated against its schema, viewer-bound ones filled from the viewer (a client value
 *     for one is refused);
 *  4. the source's descriptor hash and the query's contract hash, recomputed NOW from the stored catalog,
 *     the registry or the introspection, equal the lock's; the read policy passes again;
 *  5. the read, through the dialer, the secret resolved now: READ ONLY, the 10 s deadline at the source,
 *     4 per source per app at once (queue 16, then 429), 60 a minute per viewer;
 *  6. rows projected to the declared columns, coerced and validated, the more path read, secrets scrubbed;
 *     a call record (who, app, version, query, ms, rows, bytes; never the rows).
 *
 * Reads are cached per app (cache.ts) and every action outcome invalidates the app's cache (`invalidate`).
 */

import { createHash } from 'node:crypto';

import { buildClientSchema, getVariableValues, type IntrospectionQuery, Kind, parse } from 'graphql';

import type { Actor, AppCell, AppLock, AppQuery, AppQueryResponse } from '../../core/types.js';
import { canonicalJson, deriveToolClass, effectiveToolClass } from '../../mcp/classify.js';
import { McpRegistryError, type McpRegistry } from '../../mcp/registry.js';
import { invokeMcpTool } from '../../mcp/invoke.js';
import type { McpToolRecord } from '../../mcp/registry-store.js';
import { UpstreamCallError } from '../../mcp/upstream-error.js';
import { policyCatalog, type SqlCatalog } from '../../sources/catalog/types.js';
import { CREW_SOURCE_ROUTES, type CrewInject, readCrewSource } from '../../sources/crew-source.js';
import { DialRefusedError, type DialOptions } from '../../sources/dialer.js';
import { SourceQueryError, STATEMENT_DEADLINE_MS } from '../../sources/drivers/types.js';
import { checkGraphqlRead, readGraphql } from '../../sources/graphql.js';
import { graphqlSource, sqlConnectArgs } from '../../sources/kinds.js';
import { checkReadPolicy } from '../../sources/policy/index.js';
import { readSqlQuery, SourcePolicyError, type SqlSourceHandle } from '../../sources/sql.js';
import { snapshotPath } from '../../sources/uploads.js';
import type { AppStore } from '../store.js';
import { AppReadCache, ttlOf } from './cache.js';
import { crewQueryContract, graphqlQueryContract, graphqlRootSignatures, sqlQueryContract, toolQueryContract } from './contract.js';
import { AppLimits, RateLimited } from './limits.js';
import { bindParams, ParamError, type Viewer } from './params.js';
import { morePathSays, projectRows, RESULT_LIMITS, ResultError, selectPath, sqlRowObjects } from './project.js';
import { lookupSource, pinOf, queryKindFits, type AppSource } from './sources.js';
import { parseCrewQueryText, parseToolQueryText, type QueryArg } from './texts.js';

/** A refusal or failure of the query route, as `AppErrorBody` carries it. */
export class AppExecError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: { retryAfterMs?: number } = {},
  ) {
    super(message);
  }
}

/** One call record (§7.2 step 6): never a row. */
export interface AppCallRecord {
  at: number;
  viewer: string;
  app: string;
  version: number | null;
  tree: string;
  query: string;
  ms: number;
  rows: number;
  bytes: number;
  outcome: 'ok' | 'cached' | string;
}

export interface ExecutorDeps {
  store: AppStore;
  registry: McpRegistry | null;
  /** The crew source's in-process reads (Fastify `inject`); absent = the crew source is unavailable. */
  crewInject?: CrewInject;
  /** Who the actor is as a viewer (email, name, groups). */
  viewerOf: (actor: Actor) => Promise<Viewer>;
  dial?: DialOptions;
  snapshotDir?: string;
  now?: () => number;
  /** How long a crew-source read may take (default: the 10 s statement deadline). */
  crewDeadlineMs?: number;
}

const sha = (v: unknown): string => createHash('sha256').update(canonicalJson(v)).digest('hex');
const CALLS_PER_APP = 200;

/** What a query needs to run, once its contract has been recomputed. */
type Plan =
  | { kind: 'sql'; source: Extract<AppSource, { kind: 'sql' }>; driver: 'postgres' | 'mysql' | 'sqlite'; catalog: SqlCatalog }
  | { kind: 'graphql'; source: Extract<AppSource, { kind: 'graphql' }> }
  | { kind: 'tool'; source: Extract<AppSource, { kind: 'rest' | 'mcp-http' | 'mcp-stdio' }>; tool: McpToolRecord; args: Record<string, QueryArg> }
  | { kind: 'crew'; route: string; params: Record<string, QueryArg>; query: Record<string, QueryArg> };

const argValue = (a: QueryArg, byName: Record<string, unknown>): unknown => (a.kind === 'literal' ? a.value : byName[a.name]);

export class AppExecutor {
  readonly cache: AppReadCache<Omit<AppQueryResponse, 'cachedAt' | 'ms'> & { bytes: number }>;
  readonly limits: AppLimits;
  private readonly calls = new Map<string, AppCallRecord[]>();
  private readonly now: () => number;

  constructor(private readonly deps: ExecutorDeps) {
    this.now = deps.now ?? Date.now;
    this.cache = new AppReadCache(this.now);
    this.limits = new AppLimits(this.now);
  }

  /** Every cached read of `app` gone (an action ran on it). */
  invalidate(app: string): void {
    this.cache.invalidate(app);
  }

  /** The app's last call records, newest last. */
  callRecords(app: string): AppCallRecord[] {
    return [...(this.calls.get(app) ?? [])];
  }

  private record(r: AppCallRecord): void {
    const list = this.calls.get(r.app) ?? [];
    list.push(r);
    if (list.length > CALLS_PER_APP) list.splice(0, list.length - CALLS_PER_APP);
    this.calls.set(r.app, list);
  }

  async runQuery(input: { app: string; version: number | string; query: string; params?: Record<string, unknown>; actor: Actor; authorization?: string }): Promise<AppQueryResponse> {
    const started = this.now();
    const { files, tree, version } = await this.deps.store.acceptedFiles(input.app, input.version);
    const q = files.spec.queries.find((x) => x.id === input.query);
    if (q === undefined) throw new AppExecError(404, 'unknown_query', `this version of ${input.app} has no query ${input.query}`);
    const viewer = await this.deps.viewerOf(input.actor);
    let bound: ReturnType<typeof bindParams>;
    try {
      bound = bindParams(q.params, input.params, viewer);
    } catch (err) {
      if (err instanceof ParamError) throw new AppExecError(err.code === 'bad_params' ? 400 : 409, err.code, err.message);
      throw err;
    }
    const text = Object.hasOwn(files.queryText, q.id) ? files.queryText[q.id]! : '';
    const first = await this.plan(q, text, files.lock, bound.byName);
    const { plan, contractHash, descriptorHash } = first;
    // The secret resolved now: its digest keys the cache, so rows read under a credential that has since been
    // rotated are never served under the new one (codex r1); it is never stored.
    const secret = await this.secret(plan);
    try {
      this.limits.rate('query', input.app, input.actor.id);
    } catch (err) {
      if (err instanceof RateLimited) throw new AppExecError(429, 'rate_limited', err.message, { retryAfterMs: err.retryAfterMs });
      throw err;
    }
    const key = sha({ tree, query: q.id, params: bound.byName, descriptorHash, contractHash, credential: secret === null ? null : createHash('sha256').update(secret).digest('hex'), ...(plan.kind === 'crew' ? { actor: input.actor.id } : {}) });
    try {
      const sourceName = plan.kind === 'crew' ? 'crew' : plan.source.name;
      const r = await this.cache.read(input.app, key, ttlOf(q.refresh), () =>
        this.limits.run(input.app, sourceName, async () => {
          // Planned again once the slot is held: a read that waited never runs a plan the source has since
          // changed under (codex r1).
          const now = await this.plan(q, text, files.lock, bound.byName);
          // A credential removed while it waited is a change like any other (codex r2).
          const nowSecret = await this.secret(now.plan).catch(() => undefined);
          if (now.contractHash !== contractHash || now.descriptorHash !== descriptorHash || nowSecret !== secret) {
            throw new AppExecError(409, 'contract_changed', `${q.source} changed while query ${q.id} waited: run it again`);
          }
          return this.execute(q, text, now.plan, bound, input.authorization, secret);
        }),
      );
      const ms = this.now() - started;
      this.record({ at: started, viewer: input.actor.id, app: input.app, version, tree, query: q.id, ms, rows: r.value.rows.length, bytes: r.value.bytes, outcome: r.cachedAt === null ? 'ok' : 'cached' });
      const { bytes: _b, ...body } = r.value;
      void _b;
      return { ...body, ms, cachedAt: r.cachedAt };
    } catch (err) {
      const e = this.failure(err);
      this.record({ at: started, viewer: input.actor.id, app: input.app, version, tree, query: q.id, ms: this.now() - started, rows: 0, bytes: 0, outcome: e.code });
      throw e;
    }
  }

  /** Step 4: the descriptor and the contract recomputed now, against the lock. */
  private async plan(q: AppQuery, text: string, lock: AppLock, byName: Record<string, unknown>): Promise<{ plan: Plan; contractHash: string; descriptorHash: string }> {
    void byName;
    const locked = Object.hasOwn(lock.queries, q.id) ? lock.queries[q.id]! : undefined;
    const pinned = Object.hasOwn(lock.sources, q.source) ? lock.sources[q.source]! : undefined;
    if (locked === undefined || pinned === undefined) throw new AppExecError(409, 'contract_changed', `query ${q.id} was never checked against ${q.source}: check this version again`);
    let source: AppSource | null;
    try {
      source = await lookupSource(this.deps.registry, q.source);
    } catch (err) {
      if (err instanceof McpRegistryError) throw new AppExecError(409, 'contract_changed', `${q.source} cannot be used now (${err.code})`);
      throw err;
    }
    if (source === null || !queryKindFits(q.kind, source)) throw new AppExecError(409, 'contract_changed', `${q.source} is gone or is another kind of source now`);
    if (source.pin.descriptorHash !== pinned.descriptorHash) throw new AppExecError(409, 'contract_changed', `${q.source}'s connection changed since this version was checked: check it again`);
    // A source switched off reads nothing (codex r1; a tool's server is checked through `bound`).
    if ((source.kind === 'sql' || source.kind === 'graphql') && !source.enabled) throw new AppExecError(409, 'query_refused', `${q.source} is switched off`);
    const changed = (): AppExecError => new AppExecError(409, 'contract_changed', `what query ${q.id} reads at ${q.source} changed since this version was checked: check it again`);
    let plan: Plan;
    let contract: string | null;
    if (source.kind === 'crew') {
      const t = parseCrewQueryText(text);
      const route = t.ok ? CREW_SOURCE_ROUTES.find((r) => r.path === t.value.route) : undefined;
      if (!t.ok || route === undefined) throw changed();
      contract = crewQueryContract(route);
      plan = { kind: 'crew', route: route.path, params: t.value.params, query: t.value.query };
    } else if (source.kind === 'graphql') {
      const introspection = source.description?.introspection;
      if (introspection === undefined) throw changed();
      const c = checkGraphqlRead(text, introspection);
      const sigs = c.ok ? graphqlRootSignatures(text, introspection, 'query') : null;
      if (sigs === null) throw changed();
      contract = graphqlQueryContract(sigs, q.params);
      plan = { kind: 'graphql', source };
    } else if (source.kind === 'sql') {
      if (source.description === null) throw changed();
      const catalog = source.description.catalog as SqlCatalog;
      const driver = source.config.sql?.driver ?? 'postgres';
      const policy = await checkReadPolicy(driver, text, policyCatalog(catalog, driver === 'sqlite' ? [] : (source.config.viewsAllowed ?? [])));
      if (!policy.ok) throw new AppExecError(409, 'query_refused', `the read policy refuses query ${q.id} now (${policy.code}): ${policy.detail}`);
      contract = sqlQueryContract(driver, catalog, policy.keys ?? [], q.params);
      plan = { kind: 'sql', source, driver, catalog };
    } else {
      const t = parseToolQueryText(text);
      if (!t.ok) throw changed();
      const found = await this.deps.registry!.appTool(source.name, t.value.tool);
      // The tool as the PINNED config's server has it (a save between the two reads is a change, not a mix).
      if (found === null || !found.bound || pinOf(found.config).descriptorHash !== source.pin.descriptorHash) throw changed();
      if (effectiveToolClass(deriveToolClass(found.tool.annotations), found.tool.classOverride) !== 'read') throw changed();
      contract = toolQueryContract(source.kind, found.tool, q.params);
      plan = { kind: 'tool', source, tool: found.tool, args: t.value.args };
    }
    if (contract === null || contract !== locked.contractHash) throw changed();
    return { plan, contractHash: contract, descriptorHash: source.pin.descriptorHash };
  }

  /** Steps 5-6: the read, then the rows. */
  private async execute(q: AppQuery, text: string, plan: Plan, bound: ReturnType<typeof bindParams>, authorization: string | undefined, secret: string | null): Promise<{ value: Omit<AppQueryResponse, 'cachedAt' | 'ms'> & { bytes: number }; bytes: number }> {
    const secrets: string[] = secret === null ? [] : [secret];
    let rows: Array<Record<string, unknown>>;
    let truncated = false;
    let hasMore = false;
    if (plan.kind === 'sql') {
      let handle: SqlSourceHandle;
      if (plan.driver === 'sqlite') {
        handle = { driver: 'sqlite', snapshotPath: snapshotPath(plan.source.config.sql?.snapshot ?? '', this.deps.snapshotDir), catalog: plan.catalog };
      } else {
        handle = { driver: plan.driver, connect: sqlConnectArgs(plan.source.config, secret, this.deps.dial ?? {}), catalog: plan.catalog, viewsAllowed: plan.source.config.viewsAllowed ?? [] };
      }
      // The 10 MB cap applies while reading, not after holding everything (codex r1).
      const r = await readSqlQuery(handle, text, bound.ordered, { maxBytes: RESULT_LIMITS.bytes });
      // The live result carries the declared columns (names; the source check held their types).
      for (const o of q.output) if (!r.columns.some((c) => c.name === o.name)) throw new AppExecError(409, 'contract_changed', `query ${q.id} no longer returns column ${o.name}: check this version again`);
      rows = sqlRowObjects(r.columns, r.rows);
      truncated = r.truncated;
    } else {
      let body: unknown;
      if (plan.kind === 'graphql') {
        const introspection = plan.source.description!.introspection!;
        const variables = Object.fromEntries(Object.entries(bound.byName).filter(([k]) => !bound.absent.has(k)));
        // graphql-js's own coercion of the bound variables, before anything is sent (codex r2: Int range, enums, nulls).
        const problem = graphqlVariablesProblem(text, introspection, variables);
        if (problem !== null) throw new AppExecError(400, 'bad_params', problem);
        body = await readGraphql(graphqlSource(plan.source.config, this.deps.dial ?? {}), secret, introspection, text, variables);
        const errs = (body as { errors?: unknown } | null)?.errors;
        if (Array.isArray(errs) && errs.length > 0 && (body as { data?: unknown }).data == null) throw new AppExecError(502, 'source_failed', `the GraphQL source answered ${errs.length} error(s) and no data`);
      } else if (plan.kind === 'tool') {
        // An argument an absent optional parameter fills is left out (codex r2).
        const args = Object.fromEntries(Object.entries(plan.args).filter(([, a]) => a.kind !== 'param' || !bound.absent.has(a.name)).map(([k, a]) => [k, argValue(a, bound.byName)]));
        const res = await invokeMcpTool(plan.source.config, secret, plan.tool.name, args, 30_000, plan.tool.rest ?? null);
        if (res['isError'] === true) {
          // Only crew's own REST invoker writes this status; an MCP server's metadata is its own text (codex r1).
          const status = plan.source.kind === 'rest' ? (res['_meta'] as { 'wicked/rest'?: { status?: unknown } } | undefined)?.['wicked/rest']?.status : undefined;
          const shown = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? ` (HTTP ${status})` : '';
          throw new AppExecError(502, 'source_failed', `${plan.source.name}/${plan.tool.name} answered an error${shown}`);
        }
        body = toolBody(res);
      } else {
        if (this.deps.crewInject === undefined) throw new AppExecError(503, 'apps_unavailable', 'the crew source is not available on this daemon');
        const params = Object.fromEntries(Object.entries(plan.params).map(([k, a]) => [k, String(argValue(a, bound.byName) ?? '')]));
        const query = Object.fromEntries(Object.entries(plan.query).flatMap(([k, a]) => {
          const v = argValue(a, bound.byName);
          return v === null || v === undefined ? [] : [[k, String(v)]];
        }));
        // Bounded like every other read: a crew route that never answers releases its slot at the deadline (codex r1).
        let timer: NodeJS.Timeout | undefined;
        const deadline = new Promise<never>((_, reject) => {
          const ms = this.deps.crewDeadlineMs ?? STATEMENT_DEADLINE_MS;
          timer = setTimeout(() => reject(new AppExecError(504, 'source_timeout', `crew did not answer ${plan.route} within ${Math.round(ms / 1000)} s`)), ms);
        });
        const r = await Promise.race([readCrewSource(this.deps.crewInject, plan.route, params, query, authorization !== undefined ? { authorization } : {}), deadline]).finally(() => clearTimeout(timer));
        if (r.status !== 200) throw new AppExecError(502, 'source_failed', `crew answered HTTP ${r.status} for ${plan.route}`);
        body = r.json;
      }
      // At most one row past the cap is selected (it says `truncated`); only rows that are kept are validated.
      const selected = q.rowPath === undefined ? Object.assign([body], { more: false }) : selectPath(body, q.rowPath, RESULT_LIMITS.rows);
      truncated = selected.more === true;
      rows = selected.map((v, i) => {
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new ResultError(`row ${i + 1} at ${q.rowPath ?? '$'} is not an object`);
        return v as Record<string, unknown>;
      });
      hasMore = morePathSays(body, q.morePath);
    }
    // The secret is scrubbed from each raw value before it is coerced, cut or measured.
    const projected = projectRows(q.output, rows, truncated, secrets);
    const cells: AppCell[][] = projected.rows;
    const value = { columns: q.output.map((c) => ({ ...c })), rows: cells, truncated: projected.truncated, hasMore, bytes: projected.bytes };
    return { value, bytes: projected.bytes };
  }

  private async secret(plan: Plan): Promise<string | null> {
    if (plan.kind === 'crew' || (plan.kind === 'sql' && plan.driver === 'sqlite')) return null;
    const s = plan.source;
    const r = await this.deps.registry!.callSecret(s.config);
    if (r.missing) throw new AppExecError(409, 'source_failed', `${s.name}'s secret resolves to nothing; set it first`);
    return r.secret;
  }

  /** A failure in the route's words: a class and a SQLSTATE, never the source's message (it can echo a value). */
  private failure(err: unknown): AppExecError {
    if (err instanceof AppExecError) return err;
    if (err instanceof RateLimited) return new AppExecError(429, 'rate_limited', err.message, { retryAfterMs: err.retryAfterMs });
    if (err instanceof ResultError) return new AppExecError(422, 'result_invalid', err.message);
    if (err instanceof SourcePolicyError) return new AppExecError(409, 'query_refused', `the read policy refuses the query (${err.code}): ${err.message}`);
    if (err instanceof DialRefusedError) return new AppExecError(409, 'query_refused', `the connection to the source was refused (${err.code})`);
    if (err instanceof SourceQueryError) {
      const st = err.sqlstate !== null ? ` (SQLSTATE ${err.sqlstate})` : '';
      if (err.errorClass === 'timeout') return new AppExecError(504, 'source_timeout', 'the query ran past its 10 s deadline and was stopped at the source');
      if (err.errorClass === 'refused') return new AppExecError(409, 'query_refused', `the source refused the read${err.refusal !== null ? ` (${err.refusal})` : ''}: describe it again if it changed`);
      return new AppExecError(502, err.errorClass === 'connection' ? 'source_unavailable' : 'source_failed', `the source answered ${err.errorClass}${st}`);
    }
    if (err instanceof UpstreamCallError) return new AppExecError(err.errorClass === 'timeout' ? 504 : 502, err.errorClass === 'timeout' ? 'source_timeout' : 'source_failed', `the source call failed (${err.errorClass})`);
    if (err instanceof McpRegistryError) return new AppExecError(409, 'contract_changed', `the source cannot be used now (${err.code})`);
    return new AppExecError(502, 'source_failed', 'the read failed');
  }
}

/** Why graphql-js would refuse these variable values for `document`, or `null` (its own input coercion). */
export function graphqlVariablesProblem(document: string, introspection: IntrospectionQuery, variables: Record<string, unknown>): string | null {
  try {
    const schema = buildClientSchema(introspection);
    const op = parse(document, { noLocation: true, maxTokens: 10_000 }).definitions.find((d) => d.kind === Kind.OPERATION_DEFINITION);
    if (op === undefined || op.kind !== Kind.OPERATION_DEFINITION) return 'the document has no operation';
    const r = getVariableValues(schema, op.variableDefinitions ?? [], variables, { maxErrors: 5 });
    return r.errors === undefined || r.errors.length === 0 ? null : r.errors.map((e) => e.message).join('; ');
  } catch (err) {
    return `the variables cannot be checked (${err instanceof Error ? err.name : 'error'})`;
  }
}

/** A tool's answer as one JSON body: its structured content, or its single text content parsed as JSON. */
function toolBody(res: Record<string, unknown>): unknown {
  if (res['structuredContent'] !== undefined) return res['structuredContent'];
  const content = Array.isArray(res['content']) ? (res['content'] as Array<{ type?: string; text?: string }>) : [];
  const texts = content.filter((c) => c.type === 'text' && typeof c.text === 'string');
  if (texts.length === 1) {
    try {
      return JSON.parse(texts[0]!.text!);
    } catch {
      throw new ResultError('the tool answered text that is not JSON');
    }
  }
  throw new ResultError('the tool answered no structured content and no single JSON text');
}
