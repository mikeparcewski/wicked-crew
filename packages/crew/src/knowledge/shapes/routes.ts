/**
 * Data shapes and the Knowledge map (DES-KNOWLEDGE-DATA-001 §10, §19 B4):
 *
 *   POST /sources/:name/profile   HUMAN   profile a source (value-free), file its shapes as proposals for review
 *   GET  /knowledge/map           HUMAN   the approved shapes and the source catalogs, as nodes and typed edges
 *
 * Both are a human operator's only: an agent-kind actor, whatever its trust, gets 403 (the profile reads the
 * person's source through the `person` context; the map is the person's full view of every source and repo).
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { API_PREFIX } from '../../api/api-prefix.js';
import { trustAtLeast } from '../../api/auth.js';
import type { Actor, RepoEntry, SourceProfileResponse } from '../../core/types.js';
import { MCP_SERVER_NAME_RE } from '../../mcp/classify.js';
import type { McpRegistry } from '../../mcp/registry.js';
import { McpRegistryCorruptError } from '../../mcp/registry-store.js';
import type { SqlCatalog } from '../../sources/catalog/types.js';
import type { DialOptions } from '../../sources/dialer.js';
import { STATEMENT_DEADLINE_MS } from '../../sources/drivers/types.js';
import { sqlConnectArgs } from '../../sources/kinds.js';
import type { DataGate } from '../gate/gate.js';
import type { GateSource } from '../gate/sources.js';
import { type NameLookup, searchableRepos, searchEntities } from './code-search.js';
import { buildKnowledgeMap } from './map.js';
import { entityNames, PROFILE_BUDGET_MS, profileSource, type ProfileRelation } from './profile.js';
import { CatalogChangedError, type EstateCall, fileShapes, readCatalog, shapeProposals } from './shapes.js';

const V = API_PREFIX;

export interface ShapeRouteDeps {
  registry?: Pick<McpRegistry, 'callSecret'>;
  gate?: Pick<DataGate, 'sources' | 'personRead'>;
  /** Estate, the operator client (write mode, this daemon's stores). */
  estate: EstateCall;
  repos: () => Promise<RepoEntry[]>;
  audit: { record(action: string, actor: Actor, fields?: { runId?: string; detail?: Record<string, unknown> }): unknown };
  actorOf: (req: FastifyRequest) => Actor;
  dial?: DialOptions;
  /** TESTS: the exact-name code lookup (production: the `wicked-estate` CLI). */
  lookup?: NameLookup;
  /** TESTS: a shorter read deadline (production: K1's 10 s). */
  deadlineMs?: number;
  /** TESTS: the whole profile's time (production: {@link PROFILE_BUDGET_MS}). */
  budgetMs?: number;
}

function isHumanOperator(actor: Actor): boolean {
  return actor.kind === 'human' && trustAtLeast(actor, 'operator');
}

const capped = (err: unknown): string => {
  const m = err instanceof Error ? err.message : String(err);
  return m.length > 200 ? `${m.slice(0, 200)}…` : m;
};

/** At most this many relations and columns per relation are profiled; the rest are counted. */
export const PROFILE_RELATIONS_MAX = 200;
export const PROFILE_COLUMNS_MAX = 200;

/**
 * The relations to profile: estate's catalog documents (their keys exactly as estate holds them, which the shapes
 * link), each matched by its entry's schema and name to crew's OWN stored catalog, the truth for identifiers, types and
 * keys (a document crew's catalog does not hold, or a view the person has not allowed, is not read). Pure.
 */
export function relationsFromCatalog(
  docs: ReadonlyArray<{ key: string; entry?: unknown }>,
  catalog: SqlCatalog,
  viewsAllowed: readonly string[],
): { relations: ProfileRelation[]; notInCatalog: number; notListed: number } {
  const qualified = (schema: string | null, n: string): string => (schema === null ? n : `${schema}.${n}`);
  const allowed = new Set(viewsAllowed);
  const byName = new Map(catalog.relations.map((r) => [`${r.schema ?? ''}\u0000${r.name}`, r] as const));
  const byPlain = new Map(catalog.relations.map((r) => [qualified(r.schema, r.name), r] as const));
  const relations: ProfileRelation[] = [];
  let notInCatalog = 0;
  let notListed = 0;
  for (const d of docs) {
    const e = (typeof d.entry === 'object' && d.entry !== null ? d.entry : {}) as { schema?: unknown; name?: unknown };
    const r = typeof e.name === 'string' ? byName.get(`${typeof e.schema === 'string' ? e.schema : ''}\u0000${e.name}`) : byPlain.get(d.key);
    const readable = r !== undefined && (r.kind === 'table' || r.kind === 'partitioned' || ((r.kind === 'view' || r.kind === 'matview') && allowed.has(qualified(r.schema, r.name))));
    if (!readable) {
      notInCatalog++;
      continue;
    }
    if (relations.length >= PROFILE_RELATIONS_MAX) {
      notListed++;
      continue;
    }
    const cols = r.columns.slice(0, PROFILE_COLUMNS_MAX);
    relations.push({
      key: d.key,
      schema: r.schema,
      name: r.name,
      columns: cols.map((c) => ({ name: c.name, type: c.type, nullable: c.nullable })),
      primaryKey: [...r.primaryKey],
      foreignKeys: r.foreignKeys.map((f) => ({ columns: [...f.columns], references: { schema: f.references.schema, table: f.references.table, columns: [...f.references.columns] } })),
      ...(r.columns.length > cols.length ? { columnsNotListed: r.columns.length - cols.length } : {}),
    });
  }
  return { relations, notInCatalog, notListed };
}

export function registerShapeRoutes(app: FastifyInstance, deps: ShapeRouteDeps): void {
  // One profile per source at a time on this daemon: two at once would both read the queue empty and file twice.
  const running = new Map<string, Promise<unknown>>();
  const oneAtATime = <T>(sourceId: string, job: () => Promise<T>): Promise<T> => {
    const prior = running.get(sourceId) ?? Promise.resolve();
    const next = prior.then(job, job);
    running.set(sourceId, next);
    void next.then(
      () => (running.get(sourceId) === next ? running.delete(sourceId) : undefined),
      () => (running.get(sourceId) === next ? running.delete(sourceId) : undefined),
    );
    return next;
  };

  app.post<{ Params: { name: string } }>(
    `${V}/sources/:name/profile`,
    { config: { manifest: { responseType: 'SourceProfileResponse', statusCodes: [200, 400, 403, 404, 409, 502, 503] } } },
    async (req, reply) => {
      const actor = deps.actorOf(req);
      if (!isHumanOperator(actor)) {
        return reply.code(403).send({ error: `only a human operator profiles a source; you are ${actor.kind}/${actor.trust}`, code: 'profile_human_only' });
      }
      const name = req.params.name;
      if (!MCP_SERVER_NAME_RE.test(name)) return reply.code(400).send({ error: 'not a source name', code: 'bad_name' });
      const gate = deps.gate;
      const registry = deps.registry;
      if (gate === undefined || registry === undefined) return reply.code(503).send({ error: 'this daemon runs no data gate', code: 'gate_unavailable' });
      /** The source as the registry holds it NOW (read at the job's start and again before filing). */
      const current = async (): Promise<GateSource | undefined> => (await gate.sources()).find((x) => x.name === name);
      let first: GateSource | undefined;
      try {
        first = await current();
      } catch (err) {
        return reply.code(503).send({ error: err instanceof McpRegistryCorruptError ? err.message : `the connector registry could not be read: ${capped(err)}`, code: err instanceof McpRegistryCorruptError ? 'registry_corrupt' : 'registry_unavailable' });
      }
      if (first === undefined) return reply.code(404).send({ error: `no data source named ${name}`, code: 'unknown_server' });
      return oneAtATime(first.id, async () => {
        // Every check runs when this profile's turn comes: a profile queued behind another never uses an old record.
        let s: GateSource | undefined;
        try {
          s = await current();
        } catch (err) {
          return reply.code(503).send({ error: `the connector registry could not be read: ${capped(err)}`, code: 'registry_unavailable' });
        }
        if (s === undefined || s.id !== first.id) return reply.code(409).send({ error: `${name} was removed or replaced while this profile waited: profile it again`, code: 'source_changed' });
        if (s.runtime !== 'native' || s.dialect !== 'postgres') return reply.code(409).send({ error: `${name} is not a Postgres source on crew's own adapter: profiling reads those in this release`, code: 'profile_unsupported' });
        if (!s.enabled) return reply.code(409).send({ error: `${name} is switched off: it reads nothing`, code: 'source_disabled' });
        if (s.description === null) return reply.code(409).send({ error: `${name} has not been described yet: test the connection first`, code: 'not_described' });
        const catalog = s.description.catalog as SqlCatalog;
        // A shape links the relation's catalog document, so estate must hold the source's structure first; the
        // documents (their keys, as estate holds them) are what is profiled, each matched to crew's own catalog.
        let held: Awaited<ReturnType<typeof readCatalog>>;
        try {
          held = await readCatalog(deps.estate, s.id, [`source:${s.id}`]);
        } catch (err) {
          if (err instanceof CatalogChangedError) return reply.code(409).send({ error: `${name}'s structure changed in knowledge while crew read it: profile it again`, code: 'catalog_changed' });
          return reply.code(502).send({ error: `estate could not be read: ${capped(err)}`, code: 'estate_unavailable' });
        }
        const picked = relationsFromCatalog(held?.docs ?? [], catalog, s.viewsAllowed);
        if (picked.relations.length === 0) {
          return reply.code(409).send({ error: `crew has not written ${name}'s structure into knowledge yet: test its connection again, then profile it`, code: 'not_in_knowledge' });
        }
        let secret: { secret: string | null; missing: boolean };
        try {
          secret = await registry.callSecret(s.config);
        } catch {
          return reply.code(503).send({ error: `${name}'s secret could not be read from the secret store`, code: 'secret_unavailable' });
        }
        if (secret.missing) return reply.code(409).send({ error: `${name}'s secret is not set, so crew does not connect`, code: 'secret_missing' });
        const connect = sqlConnectArgs(s.config, secret.secret, deps.dial);
        const deadlineMs = deps.deadlineMs ?? STATEMENT_DEADLINE_MS;
        const budgetMs = deps.budgetMs ?? PROFILE_BUDGET_MS;
        const viewsAllowed = s.viewsAllowed;
        const views = JSON.stringify([...viewsAllowed].sort());
        /** The source is still the one being profiled: same id, descriptor, on, and the same allowed views. */
        const unchanged = async (): Promise<boolean> => {
          const now = await current().catch(() => undefined);
          return now !== undefined && now.id === s.id && now.descriptorHash === s.descriptorHash && now.enabled && JSON.stringify([...now.viewsAllowed].sort()) === views;
        };
        let changed = false;
        const profile = await profileSource(
          picked.relations,
          async (sql) => {
            // Checked before every statement (a switch-off or a re-save stops the next read, not only the filing).
            if (changed || !(await unchanged())) {
              changed = true;
              throw Object.assign(new Error('the source changed while it was profiled'), { code: 'source_changed' });
            }
            return gate.personRead(name, { connect, catalog, viewsAllowed, sql, rowCap: 1, maxBytes: 64 * 1024, deadlineMs, cls: 'profile' });
          },
          { now: Date.now, endsAt: Date.now() + budgetMs },
        );
        if (changed) return reply.code(409).send({ error: `${name} was switched off, removed or saved again while it was profiled: nothing was filed; profile it again`, code: 'source_changed' });
        // `describes`: exact-name code entities in the repos' own graphs, for relations that were read.
        const read = new Set(profile.relations.filter((p) => p.rows !== null).map((p) => p.key));
        const names = new Map(picked.relations.filter((r) => read.has(r.key)).map((r) => [r.key, entityNames(r.name)] as const));
        let repos: RepoEntry[] = [];
        try {
          repos = await deps.repos();
        } catch {
          // No repository list: nothing is searched, and the answer says so (codeSearch is empty).
        }
        const code = await searchEntities(names, searchableRepos(repos), deps.lookup);
        // The source must still be the one profiled (same id, descriptor, on, views) before anything is filed.
        if (!(await unchanged())) {
          return reply.code(409).send({ error: `${name} was switched off, removed or saved again while it was profiled: nothing was filed; profile it again`, code: 'source_changed' });
        }
        const at = new Date().toISOString();
        const proposals = shapeProposals({ id: s.id, name }, profile, code.matches, at);
        let filed: Awaited<ReturnType<typeof fileShapes>>;
        try {
          filed = await fileShapes(deps.estate, proposals);
        } catch (err) {
          return reply.code(502).send({ error: `estate did not take the shapes: ${capped(err)}`, code: 'estate_unavailable' });
        }
        deps.audit.record('knowledge.source.profiled', actor, {
          detail: { source: name, relations: profile.relations.length, unread: profile.relations.filter((p) => p.rows === null).length, joins: profile.joins.length, describes: [...code.matches.values()].reduce((n, m) => n + m.length, 0), proposed: filed.filed.length, alreadyProposed: filed.skipped },
        });
        const body: SourceProfileResponse = {
          name,
          sourceId: s.id,
          profiledAt: at,
          relations: profile.relations,
          joins: profile.joins,
          describes: [...code.matches.entries()].flatMap(([relation, ms]) => ms.map((m) => ({ relation, repo: m.repo, name: m.name, kind: m.kind, file: m.file }))),
          proposed: filed.filed,
          alreadyProposed: filed.skipped,
          codeSearch: { searched: code.searched, notSearched: code.notSearched },
          ...(picked.notInCatalog > 0 ? { notInKnowledge: picked.notInCatalog } : {}),
          ...(picked.notListed > 0 ? { notListed: picked.notListed } : {}),
          ...(held?.truncated === true ? { catalogTruncated: true } : {}),
        };
        return body;
      });
    },
  );

  app.get(
    `${V}/knowledge/map`,
    { config: { manifest: { responseType: 'KnowledgeMapResponse', statusCodes: [200, 403, 502, 503] } } },
    async (req, reply) => {
      const actor = deps.actorOf(req);
      if (!isHumanOperator(actor)) {
        return reply.code(403).send({ error: `the knowledge map is a human operator's view; you are ${actor.kind}/${actor.trust}`, code: 'knowledge_map_human_only' });
      }
      if (deps.gate === undefined) return reply.code(503).send({ error: 'this daemon runs no data gate', code: 'gate_unavailable' });
      let sources;
      try {
        sources = (await deps.gate.sources()).map((s) => ({ id: s.id, name: s.name, described: s.description !== null }));
      } catch (err) {
        if (err instanceof McpRegistryCorruptError) return reply.code(503).send({ error: err.message, code: 'registry_corrupt' });
        return reply.code(503).send({ error: 'the connector registry could not be read', code: 'registry_unavailable' });
      }
      let repos: string[];
      try {
        repos = (await deps.repos()).map((r) => r.id);
      } catch {
        return reply.code(503).send({ error: 'the repositories could not be read', code: 'repos_unavailable' });
      }
      try {
        return await buildKnowledgeMap(deps.estate, sources, repos);
      } catch (err) {
        return reply.code(502).send({ error: `estate could not be read: ${capped(err)}`, code: 'estate_unavailable' });
      }
    },
  );
}
