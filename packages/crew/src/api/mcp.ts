/**
 * The `/api/v1/mcp/*` registry routes (DES-MCP-TOOLS-001 §8; slice S2).
 *
 *   GET    /mcp/servers                 upstreams, their tools (class, subject, status), health,
 *                                       auth state, and the servers discovered in CLI homes (names only)
 *   POST   /mcp/servers/preview         probe (10 s, hardened env): tools, classes and a previewHash
 *   POST   /mcp/servers                 save: `{previewHash}` only; missing, unknown or expired → 409
 *   PATCH  /mcp/servers/:name           `{enabled}`
 *   DELETE /mcp/servers/:name           remove the server and the keychain secret it owns
 *   POST   /mcp/servers/:name/test      probe again: health plus the tool diff
 *   PATCH  /mcp/tools/:subject          `{enabled?, classOverride?}`; `:subject` is `mcp:<server>/<tool>`, URL-encoded
 *   PUT    /mcp/servers/:name/secret    `{value}` → the OS keychain; answers `{ref, set: true}`, never the value
 *
 * The secret value is in no response, log, audit entry or file (D-2); tests/mcp-registry.test.ts
 * scans all of them, a malformed secret body included.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Actor } from '../core/types.js';
import { MCP_SERVER_NAME_RE } from '../mcp/classify.js';
import { McpRegistryError, type McpRegistry } from '../mcp/registry.js';
import { McpRegistryCorruptError } from '../mcp/registry-store.js';
import { parseSecretRef, SecretStoreError } from '../mcp/secrets.js';
import type { McpUpstreamConfig } from '../mcp/probe.js';
import { API_PREFIX } from './api-prefix.js';
import type { AuditLog } from './audit.js';

const V = API_PREFIX;
const serverName = z.string().regex(MCP_SERVER_NAME_RE, 'a server name is 1-63 of a-z 0-9 _ -, starting with a letter or digit');
const toolClass = z.enum(['read', 'write', 'destructive']);

const AuthSchema = z
  .object({
    ref: z.string().refine((r) => parseSecretRef(r) !== null, { message: 'ref must be keychain:wicked-mcp/<name> or env:<NAME>' }),
    env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/).optional(),
    header: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).optional(),
    prefix: z.string().max(32).optional(),
  })
  .strict();

// Exported so tests/wire-contract.test.ts can pin the published bodies against them.
export const McpServerConfigSchema = z
  .object({
    name: serverName,
    kind: z.enum(['mcp-stdio', 'mcp-http']),
    command: z.string().min(1).max(4096).optional(),
    args: z.array(z.string().max(4096)).max(64).optional(),
    url: z.string().max(4096).optional(),
    auth: AuthSchema.nullable().optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const issue = (path: string, message: string): void => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if (c.kind === 'mcp-stdio') {
      if (c.command === undefined) issue('command', 'an mcp-stdio server needs a command');
      if (c.url !== undefined) issue('url', 'an mcp-stdio server takes no url');
      if (c.auth != null && (c.auth.env === undefined || c.auth.header !== undefined)) issue('auth', 'an mcp-stdio server injects its secret into one env variable: auth.env, no auth.header');
    } else {
      if (c.command !== undefined || c.args !== undefined) issue('command', 'an mcp-http server takes a url, not a command');
      let ok = false;
      try {
        const u = new URL(c.url ?? '');
        ok = u.protocol === 'https:' || u.protocol === 'http:';
      } catch {
        ok = false;
      }
      if (!ok) issue('url', 'an mcp-http server needs an http(s) url');
      if (c.auth != null && (c.auth.header === undefined || c.auth.env !== undefined)) issue('auth', 'an mcp-http server injects its secret into one header: auth.header, no auth.env');
    }
  });
export const SaveMcpServerSchema = z.object({ previewHash: z.string().min(1).max(128).optional() }).strict();
export const PatchMcpServerSchema = z.object({ enabled: z.boolean() }).strict();
export const PatchMcpToolSchema = z
  .object({ enabled: z.boolean().optional(), classOverride: toolClass.nullable().optional() })
  .strict()
  .refine((p) => p.enabled !== undefined || p.classOverride !== undefined, { message: 'set enabled, classOverride or both' });
export const PutMcpSecretSchema = z
  .object({
    value: z
      .string()
      .min(8, 'a secret is at least 8 characters')
      .max(8192)
      .refine((v) => !/[\r\n\0]/.test(v), { message: 'a secret is one line' }),
  })
  .strict();

export interface McpRouteDeps {
  /** Absent = a directly-driven route set with no registry seam → 503. */
  registry?: McpRegistry;
  audit: Pick<AuditLog, 'record'>;
  actorOf: (req: FastifyRequest) => Actor;
}

function invalidBody(reply: FastifyReply, err: z.ZodError): FastifyReply {
  return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
}

function fail(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof McpRegistryError) return reply.code(err.status).send({ error: err.message, code: err.code });
  if (err instanceof McpRegistryCorruptError) return reply.code(503).send({ error: err.message, code: 'registry_corrupt' });
  if (err instanceof SecretStoreError) return reply.code(502).send({ error: err.message, code: 'secret_store_failed' });
  throw err;
}

function toConfig(body: z.infer<typeof McpServerConfigSchema>): McpUpstreamConfig {
  return {
    name: body.name,
    kind: body.kind,
    command: body.command ?? null,
    args: body.args ?? [],
    url: body.url ?? null,
    auth:
      body.auth == null
        ? null
        : {
            ref: body.auth.ref,
            ...(body.auth.env !== undefined ? { env: body.auth.env } : {}),
            ...(body.auth.header !== undefined ? { header: body.auth.header } : {}),
            ...(body.auth.prefix !== undefined ? { prefix: body.auth.prefix } : {}),
          },
  };
}

export function registerMcpRoutes(app: FastifyInstance, deps: McpRouteDeps): void {
  const registry = (reply: FastifyReply): McpRegistry | null => {
    if (deps.registry !== undefined) return deps.registry;
    void reply.code(503).send({ error: 'the MCP registry is not configured on this daemon', code: 'mcp_unavailable' });
    return null;
  };

  app.get(`${V}/mcp/servers`, { config: { manifest: { responseType: 'McpServersResponse', statusCodes: [200, 503] } } }, async (_req, reply) => {
    const r = registry(reply);
    if (r === null) return reply;
    try {
      return await r.list();
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post(
    `${V}/mcp/servers/preview`,
    { config: { manifest: { requestType: 'McpServerConfigBody', responseType: 'McpPreviewResponse', statusCodes: [200, 400, 502, 503] } } },
    async (req, reply) => {
      const r = registry(reply);
      if (r === null) return reply;
      const parsed = McpServerConfigSchema.safeParse(req.body);
      if (!parsed.success) return invalidBody(reply, parsed.error);
      try {
        return await r.preview(toConfig(parsed.data));
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.post(
    `${V}/mcp/servers`,
    { config: { manifest: { requestType: 'SaveMcpServerBody', responseType: 'McpServer', statusCodes: [201, 400, 409, 503] } } },
    async (req, reply) => {
      const r = registry(reply);
      if (r === null) return reply;
      const parsed = SaveMcpServerSchema.safeParse(req.body ?? {});
      if (!parsed.success) return invalidBody(reply, parsed.error);
      try {
        const server = await r.save(parsed.data.previewHash);
        deps.audit.record('mcp.server.saved', deps.actorOf(req), {
          detail: { name: server.name, kind: server.kind, tools: server.tools.length, authRef: server.auth?.ref ?? null },
        });
        return reply.code(201).send(server);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.patch<{ Params: { name: string } }>(
    `${V}/mcp/servers/:name`,
    { config: { manifest: { requestType: 'PatchMcpServerBody', responseType: 'McpServer', statusCodes: [200, 400, 404, 503] } } },
    async (req, reply) => {
      const r = registry(reply);
      if (r === null) return reply;
      const parsed = PatchMcpServerSchema.safeParse(req.body);
      if (!parsed.success) return invalidBody(reply, parsed.error);
      try {
        const server = await r.setServerEnabled(req.params.name, parsed.data.enabled);
        deps.audit.record(parsed.data.enabled ? 'mcp.server.enabled' : 'mcp.server.disabled', deps.actorOf(req), { detail: { name: server.name } });
        return server;
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.delete<{ Params: { name: string } }>(
    `${V}/mcp/servers/:name`,
    { config: { manifest: { responseType: '{ removed: string }', statusCodes: [200, 404, 503] } } },
    async (req, reply) => {
      const r = registry(reply);
      if (r === null) return reply;
      try {
        await r.remove(req.params.name);
        deps.audit.record('mcp.server.removed', deps.actorOf(req), { detail: { name: req.params.name } });
        return { removed: req.params.name };
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.post<{ Params: { name: string } }>(
    `${V}/mcp/servers/:name/test`,
    { config: { manifest: { responseType: 'McpServerTestResponse', statusCodes: [200, 404, 503] } } },
    async (req, reply) => {
      const r = registry(reply);
      if (r === null) return reply;
      try {
        return await r.test(req.params.name);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.patch<{ Params: { subject: string } }>(
    `${V}/mcp/tools/:subject`,
    { config: { manifest: { requestType: 'PatchMcpToolBody', responseType: 'McpTool', statusCodes: [200, 400, 404, 503] } } },
    async (req, reply) => {
      const r = registry(reply);
      if (r === null) return reply;
      const parsed = PatchMcpToolSchema.safeParse(req.body);
      if (!parsed.success) return invalidBody(reply, parsed.error);
      try {
        const tool = await r.patchTool(req.params.subject, parsed.data);
        deps.audit.record('mcp.tool.updated', deps.actorOf(req), { detail: { subject: tool.subject, ...parsed.data } });
        return tool;
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.put<{ Params: { name: string } }>(
    `${V}/mcp/servers/:name/secret`,
    {
      config: { manifest: { requestType: 'PutMcpSecretBody', responseType: 'McpSecretResponse', statusCodes: [200, 400, 501, 502, 503] } },
    },
    async (req, reply) => {
      const r = registry(reply);
      if (r === null) return reply;
      const name = serverName.safeParse(req.params.name);
      if (!name.success) return invalidBody(reply, name.error);
      const parsed = PutMcpSecretSchema.safeParse(req.body);
      if (!parsed.success) return invalidBody(reply, parsed.error);
      try {
        const ref = await r.setSecret(name.data, parsed.data.value);
        deps.audit.record('mcp.secret.set', deps.actorOf(req), { detail: { name: name.data, ref } });
        return { ref, set: true as const };
      } catch (err) {
        return fail(reply, err);
      }
    },
  );
}
