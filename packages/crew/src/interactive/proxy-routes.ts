/**
 * `/api/v1/projects/:projectId/interactive/*` — crew reverse-proxies the wicked-interactive
 * bridge (DES-MERGE-001 §5.3, §7.2; slice 1).
 *
 * PURE TRANSPORT. Nothing user-visible moves in this slice: what changes is that interactive's
 * HTTP surface becomes reachable through crew's OWN origin, so the studio client never learns a
 * second origin, never needs CORS, and never carries a bridge port literal — ADR-0022's dynamic
 * port is honored rather than worked around, and the bridge stops being browser-reachable at all.
 *
 * The path encodes the project (§7.2) because the ROOT is per project — an explicit setting, or
 * the project's own partition of the default root (crew#472, `bridge-root.ts`): the same proxy
 * mount serves N interactive instances, one bridge per resolved root.
 *
 * Two things are deliberately hand-rolled over `node:http` rather than delegated to `fetch`:
 *
 *  1. UNBUFFERED STREAMING BOTH WAYS. Interactive's generation surface is SSE; a proxy that
 *     buffers turns a live narration into a single blob delivered at stream close. Piping raw
 *     sockets keeps every chunk flowing as it arrives, in both directions.
 *  2. VERBATIM FORWARDING. The path remainder and query string are taken from `req.raw.url`,
 *     not from Fastify's decoded wildcard param, so percent-encoding survives the hop intact.
 *
 * THE ONE EXCEPTION TO PURE TRANSPORT — the doc CREATE (acceptance finding F-046). `POST
 * <prefix>/api/docs` is read before it is forwarded, because two things the bridge cannot do have
 * to happen at the daemon: (a) a document may name the repository (or repositories) it is ABOUT
 * (`repo_ref` / `repo_refs`), which only crew can validate against the project's members and
 * only crew can remember — the bridge's create wire builds `doc.created` explicitly and never
 * echoes a field it does not know; and (b) a print/A4 brief with no `style` must reach the
 * bridge's print instructions, so an absent style is inferred from the brief's format words. A
 * named repo the project does not have is a 400 with nothing created (the bridge never sees the
 * request); the refs are stripped from the forwarded body; the binding is recorded from the
 * bridge's create answer (`name`) as a `crew-grounding.json` sidecar beside the new doc's
 * `versions.json` under this project's docs root, for the draft/demo seams (`doc-grounding.ts`).
 * The create response is small JSON, so it is buffered — SSE never rides this route.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { API_PREFIX } from '../api/api-prefix.js';
import type { CoreAdapter } from '../core/adapter.js';
import { DEFAULT_PROJECT_ID } from '../projects/default-project.js';
import type { ProjectSettingsStore } from '../projects/settings.js';
import { BridgeUnavailableError, InteractiveBridgePool, type LiveBridge } from './bridge-pool.js';
import {
  inferDocStyle,
  isDocStyle,
  matchingRepos,
  parseRepoRefs,
  projectRepoCandidates,
  type DocGroundingStore,
} from './doc-grounding.js';
import { projectDocsRoot } from './project-root.js';

/** The bridge route whose request crew reads before forwarding (F-046) — exact path, any query. */
export const DOC_CREATE_PATH = '/api/docs';
/** Create bodies are a brief plus a few fields; anything bigger is not a create crew should buffer. */
export const DOC_CREATE_BODY_MAX = 4 * 1024 * 1024;

/** Per-hop headers that must never be forwarded across a proxy (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function forwardableRequestHeaders(headers: IncomingHttpHeaders, bridge: LiveBridge): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name) || value === undefined) continue;
    // Crew's bearer token is CREW's credential. The bridge is a local process with no auth of
    // its own and no use for it; forwarding it would hand a third-party child crew's ambient
    // authority for free. One auth path (§5.3) means crew terminates auth, it does not relay it.
    if (name === 'authorization') continue;
    out[name] = value;
  }
  out['host'] = `${bridge.host}:${bridge.port}`;
  return out;
}

/**
 * Point a `Location` back at the proxy. The bridge answers on its own origin and knows nothing
 * about the mount prefix, so both spellings it can emit have to be re-anchored: an absolute URL
 * on the bridge origin, and a root-relative path. Anything else (a foreign origin, a relative
 * path) is left exactly as-is — rewriting those would be inventing a redirect target.
 */
export function rewriteLocation(location: string, bridge: LiveBridge, prefix: string): string {
  for (const host of new Set([bridge.host, 'localhost', '127.0.0.1'])) {
    const origin = `http://${host}:${bridge.port}`;
    if (location.startsWith(origin)) return `${prefix}${location.slice(origin.length)}`;
  }
  if (location.startsWith('/')) return `${prefix}${location}`;
  return location;
}

export interface InteractiveProxyDeps {
  settings: ProjectSettingsStore;
  pool: InteractiveBridgePool;
  env?: NodeJS.ProcessEnv;
  /** The home the default root hangs off (tests point it at a scratch dir). */
  home?: string;
  /** The create-time doc → subject-repo binding store (F-046). Absent = the create is pure
   *  transport like every other route (a directly-driven route set with no grounding). */
  grounding?: DocGroundingStore;
  log?: (msg: string) => void;
}

/** Crew's 400 on a create that names a repository the document cannot be grounded on (F-046);
 *  wire: crew-api-types `InteractiveDocCreateRefusal`. */
export interface DocCreateRefusal {
  error: string;
  code: 'repo_not_in_project' | 'unfiled_doc_repo' | 'invalid_repo_ref' | 'ambiguous_repo_ref' | 'project_mismatch';
  requested: string[];
  missing?: string[];
  /** `ambiguous_repo_ref`: the refs that name several repos, each with its candidates. */
  ambiguous?: Array<{ ref: string; candidates: Array<{ id: string; name: string }> }>;
  available?: Array<{ id: string; name: string }>;
}

/** The 502 a create earns when the bridge dropped the connection AFTER the request was sent: the
 *  doc may or may not exist, so the proxy never replays a non-idempotent POST (codex on crew#506). */
export const CREATE_UNDETERMINED = {
  code: 'create_undetermined',
  error:
    'the interactive bridge dropped the connection after the create was sent — the document may already ' +
    'exist; list the project\'s documents before creating it again',
} as const;

/** Thrown by `forwardCreate` — carries whether the request had already reached the bridge. */
interface CreateForwardError extends Error {
  createDispatched?: boolean;
}

/** A create read and validated at the daemon, ready to forward (or to refuse). */
export interface PreparedCreate {
  /** The bytes to forward — the rewritten JSON, or the original bytes when they were not a JSON object. */
  body: Buffer;
  contentType: string;
  /** Recorded under the doc name the bridge answers with, when the request named repositories. */
  binding?: { projectId: string; repoRefs: string[]; style?: string | undefined };
  refusal?: DocCreateRefusal;
}

/** `true` for the bridge's doc-create request (method + exact path, query ignored). */
export function isDocCreate(method: string | undefined, target: string): boolean {
  const path = target.split('?')[0] ?? target;
  return method === 'POST' && path === DOC_CREATE_PATH;
}

async function readBody(stream: IncomingMessage, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > max) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * The create's daemon-side half (F-046): read the body, validate `repo_ref(s)` against the
 * project's repositories, infer a missing `style` from the brief, strip what the bridge must not
 * see, and say what to record once the bridge names the doc. Pure over its inputs — the route
 * decides what to do with a refusal; exported so the rule is unit-testable without a bridge.
 */
export async function prepareDocCreate(
  raw: Buffer,
  contentType: string | undefined,
  adapter: CoreAdapter,
  projectId: string,
  log?: (msg: string) => void,
): Promise<PreparedCreate> {
  const passthrough: PreparedCreate = { body: raw, contentType: contentType ?? 'application/json' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return passthrough; // not JSON — the bridge answers its own 400
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return passthrough;
  const body = { ...(parsed as Record<string, unknown>) };

  // THE PROJECT IS THE ROUTE'S (codex on crew#506): the proxy validates and records the binding
  // against `projectId`, so the body's `project` — which the bridge registers the doc under — must
  // be the same project or absent. An omitted value is canonicalized from the route; a different
  // one is refused, never forwarded to file the doc somewhere else. The Unfiled mount creates
  // UNBOUND, so a `project` there is a mismatch too.
  const bodyProject = typeof body['project'] === 'string' ? body['project'].trim() : '';
  if (projectId === DEFAULT_PROJECT_ID) {
    if (bodyProject !== '') {
      return {
        ...passthrough,
        refusal: {
          error: `this create is on the Unfiled mount but names project "${bodyProject}" — create it under /projects/${bodyProject}/interactive instead`,
          code: 'project_mismatch',
          requested: [],
        },
      };
    }
    delete body['project'];
  } else if (bodyProject === '') {
    body['project'] = projectId;
  } else if (bodyProject !== projectId) {
    return {
      ...passthrough,
      refusal: {
        error: `the create names project "${bodyProject}" but was sent to project ${projectId} — one document, one project; nothing was created`,
        code: 'project_mismatch',
        requested: [],
      },
    };
  }

  const refs = parseRepoRefs(body);
  if (!refs.ok) {
    return { ...passthrough, refusal: { error: refs.error, code: 'invalid_repo_ref', requested: refs.requested } };
  }
  const repoRefs: string[] = [];
  if (refs.refs.length > 0) {
    if (projectId === DEFAULT_PROJECT_ID) {
      return {
        ...passthrough,
        refusal: {
          error:
            'an Unfiled document cannot name a repository — create it inside a project that has the ' +
            'repository as a member (attach it with POST /projects/:id/members {kind:"crew.repo"})',
          code: 'unfiled_doc_repo',
          requested: refs.refs,
        },
      };
    }
    const candidates = await projectRepoCandidates(adapter, projectId, log);
    const missing: string[] = [];
    const ambiguous: Array<{ ref: string; candidates: Array<{ id: string; name: string }> }> = [];
    for (const ref of refs.refs) {
      const hits = matchingRepos(ref, candidates);
      if (hits.length === 0) missing.push(ref);
      else if (hits.length > 1) ambiguous.push({ ref, candidates: hits.map((h) => ({ id: h.repoRef, name: h.name })) });
      else if (!repoRefs.includes(hits[0]!.repoRef)) repoRefs.push(hits[0]!.repoRef);
    }
    if (ambiguous.length > 0) {
      // Two member repos share the spelling (two checkouts of one name under different parents):
      // never the first match — the request must say which, by id (codex on crew#506).
      return {
        ...passthrough,
        refusal: {
          error:
            ambiguous
              .map((a) => `"${a.ref}" names ${a.candidates.length} repositories in project ${projectId} (${a.candidates.map((c) => `${c.name} = ${c.id}`).join(', ')})`)
              .join('; ') + ' — name the repository by id. Nothing was created.',
          code: 'ambiguous_repo_ref',
          requested: refs.refs,
          ambiguous,
          available: candidates.map((c) => ({ id: c.repoRef, name: c.name })),
        },
      };
    }
    if (missing.length > 0) {
      const available = candidates.map((c) => ({ id: c.repoRef, name: c.name }));
      const pick =
        available.length > 0
          ? `pick one of: ${available.map((a) => a.name).join(', ')}`
          : 'this project has no repository members yet';
      return {
        ...passthrough,
        refusal: {
          error:
            `${missing.length === 1 ? 'repository' : 'repositories'} ${missing.map((m) => `"${m}"`).join(', ')} ` +
            `${missing.length === 1 ? 'is' : 'are'} not a member of project ${projectId} — attach ` +
            `${missing.length === 1 ? 'it' : 'them'} (POST /projects/${projectId}/members {kind:"crew.repo", ref:<repo id>}) ` +
            `or ${pick}. Nothing was created.`,
          code: 'repo_not_in_project',
          requested: refs.refs,
          missing,
          available,
        },
      };
    }
  }
  delete body['repo_ref'];
  delete body['repo_refs'];

  // Style: pass a valid one through; infer an absent/unknown one from the brief's format words so
  // a print brief reaches the bridge's print instructions instead of its `web` default.
  let style: string | undefined = isDocStyle(body['style']) ? body['style'] : undefined;
  if (style === undefined) {
    const brief = typeof body['brief'] === 'string' ? body['brief'] : '';
    const inferred = inferDocStyle(brief);
    if (inferred !== undefined) {
      style = inferred;
      body['style'] = inferred;
      log?.(`interactive create for project ${projectId}: no style given — inferred "${inferred}" from the brief's format words`);
    } else {
      delete body['style'];
    }
  }

  return {
    body: Buffer.from(JSON.stringify(body), 'utf8'),
    contentType: 'application/json',
    ...(repoRefs.length > 0 ? { binding: { projectId, repoRefs, style } } : {}),
  };
}

export function registerInteractiveProxy(app: FastifyInstance, adapter: CoreAdapter, deps: InteractiveProxyDeps): void {
  const { settings, pool } = deps;
  // Strips exactly the mount prefix off the RAW url, leaving the remainder + query untouched.
  const prefixRe = new RegExp(`^${API_PREFIX}/projects/[^/?#]+/interactive`);

  /** The resolved docs root for a project, or null when no such project exists. */
  const rootFor = (projectId: string): Promise<string | null> => projectDocsRoot(adapter, settings, projectId, deps);

  // Encapsulated so the raw-body parser below applies to the PROXY ONLY. The root instance
  // installs a JSON parser that buffers and parses the body — correct for every other route,
  // fatal here: a parsed body is a consumed stream, and an SSE POST would arrive at the bridge
  // only once the client finished sending.
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_req, payload, done) => {
      done(null, payload);
    });

    scope.all(`${API_PREFIX}/projects/:projectId/interactive/*`, async (req, reply) => {
      const { projectId } = req.params as { projectId: string };
      const prefix = `${API_PREFIX}/projects/${encodeURIComponent(projectId)}/interactive`;

      const root = await rootFor(projectId);
      if (root === null) return reply.code(404).send({ error: `Project ${projectId} not found` });

      let bridge: LiveBridge;
      try {
        bridge = await pool.ensure(root);
      } catch (err) {
        return unavailable(reply, err, deps.log);
      }

      const target = (req.raw.url ?? '').replace(prefixRe, '') || '/';

      // F-046: the doc create is read and validated HERE before the bridge sees it (module doc).
      // Everything else stays socket-to-socket transport.
      let create: PreparedCreate | null = null;
      let createToken: number | undefined;
      const grounding = deps.grounding;
      if (grounding !== undefined && isDocCreate(req.method, target)) {
        const raw = await readBody(req.raw, DOC_CREATE_BODY_MAX);
        if (raw === null) return reply.code(413).send({ error: `create body exceeds ${DOC_CREATE_BODY_MAX} bytes` });
        create = await prepareDocCreate(raw, req.headers['content-type'], adapter, projectId, deps.log);
        if (create.refusal !== undefined) return reply.code(400).send(create.refusal);
        // The seams may see this doc's `doc.created` before the bridge has answered with its
        // name: mark the create in flight so they wait for the binding (doc-grounding.ts).
        if (create.binding !== undefined) createToken = grounding.beginCreate(projectId);
      }
      const send = (b: LiveBridge): Promise<void> =>
        create !== null
          ? forwardCreate(req, reply, b, target, prefix, create, grounding, root, deps.log)
          : forward(req, reply, b, target, prefix);

      try {
        try {
          await send(bridge);
        } catch (err) {
          // A create that already REACHED the bridge is never replayed (codex on crew#506): the
          // bridge may have created and announced the doc before the connection dropped, and a
          // second POST would 409 (or mint a duplicate) while the first doc carries no sidecar.
          // Say what is known — the outcome is undetermined — and let the client look.
          if (create !== null && (err as CreateForwardError).createDispatched === true && !reply.raw.headersSent) {
            deps.log?.(`interactive create for project ${projectId} was dispatched but the bridge dropped the connection: ${(err as Error).message}`);
            return reply.code(502).send(CREATE_UNDETERMINED);
          }
          // The cached bridge died between the pid check and the connect (an operator killed it,
          // a crash). Invalidate and let `ensure` restart it — ONE retry, so a genuinely broken
          // bridge fails fast to a 503 instead of looping.
          if (!isConnectionRefused(err) || reply.raw.headersSent) throw err;
          pool.invalidate(root);
          try {
            bridge = await pool.ensure(root);
          } catch (startErr) {
            return unavailable(reply, startErr, deps.log);
          }
          await send(bridge);
        }
      } finally {
        if (createToken !== undefined) grounding?.settleCreate(createToken);
      }
      return reply;
    });
  });
}

/**
 * The create's forwarding half (F-046): send the prepared body, BUFFER the bridge's answer (small
 * JSON), record the binding under the doc name it carries when the create succeeded, then relay
 * status/headers/body to the client with the same header discipline as `forward`.
 */
function forwardCreate(
  req: FastifyRequest,
  reply: FastifyReply,
  bridge: LiveBridge,
  target: string,
  prefix: string,
  create: PreparedCreate,
  grounding: DocGroundingStore | undefined,
  docsRoot: string,
  log?: (msg: string) => void,
): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const headers = forwardableRequestHeaders(req.headers, bridge);
    headers['content-type'] = create.contentType;
    headers['content-length'] = String(create.body.length);
    delete headers['transfer-encoding'];
    // Once the request body has been flushed to the socket the bridge may have acted on it: from
    // here on a failure is UNDETERMINED, not retryable (see the route's catch).
    let dispatched = false;
    const fail = (err: Error): void => {
      (err as CreateForwardError).createDispatched = dispatched;
      rejectPromise(err);
    };
    const upstream = httpRequest(
      { host: bridge.host, port: bridge.port, method: 'POST', path: target, headers },
      (res) => {
        dispatched = true;
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', (err) => fail(err));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          const status = res.statusCode ?? 502;
          if (create.binding !== undefined && grounding !== undefined && status >= 200 && status < 300) {
            try {
              const answer = JSON.parse(body.toString('utf8')) as { name?: unknown };
              if (typeof answer.name === 'string' && answer.name.length > 0) {
                grounding.record(docsRoot, answer.name, {
                  project_id: create.binding.projectId,
                  repo_refs: create.binding.repoRefs,
                  ...(create.binding.style !== undefined ? { style: create.binding.style } : {}),
                });
                log?.(
                  `interactive doc ${answer.name} (project ${create.binding.projectId}) is about ${create.binding.repoRefs.join(', ')} — grounding binding recorded`,
                );
              } else {
                log?.(`interactive create for project ${create.binding.projectId} answered ${status} without a doc name — no grounding binding recorded`);
              }
            } catch (err) {
              log?.(
                `interactive create for project ${create.binding.projectId}: grounding binding NOT recorded (${
                  err instanceof Error ? err.message : String(err)
                }) — the document will be grounded by its brief / the project's sole repo instead`,
              );
            }
          }
          reply.hijack();
          const out: Record<string, string | string[]> = {};
          for (const [name, value] of Object.entries(res.headers)) {
            if (HOP_BY_HOP.has(name) || value === undefined || name === 'content-length') continue;
            out[name] = name === 'location' && typeof value === 'string' ? rewriteLocation(value, bridge, prefix) : value;
          }
          out['content-length'] = String(body.length);
          reply.raw.writeHead(status, out);
          reply.raw.end(body);
          resolvePromise();
        });
      },
    );
    upstream.on('finish', () => {
      dispatched = true;
    });
    upstream.on('error', (err) => {
      if (reply.raw.headersSent) reply.raw.destroy();
      fail(err);
    });
    upstream.end(create.body);
  });
}

function isConnectionRefused(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH';
}

/** §5.6's failure shape: a machine-readable code plus a command the operator can actually run. */
function unavailable(reply: FastifyReply, err: unknown, log?: (msg: string) => void): FastifyReply {
  if (!(err instanceof BridgeUnavailableError)) throw err;
  log?.(`interactive bridge unavailable: ${err.message}`);
  return reply.code(503).send({ code: 'bridge_unavailable', hint: err.hint });
}

/**
 * One proxied exchange, socket to socket. `reply.hijack()` hands us the raw response before
 * Fastify can serialize or buffer anything, which is what lets an SSE chunk reach the browser
 * the moment the bridge emits it rather than at stream close.
 */
function forward(
  req: FastifyRequest,
  reply: FastifyReply,
  bridge: LiveBridge,
  target: string,
  prefix: string,
): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const upstream = httpRequest(
      {
        host: bridge.host,
        port: bridge.port,
        method: req.method,
        path: target,
        headers: forwardableRequestHeaders(req.headers, bridge),
      },
      (res) => {
        reply.hijack();
        const headers: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(res.headers)) {
          if (HOP_BY_HOP.has(name) || value === undefined) continue;
          headers[name] = name === 'location' && typeof value === 'string' ? rewriteLocation(value, bridge, prefix) : value;
        }
        reply.raw.writeHead(res.statusCode ?? 502, headers);
        // No `pipeline` and no buffering layer: `pipe` forwards each chunk as it lands, and
        // Node flushes it because we never set a highWaterMark barrier in between.
        res.pipe(reply.raw);
        res.on('end', () => resolvePromise());
        res.on('error', (err) => {
          reply.raw.destroy();
          rejectPromise(err);
        });
      },
    );

    upstream.on('error', (err) => {
      if (reply.raw.headersSent) reply.raw.destroy();
      rejectPromise(err);
    });
    // If the client hangs up mid-stream (closing an SSE tab), stop pulling from the bridge.
    reply.raw.on('close', () => upstream.destroy());
    req.raw.pipe(upstream);
  });
}
