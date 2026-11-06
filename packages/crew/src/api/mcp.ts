/**
 * The `/api/v1/mcp/*` registry routes (DES-MCP-TOOLS-001 §8; slice S2).
 *
 *   GET    /mcp/servers                 upstreams, their tools (class, subject, status), health,
 *                                       auth state, and the servers discovered in CLI homes (names only)
 *   POST   /mcp/servers/preview         probe (45 s budget, hardened env): tools, classes and a previewHash
 *                                       (`kind: "rest"`, slice S5a: the tools of an OpenAPI 3 document,
 *                                       each pinned to the base `url`; see `mcp/rest.ts`)
 *   POST   /mcp/servers                 save: `{previewHash, enabledWrites?, allowOrigin?}`; missing, unknown or expired → 409.
 *                                       (G1) a write/destructive tool that is new or whose schema changed
 *                                       is registered DISABLED; `enabledWrites` names the ones the operator
 *                                       grants (human operator only → else 403), each audited
 *                                       `mcp.tool.write_granted`.
 *                                       (G2) a `rest` base URL that matches none of the spec's `servers` needs
 *                                       `allowOrigin` = exactly that origin (409 `egress_unconfirmed`; human
 *                                       operator only → else 403), audited `mcp.server.egress_confirmed`. A REST
 *                                       tool's hash covers the target, so a changed target re-registers its tools
 *                                       and withdraws their approvals.
 *                                       (DES-APPS-001 §5.2) every connection to an `mcp-http`/`rest` server goes
 *                                       through the one dialer: a loopback/private host needs `address.allow` on
 *                                       the PREVIEW (which dials) and the save, human operator only (403
 *                                       `address_confirm_human_only`), audited `mcp.server.address_confirmed`
 *                                       (crew#1316) a preview whose `auth.ref` names a secret it does not stage (an
 *                                       `env:` reference, a keychain entry crew already holds) probes with that
 *                                       secret: human operator only (403 `stored_secret_human_only`)
 *   PATCH  /mcp/servers/:name           `{enabled}`
 *   DELETE /mcp/servers/:name           remove the server and the keychain secret it owns
 *   POST   /mcp/servers/:name/test      probe again: health plus the tool diff
 *   PATCH  /mcp/tools/:subject          `{enabled?, classOverride?}`; `:subject` is `mcp:<server>/<tool>`, URL-encoded.
 *                                       (G1) leaving a tool enabled AND a write when it was not both (turning
 *                                       a write on, or re-classing an enabled read) is a grant: human
 *                                       operator only (403), audited `mcp.tool.write_granted`
 *   PUT    /mcp/servers/:name/secret    `{value}` → the OS keychain; answers `{ref, set: true}`, never the value.
 *                                       RE-KEY only (crew#719): the server must already reference
 *                                       `keychain:wicked-mcp/<name>`. A new server's secret rides
 *                                       `secret` on the PREVIEW body and is written by the save.
 *   POST   /mcp/call                    the broker (§6, slice S3): `{token, subject, args?}` from the garden
 *                                       shim; judged, budgeted, invoked, scrubbed, output-judged, recorded
 *   POST   /mcp/tools                   `{token}` from the garden shim's `list` (slice S4): the tools the
 *                                       token's unit may try, judged with no arguments, recorded nowhere
 *
 * Slice S6 (the policy preview and the approvals, `mcp/policies.ts`):
 *
 *   POST   /mcp/policies/preview        `{subject?, server?, phaseRole?, seat?, mode?, phaseId?}` → each
 *                                       tool's decision per role × seat × mode; nothing is recorded
 *   GET    /mcp/approvals               the approved subjects, the tools that would ask, the two ledgers
 *   POST   /mcp/approvals               `{subject}`: a server joins `MCP-FIRST-USE` excludes; a tool joins
 *                                       that and `MCP-POSTURE-WRITE` (audited rule upserts)
 *   DELETE /mcp/approvals/:subject      removes it from both (`:subject` URL-encoded)
 *
 * Slice S7 (the usage fold, `mcp/usage.ts`):
 *
 *   GET    /mcp/usage                   `?days=1-30&subject&seat&decision` → counts, the decision split
 *                                       (allow / ask / deny / guard_error), error rate, p50/p95/p99,
 *                                       per-tool, per-server, tool × seat × run, chains, per day
 *
 * `POST /mcp/servers/preview` also answers the matrix (`policies`); a save that changes a saved
 * tool's schema, and a removal, withdraw the approvals that named it, BEFORE the registry changes.
 *
 * DES-KNOWLEDGE-DATA-001 §5 (the one registry, B1):
 *
 *   GET    /mcp/servers?view=agent      the agent-safe projection (crew#1310): every NON-HUMAN actor gets it
 *                                       whatever it asks; a human gets it on request. The answers of a save,
 *                                       `PATCH /mcp/servers/:name` and a test are projected the same way
 *   POST   /mcp/servers/preview         also `kind: "toolbox-source"` (Toolbox's own source document, checked
 *                                       against the deployment policy: 400 with the policy's code); a `sql`
 *                                       Postgres body is saved as the same document (descriptor version 2)
 *   POST   /mcp/servers                 also `disclosures` (each tool's disclosure class): human operator only
 *   PATCH  /mcp/tools/:subject          also `disclosure`: setting one is human operator only
 *   GET    /mcp/registry/generations    the kept generations (human operator only)
 *   POST   /mcp/registry/restore        `{generation}`: restore one, failing closed (human operator only)
 *
 * The secret value is in no response, log, audit entry or file (D-2); tests/mcp-registry.test.ts
 * scans all of them, a malformed secret body included.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { record, z } from '../zod.js';

import type { Actor, McpApprovalResponse, McpCallDecision, McpPreviewResponse, McpRegistryRestoreResponse, McpServer, McpServerAgentView, McpServerTestAgentResponse, McpServerTestResponse, McpUsageResponse } from '../core/types.js';
import { canonicalJson, MCP_SERVER_NAME_RE } from '../mcp/classify.js';
import type { McpBroker } from '../mcp/broker.js';
import type { AskServer } from '../mcp/ask-server.js';
import type { McpPolicies } from '../mcp/policies.js';
import { MCP_PREVIEW_ROLES, MCP_RUN_MODES, McpLedgerEditError } from '../mcp/policies.js';
import { agentServerView, configOf, isWriteGrant, McpRegistryError, type McpRegistry } from '../mcp/registry.js';
import { restTarget } from '../mcp/rest.js';
import { listUnitTools } from '../mcp/tool-list.js';
import type { RunFence } from '../mcp/run-fence.js';
import type { DataGate } from '../knowledge/gate/gate.js';
import { McpRegistryCorruptError, type McpServerRecord } from '../mcp/registry-store.js';
import { parseSecretRef, SecretStoreError } from '../mcp/secrets.js';
import type { McpCallRecordSource } from '../mcp/call-records.js';
import { foldMcpUsage, MCP_USAGE_DECISIONS, MCP_USAGE_DEFAULT_DAYS, MCP_USAGE_MAX_DAYS } from '../mcp/usage.js';
import type { McpUpstreamConfig } from '../mcp/probe.js';
import { parseBaseUrl, REST_SPEC_MAX_BYTES } from '../mcp/rest.js';
import { NO_CONFIRMATION, validateAllowRanges } from '../sources/dialer.js';
import type { ToolboxSourceEntry } from '../knowledge/registry/entry.js';
import { API_PREFIX } from './api-prefix.js';
import type { AuditLog } from './audit.js';
import { trustAtLeast, viewOf } from './auth.js';

const V = API_PREFIX;
const serverName = z.string().regex(MCP_SERVER_NAME_RE, 'a server name is 1-63 of a-z 0-9 _ -, starting with a letter or digit');
const toolClass = z.enum(['read', 'write', 'destructive']);
/** (DES-KNOWLEDGE-DATA-001 §7.1) What a tool's answer discloses. */
const disclosureClass = z.enum(['none', 'structure', 'rows']);
/** A pasted secret VALUE. Shared by the staged-secret preview field and `PUT …/secret` (crew#719). */
const secretValue = z
  .string()
  .min(8, 'a secret is at least 8 characters')
  .max(8192)
  .refine((v) => !/[\r\n\0]/.test(v), { error: 'a secret is one line' });

const AuthSchema = z.strictObject({
  ref: z.string().refine((r) => parseSecretRef(r) !== null, { error: 'ref must be keychain:wicked-mcp/<name> or env:<NAME>' }),
  env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/).optional(),
  header: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).optional(),
  prefix: z.string().max(32).optional(),
});

/** (DES-APPS-001 §5.2) A source's address confirmation: CIDRs inside loopback/private ranges only. */
export const AddressSchema = z.strictObject({
  allow: z.array(z.string().min(1).max(64)).max(16),
  plaintext: z.boolean().optional(),
})
  .superRefine((a, ctx) => {
    const problem = validateAllowRanges(a.allow);
    if (problem !== null) ctx.addIssue({ code: 'custom', path: ['allow'], message: problem });
  });

/** (DES-APPS-001 §5.1) A network SQL source's settings; the password is `auth.ref`'s secret. */
export const SqlSourceSchema = z.strictObject({
  driver: z.enum(['postgres', 'mysql']),
  host: z.string().min(1).max(253).regex(/^[^\s/@?#]+$/, 'a host name or IP address'),
  port: z.int().min(1).max(65_535).optional(),
  database: z.string().min(1).max(128),
  user: z.string().min(1).max(128),
  tls: z.enum(['verify-full', 'disable']).optional(),
  ca: z.string().min(1).max(65_536).optional(),
});

/**
 * (DES-KNOWLEDGE-DATA-001 §5.1) Toolbox's source document, as sent: an object of at most 32 fields, each judged
 * by the deployment policy (`knowledge/registry/policy.ts`) at the preview, not here.
 */
const ToolboxDocumentSchema = record(z.string().max(64), z.union([z.string().max(4096), z.number(), z.boolean(), z.null(), record(z.string(), z.unknown()), z.array(z.unknown())]))
  .refine((d) => Object.keys(d).length <= 32, { error: 'a Toolbox source document has at most 32 fields' });

// Exported so tests/wire-contract.test.ts can pin the published bodies against them.
export const McpServerConfigSchema = z.strictObject({
  name: serverName,
  kind: z.enum(['mcp-stdio', 'mcp-http', 'rest', 'sql', 'graphql', 'toolbox-source']),
  command: z.string().min(1).max(4096).optional(),
  args: z.array(z.string().max(4096)).max(64).optional(),
  url: z.string().max(4096).optional(),
  auth: AuthSchema.nullable().optional(),
  openapiUrl: z.string().max(4096).optional(),
  openapi: record(z.string(), z.unknown())
    .refine((d) => Buffer.byteLength(JSON.stringify(d), 'utf8') <= REST_SPEC_MAX_BYTES, { error: `the OpenAPI document is at most ${REST_SPEC_MAX_BYTES} bytes` })
    .optional(),
  operations: z.array(z.string().min(1).max(256)).min(1).max(512).optional(),
  /**
   * (DES-APPS-001 §5.2) The loopback/private ranges the person confirms for this server's
   * connections, and whether plaintext is accepted on a confirmed private range. Human operator
   * only (403 `address_confirm_human_only`), on the preview (which dials) and the save; audited
   * `mcp.server.address_confirmed`. `mcp-http` and `rest` only: an `mcp-stdio` server is a local
   * program, outside the dialer.
   */
  address: AddressSchema.optional(),
  /** (DES-APPS-001 §5.1) `sql` only: a network SQL source's settings (sqlite sources come from uploads). */
  sql: SqlSourceSchema.optional(),
  /** `sql` only: the views a read may name (`schema.view`). */
  viewsAllowed: z.array(z.string().min(3).max(256).regex(/^[^.\s]+\.[^.\s]+$/, 'a view is named schema.view')).max(256).optional(),
  /** (DES-KNOWLEDGE-DATA-001 §5.1) `toolbox-source` only: Toolbox's own source document, its runtime and TLS choice. */
  toolbox: ToolboxDocumentSchema.optional(),
  runtime: z.enum(['native', 'toolbox']).optional(),
  tls: z.strictObject({ mode: z.enum(['verify-full', 'disable']), ca: z.string().min(1).max(65_536).optional() }).optional(),
  /**
   * (crew#719) The secret VALUE this server's keychain entry will hold. The preview is probed
   * with it and it is held with the preview; `POST /mcp/servers` writes it to the OS store as
   * part of the save, so the secret and the registry row commit together. Requires
   * `auth.ref` = `keychain:wicked-mcp/<name>`. It is in no response, log, audit entry or file.
   */
  secret: secretValue.optional(),
  /**
   * (DES-PM-001 §3) `mcp-http` / `mcp-stdio` only: this server is a project-management system's own MCP server. A
   * human operator's only (403 `pm_source_human_only`). `gitlab` and `ado` are wave PM-2.
   */
  pm: z.strictObject({ system: z.enum(['github', 'jira']) }).optional(),
})
  .superRefine((c, ctx) => {
    const issue = (path: string, message: string): void => ctx.addIssue({ code: 'custom', path: [path], message });
    const httpUrl = (raw: string | undefined): boolean => {
      try {
        const u = new URL(raw ?? '');
        return u.protocol === 'https:' || u.protocol === 'http:';
      } catch {
        return false;
      }
    };
    if (c.kind !== 'rest' && (c.openapiUrl !== undefined || c.openapi !== undefined || c.operations !== undefined)) {
      issue('openapi', 'openapiUrl, openapi and operations are for a rest server');
    }
    if (c.kind !== 'sql' && c.sql !== undefined) issue('sql', 'sql is for a sql source');
    if (c.pm !== undefined && c.kind !== 'mcp-http' && c.kind !== 'mcp-stdio') issue('pm', 'pm marks a project-management system\'s own MCP server: kind mcp-http or mcp-stdio');
    if (c.kind !== 'sql' && c.kind !== 'toolbox-source' && c.viewsAllowed !== undefined) issue('viewsAllowed', 'viewsAllowed is for a sql or toolbox-source source');
    if (c.kind !== 'toolbox-source' && (c.toolbox !== undefined || c.runtime !== undefined || c.tls !== undefined)) issue('toolbox', 'toolbox, runtime and tls are for a toolbox-source');
    if (c.kind === 'toolbox-source') {
      if (c.toolbox === undefined) issue('toolbox', "a toolbox-source needs toolbox: Toolbox's own source document ({kind: 'source', type: 'postgres', host, port, database, user, password: '${WICKED_SRC_1}'})");
      if (c.command !== undefined || c.args !== undefined || c.url !== undefined) issue('url', 'a toolbox-source takes its Toolbox document, not a command or url');
      if (c.auth != null && (c.auth.env !== undefined || c.auth.header !== undefined || c.auth.prefix !== undefined)) issue('auth', 'a toolbox-source takes its secret as auth.ref only');
      return;
    }
    if (c.kind === 'sql') {
      if (c.sql === undefined) issue('sql', 'a sql source needs sql: {driver, host, database, user} (a sqlite source comes from POST /apps/uploads)');
      if (c.command !== undefined || c.args !== undefined || c.url !== undefined) issue('url', 'a sql source takes sql settings, not a command or url');
      if (c.auth != null && (c.auth.env !== undefined || c.auth.header !== undefined || c.auth.prefix !== undefined)) issue('auth', 'a sql source takes its password as auth.ref only');
      return;
    }
    if (c.kind === 'graphql') {
      if (c.command !== undefined || c.args !== undefined) issue('command', 'a graphql source takes a url, not a command');
      if (!httpUrl(c.url)) issue('url', 'a graphql source needs an http(s) endpoint url');
      else if (new URL(c.url ?? '').username + new URL(c.url ?? '').password !== '') issue('url', 'the url must not carry credentials; reference the secret with auth.ref');
      if (c.auth != null && (c.auth.header === undefined || c.auth.env !== undefined)) issue('auth', 'a graphql source injects its secret into one header: auth.header, no auth.env');
      return;
    }
    if (c.kind === 'rest') {
      if (c.command !== undefined || c.args !== undefined) issue('command', 'a rest server takes a base url, not a command');
      if (parseBaseUrl(c.url ?? null) === null) issue('url', 'a rest server needs an http(s) base url with no credentials, query or fragment');
      if ((c.openapiUrl === undefined) === (c.openapi === undefined)) issue('openapi', 'a rest server takes openapiUrl or openapi (the document), exactly one');
      if (c.openapiUrl !== undefined && !httpUrl(c.openapiUrl)) issue('openapiUrl', 'openapiUrl must be an http(s) url');
      // The URL is stored and answered back, so it may not carry credentials: a secret goes in auth.ref.
      if (c.openapiUrl !== undefined && httpUrl(c.openapiUrl) && new URL(c.openapiUrl).username + new URL(c.openapiUrl).password !== '') {
        issue('openapiUrl', 'openapiUrl must not carry credentials; reference the secret with auth.ref');
      }
      if (c.auth != null && (c.auth.header === undefined || c.auth.env !== undefined)) issue('auth', 'a rest server injects its secret into one header: auth.header, no auth.env');
    } else if (c.kind === 'mcp-stdio') {
      if (c.address !== undefined) issue('address', 'an mcp-stdio server is a local program, outside the dialer: it takes no address confirmation');
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
export const SaveMcpServerSchema = z.strictObject({
  previewHash: z.string().min(1).max(128).optional(),
  /** (G1) The write/destructive tools of the preview the operator grants: registered enabled. */
  enabledWrites: z.array(z.string().min(1).max(256)).max(512).optional(),
  /** (G2) The exact origin a `rest` server's calls go to, confirmed by a human operator. */
  allowOrigin: z.string().min(1).max(4096).optional(),
  /** (DES-KNOWLEDGE-DATA-001 §5.1) Each tool's disclosure class, reviewed by a human operator. */
  disclosures: record(z.string().min(1).max(256), disclosureClass).refine((d) => Object.keys(d).length <= 512, { error: 'at most 512 tools' }).optional(),
});
export const PatchMcpServerSchema = z.strictObject({ enabled: z.boolean() });
export const PatchMcpToolSchema = z.strictObject({ enabled: z.boolean().optional(), classOverride: toolClass.nullable().optional(), disclosure: disclosureClass.nullable().optional() })
  .refine((p) => p.enabled !== undefined || p.classOverride !== undefined || p.disclosure !== undefined, { error: 'set enabled, classOverride, disclosure or a combination' });
/** Unknown query parameters (a cache-buster) are ignored, as they always were. */
export const McpServersQuerySchema = z.object({ view: z.enum(['full', 'agent']).optional() });
export const McpRegistryRestoreSchema = z.strictObject({ generation: z.int().min(1).max(Number.MAX_SAFE_INTEGER) });
export const PutMcpSecretSchema = z.strictObject({ value: secretValue });

export const McpCallSchema = z.strictObject({
  token: z.string().min(1).max(256),
  subject: z.string().min(1).max(512),
  args: record(z.string(), z.unknown()).optional(),
});
export const McpToolsSchema = z.strictObject({ token: z.string().min(1).max(256) });
export const McpPolicyPreviewSchema = z.strictObject({
  subject: z.string().min(1).max(256).optional(),
  server: serverName.optional(),
  phaseRole: z.enum(MCP_PREVIEW_ROLES as [string, ...string[]]).optional(),
  seat: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
  mode: z.enum(MCP_RUN_MODES as [string, ...string[]]).optional(),
  phaseId: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/).optional(),
})
  .refine((b) => b.subject === undefined || b.server === undefined, { error: 'give subject or server, not both' });
export const McpApprovalSchema = z.strictObject({ subject: z.string().min(5).max(256) });
export const McpUsageQuerySchema = z.strictObject({
  days: z.coerce.number().int().min(1).max(MCP_USAGE_MAX_DAYS).optional(),
  subject: z.string().min(1).max(512).optional(),
  seat: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
  decision: z.enum(MCP_USAGE_DECISIONS as [string, ...string[]]).optional(),
});

export interface McpRouteDeps {
  askServer?: AskServer;
  /** Absent = a directly-driven route set with no registry seam → 503. */
  registry?: McpRegistry;
  /** The broker's call path (S3). Absent → `POST /mcp/call` answers 503. */
  broker?: McpBroker;
  /** `Core.listMcpTools` for `POST /mcp/tools` (S4), read per request. Absent → that route answers 503. */
  toolLister?: () => ((requestJson: string) => Promise<string>) | null;
  /** (DES-CATALOG-002 §2.3) A fenced run's units are listed no tool (the `detect-shape` turn). */
  fence?: RunFence;
  /** (DES-KNOWLEDGE-DATA-001 §7) The data gate: live sources' tools, listed for a unit as their switches allow. */
  gate?: DataGate;
  /** The preview and approvals (S6). Absent → those routes answer 503; the S2 routes are unchanged. */
  policies?: McpPolicies;
  /** The call records the usage fold reads (S7). Absent → `GET /mcp/usage` answers 503. */
  usage?: McpCallRecordSource;
  /** The usage window's end; tests pin it. Default `Date.now`. */
  now?: () => number;
  audit: Pick<AuditLog, 'record'>;
  actorOf: (req: FastifyRequest) => Actor;
}

function invalidBody(reply: FastifyReply, err: z.ZodError): FastifyReply {
  return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
}

/** A ledger edit that failed part-way still changed rules: audit what it left changed. */
function auditPartial(deps: McpRouteDeps, req: FastifyRequest, err: unknown, subjects: string[]): void {
  if (!(err instanceof McpLedgerEditError) || err.changed.length === 0) return;
  deps.audit.record('mcp.approval.partial', deps.actorOf(req), { detail: { subjects, rules: err.changed } });
  for (const id of err.changed) deps.audit.record('governance.rule.upserted', deps.actorOf(req), { detail: { id, source: 'mcp-approval', partial: true } });
}

function fail(reply: FastifyReply, err: unknown, actor?: Actor): FastifyReply {
  if (err instanceof McpRegistryError) {
    // A source's own words go to a human only (DES-APPS-001 §5.2); an agent gets crew's sentence.
    const words = actor?.kind === 'human' && err.humanMessage !== undefined ? err.humanMessage : err.message;
    return reply.code(err.status).send({ error: words, code: err.code });
  }
  if (err instanceof McpRegistryCorruptError) return reply.code(503).send({ error: err.message, code: 'registry_corrupt' });
  if (err instanceof SecretStoreError) return reply.code(502).send({ error: err.message, code: 'secret_store_failed' });
  throw err;
}

/**
 * (G1, DES-data-connectors §3) Enabling a write tool is the operator's grant: a human operator
 * only, like an editor install (`editors/routes.ts`). Under `auth=off` every same-uid caller is the
 * local human actor, so this refuses a worker token; it is not a boundary against the local user.
 */
function mayGrantWrite(actor: Actor): boolean {
  return actor.kind === 'human' && trustAtLeast(actor, 'operator');
}

/** (DES-KNOWLEDGE-DATA-001 §5.2) The full view is a human actor's; every other actor gets the agent-safe one. */
const sees = viewOf;

/** A server answer as `actor` may see it. */
function serverFor(actor: Actor, server: McpServer): McpServer | McpServerAgentView {
  return sees(actor) === 'full' ? server : agentServerView(server);
}

function humanOperatorOnly(reply: FastifyReply, actor: Actor, what: string, code: string): FastifyReply {
  return reply.code(403).send({ error: `only a human operator can ${what}; you are ${actor.kind}/${actor.trust}`, code });
}

function writeGrantRefused(reply: FastifyReply, actor: Actor): FastifyReply {
  return reply.code(403).send({
    error: `only a human operator can enable a write tool (a write grant); you are ${actor.kind}/${actor.trust}`,
    code: 'write_grant_human_only',
  });
}

/** Whether a confirmation actually confirms something (a range, or plaintext). */
function confirmsAddress(address: { allow: string[]; plaintext?: boolean | undefined } | null | undefined): boolean {
  return address != null && (address.allow.length > 0 || address.plaintext === true);
}

function addressConfirmRefused(reply: FastifyReply, actor: Actor): FastifyReply {
  return reply.code(403).send({
    error: `only a human operator can confirm a loopback or private range (or plaintext) for a server's connections; you are ${actor.kind}/${actor.trust}`,
    code: 'address_confirm_human_only',
  });
}

/**
 * (crew#1316) Whether a preview names a secret the caller did not stage with it: an `env:` variable of the daemon,
 * or a keychain entry crew already holds (another server's, or this name's own saved one). The preview probes with
 * that secret, so it would go to a host the caller chose. A staged secret is the caller's own value, and the
 * registry pins it to this server's own keychain reference (`secret_not_staged_here`), so it is not one.
 */
function namesStoredSecret(body: { auth?: { ref: string } | null | undefined; secret?: string | undefined }): boolean {
  return body.auth != null && body.secret === undefined;
}

function storedSecretRefused(reply: FastifyReply, actor: Actor): FastifyReply {
  return reply.code(403).send({
    error: `only a human operator can preview a server with a secret crew already holds (an env: reference, or a keychain entry this preview did not stage); you are ${actor.kind}/${actor.trust}`,
    code: 'stored_secret_human_only',
  });
}

function egressConfirmRefused(reply: FastifyReply, actor: Actor): FastifyReply {
  return reply.code(403).send({
    error: `only a human operator can confirm where a rest server's calls go (allowOrigin); you are ${actor.kind}/${actor.trust}`,
    code: 'egress_confirm_human_only',
  });
}

function toConfig(body: z.infer<typeof McpServerConfigSchema>): McpUpstreamConfig {
  return {
    name: body.name,
    kind: body.kind,
    command: body.command ?? null,
    args: body.args ?? [],
    url: body.url ?? null,
    ...(body.pm !== undefined ? { pm: { system: body.pm.system } } : {}),
    ...(body.kind === 'rest'
      ? { openapiUrl: body.openapiUrl ?? null, openapi: body.openapi ?? null, operations: body.operations ?? null }
      : {}),
    ...(body.kind === 'sql' && body.sql !== undefined
      ? {
          sql: {
            driver: body.sql.driver,
            host: body.sql.host,
            port: body.sql.port ?? (body.sql.driver === 'postgres' ? 5432 : 3306),
            database: body.sql.database,
            user: body.sql.user,
            tls: body.sql.tls ?? 'verify-full',
            ...(body.sql.ca !== undefined ? { ca: body.sql.ca } : {}),
          },
          viewsAllowed: body.viewsAllowed ?? [],
        }
      : {}),
    // (DES-KNOWLEDGE-DATA-001 §5.1) The document as sent: the registry checks it against the deployment policy.
    ...(body.kind === 'toolbox-source' && body.toolbox !== undefined
      ? {
          entry: {
            toolbox: body.toolbox as unknown as ToolboxSourceEntry['toolbox'],
            runtime: body.runtime ?? 'native',
            tls: { mode: body.tls?.mode ?? 'verify-full', ca: body.tls?.ca ?? null },
            descriptorVersion: 2 as const,
            policyVersion: '',
          },
          viewsAllowed: body.viewsAllowed ?? [],
        }
      : {}),
    // A dialled server always carries its confirmation (none = global unicast over TLS only), so a
    // save stores it and a legacy record is the only one ever derived (registry.ts legacyAddress).
    ...(body.kind !== 'mcp-stdio'
      ? { address: body.address === undefined ? { ...NO_CONFIRMATION, allow: [] } : { allow: [...body.address.allow], plaintext: body.address.plaintext ?? false } }
      : {}),
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

/**
 * (DES-KNOWLEDGE-DATA-001 §5.5) The approval tokens a restore withdraws: an approval covers a tool's SAVED schema,
 * not its name. Every held token of a tool whose restored record is absent, was never saved (`schemaHash` null) or
 * was saved under another schema is withdrawn, with its server's own token (a server-wide approval cannot leave one
 * tool out); every token of a server the generation does not hold, or of a `rest` server whose target differs; and
 * every token naming a server the generation brings back that is not registered now (an orphan).
 */
export async function restoreWithdrawals(p: Pick<McpPolicies, 'tokensOf'>, current: readonly McpServer[], restored: readonly McpServerRecord[]): Promise<string[]> {
  const out = new Set<string>();
  for (const now of current) {
    const held = await p.tokensOf(now.name);
    if (held.length === 0) continue;
    const then = restored.find((x) => x.name === now.name);
    const targetChanged = then !== undefined && (now.kind === 'rest' || then.kind === 'rest') && canonicalJson(now.kind === 'rest' ? restTarget(now) : null) !== canonicalJson(then.kind === 'rest' ? restTarget(configOf(then)) : null);
    if (then === undefined || targetChanged) {
      for (const t of held) out.add(t);
      continue;
    }
    const changed = now.tools
      .filter((t) => {
        const was = then.tools.find((x) => x.name === t.name);
        return was === undefined || was.schemaHash === null || was.schemaHash !== t.schemaHash;
      })
      .map((t) => t.subject);
    const drop = new Set([...changed, ...(changed.length > 0 ? [`mcp:${now.name}`] : [])]);
    for (const t of held) if (drop.has(t)) out.add(t);
  }
  // codex r3: an approval naming a server that is not registered now covers nothing anyone reviewed; a restore that
  // brings the name back must not hand it to that registration.
  for (const then of restored) {
    if (current.some((c) => c.name === then.name)) continue;
    for (const t of await p.tokensOf(then.name)) out.add(t);
  }
  return [...out].sort();
}

export function registerMcpRoutes(app: FastifyInstance, deps: McpRouteDeps): void {
  // The MCP ask tool (streamable HTTP, stateless): worker-facing, the unit token in Authorization.
  app.post(`${V}/mcp/ask`, { config: { manifest: { statusCodes: [200, 401, 503] } } }, async (req, reply) => {
    if (deps.askServer === undefined) return reply.code(503).send({ error: 'ask_unsupported' });
    return deps.askServer.handle(req, reply);
  });
  app.route({
    method: ['GET', 'DELETE'],
    url: `${V}/mcp/ask`,
    config: { manifest: { statusCodes: [405] } },
    handler: async (_req, reply) => reply.code(405).header('Allow', 'POST').send({ error: 'method_not_allowed' }),
  });

  // (crew#993) A withdraw-then-change of one server's registration runs under the policies' lock
  // for that server, the one approve and revoke take. With no policies there are no approvals to race.
  const exclusive = <T>(name: string, fn: () => Promise<T>): Promise<T> => (deps.policies === undefined ? fn() : deps.policies.exclusive(name, fn));

  const registry = (reply: FastifyReply): McpRegistry | null => {
    if (deps.registry !== undefined) return deps.registry;
    void reply.code(503).send({ error: 'the MCP registry is not configured on this daemon', code: 'mcp_unavailable' });
    return null;
  };

  app.get(`${V}/mcp/servers`, { config: { manifest: { responseType: 'McpServersResponse | McpServersAgentResponse', statusCodes: [200, 400, 503] } } }, async (req, reply) => {
    const r = registry(reply);
    if (r === null) return reply;
    const q = McpServersQuerySchema.safeParse(req.query ?? {});
    if (!q.success) return invalidBody(reply, q.error);
    try {
      // (DES-KNOWLEDGE-DATA-001 §5.2, crew#1310) Connection fields are a human operator's: any other actor gets
      // the projection whatever it asks for.
      if (q.data.view === 'agent' || sees(deps.actorOf(req)) === 'agent') return { view: 'agent' as const, ...(await r.listForAgents()) };
      return await r.list();
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post(
    `${V}/mcp/servers/preview`,
    { config: { manifest: { requestType: 'McpServerConfigBody', responseType: 'McpPreviewResponse', statusCodes: [200, 400, 403, 409, 501, 502, 503] } } },
    async (req, reply) => {
      const r = registry(reply);
      if (r === null) return reply;
      const parsed = McpServerConfigSchema.safeParse(req.body);
      if (!parsed.success) return invalidBody(reply, parsed.error);
      const actor = deps.actorOf(req);
      // (DES-APPS-001 §5.2) The preview DIALS: a confirmed private range is used now, so only a
      // human operator may name one, here as at the save.
      if (confirmsAddress(parsed.data.address) && !mayGrantWrite(actor)) return addressConfirmRefused(reply, actor);
      // (crew#1316) It also PROBES with the secret `auth.ref` names: a secret crew already holds is a human operator's to send.
      if (namesStoredSecret(parsed.data) && !mayGrantWrite(actor)) return storedSecretRefused(reply, actor);
      // (DES-PM-001 §3) A PM source gains tracker links and the gate's bindings: only a person registers one, or
      // previews a save over one.
      const over = await r.get(parsed.data.name).catch(() => null);
      if ((parsed.data.pm !== undefined || over?.pm !== undefined) && !mayGrantWrite(actor)) return humanOperatorOnly(reply, actor, 'register a project-management source', 'pm_source_human_only');
      try {
        const full = await r.preview(toConfig(parsed.data), parsed.data.secret ?? null);
        // (DES-KNOWLEDGE-DATA-001 §5.2) A source's structure reaches an agent only through estate and the gate.
        const { source: described, ...rest } = full;
        const preview: McpPreviewResponse = sees(actor) === 'full' && described !== undefined ? { ...rest, source: described } : rest;
        if (deps.policies === undefined) return preview;
        let policies: McpPreviewResponse['policies'] = null;
        try {
          policies = await deps.policies.previewUnsaved(preview.server, preview.tools);
        } catch {
          policies = null; // the registry preview stands; the matrix is disclosed as unavailable
        }
        return { ...preview, policies };
      } catch (err) {
        return fail(reply, err, actor);
      }
    },
  );

  app.post(
    `${V}/mcp/servers`,
    { config: { manifest: { requestType: 'SaveMcpServerBody', responseType: 'McpServer | McpServerAgentView', statusCodes: [201, 400, 403, 409, 500, 502, 503] } } },
    async (req, reply) => {
      const r = registry(reply);
      if (r === null) return reply;
      const parsed = SaveMcpServerSchema.safeParse(req.body ?? {});
      if (!parsed.success) return invalidBody(reply, parsed.error);
      const enabledWrites = [...new Set(parsed.data.enabledWrites ?? [])];
      // A grant is refused before anything is withdrawn or saved.
      if (enabledWrites.length > 0 && !mayGrantWrite(deps.actorOf(req))) return writeGrantRefused(reply, deps.actorOf(req));
      // (G2) So is an egress confirmation from anyone but a human operator.
      const allowOrigin = parsed.data.allowOrigin ?? null;
      if (allowOrigin !== null && !mayGrantWrite(deps.actorOf(req))) return egressConfirmRefused(reply, deps.actorOf(req));
      // (DES-KNOWLEDGE-DATA-001 §5.1) So is a review of what a tool discloses.
      const disclosures = parsed.data.disclosures ?? {};
      if (Object.keys(disclosures).length > 0 && !mayGrantWrite(deps.actorOf(req))) return humanOperatorOnly(reply, deps.actorOf(req), 'review what a tool discloses', 'disclosure_review_human_only');
      try {
        // A saved tool whose schema changed loses its approvals BEFORE the save lands, so a failed
        // withdrawal refuses the save rather than leaving an approval over a schema nobody approved.
        // A grant that does not fit the preview is refused BEFORE any approval is withdrawn.
        if (parsed.data.previewHash !== undefined) {
          await r.checkWriteGrants(parsed.data.previewHash, enabledWrites);
          // (G2) An unconfirmed egress is refused before any approval is withdrawn, too.
          await r.checkEgress(parsed.data.previewHash, allowOrigin);
          r.checkDisclosures(parsed.data.previewHash, disclosures);
        }
        const held = parsed.data.previewHash === undefined ? null : r.peekPreview(parsed.data.previewHash);
        // The confirmation rides in the previewed config; saving it is the human operator's, too.
        if (held !== null && confirmsAddress(held.address) && !mayGrantWrite(deps.actorOf(req))) return addressConfirmRefused(reply, deps.actorOf(req));
        if (held !== null && held.pm != null && !mayGrantWrite(deps.actorOf(req))) return humanOperatorOnly(reply, deps.actorOf(req), 'register a project-management source', 'pm_source_human_only');
        const commit = async (): Promise<McpServer> => {
          if (held !== null && deps.policies !== undefined) {
            const tokens = await deps.policies.withdrawnBySave(held);
            if (tokens.length > 0) {
              const rules = await deps.policies.withdraw(tokens).catch((e: unknown) => { auditPartial(deps, req, e, tokens); throw e; });
              deps.audit.record('mcp.approval.withdrawn', deps.actorOf(req), { detail: { subjects: tokens, rules, why: 'schema_changed' } });
              for (const id of rules) deps.audit.record('governance.rule.upserted', deps.actorOf(req), { detail: { id, source: 'mcp-approval' } });
            }
          }
          return r.save(parsed.data.previewHash, enabledWrites, allowOrigin, disclosures);
        };
        // (crew#993) The withdrawal and the save are one step for the server: an approval for it
        // waits until the save commits, then is judged against the new registration. With no held
        // preview the save refuses (409) and nothing is withdrawn, so there is nothing to serialize.
        const server = held === null ? await commit() : await exclusive(held.name, commit);
        deps.audit.record('mcp.server.saved', deps.actorOf(req), {
          detail: {
            name: server.name,
            kind: server.kind,
            tools: server.tools.length,
            authRef: server.auth?.ref ?? null,
            // G1: the write tools this save left off, so the record says what was not granted.
            disabledWrites: server.tools.filter((t) => t.status !== 'gone' && !t.enabled && isWriteGrant(t.annotations, t.classOverride)).map((t) => t.subject),
          },
        });
        if (held !== null && confirmsAddress(held.address)) {
          deps.audit.record('mcp.server.address_confirmed', deps.actorOf(req), { detail: { name: server.name, kind: server.kind, allow: held.address?.allow ?? [], plaintext: held.address?.plaintext ?? false } });
        }
        // Audited whenever the operator named the origin: the save accepted it, so it is the origin.
        if (allowOrigin !== null && held?.egress != null) {
          const e = held.egress;
          deps.audit.record('mcp.server.egress_confirmed', deps.actorOf(req), { detail: { name: server.name, origin: e.origin, basePath: e.basePath, matches: e.matches, privateAddress: e.privateAddress, resolved: e.resolved, servers: e.servers } });
        }
        for (const name of enabledWrites) {
          const tool = server.tools.find((t) => t.name === name);
          if (tool === undefined) continue;
          deps.audit.record('mcp.tool.write_granted', deps.actorOf(req), { detail: { subject: tool.subject, class: tool.class, via: 'save' } });
        }
        for (const [name, disclosure] of Object.entries(disclosures)) {
          const tool = server.tools.find((t) => t.name === name);
          if (tool !== undefined) deps.audit.record('mcp.tool.disclosure_reviewed', deps.actorOf(req), { detail: { subject: tool.subject, disclosure, via: 'save' } });
        }
        return reply.code(201).send(serverFor(deps.actorOf(req), server));
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.patch<{ Params: { name: string } }>(
    `${V}/mcp/servers/:name`,
    { config: { manifest: { requestType: 'PatchMcpServerBody', responseType: 'McpServer | McpServerAgentView', statusCodes: [200, 400, 403, 404, 503] } } },
    async (req, reply) => {
      const r = registry(reply);
      if (r === null) return reply;
      const parsed = PatchMcpServerSchema.safeParse(req.body);
      if (!parsed.success) return invalidBody(reply, parsed.error);
      try {
        // (DES-PM-001 §3) Switching a PM source on or off changes what its links reach: a person's only. Judged and
        // done inside the server's lock, so a save that makes the name a PM source cannot slip between.
        const actor = deps.actorOf(req);
        const server = await exclusive(req.params.name, async () => {
          if ((await r.get(req.params.name)).pm !== undefined && !mayGrantWrite(actor)) return null;
          return r.setServerEnabled(req.params.name, parsed.data.enabled);
        });
        if (server === null) return humanOperatorOnly(reply, actor, 'switch a project-management source on or off', 'pm_source_human_only');
        deps.audit.record(parsed.data.enabled ? 'mcp.server.enabled' : 'mcp.server.disabled', deps.actorOf(req), { detail: { name: server.name } });
        return serverFor(deps.actorOf(req), server);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.delete<{ Params: { name: string } }>(
    `${V}/mcp/servers/:name`,
    { config: { manifest: { responseType: '{ removed: string }', statusCodes: [200, 403, 404, 500, 502, 503] } } },
    async (req, reply) => {
      const r = registry(reply);
      if (r === null) return reply;
      try {
        // (crew#993) One step for the server, like the save: no approval lands between the
        // withdrawal and the removal.
        let refused = false;
        await exclusive(req.params.name, async () => {
          // (DES-PM-001 §3.2, Q-PM5) Removing a PM source drops its links, and the last GitHub one would hand `#N` back
          // to the daemon's own `gh`: a person's only. Judged on the record being removed, inside the server's lock.
          if ((await r.get(req.params.name)).pm !== undefined && !mayGrantWrite(deps.actorOf(req))) {
            refused = true;
            return;
          }
          if (deps.policies !== undefined) {
            const tokens = await deps.policies.tokensOf(req.params.name);
            if (tokens.length > 0) {
              const rules = await deps.policies.withdraw(tokens).catch((e: unknown) => { auditPartial(deps, req, e, tokens); throw e; });
              deps.audit.record('mcp.approval.withdrawn', deps.actorOf(req), { detail: { subjects: tokens, rules, why: 'server_removed' } });
              for (const id of rules) deps.audit.record('governance.rule.upserted', deps.actorOf(req), { detail: { id, source: 'mcp-approval' } });
            }
          }
          await r.remove(req.params.name);
        });
        if (refused) return humanOperatorOnly(reply, deps.actorOf(req), 'remove a project-management source', 'pm_source_human_only');
        deps.audit.record('mcp.server.removed', deps.actorOf(req), { detail: { name: req.params.name } });
        return { removed: req.params.name };
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.post<{ Params: { name: string } }>(
    `${V}/mcp/servers/:name/test`,
    { config: { manifest: { responseType: 'McpServerTestResponse | McpServerTestAgentResponse', statusCodes: [200, 404, 409, 503] } } },
    async (req, reply) => {
      const r = registry(reply);
      if (r === null) return reply;
      try {
        const t: McpServerTestResponse = await r.test(req.params.name);
        if (sees(deps.actorOf(req)) === 'full') return t;
        // A probe's error can name the host it could not reach: an agent gets that it failed.
        const agentAnswer: McpServerTestAgentResponse = { ok: t.ok, error: t.error === null ? null : 'the probe failed', diff: t.diff, server: agentServerView(t.server) };
        return agentAnswer;
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.patch<{ Params: { subject: string } }>(
    `${V}/mcp/tools/:subject`,
    { config: { manifest: { requestType: 'PatchMcpToolBody', responseType: 'McpTool', statusCodes: [200, 400, 403, 404, 503] } } },
    async (req, reply) => {
      const r = registry(reply);
      if (r === null) return reply;
      const parsed = PatchMcpToolSchema.safeParse(req.body);
      if (!parsed.success) return invalidBody(reply, parsed.error);
      try {
        const actor = deps.actorOf(req);
        const { tool, grantedWrite } = await r.patchTool(req.params.subject, parsed.data, { mayGrantWrite: mayGrantWrite(actor), mayReviewDisclosure: mayGrantWrite(actor) });
        deps.audit.record('mcp.tool.updated', actor, { detail: { subject: tool.subject, ...parsed.data } });
        if (grantedWrite) {
          deps.audit.record('mcp.tool.write_granted', actor, { detail: { subject: tool.subject, class: tool.class, via: 'toggle' } });
        }
        if (parsed.data.disclosure !== undefined) deps.audit.record('mcp.tool.disclosure_reviewed', actor, { detail: { subject: tool.subject, disclosure: parsed.data.disclosure, via: 'patch' } });
        return tool;
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // The broker (§6). The body carries a worker's arguments: a malformed one is refused without
  // echoing any of it, and nothing of the body is logged or audited (the call record is the record).
  // WORKER-FACING (crew#714): this route and `POST /mcp/tools` below are the two the bearer
  // boundary exempts (`isUnitTokenRoute`, src/api/auth.ts) — a worker holds no operator bearer,
  // and the body's capability token is judged by the engine on every call (401 `invalid_token`).
  // Nothing here reads `req.actor`; keep it that way.
  app.post(
    `${V}/mcp/call`,
    { config: { manifest: { requestType: 'McpCallBody', responseType: 'McpCallResponse', statusCodes: [200, 400, 401, 403, 409, 429, 500, 502, 503, 504] } } },
    async (req, reply) => {
      if (deps.broker === undefined) return reply.code(503).send({ error: 'the MCP broker is not configured on this daemon', code: 'mcp_unavailable' });
      const parsed = McpCallSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: `body: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'body'} ${i.code}`).join('; ')}`, code: 'bad_request' });
      }
      const answer = await deps.broker.call({
        token: parsed.data.token,
        subject: parsed.data.subject,
        ...(parsed.data.args !== undefined ? { args: parsed.data.args } : {}),
      });
      return reply.code(answer.status).send(answer.body);
    },
  );

  // The unit's tool list (S4). Like the call, the token travels in the body so it never reaches a
  // request log, and nothing of the body is logged or audited. WORKER-FACING, bearer-exempt like
  // the call above (crew#714): the engine's `listMcpTools` judges the token, not an actor.
  app.post(
    `${V}/mcp/tools`,
    { config: { manifest: { requestType: 'McpToolsBody', responseType: 'McpToolsResponse', statusCodes: [200, 400, 401, 500, 503] } } },
    async (req, reply) => {
      const registry = deps.registry;
      const toolLister = deps.toolLister;
      if (registry === undefined || toolLister === undefined) {
        return reply.code(503).send({ error: 'the MCP registry is not configured on this daemon', code: 'mcp_unavailable' });
      }
      const parsed = McpToolsSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: `body: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'body'} ${i.code}`).join('; ')}`, code: 'bad_request' });
      }
      const answer = await listUnitTools({ registry, lister: toolLister, ...(deps.gate !== undefined ? { gate: deps.gate } : {}), ...(deps.fence !== undefined ? { fence: deps.fence } : {}) }, parsed.data.token);
      return reply.code(answer.status).send(answer.body);
    },
  );

  // (crew#719) RE-KEY only: the server must already be registered and already reference this
  // keychain entry. A NEW server's secret is staged with its preview (`secret` on the preview
  // body) and committed by the save, so the two can no longer half-land.
  app.put<{ Params: { name: string } }>(
    `${V}/mcp/servers/:name/secret`,
    {
      config: { manifest: { requestType: 'PutMcpSecretBody', responseType: 'McpSecretResponse', statusCodes: [200, 400, 403, 404, 501, 502, 503] } },
    },
    async (req, reply) => {
      const r = registry(reply);
      if (r === null) return reply;
      const name = serverName.safeParse(req.params.name);
      if (!name.success) return invalidBody(reply, name.error);
      const parsed = PutMcpSecretSchema.safeParse(req.body);
      if (!parsed.success) return invalidBody(reply, parsed.error);
      try {
        // (DES-PM-001 §5) A PM source's credential is the identity its approved actions post as: a person re-keys it.
        // Judged and written inside the server's lock, so a save that makes the name a PM source cannot slip between.
        const actor = deps.actorOf(req);
        const ref = await exclusive(name.data, async () => {
          // An unknown name is setSecret's to answer (its own refusals come first, as before).
          if ((await r.get(name.data).catch(() => null))?.pm !== undefined && !mayGrantWrite(actor)) return null;
          return r.setSecret(name.data, parsed.data.value);
        });
        if (ref === null) return humanOperatorOnly(reply, actor, "re-key a project-management source's credential", 'pm_source_human_only');
        deps.audit.record('mcp.secret.set', deps.actorOf(req), { detail: { name: name.data, ref } });
        return { ref, set: true as const };
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // ── DES-KNOWLEDGE-DATA-001 §5.5: generations and a fail-closed restore ───────────────────────

  app.get(
    `${V}/mcp/registry/generations`,
    { config: { manifest: { responseType: 'McpRegistryGenerationsResponse', statusCodes: [200, 403, 503] } } },
    async (req, reply) => {
      const actor = deps.actorOf(req);
      if (!mayGrantWrite(actor)) return humanOperatorOnly(reply, actor, "read the registry's generations", 'human_only');
      const r = registry(reply);
      if (r === null) return reply;
      try {
        return await r.generations();
      } catch (err) {
        return fail(reply, err, actor);
      }
    },
  );

  app.post(
    `${V}/mcp/registry/restore`,
    { config: { manifest: { requestType: 'McpRegistryRestoreBody', responseType: 'McpRegistryRestoreResponse', statusCodes: [200, 400, 403, 404, 409, 500, 503] } } },
    async (req, reply) => {
      const actor = deps.actorOf(req);
      if (!mayGrantWrite(actor)) return humanOperatorOnly(reply, actor, 'restore the registry', 'restore_human_only');
      const r = registry(reply);
      if (r === null) return reply;
      const parsed = McpRegistryRestoreSchema.safeParse(req.body);
      if (!parsed.success) return invalidBody(reply, parsed.error);
      const generation = parsed.data.generation;
      try {
        // ONE snapshot, read and validated before anything changes: a restore that is refused (unknown, unreadable,
        // a document the policy refuses) withdraws nothing, and a generation pruned meanwhile cannot fail it half-way.
        const plan = await r.planRestore(generation);
        const p = deps.policies;
        const planned = plan.servers.map((s) => s.name);
        // (crew#993) The withdrawal and the commit are one step for EVERY server they touch: each server's lock, in
        // name order (every other holder takes one lock, so the order cannot deadlock), so no approval, save or
        // removal of those servers lands between them. A server registered while the locks were being taken is not
        // covered: then nothing is done, and the locks are taken again over the larger set (codex r2).
        const locked = <T>(names: readonly string[], fn: () => Promise<T>): Promise<T> => (p === undefined ? fn() : names.reduceRight<() => Promise<T>>((inner, name) => () => p.exclusive(name, inner), fn)());
        let names = [...new Set([...(await r.list()).servers.map((s) => s.name), ...planned])].sort();
        let done: { out: Awaited<ReturnType<McpRegistry['restore']>>; withdrawn: string[] } | null = null;
        for (let attempt = 0; attempt < 3 && done === null; attempt++) {
          const held = names;
          done = await locked(held, async () => {
            const now = (await r.list()).servers;
            const wider = now.map((s) => s.name).filter((n) => !held.includes(n));
            if (wider.length > 0) {
              names = [...new Set([...held, ...wider])].sort();
              return null;
            }
            let withdrawn: string[] = [];
            if (p !== undefined) {
              withdrawn = await restoreWithdrawals(p, now, plan.servers);
              if (withdrawn.length > 0) {
                let rules: string[];
                try {
                  rules = await p.withdraw(withdrawn);
                } catch (err) {
                  auditPartial(deps, req, err, withdrawn);
                  throw new McpRegistryError(500, 'withdraw_failed', `the registry was not restored: approvals that generation ${generation} does not cover could not be withdrawn (${err instanceof Error ? err.message : String(err)})`);
                }
                deps.audit.record('mcp.approval.withdrawn', actor, { detail: { subjects: withdrawn, rules, why: 'registry_restored' } });
                for (const id of rules) deps.audit.record('governance.rule.upserted', actor, { detail: { id, source: 'mcp-approval' } });
              }
            }
            return { out: await r.restore(plan, held), withdrawn };
          });
        }
        if (done === null) throw new McpRegistryError(409, 'registry_busy', 'servers kept being registered while the restore was taking their locks; nothing was restored: try again');
        const { out, withdrawn } = done;
        const body: McpRegistryRestoreResponse = { ...out, withdrawnApprovals: withdrawn };
        deps.audit.record('mcp.registry.restored', actor, { detail: { restored: generation, generation: out.generation, servers: out.servers, disabled: out.disabled, queryReset: out.queryReset, writesReset: out.writesReset, withdrawnApprovals: withdrawn } });
        return body;
      } catch (err) {
        return fail(reply, err, actor);
      }
    },
  );

  // ── S6: the policy preview and the approvals ────────────────────────────────────────────────
  const policies = (reply: FastifyReply): McpPolicies | null => {
    if (deps.registry !== undefined && deps.policies !== undefined) return deps.policies;
    void reply.code(503).send({ error: 'MCP policies are not configured on this daemon', code: 'mcp_unavailable' });
    return null;
  };

  app.post(
    `${V}/mcp/policies/preview`,
    { config: { manifest: { requestType: 'McpPolicyPreviewBody', responseType: 'McpPolicyPreviewResponse', statusCodes: [200, 400, 404, 501, 502, 503] } } },
    async (req, reply) => {
      const p = policies(reply);
      if (p === null) return reply;
      const parsed = McpPolicyPreviewSchema.safeParse(req.body ?? {});
      if (!parsed.success) return invalidBody(reply, parsed.error);
      try {
        const b = parsed.data;
        return await p.preview({
          subject: b.subject,
          server: b.server,
          phaseRole: b.phaseRole as McpPolicyQueryRole,
          seat: b.seat,
          mode: b.mode as McpPolicyQueryMode,
          phaseId: b.phaseId,
        });
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.get(
    `${V}/mcp/approvals`,
    { config: { manifest: { responseType: 'McpApprovalsResponse', statusCodes: [200, 503] } } },
    async (_req, reply) => {
      const p = policies(reply);
      if (p === null) return reply;
      try {
        return await p.approvals();
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.post(
    `${V}/mcp/approvals`,
    { config: { manifest: { requestType: 'McpApprovalBody', responseType: 'McpApprovalResponse', statusCodes: [200, 400, 404, 503] } } },
    async (req, reply) => {
      const p = policies(reply);
      if (p === null) return reply;
      const parsed = McpApprovalSchema.safeParse(req.body);
      if (!parsed.success) return invalidBody(reply, parsed.error);
      try {
        const subject = parsed.data.subject;
        const rules = await p.approve(subject).catch((e: unknown) => { auditPartial(deps, req, e, [subject]); throw e; });
        deps.audit.record('mcp.approval.granted', deps.actorOf(req), { detail: { subject, rules } });
        for (const id of rules) deps.audit.record('governance.rule.upserted', deps.actorOf(req), { detail: { id, source: 'mcp-approval' } });
        const body: McpApprovalResponse = { subject, approved: true, rulesChanged: rules };
        return body;
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.delete<{ Params: { subject: string } }>(
    `${V}/mcp/approvals/:subject`,
    { config: { manifest: { responseType: 'McpApprovalResponse', statusCodes: [200, 400, 404, 503] } } },
    async (req, reply) => {
      const p = policies(reply);
      if (p === null) return reply;
      try {
        const subject = req.params.subject;
        const rules = await p.revoke(subject).catch((e: unknown) => { auditPartial(deps, req, e, [subject]); throw e; });
        deps.audit.record('mcp.approval.revoked', deps.actorOf(req), { detail: { subject, rules } });
        for (const id of rules) deps.audit.record('governance.rule.upserted', deps.actorOf(req), { detail: { id, source: 'mcp-approval' } });
        const body: McpApprovalResponse = { subject, approved: false, rulesChanged: rules };
        return body;
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // ── S7: the usage fold over the call records ────────────────────────────────────────────────
  app.get(
    `${V}/mcp/usage`,
    { config: { manifest: { responseType: 'McpUsageResponse', statusCodes: [200, 400, 503] } } },
    async (req, reply) => {
      if (deps.usage === undefined) {
        return reply.code(503).send({ error: 'MCP usage is not configured on this daemon', code: 'mcp_unavailable' });
      }
      const parsed = McpUsageQuerySchema.safeParse(req.query ?? {});
      if (!parsed.success) return invalidBody(reply, parsed.error);
      const q = parsed.data;
      const now = (deps.now ?? Date.now)();
      let read: Awaited<ReturnType<McpCallRecordSource['read']>>;
      try {
        read = await deps.usage.read(now);
      } catch (err) {
        return reply.code(503).send({ error: `the MCP call records could not be read: ${err instanceof Error ? err.message : String(err)}`, code: 'records_unreadable' });
      }
      const body: McpUsageResponse = foldMcpUsage(
        read.records,
        {
          days: q.days ?? MCP_USAGE_DEFAULT_DAYS,
          ...(q.subject !== undefined ? { subject: q.subject } : {}),
          ...(q.seat !== undefined ? { seat: q.seat } : {}),
          ...(q.decision !== undefined ? { decision: q.decision as McpCallDecision } : {}),
        },
        now,
        read.skipped,
      );
      return body;
    },
  );
}

type McpPolicyQueryRole = import('../mcp/policies.js').McpPolicyQuery['phaseRole'];
type McpPolicyQueryMode = import('../mcp/policies.js').McpPolicyQuery['mode'];
