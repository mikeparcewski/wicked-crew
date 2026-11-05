/**
 * Tracker links (DES-PM-001 §3.3): which trackers (one project inside one tenant of a registered PM system) are
 * linked to which studio projects and repos. Every route is a HUMAN's only: any other actor, whatever its trust, gets
 * 403 `tracker_links_human_only` (the rule of `knowledge/gate/routes.ts`): a link says "this work is tracked there",
 * and it widens what a project's agents may read.
 *
 *   GET    /tracker-links?project=&repo=   the links of a project and/or a repo (with both: a run's tracker set)
 *   POST   /tracker-links                  link a tracker (a direct live lookup first); 201, or 200 when it exists
 *   DELETE /tracker-links/:id              unlink; the tracker's last link retires it (its estate documents go)
 *   GET    /sources/:name/trackers         one page of the projects the source lists NOW (a person's live read)
 *
 * The links live on the PM source's registry entry (`trackers[]`), written in one registry mutation (a generation,
 * an atomic rename), audited `knowledge.source.tracker_linked` / `tracker_unlinked`, then projected into estate.
 * Access follows the registry at once (the gate reads it on every call); Understand follows the projection.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { API_PREFIX } from '../../api/api-prefix.js';
import { trustAtLeast } from '../../api/auth.js';
import type { Actor, SourceTrackersResponse, TrackerIssuesResponse, TrackerLink, TrackerLinksResponse } from '../../core/types.js';
import { MCP_SERVER_NAME_RE } from '../../mcp/classify.js';
import { configOf, normalizeRegistryFile, pmDescriptorHash } from '../../mcp/registry.js';
import { McpRegistryCorruptError, type McpRegistryStore } from '../../mcp/registry-store.js';
import { DEFAULT_PROJECT_ID } from '../../projects/default-project.js';
import { agentMay } from '../gate/access.js';
import { type StoredTracker, type TrackerLinkTarget, type TrackerStructure, trackerIdOf, trackerLabel, trackerLinkIdOf, trackersOf } from '../registry/entry.js';
import { bindingInForce, GITHUB_TENANT, jiraSitesOf, outlineOf, readPayload } from './bindings.js';
import { type PmGate, projectOptsOf } from './gate-pm.js';
import { type PmEntry, pmEntriesOf } from './set.js';
import { PROJECTION_UNKNOWN, type TrackerProjectionLookup, trackerLinkView } from './view.js';

const V = API_PREFIX;

export interface TrackerRouteDeps {
  store?: Pick<McpRegistryStore, 'read' | 'mutate'>;
  pm?: Pick<PmGate, 'personCall' | 'personOp' | 'vendorRead' | 'trackerSet'>;
  projects: {
    get(id: string): Promise<{ id: string; name: string; status: string } | null>;
    /** The live `crew.repo` members of a project. */
    repos(projectId: string): Promise<string[]>;
    /** The projects a repo is a live member of. */
    ofRepo(repoId: string): Promise<string[]>;
    /** Every registered repo id. */
    allRepos(): Promise<string[]>;
  };
  audit: { record(action: string, actor: Actor, fields?: { runId?: string; detail?: Record<string, unknown> }): unknown };
  actorOf: (req: FastifyRequest) => Actor;
  /** Whether estate holds each tracker's links (the projector). */
  projection?: TrackerProjectionLookup;
  /** A tracker's links changed: project it (the projector reconciles). */
  changed?: (sourceName: string, trackerId: string) => void;
}

const isHuman = (a: Actor): boolean => a.kind === 'human';
const isHumanOperator = (a: Actor): boolean => a.kind === 'human' && trustAtLeast(a, 'operator');

function humanOnly(reply: FastifyReply, actor: Actor): FastifyReply {
  return reply.code(403).send({ error: `only a person links trackers to projects and repos, or reads a tracker source's projects; you are ${actor.kind}/${actor.trust}`, code: 'tracker_links_human_only' });
}

const TargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project'), id: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/) }).strict(),
  z.object({ kind: z.literal('repo'), id: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/) }).strict(),
]);

export const CreateTrackerLinkSchema = z
  .object({
    source: z.string().min(1).max(63),
    tenant: z.string().min(1).max(256),
    key: z.string().min(1).max(201),
    target: TargetSchema,
  })
  .strict();

const ListQuery = z.object({ project: z.string().min(1).max(128).optional(), repo: z.string().min(1).max(128).optional() }).strict();
const IssuesQuery = z.object({ project: z.string().min(1).max(128).optional(), repo: z.string().min(1).max(128).optional(), q: z.string().max(200).optional() }).strict();
const SourceTrackersQuery = z.object({ q: z.string().max(200).optional(), cursor: z.string().max(400).optional(), tenant: z.string().max(256).optional() }).strict();

/** A Jira project key, or a GitHub `owner/repo`: one key names one project (no wildcard, JQL or whole site). */
export function validTrackerKey(system: string, key: string): boolean {
  if (system === 'jira') return /^[A-Z][A-Z0-9_]{0,19}$/.test(key);
  if (system === 'github') return /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(key);
  return false;
}

const PAGE = 50;
/** At most this many links per tracker (estate's per-document link bound). */
export const TRACKER_LINKS_MAX = 200;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The single JSON payload of a person read (the same rule the projectors use), or `null`. */
function payload(result: Record<string, unknown>): unknown {
  const r = readPayload(result);
  return r.ok ? r.payload : null;
}

type Fail = { ok: false; code: string; reason: string };

/**
 * A person read's payload, or why there is none, said so the next attempt is diagnosable: the vendor's error with its
 * HTTP status, or the outline of a shape crew does not know (block types, field names, array lengths; never a value).
 */
function read(e: PmEntry, tool: string, result: Record<string, unknown>): { ok: true; payload: unknown } | Fail {
  return readPayload(result, `${e.name} (${tool})`);
}

type Listed = { tenant: string; tenantLabel?: string; key: string; label: string };
type Lister = { ok: true; rows: Listed[]; next: string | null } | Fail;

/** Jira sites the credential reaches (`getAccessibleAtlassianResources`): v2 `{resources: [{cloudId, url, products}]}`. */
async function jiraSites(pm: Pick<PmGate, 'personCall'>, e: PmEntry): Promise<{ ok: true; sites: Array<{ id: string; label: string; host: string | null }> } | Fail> {
  const r = await pm.personCall(e, 'getAccessibleAtlassianResources', {});
  if (!r.ok) return r;
  const p = read(e, 'getAccessibleAtlassianResources', r.result);
  if (!p.ok) return p;
  const sites = jiraSitesOf(p.payload);
  if (sites === null) return { ok: false, code: 'unknown_shape', reason: `${e.name} answered its sites in a shape crew does not know (got ${outlineOf(p.payload)})` };
  return { ok: true, sites: sites.map((s) => ({ ...s, label: trackerLabel(s.label, s.id) })) };
}

/** One page of a Jira site's projects (`listJiraProjects`). */
async function jiraProjects(pm: Pick<PmGate, 'personOp'>, e: PmEntry, cloudId: string, q: string, startAt: number): Promise<{ ok: true; rows: Array<{ key: string; label: string }>; more: boolean } | Fail> {
  // A non-primary operation on the Atlassian v2 server: by name, or through its executeRead meta-tool.
  const r = await pm.personOp(e, 'listJiraProjects', cloudId, { ...(q !== '' ? { searchString: q } : {}), startAt, maxResults: PAGE });
  if (!r.ok) return r;
  const pr = read(e, 'listJiraProjects', r.result);
  if (!pr.ok) return pr;
  const p = pr.payload;
  const list = Array.isArray(p) ? p : isObj(p) && Array.isArray(p['values']) ? (p['values'] as unknown[]) : isObj(p) && Array.isArray(p['projects']) ? (p['projects'] as unknown[]) : null;
  if (list === null) return { ok: false, code: 'unknown_shape', reason: `${e.name} answered its projects in a shape crew does not know (got ${outlineOf(p)})` };
  const rows = list.filter(isObj).filter((x) => typeof x['key'] === 'string' && validTrackerKey('jira', x['key'])).map((x) => ({ key: x['key'] as string, label: trackerLabel(x['name'], x['key'] as string) }));
  const more = isObj(p) && p['isLast'] === false ? true : isObj(p) && typeof p['total'] === 'number' ? startAt + list.length < p['total'] : list.length >= PAGE;
  return { ok: true, rows, more };
}

/** One page of GitHub repositories (`search_repositories`). */
async function githubRepos(pm: Pick<PmGate, 'personCall'>, e: PmEntry, query: string, page: number): Promise<{ ok: true; rows: Array<{ key: string; label: string }>; more: boolean } | { ok: false; code: string; reason: string }> {
  const r = await pm.personCall(e, 'search_repositories', { query, page, perPage: PAGE });
  if (!r.ok) return r;
  const pr = read(e, 'search_repositories', r.result);
  if (!pr.ok) return pr;
  const p = pr.payload;
  if (!isObj(p) || !Array.isArray(p['items'])) return { ok: false, code: 'unknown_shape', reason: `${e.name} answered its repositories in a shape crew does not know (got ${outlineOf(p)})` };
  const rows = (p['items'] as unknown[]).filter(isObj).filter((x) => typeof x['full_name'] === 'string' && validTrackerKey('github', x['full_name'])).map((x) => ({ key: x['full_name'] as string, label: trackerLabel(x['full_name'], x['full_name'] as string) }));
  const total = typeof p['total_count'] === 'number' ? p['total_count'] : 0;
  return { ok: true, rows, more: page * PAGE < Math.min(total, 1000) };
}

const enc = (v: unknown): string => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
function dec(c: string | undefined): Record<string, unknown> | null {
  if (c === undefined || c === '') return {};
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as unknown;
    if (!isObj(v)) return null;
    // Only this route's own shapes: whole, non-negative offsets (`t`, `s`) or a page from 1 (`p`).
    const keys = Object.keys(v);
    const nat = (x: unknown, min: number): boolean => typeof x === 'number' && Number.isInteger(x) && x >= min && x <= 1_000_000;
    if (keys.every((k) => k === 't' || k === 's') && (v['t'] === undefined || nat(v['t'], 0)) && (v['s'] === undefined || nat(v['s'], 0))) return v;
    if (keys.length === 1 && keys[0] === 'p' && nat(v['p'], 1)) return v;
    return null;
  } catch {
    return null;
  }
}

/** One page of the projects a PM source lists now. */
export async function listSourceTrackers(pm: Pick<PmGate, 'personCall' | 'personOp'>, e: PmEntry, q: string, cursor: Record<string, unknown>, onlyTenant: string | null): Promise<Lister> {
  if (e.system === 'github') {
    const page = typeof cursor['p'] === 'number' && cursor['p'] >= 1 ? Math.trunc(cursor['p']) : 1;
    let query = q.trim();
    if (query === '') {
      const me = await pm.personCall(e, 'get_me', {});
      if (!me.ok) return me;
      const pr = read(e, 'get_me', me.result);
      if (!pr.ok) return pr;
      const p = pr.payload;
      const login = isObj(p) && typeof p['login'] === 'string' ? p['login'] : null;
      if (login === null) return { ok: false, code: 'unknown_shape', reason: `${e.name} did not say whose credential it holds (get_me answered ${outlineOf(p)})` };
      query = `user:${login}`;
    } else {
      query = `${query.replace(/[^\w./ -]/g, ' ')} in:name`;
    }
    const r = await githubRepos(pm, e, `${query} fork:true`, page);
    if (!r.ok) return r;
    return { ok: true, rows: r.rows.map((x) => ({ tenant: GITHUB_TENANT, key: x.key, label: x.label })), next: r.more ? enc({ p: page + 1 }) : null };
  }
  const sites = await jiraSites(pm, e);
  if (!sites.ok) return sites;
  const pool = onlyTenant === null ? sites.sites : sites.sites.filter((s) => s.id === onlyTenant);
  let t = typeof cursor['t'] === 'number' ? Math.trunc(cursor['t']) : 0;
  let s = typeof cursor['s'] === 'number' ? Math.trunc(cursor['s']) : 0;
  const rows: Listed[] = [];
  while (t < pool.length && rows.length === 0) {
    const site = pool[t]!;
    const r = await jiraProjects(pm, e, site.id, q.trim(), s);
    if (!r.ok) return r;
    rows.push(...r.rows.map((x) => ({ tenant: site.id, tenantLabel: site.label, key: x.key, label: x.label })));
    if (r.more) {
      s += PAGE;
      return { ok: true, rows, next: enc({ t, s }) };
    }
    t += 1;
    s = 0;
  }
  return { ok: true, rows, next: t < pool.length ? enc({ t, s: 0 }) : null };
}

/** The direct live lookup a link needs (§3.3): the tracker's label, or why it cannot be linked. */
export async function lookupTracker(pm: Pick<PmGate, 'personCall' | 'personOp'>, e: PmEntry, tenant: string, key: string): Promise<{ ok: true; key: string; label: string; tenantLabel: string | null; siteHost?: string | null } | { ok: false; code: string; reason: string; status: number; cause?: string }> {
  if (!validTrackerKey(e.system, key)) return { ok: false, status: 422, code: 'tracker_unknown', reason: e.system === 'jira' ? 'a Jira tracker is one project key, such as PROJA' : 'a GitHub tracker is one owner/repo' };
  if (e.system === 'github') {
    if (tenant !== GITHUB_TENANT) return { ok: false, status: 422, code: 'tracker_unknown', reason: `a GitHub source's tenant is ${GITHUB_TENANT}` };
    const r = await githubRepos(pm, e, `repo:${key}`, 1);
    if (!r.ok) return { ...r, status: 503, code: 'source_unavailable', cause: r.code };
    const hit = r.rows.find((x) => x.key.toLowerCase() === key.toLowerCase());
    if (hit === undefined) return { ok: false, status: 422, code: 'tracker_unknown', reason: `${e.name} finds no repository ${key}` };
    return { ok: true, key: hit.key, label: hit.label, tenantLabel: null };
  }
  const sites = await jiraSites(pm, e);
  if (!sites.ok) return { ...sites, status: 503, code: 'source_unavailable', cause: sites.code };
  const site = sites.sites.find((s) => s.id === tenant);
  if (site === undefined) return { ok: false, status: 422, code: 'tracker_unknown', reason: `${e.name}'s credential reaches no Jira site ${tenant}` };
  // Every page of the key's search, until the exact key is found or the site says it was the last page.
  for (let page = 0; page < 20; page++) {
    const r = await jiraProjects(pm, e, tenant, key, page * PAGE);
    if (!r.ok) return { ...r, status: 503, code: 'source_unavailable', cause: r.code };
    const hit = r.rows.find((x) => x.key === key);
    if (hit !== undefined) return { ok: true, key: hit.key, label: hit.label, tenantLabel: site.label, siteHost: site.host };
    if (!r.more) return { ok: false, status: 422, code: 'tracker_unknown', reason: `${site.label} has no project ${key}` };
  }
  // Pages left that were not read: not a "no such project", which this could not tell.
  return { ok: false, status: 503, code: 'source_unavailable', reason: `${site.label} answered more projects matching ${key} than crew reads at once; try again with the exact key` };
}

/**
 * A tracker's value-free structure (§3.4): its issue types and workflow states, mapped to todo/doing/done. Read at
 * link time, best-effort: a tool the server lacks, or an answer this cannot read, leaves that part empty.
 */
export async function readStructure(pm: Pick<PmGate, 'personCall' | 'personOp'>, e: PmEntry, tenant: string, key: string): Promise<TrackerStructure> {
  const names = (p: unknown, ...lists: string[]): Array<Record<string, unknown>> => {
    const l = Array.isArray(p) ? p : isObj(p) ? lists.map((k) => p[k]).find(Array.isArray) : null;
    return Array.isArray(l) ? (l as unknown[]).filter(isObj).slice(0, 50) : [];
  };
  const cat = (v: unknown): 'todo' | 'doing' | 'done' | null => {
    const k = String(isObj(v) ? (v['key'] ?? '') : (v ?? '')).toLowerCase();
    return k === 'new' || k === 'todo' || k === 'to_do' ? 'todo' : k === 'indeterminate' || k === 'in_progress' ? 'doing' : k === 'done' ? 'done' : null;
  };
  if (e.system === 'github') {
    const [owner] = key.split('/');
    const r = await pm.personCall(e, 'list_issue_types', { owner }).catch(() => null);
    const types = r !== null && r.ok ? names(payload(r.result), 'issue_types', 'types').map((x) => trackerLabel(x['name'], '?')) : [];
    return { issueTypes: types, states: [{ name: 'open', category: 'todo' }, { name: 'closed', category: 'done' }], fields: [] };
  }
  const t = await pm.personOp(e, 'listJiraProjectIssueTypesMetadata', tenant, { projectIdOrKey: key }).catch(() => null);
  const st = await pm.personOp(e, 'listJiraStatuses', tenant, { projectIdOrKey: key }).catch(() => null);
  const types = t !== null && t.ok ? names(payload(t.result), 'issueTypes', 'values') : [];
  // The fields of the first issue type: identifiers, names and value types only (never a value or a default).
  const first = types.find((x) => typeof x['id'] === 'string');
  const f = first === undefined ? null : await pm.personOp(e, 'getJiraIssueTypeMetaWithFields', tenant, { projectIdOrKey: key, issueTypeId: first['id'] }).catch(() => null);
  return {
    issueTypes: types.map((x) => trackerLabel(x['name'], '?')),
    states: st !== null && st.ok ? names(payload(st.result), 'values', 'statuses').map((x) => ({ name: trackerLabel(x['name'], '?'), category: cat(x['statusCategory']) })) : [],
    fields:
      f !== null && f.ok
        ? names(payload(f.result), 'fields', 'values').map((x) => ({ id: trackerLabel(x['fieldId'] ?? x['key'] ?? x['id'], '?'), name: trackerLabel(x['name'], '?'), type: isObj(x['schema']) ? trackerLabel(x['schema']['type'], '?') : null }))
        : [],
  };
}

/** Every link of every PM entry, as stored, with its entry and tracker. */
function allLinks(entries: readonly PmEntry[]): Array<{ e: PmEntry; t: StoredTracker; l: StoredTracker['links'][number] }> {
  const out: Array<{ e: PmEntry; t: StoredTracker; l: StoredTracker['links'][number] }> = [];
  for (const e of entries) for (const t of e.trackers) for (const l of t.links) out.push({ e, t, l });
  return out;
}


export function registerTrackerRoutes(app: FastifyInstance, deps: TrackerRouteDeps): void {
  const projection = deps.projection ?? PROJECTION_UNKNOWN;
  const view = (x: { e: PmEntry; t: StoredTracker; l: StoredTracker['links'][number] }): TrackerLink => trackerLinkView({ id: x.e.id, name: x.e.name, system: x.e.system }, x.t, x.l, projection);
  const entries = async (): Promise<PmEntry[]> => pmEntriesOf(await deps.store!.read());

  app.get(
    `${V}/tracker-links`,
    { config: { manifest: { responseType: 'TrackerLinksResponse', statusCodes: [200, 400, 403, 503] } } },
    async (req, reply) => {
      const actor = deps.actorOf(req);
      if (!isHuman(actor)) return humanOnly(reply, actor);
      const q = ListQuery.safeParse(req.query ?? {});
      if (!q.success || (q.data.project === undefined && q.data.repo === undefined)) return reply.code(400).send({ error: 'name ?project=<id>, ?repo=<id>, or both', code: 'bad_request' });
      if (deps.store === undefined) return reply.code(503).send({ error: 'the connector registry is not available on this daemon', code: 'registry_unavailable' });
      let es: PmEntry[];
      try {
        es = await entries();
      } catch (err) {
        if (err instanceof McpRegistryCorruptError) return reply.code(503).send({ error: err.message, code: 'registry_corrupt' });
        throw err;
      }
      const { project, repo } = q.data;
      const all = allLinks(es);
      const own = (t: TrackerLinkTarget): boolean => (project !== undefined ? t.kind === 'project' && t.id === project : t.kind === 'repo' && t.id === repo);
      const links = all.filter((x) => own(x.l.target)).map(view);
      const viaRepos: TrackerLinksResponse['viaRepos'] = [];
      const projects: TrackerLinksResponse['projects'] = [];
      const agents: TrackerLinksResponse['agents'] = [];
      if (project !== undefined) {
        const repos = new Set<string>();
        try {
          for (const r of await deps.projects.repos(project)) repos.add(r);
        } catch {
          // a membership read that fails shows the project's own links only
        }
        if (repo !== undefined) repos.add(repo);
        for (const x of all) if (x.l.target.kind === 'repo' && repos.has(x.l.target.id)) viaRepos.push({ ...view(x), viaRepo: x.l.target.id });
        const named = new Set([...links, ...viaRepos].map((l) => l.source));
        for (const e of es.filter((x) => named.has(x.name))) {
          const src = { enabled: e.enabled, queryable: true };
          agents.push({ source: e.name, see: agentMay(e.access, src, project, 'see'), query: agentMay(e.access, src, project, 'query') });
        }
      } else if (repo !== undefined) {
        try {
          for (const id of await deps.projects.ofRepo(repo)) {
            const p = await deps.projects.get(id).catch(() => null);
            if (p !== null) projects.push({ id: p.id, name: p.name });
          }
        } catch {
          // the reverse read is unavailable: the card says nothing about reach
        }
      }
      const body: TrackerLinksResponse = { target: { ...(project !== undefined ? { project } : {}), ...(repo !== undefined ? { repo } : {}) }, links, viaRepos, projects, agents };
      return body;
    },
  );

  // §6 step 1: the issues of a launch's tracker set, for "Start a job from an issue" (a person's live read, bound).
  app.get(
    `${V}/tracker-links/issues`,
    { config: { manifest: { responseType: 'TrackerIssuesResponse', statusCodes: [200, 400, 403, 503] } } },
    async (req, reply) => {
      const actor = deps.actorOf(req);
      // A live read with the source's credential, like the picker and the link lookup: a human operator's.
      if (!isHumanOperator(actor)) return humanOnly(reply, actor);
      const q = IssuesQuery.safeParse(req.query ?? {});
      if (!q.success || (q.data.project === undefined && q.data.repo === undefined)) return reply.code(400).send({ error: 'name ?project=<id>, ?repo=<id>, or both', code: 'bad_request' });
      if (deps.store === undefined || deps.pm === undefined) return reply.code(503).send({ error: 'the connector registry is not available on this daemon', code: 'registry_unavailable' });
      const pm = deps.pm;
      const es = await entries();
      const set = await pm.trackerSet({ projectId: q.data.project ?? null, repoId: q.data.repo ?? null }, es);
      const text = (q.data.q ?? '').replace(/[^\w\s.#-]/g, ' ').replace(/\s+/g, ' ').trim();
      const out: TrackerIssuesResponse['trackers'] = [];
      for (const t of set.slice(0, 10)) {
        const e = es.find((x) => x.id === t.sourceId)!;
        const row: TrackerIssuesResponse['trackers'][number] = {
          trackerId: t.trackerId,
          source: t.source,
          system: t.system,
          tenant: t.tenant,
          key: t.key,
          label: t.label,
          ...(t.tenantLabel !== null ? { tenantLabel: t.tenantLabel } : {}),
          via: t.via.find((v) => v.kind === 'project') ?? t.via[0]!,
          issues: [],
        };
        out.push(row);
        if (!agentMay(e.access, { enabled: e.enabled, queryable: true }, q.data.project ?? null, 'query')) {
          row.error = 'query_off';
          continue;
        }
        const tool = e.system === 'jira' ? 'searchJiraIssuesUsingJql' : 'search_issues';
        const stored = e.record.tools.find((x) => x.name === tool && x.present);
        const binding = stored === undefined ? null : bindingInForce(e.system, stored);
        if (binding === null) {
          row.error = 'tool_unbound';
          continue;
        }
        const [owner, repo] = t.key.split('/');
        const args =
          e.system === 'jira'
            ? { cloudId: t.tenant, jql: `${text !== '' ? `text ~ "${text}" ` : ''}ORDER BY updated DESC`, maxResults: 20 }
            : { query: `${text} is:issue is:open`.trim(), owner, repo, perPage: 20 };
        const prepared = binding.bindArgs(args, [{ trackerId: t.trackerId, tenant: t.tenant, key: t.key, siteHost: t.siteHost }]);
        if (!prepared.ok) {
          row.error = prepared.code;
          continue;
        }
        const r = await pm.vendorRead(e, tool, prepared.args, 'person');
        const p = r.ok ? binding.project(r.result, prepared, projectOptsOf(e)) : null;
        if (p === null || !p.ok) {
          row.error = 'unavailable';
          continue;
        }
        // A key two trackers of this set share is qualified, so the reference a launch takes is never ambiguous.
        const shared = e.system === 'jira' && set.filter((x) => x.system === 'jira' && x.key === t.key).length > 1;
        row.issues = p.items.map((i) => ({
          key: i.ref,
          ref: shared ? `${t.source}@${t.tenant}:${i.ref}` : i.ref,
          title: String((e.system === 'jira' ? i.value['summary'] : i.value['title']) ?? ''),
          state: typeof (e.system === 'jira' ? i.value['status'] : i.value['state']) === 'string' ? String(e.system === 'jira' ? i.value['status'] : i.value['state']) : null,
        }));
      }
      const body: TrackerIssuesResponse = { trackers: out };
      return body;
    },
  );

  app.post(
    `${V}/tracker-links`,
    { config: { manifest: { requestType: 'CreateTrackerLinkBody', responseType: 'TrackerLink', statusCodes: [200, 201, 400, 403, 404, 409, 422, 503] } } },
    async (req, reply) => {
      const actor = deps.actorOf(req);
      if (!isHumanOperator(actor)) return humanOnly(reply, actor);
      const parsed = CreateTrackerLinkSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), code: 'bad_request' });
      if (deps.store === undefined || deps.pm === undefined) return reply.code(503).send({ error: 'the connector registry is not available on this daemon', code: 'registry_unavailable' });
      const b = parsed.data;
      if (!MCP_SERVER_NAME_RE.test(b.source)) return reply.code(404).send({ error: `no source named ${b.source}`, code: 'source_not_found' });
      const file = normalizeRegistryFile(await deps.store.read());
      const rec = file.servers.find((s) => s.name === b.source);
      if (rec === undefined) return reply.code(404).send({ error: `no source named ${b.source}`, code: 'source_not_found' });
      const e = pmEntriesOf(file).find((x) => x.name === b.source);
      if (e === undefined) return reply.code(409).send({ error: `${b.source} is not a project-management source`, code: 'not_a_tracker' });
      if (b.target.kind === 'project') {
        if (b.target.id === DEFAULT_PROJECT_ID) return reply.code(409).send({ error: 'trackers link to a real project, not the synthesised Unfiled one', code: 'default_project' });
        const p = await deps.projects.get(b.target.id).catch(() => null);
        if (p === null) return reply.code(404).send({ error: `no project ${b.target.id}`, code: 'project_not_found' });
        if (p.status === 'archived') return reply.code(409).send({ error: `${p.name} is archived`, code: 'project_archived' });
      } else if (!(await deps.projects.allRepos()).includes(b.target.id)) {
        return reply.code(404).send({ error: `no repo ${b.target.id}`, code: 'repo_not_found' });
      }
      const found = await lookupTracker(deps.pm, e, b.tenant, b.key);
      if (!found.ok) return reply.code(found.status).send({ error: found.reason, code: found.code, ...(found.cause !== undefined ? { cause: found.cause } : {}) });
      const structure = await readStructure(deps.pm, e, b.tenant, found.key);
      const trackerId = trackerIdOf(e.id, b.tenant, found.key);
      const target: TrackerLinkTarget = b.target.kind === 'project' ? { kind: 'project', id: b.target.id } : { kind: 'repo', id: b.target.id };
      const linkId = trackerLinkIdOf(trackerId, target);
      const stamp = new Date().toISOString();
      let out: { created: boolean; tracker: StoredTracker; link: StoredTracker['links'][number] } | { gone: true } | { full: true };
      try {
        out = await deps.store.mutate((f) => {
          const s = f.servers.find((x) => x.name === b.source);
          // Saved again as another entry (a new id), or re-pointed at another server, since the lookup: nothing is linked.
          if (s === undefined || s.id !== e.id || pmDescriptorHash(configOf(s)) !== pmDescriptorHash(configOf(e.record))) return { gone: true as const };
          const trackers = trackersOf(s);
          let t = trackers.find((x) => x.id === trackerId);
          if (t === undefined) {
            t = { id: trackerId, tenant: b.tenant, tenantLabel: found.tenantLabel, siteHost: found.siteHost ?? null, key: found.key, label: found.label, links: [], structure };
            trackers.push(t);
          } else {
            t.structure = structure;
            t.label = found.label;
            if (found.tenantLabel !== null) t.tenantLabel = found.tenantLabel;
            if (found.siteHost != null) t.siteHost = found.siteHost;
          }
          // estate bounds a document's links (200): one tracker holds at most TRACKER_LINKS_MAX.
          if (!t.links.some((l) => l.id === linkId) && t.links.length >= TRACKER_LINKS_MAX) return { full: true as const };
          let link = t.links.find((l) => l.id === linkId);
          const created = link === undefined;
          if (link === undefined) {
            link = { id: linkId, target, linkedAt: stamp, linkedBy: actor.id };
            t.links.push(link);
          }
          s.trackers = trackers;
          if (s.retired !== undefined) s.retired = s.retired.filter((r) => r.id !== trackerId);
          s.updatedAt = stamp;
          return { created, tracker: structuredClone(t), link: structuredClone(link) };
        });
      } catch (err) {
        if (err instanceof McpRegistryCorruptError) return reply.code(503).send({ error: err.message, code: 'registry_corrupt' });
        throw err;
      }
      if ('gone' in out) return reply.code(409).send({ error: `${b.source} was removed or saved again while linking; nothing was linked: try again`, code: 'source_changed' });
      if ('full' in out) return reply.code(409).send({ error: `${found.key} already has ${TRACKER_LINKS_MAX} links`, code: 'too_many_links' });
      if (out.created) deps.audit.record('knowledge.source.tracker_linked', actor, { detail: { source: b.source, tenant: b.tenant, key: found.key, target } });
      // Projected either way: a link made again may carry a new label.
      deps.changed?.(b.source, trackerId);
      return reply.code(out.created ? 201 : 200).send(view({ e, t: out.tracker, l: out.link }));
    },
  );

  app.delete<{ Params: { id: string } }>(
    `${V}/tracker-links/:id`,
    { config: { manifest: { statusCodes: [204, 403, 404, 503] } } },
    async (req, reply) => {
      const actor = deps.actorOf(req);
      if (!isHumanOperator(actor)) return humanOnly(reply, actor);
      if (deps.store === undefined) return reply.code(503).send({ error: 'the connector registry is not available on this daemon', code: 'registry_unavailable' });
      const id = req.params.id;
      if (!/^tl_[0-9a-f]{16}$/.test(id)) return reply.code(404).send({ error: `no tracker link ${id}`, code: 'not_found' });
      const stamp = new Date().toISOString();
      let out: { source: string; tenant: string; key: string; target: TrackerLinkTarget; trackerId: string } | null;
      try {
        out = await deps.store.mutate((f) => {
          for (const s of normalizeRegistryFile(f).servers) {
            const trackers = trackersOf(s);
            for (const t of trackers) {
              const l = t.links.find((x) => x.id === id);
              if (l === undefined) continue;
              t.links = t.links.filter((x) => x.id !== id);
              const kept = trackers.filter((x) => x.links.length > 0);
              s.trackers = kept;
              // The tracker's last link: it is retired until estate takes its empty generation (its documents go).
              if (t.links.length === 0) s.retired = [...(s.retired ?? []).filter((r) => r.id !== t.id), { id: t.id, since: stamp }];
              s.updatedAt = stamp;
              return { source: s.name, tenant: t.tenant, key: t.key, target: l.target, trackerId: t.id };
            }
          }
          return null;
        });
      } catch (err) {
        if (err instanceof McpRegistryCorruptError) return reply.code(503).send({ error: err.message, code: 'registry_corrupt' });
        throw err;
      }
      if (out === null) return reply.code(404).send({ error: `no tracker link ${id}`, code: 'not_found' });
      deps.audit.record('knowledge.source.tracker_unlinked', actor, { detail: { source: out.source, tenant: out.tenant, key: out.key, target: out.target } });
      deps.changed?.(out.source, out.trackerId);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { name: string } }>(
    `${V}/sources/:name/trackers`,
    { config: { manifest: { responseType: 'SourceTrackersResponse', statusCodes: [200, 400, 403, 404, 409, 503] } } },
    async (req, reply) => {
      const actor = deps.actorOf(req);
      if (!isHumanOperator(actor)) return humanOnly(reply, actor);
      const q = SourceTrackersQuery.safeParse(req.query ?? {});
      const cursor = q.success ? dec(q.data.cursor) : null;
      if (!q.success || cursor === null) return reply.code(400).send({ error: 'q is at most 200 characters; cursor is a cursor this route answered', code: 'bad_request' });
      if (deps.store === undefined || deps.pm === undefined) return reply.code(503).send({ error: 'the connector registry is not available on this daemon', code: 'registry_unavailable' });
      if (!MCP_SERVER_NAME_RE.test(req.params.name)) return reply.code(404).send({ error: `no source named ${req.params.name}`, code: 'source_not_found' });
      const file = normalizeRegistryFile(await deps.store.read());
      if (!file.servers.some((s) => s.name === req.params.name)) return reply.code(404).send({ error: `no source named ${req.params.name}`, code: 'source_not_found' });
      const e = pmEntriesOf(file).find((x) => x.name === req.params.name);
      if (e === undefined) return reply.code(409).send({ error: `${req.params.name} is not a project-management source`, code: 'not_a_tracker' });
      const page = await listSourceTrackers(deps.pm, e, q.data.q ?? '', cursor, q.data.tenant ?? null);
      // `cause` is the lister's own class (vendor_error, unknown_shape, unavailable, secret_missing, …): the reason names it.
      if (!page.ok) return reply.code(503).send({ error: page.reason, code: 'source_unavailable', cause: page.code });
      const links = allLinks([e]);
      const body: SourceTrackersResponse = {
        name: e.name,
        trackers: page.rows.map((r) => ({
          ...r,
          links: links.filter((x) => x.t.tenant === r.tenant && x.t.key.toLowerCase() === r.key.toLowerCase()).map(view),
        })),
        next: page.next,
      };
      return body;
    },
  );
}
