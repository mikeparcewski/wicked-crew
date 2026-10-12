/**
 * `/api/v1/mcp-inspect` — the MCP inspector bridge (DES-MCP-INSPECTOR-001 §3).
 *
 *  - `POST /mcp-inspect/sessions {target}` (HUMAN-only): connect and run the handshake. `201` with
 *    the session (its state may be `failed`, with the server's stderr in the log). `409
 *    secret_missing` for a registry server whose secret resolves to nothing (never connected
 *    unauthenticated); `429` past {@link MAX_SESSIONS}.
 *  - `POST /mcp-inspect/sessions/:id/rpc {method, params?}` (HUMAN-only): one allowed request, its
 *    answer (`504` after 60 s; a late answer still lands in the log).
 *  - `GET /mcp-inspect/sessions/:id/log?after=&wait=` (operator, set explicitly: a GET is otherwise
 *    observer): a long poll of the log ring.
 *  - `DELETE /mcp-inspect/sessions/:id` (HUMAN-only): close it. Restart = delete, then start again.
 *
 * A stdio command runs as the daemon's user with the SDK's safe inherited env plus exactly the env
 * the operator typed (and, for a registry server, its ONE secret variable). Human-only is the
 * editors' rule: under `auth=off` every same-uid caller is the local human (DES-EDITOR §6.4).
 */

import { isAbsolute } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { LOCAL_ACTOR, trustAtLeast } from '../api/auth.js';
import type { Actor, McpInspectLogResponse, McpInspectRpcResponse, McpInspectStartResponse } from '../core/types.js';
import type { McpUpstreamConfig } from '../mcp/probe.js';
import { isWriteGrant, type McpCallTarget } from '../mcp/registry.js';
import { commandName, InspectError, InspectSession, InspectSessions, INSPECT_METHODS, type OpenedTransport, type TargetDescription } from './session.js';

const V = '/api/v1';

/** What the bridge needs of crew's MCP registry: a server's config and its secret, at connect. */
export interface InspectRegistry {
  inspectTarget(name: string): Promise<McpUpstreamConfig | null>;
  callSecret(config: McpUpstreamConfig): Promise<{ secret: string | null; missing: boolean }>;
  /** The broker's resolution of one tool (data connectors G1: a write tool is callable only once a human granted it). */
  resolveCall(server: string, tool: string): Promise<Pick<McpCallTarget, 'annotations' | 'classOverride' | 'registered'> | null>;
}

/**
 * Data connectors G1 composed with the inspector: on a REGISTERED server, a `tools/call` of a write
 * or destructive tool (by its annotations or class override, as the broker classes it) needs the
 * human write grant the registry holds (`registered`: server and tool enabled, schema as saved).
 * A read tool is callable, enabled or not (an operator debugs what it switched off). A typed command
 * or URL has no registry grant to check: the host's confirm named exactly what runs.
 * The plugin's `mcp.session` grant (install consent) never stands in for a write grant.
 */
async function refuseUngrantedWrite(registry: InspectRegistry | undefined, server: string, params: Record<string, unknown> | undefined): Promise<InspectError | null> {
  const tool = params?.['name'];
  if (typeof tool !== 'string') return null; // the server answers a malformed call itself
  const t = registry === undefined ? null : await registry.resolveCall(server, tool);
  if (t !== null && (t.registered || !isWriteGrant(t.annotations, t.classOverride))) return null;
  return new InspectError(403, 'write_not_granted', `${server}/${tool} is a write tool no human has granted (or its schema changed since): enable it on the MCP tools page first`);
}

/** A resolved connection: what to open, and what to scrub. */
export interface ConnectSpec {
  kind: 'stdio' | 'streamable-http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

export type TransportOpener = (spec: ConnectSpec) => OpenedTransport;

/** The real opener: the SDK's transports. */
export const openTransport: TransportOpener = (spec) => {
  if (spec.kind === 'stdio') {
    const t = new StdioClientTransport({
      command: spec.command ?? '',
      args: spec.args ?? [],
      env: { ...getDefaultEnvironment(), ...(spec.env ?? {}) },
      ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
      stderr: 'pipe',
    });
    return { transport: t, stderr: t.stderr as OpenedTransport['stderr'], pid: () => t.pid };
  }
  const url = new URL(spec.url ?? '');
  const requestInit = { headers: spec.headers ?? {} };
  const t = spec.kind === 'sse' ? new SSEClientTransport(url, { requestInit }) : new StreamableHTTPClientTransport(url, { requestInit });
  // The SDK's classes declare `sessionId?: string` against `Transport`, which
  // `exactOptionalPropertyTypes` refuses; the runtime shapes are the same (as `probe.ts`).
  return { transport: t as unknown as Transport, stderr: null, pid: () => null };
};

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const HEADER = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/u;
const Env = z.record(z.string().regex(NAME), z.string().max(8192)).refine((r) => Object.keys(r).length <= 32, 'at most 32 env vars');
const Headers = z.record(z.string().regex(HEADER), z.string().max(8192)).refine((r) => Object.keys(r).length <= 32, 'at most 32 headers');
const Target = z.union([
  z.object({ server: z.string().min(1).max(128) }).strict(),
  z
    .object({
      command: z.string().min(1).max(4096),
      args: z.array(z.string().max(4096)).max(64).optional(),
      env: Env.optional(),
      cwd: z.string().min(1).max(4096).refine((p) => isAbsolute(p), 'cwd must be an absolute path').optional(),
    })
    .strict(),
  z
    .object({
      url: z.string().url().max(4096).refine((u) => /^https?:\/\//iu.test(u), 'an http(s) URL'),
      transport: z.enum(['streamable-http', 'sse']).optional(),
      headers: Headers.optional(),
    })
    .strict(),
]);
const StartSchema = z.object({ target: Target }).strict();
const RpcSchema = z.object({ method: z.string().min(1).max(128), params: z.record(z.unknown()).optional() }).strict();

export interface InspectRoutesDeps {
  /** Absent: no MCP registry on this daemon, so `{server}` targets answer 404. */
  registry?: InspectRegistry;
  open?: TransportOpener;
  sessions?: InspectSessions;
  /** Tests only: the per-call deadline (default 60 s). */
  callTimeoutMs?: number;
  log?: (msg: string) => void;
}

/** Resolve a target to what to open, what the host may show, and the values to scrub. */
async function resolve(target: z.infer<typeof Target>, registry: InspectRegistry | undefined): Promise<{ spec: ConnectSpec; describe: TargetDescription; secrets: string[] }> {
  if ('server' in target) {
    const config = registry === undefined ? null : await registry.inspectTarget(target.server);
    if (config === null || registry === undefined) throw new InspectError(404, 'unknown_server', `no MCP server named ${target.server} is registered`);
    if (config.kind === 'rest') throw new InspectError(400, 'not_mcp', `${target.server} is a REST API wrapped as tools, not an MCP server`);
    const { secret, missing } = await registry.callSecret(config);
    if (missing) throw new InspectError(409, 'secret_missing', `${config.auth?.ref ?? 'the secret'} resolves to no secret; set it in MCP tools (the inspector never connects unauthenticated)`);
    const secrets = secret === null ? [] : [secret];
    if (config.kind === 'mcp-stdio') {
      const env: Record<string, string> = {};
      if (config.auth?.env !== undefined && secret !== null) env[config.auth.env] = secret;
      return {
        spec: { kind: 'stdio', command: config.command ?? '', args: config.args, env },
        describe: { kind: 'server', name: config.name, label: [config.command ?? '', ...config.args].join(' '), envNames: Object.keys(env), headerNames: [] },
        secrets,
      };
    }
    const headers: Record<string, string> = {};
    if (config.auth?.header !== undefined && secret !== null) headers[config.auth.header] = `${config.auth.prefix ?? ''}${secret}`;
    return {
      spec: { kind: 'streamable-http', url: config.url ?? '', headers },
      describe: { kind: 'server', name: config.name, label: config.url ?? '', envNames: [], headerNames: Object.keys(headers) },
      secrets,
    };
  }
  if ('command' in target) {
    const args = target.args ?? [];
    const env = target.env ?? {};
    return {
      spec: { kind: 'stdio', command: target.command, args, env, ...(target.cwd !== undefined ? { cwd: target.cwd } : {}) },
      describe: { kind: 'stdio', name: commandName(target.command, args), label: [target.command, ...args].join(' '), envNames: Object.keys(env), headerNames: [] },
      secrets: Object.values(env).filter((v) => v.length >= 4),
    };
  }
  const kind = target.transport ?? 'streamable-http';
  const headers = target.headers ?? {};
  return {
    spec: { kind, url: target.url, headers },
    describe: { kind, name: new URL(target.url).host, label: target.url, envNames: [], headerNames: Object.keys(headers) },
    secrets: Object.values(headers).filter((v) => v.length >= 4),
  };
}

export function registerMcpInspectRoutes(app: FastifyInstance, deps: InspectRoutesDeps): InspectSessions {
  const sessions = deps.sessions ?? new InspectSessions();
  const open = deps.open ?? openTransport;
  const actorOf = (req: { actor?: Actor }): Actor => req.actor ?? LOCAL_ACTOR;
  const humanOnly = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const actor = actorOf(req);
    if (actor.kind === 'human' && trustAtLeast(actor, 'operator')) return true;
    void reply.code(403).send({ error: `only a human operator can start, drive or stop an MCP inspector session (you are ${actor.kind}/${actor.trust})` });
    return false;
  };
  const operatorOnly = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const actor = actorOf(req);
    if (trustAtLeast(actor, 'operator')) return true;
    void reply.code(403).send({ error: `Insufficient trust: the MCP inspector requires 'operator' (you are '${actor.trust}')` });
    return false;
  };
  const fail = (reply: FastifyReply, err: unknown): FastifyReply => {
    if (err instanceof InspectError) return reply.code(err.status).send({ code: err.code, error: err.message });
    throw err;
  };
  const sessionOf = (req: FastifyRequest, reply: FastifyReply): InspectSession | null => {
    const s = sessions.get((req.params as { id: string }).id);
    if (s === null) void reply.code(404).send({ code: 'no_session', error: 'no such inspector session (it may have been closed after 10 minutes idle)' });
    return s;
  };

  const onExit = (): void => sessions.killAllSync();
  process.once('exit', onExit);
  // The exit kill stays armed until every session, including one already closing, is closed (codex r2).
  app.addHook('onClose', async () => {
    try {
      await sessions.closeAll();
    } finally {
      process.removeListener('exit', onExit);
    }
  });

  app.post(
    `${V}/mcp-inspect/sessions`,
    { config: { manifest: { requestType: 'McpInspectStartBody', responseType: 'McpInspectStartResponse', statusCodes: [201, 400, 403, 404, 409, 429] } } },
    async (req, reply) => {
      if (!humanOnly(req, reply)) return reply;
      const parsed = StartSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ code: 'bad_request', error: `body must be { target: {server} | {command, args?, env?, cwd?} | {url, transport?, headers?} }: ${parsed.error.issues[0]?.message ?? ''}` });
      try {
        if (!sessions.hasRoom()) throw new InspectError(429, 'too_many_sessions', 'at most 4 inspector sessions at once; disconnect one first');
        const { spec, describe, secrets } = await resolve(parsed.data.target, deps.registry);
        let opened: OpenedTransport;
        try {
          opened = open(spec);
        } catch (err) {
          throw new InspectError(400, 'bad_target', `could not open the connection: ${err instanceof Error ? err.message : String(err)}`);
        }
        const session = new InspectSession(describe, opened, secrets, Date.now, deps.callTimeoutMs);
        sessions.add(session);
        await session.start();
        deps.log?.(session.scrubText(`[mcp-inspect] ${session.id.slice(0, 8)} ${describe.kind} ${describe.name}: ${session.state}`));
        const body: McpInspectStartResponse = { session: session.view() };
        return reply.code(201).send(body);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.post(
    `${V}/mcp-inspect/sessions/:id/rpc`,
    { config: { manifest: { requestType: 'McpInspectRpcBody', responseType: 'McpInspectRpcResponse', statusCodes: [200, 400, 403, 404, 409, 502, 504] } } },
    async (req, reply) => {
      if (!humanOnly(req, reply)) return reply;
      const s = sessionOf(req, reply);
      if (s === null) return reply;
      const parsed = RpcSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ code: 'bad_request', error: 'body must be { method, params?: object }' });
      if (!INSPECT_METHODS.has(parsed.data.method)) {
        return reply.code(400).send({ code: 'method_not_allowed', error: `${parsed.data.method} is not a method the inspector sends (allowed: ${[...INSPECT_METHODS].join(', ')})` });
      }
      const target = s.target;
      if (parsed.data.method === 'tools/call' && target.kind === 'server') {
        const refused = await refuseUngrantedWrite(deps.registry, target.name, parsed.data.params);
        if (refused !== null) return fail(reply, refused);
      }
      try {
        const body: McpInspectRpcResponse = await s.rpc(parsed.data.method, parsed.data.params);
        return body;
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.get(
    `${V}/mcp-inspect/sessions/:id/log`,
    { config: { manifest: { responseType: 'McpInspectLogResponse', statusCodes: [200, 403, 404] } } },
    async (req, reply) => {
      if (!operatorOnly(req, reply)) return reply;
      const s = sessionOf(req, reply);
      if (s === null) return reply;
      const q = req.query as { after?: string; wait?: string };
      const after = Number.parseInt(q.after ?? '0', 10);
      const wait = Number.parseInt(q.wait ?? '0', 10);
      const body: McpInspectLogResponse = await s.entries(Number.isFinite(after) ? after : 0, Number.isFinite(wait) ? Math.max(0, wait) * 1000 : 0);
      return body;
    },
  );

  app.delete(
    `${V}/mcp-inspect/sessions/:id`,
    { config: { manifest: { statusCodes: [204, 403, 404] } } },
    async (req, reply) => {
      if (!humanOnly(req, reply)) return reply;
      const removed = await sessions.remove((req.params as { id: string }).id);
      if (!removed) return reply.code(404).send({ code: 'no_session', error: 'no such inspector session' });
      return reply.code(204).send();
    },
  );

  return sessions;
}
