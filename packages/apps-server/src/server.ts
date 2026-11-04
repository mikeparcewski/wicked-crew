/**
 * The standalone site's routes (DES-APPS-001 §8.2), and nothing else:
 *
 *   GET  /, /auth/callback      the page: the runtime and the sign-in bootstrap only
 *   GET  /spec                  the published spec, for a token in the audience (or anyone, on a public site)
 *   POST /q/:query              one named query of the published version (crew's executor)
 *   POST /a/:action/prepare     the card and a record (crew's write path)
 *   POST /a/:action/run         the record, once
 *   GET  /a/records/:id         a lost answer (also while actions are off: the outcome is the person's to read)
 *   GET  /healthz               up, and what it refuses
 *
 * Bearer only, no cookies. Every POST also needs `Origin` equal to the site's own and `Content-Type:
 * application/json`. The version is always the published one: a request never chooses a tree or a spec.
 *
 * Every request to a protected route (all but the page and `/healthz`) on a signed-in site writes exactly ONE
 * decision line, refusals before or after the sign-in included: the claims that decided (never the token), the
 * decision and its reason, the outcome, and `sourceCalled`. `sourceCalled: false` is exact: the request stopped at
 * the site's own checks and no source was called. `true` means it passed them and was handed to crew's executor or
 * write path, which may have called the source (a cached read is `false`).
 *
 * `/healthz` is unauthenticated: it names what is refused (kind, id and a code), never a reason, which can name a
 * source, a table or a column.
 */

import { BlockList, isIP } from 'node:net';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { Actor, AppExecutor, AppSiteHealth, AppSiteSpecResponse, AppWritePath, Viewer } from './crew.js';
import { AppExecError, AppWriteError } from './crew.js';
import type { Judgement, SignIn } from './identity.js';
import type { ImageRegistry } from './image.js';
import type { JsonLines } from './log.js';
import { API_HEADERS, type Page, pageHeaders } from './page.js';
import type { Site } from './site.js';
import type { SiteState } from './startup.js';

const BODY_MAX = 64 * 1024;
const NAMED_ID = /^[a-z][a-z0-9_]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A public site: 600 queries a minute app-wide (DES §7.5), on top of the per-address limit. */
const PUBLIC_PER_MINUTE = 600;
/** Refusals that say the source itself may have changed or gone: the server describes it again. */
const SOURCE_ERRORS = new Set(['source_unavailable', 'source_failed', 'contract_changed', 'table_changed', 'query_refused', 'source_timeout']);

export interface SiteServerDeps {
  site: Site;
  page: Page;
  csp: string;
  /** `null` = a public site (no sign-in, no actions). */
  signIn: SignIn | null;
  executor: AppExecutor;
  writePath: AppWritePath | null;
  registry: ImageRegistry;
  state: SiteState;
  decisions: JsonLines;
  /** Where each request's verified viewer is put, keyed by its actor (crew's code reads it through `viewerOf`). */
  viewers: WeakMap<Actor, Viewer>;
  /** A read or an action on `source` failed in a way a re-describe may explain. */
  onSourceError?: (source: string) => void;
  /**
   * The reverse proxies in front of the site (`APPS_TRUSTED_PROXIES`, addresses or CIDRs). A request from one of
   * them is the client named in `X-Forwarded-For` (the nearest address not itself trusted); from anyone else the
   * header is ignored. Empty = the socket's address, always.
   */
  trustedProxies?: string[];
  /** Each request's handler, so a stopping server can wait for them (a run's outcome is recorded before it exits). */
  track?: (handler: Promise<void>) => void;
  /** The server is stopping: a request that arrives now is refused (503) before it does anything. */
  stopping?: () => boolean;
  now?: () => number;
}

class Refused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...API_HEADERS, ...headers, 'content-length': String(Buffer.byteLength(text)) });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > BODY_MAX) throw new Refused(413, 'too_large', `a request body is at most ${BODY_MAX} bytes`);
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Refused(400, 'bad_request', 'the body is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Refused(400, 'bad_request', 'the body is a JSON object');
  return parsed as Record<string, unknown>;
}

/** Only these keys, each optional unless `required`. */
function onlyKeys(body: Record<string, unknown>, allowed: string[], required: string[] = []): void {
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw new Refused(400, 'bad_request', `unknown field ${JSON.stringify(k).slice(0, 70)}`);
  for (const k of required) if (!Object.hasOwn(body, k)) throw new Refused(400, 'bad_request', `${k} is required`);
}

function paramsOf(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const p = body['params'];
  if (p === undefined) return undefined;
  if (typeof p !== 'object' || p === null || Array.isArray(p)) throw new Refused(400, 'bad_request', 'params is an object');
  return p as Record<string, unknown>;
}

/** A path segment, decoded; a malformed escape is a 400, never a 500. */
function segment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new Refused(400, 'bad_request', 'a path segment is not valid percent-encoding');
  }
}

const codeOf = (err: unknown): string => (err instanceof Refused || err instanceof AppExecError || err instanceof AppWriteError ? err.code : 'error');
const unmapped = (a: string): string => a.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');

/** The address a request comes from, through the trusted proxies only (never a header a client wrote itself). */
export function clientAddress(socketAddress: string | undefined, forwardedFor: string | string[] | undefined, trusted: BlockList | null): string {
  const raw = unmapped(socketAddress ?? 'unknown');
  const isTrusted = (a: string): boolean => {
    const fam = isIP(a);
    return trusted !== null && fam !== 0 && trusted.check(a, fam === 6 ? 'ipv6' : 'ipv4');
  };
  if (!isTrusted(raw) || typeof forwardedFor !== 'string') return raw;
  const hops = forwardedFor.split(',').map((h) => unmapped(h.trim())).filter((h) => h !== '');
  for (let i = hops.length - 1; i >= 0; i--) {
    const h = hops[i]!;
    if (isIP(h) === 0) return raw; // a hop that is not an address: trust nothing in the header
    if (!isTrusted(h)) return h;
  }
  return raw;
}

/** `APPS_TRUSTED_PROXIES` as a block list; a malformed entry stops the server, naming it. */
export function trustList(entries: string[] | undefined): BlockList | null {
  if (entries === undefined || entries.length === 0) return null;
  const list = new BlockList();
  for (const e of entries) {
    const [addr, bits] = e.trim().split('/');
    const fam = isIP(addr ?? '');
    if (fam === 0) throw new Error(`APPS_TRUSTED_PROXIES: ${JSON.stringify(e)} is not an address or CIDR`);
    const type = fam === 6 ? 'ipv6' : 'ipv4';
    if (bits === undefined) list.addAddress(addr!, type);
    else {
      const n = Number(bits);
      if (!Number.isInteger(n) || n < 0 || n > (fam === 6 ? 128 : 32)) throw new Error(`APPS_TRUSTED_PROXIES: ${JSON.stringify(e)} has a bad prefix`);
      list.addSubnet(addr!, n, type);
    }
  }
  return list;
}

/** One protected request's decision line, written once whatever happens. */
interface Decision {
  route: string;
  judged: Judgement | null;
  extra: Record<string, unknown>;
  written: boolean;
}

export function createSiteServer(deps: SiteServerDeps): Server {
  const { site, executor, writePath, state } = deps;
  const { app } = site.manifest;
  const now = deps.now ?? Date.now;
  const origin = site.manifest.site.origin;
  const viewers = deps.viewers;
  const publicWindow: number[] = [];
  const trusted = trustList(deps.trustedProxies);

  const write = (d: Decision, outcome: Record<string, unknown>): void => {
    if (d.written || deps.signIn === null) return;
    d.written = true;
    const j = d.judged;
    deps.decisions.write({
      log: 'decision',
      route: d.route,
      decision: j === null ? 'refused' : j.ok ? 'allow' : 'deny',
      ...(j !== null && !j.ok ? { status: j.status, code: j.code, reason: j.reason } : {}),
      claims: j?.claims ?? null,
      sourceCalled: false,
      ...d.extra,
      ...outcome,
    });
  };

  /** Who is asking: a person in the audience, or (a public site) the client's address. */
  const who = async (req: IncomingMessage, d: Decision): Promise<Actor> => {
    if (deps.signIn === null) {
      const actor = Object.freeze({ id: `public:${clientAddress(req.socket.remoteAddress, req.headers['x-forwarded-for'], trusted)}`, kind: 'human', trust: 'observer' }) as Actor;
      viewers.set(actor, { id: actor.id, email: null, name: null, groups: [] });
      return actor;
    }
    const j = await deps.signIn.judge(req.headers.authorization);
    d.judged = j;
    if (!j.ok) throw new Refused(j.status, j.code, j.reason);
    viewers.set(j.actor, j.viewer);
    return j.actor;
  };

  const postChecks = (req: IncomingMessage): void => {
    if (req.headers.origin !== origin) throw new Refused(403, 'origin_refused', 'this site takes requests from its own page only');
    const ct = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (ct !== 'application/json') throw new Refused(415, 'bad_content_type', 'a request is application/json');
  };

  const actionsOn = (): void => {
    if (writePath === null || !state.actions.on) throw new Refused(409, 'actions_off', state.actions.reason ?? 'actions are off on this site');
  };

  /** A source this server could not describe answers "unavailable" (not "changed"), and is described again. */
  const sourceUp = (source: string): void => {
    const down = deps.registry.downOf(source);
    if (down === null) return;
    deps.onSourceError?.(source);
    throw new Refused(503, 'source_unavailable', `${source} cannot be reached from this site right now (${down.reason}); it is tried again`);
  };

  const publicLimit = (): void => {
    if (deps.signIn !== null) return;
    const t = now();
    while (publicWindow.length > 0 && publicWindow[0]! <= t - 60_000) publicWindow.shift();
    if (publicWindow.length >= PUBLIC_PER_MINUTE) throw new AppExecError(429, 'rate_limited', 'this site answers at most 600 queries a minute', { retryAfterMs: 60_000 - (t - publicWindow[0]!) });
    publicWindow.push(t);
  };

  const health = (): AppSiteHealth => ({ ok: true, app: app.slug, version: app.version, refused: state.list().map((r) => ({ kind: r.kind, id: r.id, code: r.reason.split(':')[0]!.trim() })), actions: writePath !== null && state.actions.on });

  const handle = async (req: IncomingMessage, res: ServerResponse, d: { current: Decision | null }): Promise<void> => {
    const method = req.method ?? 'GET';
    let path: string;
    try {
      path = new URL(req.url ?? '/', 'http://site.invalid').pathname;
    } catch {
      return send(res, 400, { code: 'bad_request', error: 'bad path' });
    }
    if (method === 'GET' && (path === '/' || path === '/auth/callback')) {
      res.writeHead(200, { ...pageHeaders(deps.csp), 'content-length': String(Buffer.byteLength(deps.page.html)) });
      res.end(deps.page.html);
      return;
    }
    if (method === 'GET' && path === '/healthz') return send(res, 200, health());
    const open = (route: string, extra: Record<string, unknown> = {}): Decision => (d.current = { route, judged: null, extra, written: false });

    if (method === 'GET' && path === '/spec') {
      const dec = open('spec');
      const actor = await who(req, dec);
      const viewer = viewers.get(actor) ?? null;
      const body: AppSiteSpecResponse = {
        app: { slug: app.slug, name: app.name, version: app.version },
        spec: site.files.spec,
        viewer: deps.signIn === null || viewer === null ? null : { email: viewer.email, name: viewer.name },
        actions: writePath !== null && state.actions.on && site.files.spec.actions.length > 0,
        refused: state.list(),
      };
      write(dec, { outcome: 'ok' });
      return send(res, 200, body);
    }
    let m = /^\/q\/([^/]+)$/.exec(path);
    if (method === 'POST' && m !== null) {
      const dec = open('query');
      const query = segment(m[1]!);
      dec.extra['query'] = query;
      postChecks(req);
      if (!NAMED_ID.test(query)) throw new Refused(404, 'unknown_query', 'no such query');
      const actor = await who(req, dec);
      const body = await readJson(req);
      onlyKeys(body, ['params']);
      const params = paramsOf(body);
      publicLimit();
      const q = site.files.spec.queries.find((x) => x.id === query);
      if (q !== undefined) sourceUp(q.source);
      try {
        const r = await executor.runQuery({ app: app.slug, version: app.version, query, ...(params !== undefined ? { params } : {}), actor });
        write(dec, { outcome: r.cachedAt === null ? 'ok' : 'cached', sourceCalled: r.cachedAt === null });
        return send(res, 200, r);
      } catch (err) {
        // Handed to the executor: it may have reached the source before it failed.
        dec.extra['sourceCalled'] = q !== undefined;
        if (q !== undefined && SOURCE_ERRORS.has(codeOf(err))) deps.onSourceError?.(q.source);
        throw err;
      }
    }
    m = /^\/a\/([^/]+)\/(prepare|run)$/.exec(path);
    if (method === 'POST' && m !== null) {
      const step = m[2] as 'prepare' | 'run';
      const dec = open(step);
      const action = segment(m[1]!);
      dec.extra['action'] = action;
      postChecks(req);
      if (!NAMED_ID.test(action)) throw new Refused(404, 'unknown_action', 'no such action');
      const actor = await who(req, dec);
      actionsOn();
      const declared = site.files.spec.actions.find((a) => a.id === action);
      if (declared !== undefined) sourceUp(declared.source);
      const body = await readJson(req);
      // From here the write path may reach the source (a row write's table check, the run itself).
      const reach = (err: unknown): never => {
        dec.extra['sourceCalled'] = step === 'run' || declared?.kind === 'row-write';
        if (declared !== undefined && SOURCE_ERRORS.has(codeOf(err))) deps.onSourceError?.(declared.source);
        throw err;
      };
      if (step === 'prepare') {
        onlyKeys(body, ['params']);
        const params = paramsOf(body);
        const r = await writePath!.prepareAction(app.slug, action, { version: app.version, ...(params !== undefined ? { params } : {}), actor }).catch(reach);
        write(dec, { outcome: 'prepared', record: r.record, sourceCalled: declared?.kind === 'row-write' });
        return send(res, 200, r);
      }
      onlyKeys(body, ['record'], ['record']);
      const record = body['record'];
      if (typeof record !== 'string' || !UUID.test(record)) throw new Refused(400, 'bad_request', 'record is a record id');
      dec.extra['record'] = record;
      const r = await writePath!.runAction(app.slug, action, { record, actor }).catch(reach);
      if (r.state !== 'succeeded' && declared !== undefined) deps.onSourceError?.(declared.source);
      write(dec, { outcome: r.state, sourceCalled: true });
      return send(res, 200, r);
    }
    m = /^\/a\/records\/([^/]+)$/.exec(path);
    if (method === 'GET' && m !== null) {
      const dec = open('record');
      const id = segment(m[1]!);
      dec.extra['record'] = id;
      const actor = await who(req, dec);
      // Reading an outcome needs the store, not permission to write: it works under APPS_READ_ONLY too.
      if (writePath === null) throw new Refused(409, 'actions_off', state.actions.reason ?? 'this site keeps no action records');
      if (!UUID.test(id)) throw new Refused(404, 'unknown_record', 'no such record');
      const view = writePath.recordView(app.slug, id, actor);
      write(dec, { outcome: 'ok' });
      return send(res, 200, view);
    }
    return send(res, 404, { code: 'not_found', error: 'this site serves its page, its spec, its queries and its actions only' });
  };

  return createServer((req, res) => {
    if (deps.stopping?.() === true) {
      res.setHeader('connection', 'close');
      return send(res, 503, { code: 'stopping', error: 'this site is restarting: try again in a moment' });
    }
    const d: { current: Decision | null } = { current: null };
    const handler = handle(req, res, d).catch((err: unknown) => {
      if (d.current !== null) write(d.current, { outcome: codeOf(err) });
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof Refused) return send(res, err.status, { code: err.code, error: err.message });
      if (err instanceof AppExecError || err instanceof AppWriteError) {
        const headers: Record<string, string> = {};
        if (err.extra.retryAfterMs !== undefined) headers['retry-after'] = String(Math.max(1, Math.ceil(err.extra.retryAfterMs / 1000)));
        // crew's words for a missing viewer claim are for local preview (set your git user.email); on the site the
        // claim comes only from the sign-in.
        const message = err.code === 'viewer_unavailable' ? 'your sign-in does not give this app what it needs from you (a verified email or your name): sign in with an account that has it, or ask the person who shared the app' : err.message;
        return send(res, err.status, { code: err.code, error: message }, headers);
      }
      process.stderr.write(`[apps-server] ${req.method} ${(req.url ?? '').split('?')[0]}: ${err instanceof Error ? err.name : 'error'}\n`);
      return send(res, 500, { code: 'internal', error: 'the site could not answer' });
    });
    deps.track?.(handler);
  });
}
