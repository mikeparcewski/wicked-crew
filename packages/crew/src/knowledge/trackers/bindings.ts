/**
 * Resource bindings with response projectors (DES-PM-001 §3.1): what keeps every agent call to a PM system's own MCP
 * server inside the unit's linked set L(u, S), whatever the credential can reach.
 *
 * One credential usually reads every project on a Jira site, and often several sites; a GitHub token reads every repo
 * its owner can. So a source-level switch is not enough. For each PM tool crew knows, a binding says:
 *
 * - `bindArgs`: which arguments name the tenant and the project or repo. The gate SETS the tenant itself (Jira's
 *   `cloudId`; GitHub's host is the server's), and REWRITES or REFUSES the project argument so it stays inside L:
 *   a key must be a linked key, a repo a linked repo; a JQL query gets `project in (<linked keys>) AND (<jql>)`; a
 *   GitHub issue search gets the linked `repo:` qualifiers when it names none, and is refused when it names another.
 *   Arguments a binding does not name are dropped, never sent (an allowlist). JQL functions such as
 *   `projectsLeadByUser()` cannot be judged without a full parser, so the rewrite is defence in depth only.
 * - `project`: the RESPONSE PROJECTOR, which is the boundary. The answer is rebuilt from admitted items only: an item
 *   whose identity (the Jira issue key's project on the tenant crew set; a GitHub `html_url`'s owner/repo) is outside
 *   L is dropped; totals are recomputed from what was admitted, pagination is kept only when nothing was dropped,
 *   every other field is left out unless the binding keeps it, and an answer whose shape the projector does not know
 *   is refused. Text and structured copies are never passed through: the one answer is built from the items.
 *
 * A tool with no binding here (Rovo `search`, `executeRead`, Confluence, Teamwork Graph, every write, `get_me`, …) is
 * unavailable to agents. Jira's account metadata (`atlassianUserInfo`, `getAccessibleAtlassianResources`) is bound as
 * `structure`: the account id, and the sites of the linked trackers only.
 * Vendor text (titles, bodies, comments, labels) is untrusted: it rides inside the gate's envelope as data.
 */

import type { PmSystem, ToolBinding } from '../registry/entry.js';

/** One tracker of L(u, S): a linked (tenant, key) of one source. */
export interface LinkedTracker {
  trackerId: string;
  tenant: string;
  key: string;
  /** Jira: the site's host (`acme.atlassian.net`), confirmed at link time; an issue's own address must name it. */
  siteHost?: string | null;
}

/** Bumped when a binding's rules change: stored bindings of an older version are no longer in force. */
export const BINDING_POLICY_VERSION = 1;

/** A unit asks for at most this many issues per call. */
export const PM_PAGE_MAX = 50;
/** An issue body, a description or a comment is cut to this many characters. */
export const PM_TEXT_MAX = 6_000;
/** At most this many comments per issue are kept. */
export const PM_COMMENTS_MAX = 20;

export type Prepared =
  | { ok: true; args: Record<string, unknown>; tenant: string; trackers: LinkedTracker[] }
  | { ok: false; code: string; reason: string };

/** One admitted item: the tracker it belongs to, its reference (`PROJA-1`, `owner/repo#42`) and the kept fields. */
export interface PmItem {
  trackerId: string;
  ref: string;
  value: Record<string, unknown>;
}

export type Projected = { ok: true; items: PmItem[]; next: string | null } | { ok: false; code: string; reason: string };

/**
 * What the projector may lean on besides the answer itself (see {@link jiraAdmit}): `vendorBindsTenant`, the entry talks
 * to the vendor's own server (`https://mcp.atlassian.com`), which runs each call against the `cloudId` crew set; and
 * `soleSite`, the one site the entry's credential reaches, read from the vendor just now (`null`: several, or unknown).
 */
export interface ProjectOpts {
  vendorBindsTenant?: boolean;
  soleSite?: string | null;
}

/** Whether an item without an address may be admitted on the tenant crew bound (both conditions of {@link ProjectOpts}). */
const tenantProves = (opts: ProjectOpts | undefined, tenant: string): boolean => opts?.vendorBindsTenant === true && typeof opts.soleSite === 'string' && opts.soleSite === tenant;

export interface PmToolBinding {
  system: PmSystem;
  tool: string;
  /** What the answer discloses: issue content is `rows` (needs "query"); account metadata is `structure` ("see"). */
  disclosure: 'rows' | 'structure';
  bindArgs(args: Record<string, unknown>, linked: readonly LinkedTracker[]): Prepared;
  project(result: Record<string, unknown>, prepared: Extract<Prepared, { ok: true }>, opts?: ProjectOpts): Projected;
}

/** The Atlassian vendor server's origin: the only one whose answers may prove a site by the `cloudId` crew bound. */
export const ATLASSIAN_MCP_ORIGIN = 'https://mcp.atlassian.com';

/** Whether an entry's server is Atlassian's own remote MCP server (an https `mcp-http` entry on its origin). */
export function vendorBindsTenant(config: { kind: string; url?: string | null }, system: PmSystem): boolean {
  if (system !== 'jira' || config.kind !== 'mcp-http' || typeof config.url !== 'string') return false;
  try {
    const u = new URL(config.url);
    return u.origin === ATLASSIAN_MCP_ORIGIN && u.username === '' && u.password === '';
  } catch {
    return false;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const refuse = (code: string, reason: string): { ok: false; code: string; reason: string } => ({ ok: false, code, reason });

/** Vendor text as kept: control characters out (newlines stay), cut to `max`. */
export function vendorText(v: unknown, max = PM_TEXT_MAX): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
  return t.length <= max ? t : `${t.slice(0, max)}… (cut at ${max} characters)`;
}

/** The text of an Atlassian document (ADF): its `text` nodes in order, paragraphs on their own lines. No attrs, no URLs. */
export function adfText(doc: unknown, max = PM_TEXT_MAX): string | null {
  if (typeof doc === 'string') return vendorText(doc, max);
  if (!isObj(doc)) return null;
  const out: string[] = [];
  let len = 0;
  const walk = (n: unknown, depth: number): void => {
    if (len > max || depth > 64 || !isObj(n)) return;
    if (n['type'] === 'text' && typeof n['text'] === 'string') {
      out.push(n['text']);
      len += n['text'].length;
    }
    if (n['type'] === 'hardBreak') out.push('\n');
    if (Array.isArray(n['content'])) {
      for (const c of n['content']) {
        if (len > max) break;
        walk(c, depth + 1);
      }
    }
    if (n['type'] === 'paragraph' || n['type'] === 'heading' || n['type'] === 'listItem') out.push('\n');
  };
  walk(doc, 0);
  return vendorText(out.join('').replace(/\n{3,}/g, '\n\n').trim(), max);
}

/**
 * The Atlassian v2 server wraps an answer as `{data: …}`, sometimes with metadata beside it (`appliedContentFormat`,
 * `context`): the payload is what `data` holds. Anything else is its own payload. Siblings are dropped, never read:
 * every projector rebuilds its answer from the items it admits.
 */
export function unwrapData(p: unknown): unknown {
  if (!isObj(p) || !('data' in p) || isErrorEnvelope(p)) return p;
  return isObj(p['data']) || Array.isArray(p['data']) ? p['data'] : p;
}

/**
 * The field names an outline may print: the schema of the answers crew reads (MCP, Atlassian v2 and REST, GitHub). Any
 * other key may be vendor data (a custom field's label, a customer's name, an issue key), so it is only counted.
 */
const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'content', 'type', 'text', 'isError', 'structuredContent', 'data', 'error', 'message', 'statusCode', 'status', 'errorMessages', 'errors', 'context', 'appliedContentFormat',
  'resources', 'sites', 'accessibleResources', 'cloudId', 'id', 'url', 'name', 'products', 'access', 'scopes', 'avatarUrl', 'accountId', 'account_id',
  'issues', 'nodes', 'totalCount', 'total', 'remainingCount', 'pageInfo', 'hasNextPage', 'endCursor', 'isLast', 'nextPageToken', 'startAt', 'maxResults', 'values', 'projects',
  'key', 'self', 'webUrl', 'fields', 'summary', 'description', 'issuetype', 'priority', 'assignee', 'reporter', 'labels', 'created', 'updated', 'project', 'statusCategory', 'customFields', 'attachment', 'comment',
  'comments', 'author', 'body', 'displayName', 'visibility', 'jsdPublic', 'parentId', 'issueKey', 'issueId', 'transitions', 'to',
  'items', 'total_count', 'incomplete_results', 'number', 'title', 'state', 'html_url', 'user', 'login', 'full_name', 'result', 'results', 'warnings',
]);
const BLOCK_TYPES: ReadonlySet<string> = new Set(['text', 'image', 'audio', 'resource', 'resource_link']);
const OUTLINE_MAX = 700;
const cap = (s: string): string => (s.length <= OUTLINE_MAX ? s : `${s.slice(0, OUTLINE_MAX)}…`);

/**
 * The value-free outline of a JSON value, for a diagnosis: its type, its plain field names and array lengths, a few
 * levels deep. Never a value: a string is `string`, a number `number`, and a key that is not a plain field name is
 * only counted.
 */
export function outlineOf(v: unknown, depth = 3): string {
  return cap(outline(v, depth));
}

function outline(v: unknown, depth: number): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array(${v.length})${v.length > 0 && depth > 0 ? `[${outline(v[0], depth - 1)}]` : ''}`;
  if (typeof v !== 'object') return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? typeof v : 'other';
  const keys = Object.keys(v);
  const shown = keys.filter((k) => KNOWN_KEYS.has(k)).slice(0, 12);
  const more = keys.length - shown.length;
  const parts = shown.map((k) => (depth > 0 ? `${k}:${outline((v as Record<string, unknown>)[k], depth - 1)}` : k));
  if (more > 0) parts.push(`+${more} other key${more === 1 ? '' : 's'}`);
  // Bounded as it is built: a wide tree stops growing once the outline is longer than any reason shows.
  const out = `object{${parts.join(',')}}`;
  return out.length <= OUTLINE_MAX * 2 ? out : `${out.slice(0, OUTLINE_MAX * 2)}…}`;
}

/** The value-free outline of a whole tool result: its error flag, its content blocks (type; JSON outline or text length). */
export function resultOutline(result: unknown): string {
  if (!isObj(result)) return `result: ${outlineOf(result, 0)}`;
  const parts: string[] = [];
  if (result['isError'] !== undefined) parts.push(`isError ${result['isError'] === true ? 'true' : 'false'}`);
  const content = result['content'];
  if (!Array.isArray(content)) parts.push(`content ${content === undefined ? 'absent' : outlineOf(content, 0)}`);
  else {
    const blocks = content.slice(0, 4).map((c) => {
      if (!isObj(c)) return outlineOf(c, 0);
      const type = typeof c['type'] === 'string' && BLOCK_TYPES.has(c['type']) ? c['type'] : 'other';
      if (type !== 'text') return type;
      const text = typeof c['text'] === 'string' ? c['text'] : null;
      if (text === null) return 'text without text';
      try {
        return `text JSON ${outlineOf(JSON.parse(text) as unknown)}`;
      } catch {
        return `text, not JSON (${text.length} chars)`;
      }
    });
    parts.push(`content ${content.length} block${content.length === 1 ? '' : 's'}: [${blocks.join('; ')}${content.length > 4 ? '; …' : ''}]`);
  }
  parts.push(`structuredContent ${result['structuredContent'] === undefined ? 'absent' : 'present (not read)'}`);
  return cap(parts.join(', '));
}

/** `{"error": true, "message", "statusCode"}` (the Atlassian server, often without `isError`) or Jira's `{errorMessages}`. */
function isErrorEnvelope(p: unknown): p is Record<string, unknown> {
  if (!isObj(p)) return false;
  // An error beside data is an error: a contradictory answer is not read as a success.
  if (p['error'] === true || isObj(p['error'])) return true;
  // Jira's own error shape dominates whatever else the answer carries.
  return Array.isArray(p['errorMessages']) && p['errorMessages'].length > 0;
}

/**
 * The Atlassian scopes crew may repeat from an error (a fixed, vetted set): any other word of the vendor's sentence,
 * scope-shaped or not, is not repeated.
 */
const SCOPES: ReadonlySet<string> = new Set([
  'read:me', 'read:account', 'offline_access', 'read:jira-work', 'write:jira-work', 'read:jira-user', 'manage:jira-project', 'manage:jira-configuration',
  'read:jira:agent-interface', 'search:jira:agent-interface', 'write:jira:agent-interface', 'read:servicedesk-request', 'write:servicedesk-request',
  'read:page:confluence', 'write:page:confluence', 'read:space:confluence', 'search:confluence', 'read:confluence-user', 'read:comment:confluence', 'write:comment:confluence',
]);

/**
 * Atlassian's fixed words when it cannot resolve the sites an API token reaches (atlassian-mcp-server#285): matched,
 * never repeated, and read so only on a Jira source's in-band 401 (a 429 or 500 with the same words is not a scope
 * problem). Its v2 server resolves them for every site-scoped call under token sign-in, whatever `cloudId` says, and
 * a scoped token needs `read:account` for it (Atlassian's answer on #285).
 */
const NO_SITES = /^Failed to fetch accessible products\b/i;

/**
 * What an error answer may say: its HTTP status, and the scopes the vendor says are missing (each checked to be a
 * scope name), or what Atlassian's fixed "no sites" words mean. The vendor's other words are not shown: they can echo
 * a request. Atlassian's advice is given only for a Jira source (`system`); any other gets the vendor-neutral words.
 */
function vendorErrorReason(who: string, p: unknown, system: PmSystem | null): string {
  const env = isObj(p) ? p : {};
  const raw = env['statusCode'] ?? env['status'] ?? (isObj(env['error']) ? (env['error'] as Record<string, unknown>)['status'] : undefined);
  const status = typeof raw === 'number' && Number.isInteger(raw) && raw >= 100 && raw <= 599 ? raw : null;
  const msg = typeof env['message'] === 'string' ? env['message'] : '';
  const m = /Insufficient scopes?\.?\s*Required:\s*([^\n]{1,300})$/i.exec(msg.trim());
  const scopes = m === null ? [] : m[1]!.replace(/\.$/, '').split(/[\s,]+/).filter((x) => x !== '');
  const named = scopes.length > 0 && scopes.length <= 10 && scopes.every((x) => SCOPES.has(x)) ? scopes : [];
  const jira = system === 'jira';
  const hint =
    named.length > 0
      ? `: it says the token needs the scope${named.length === 1 ? '' : 's'} ${named.join(', ')}`
      : jira && status === 401 && NO_SITES.test(msg.trim())
        ? ': Atlassian could not find the sites this API token reaches, which it checks on every call. A scoped API token needs the read:account scope for that, beside its Jira scopes: create the token again with read:account and enter it again'
        : status === 401
          ? jira
            ? ': Atlassian refused this call for the credential, although the sign-in reached its server (check the token\'s scopes: a scoped API token needs read:account and its Jira scopes; that the token belongs to the account email; and that your organization allows API-token sign-in to its MCP server)'
            : ': the server refused this call for the credential, although the sign-in reached it (check the token and its scopes)'
        : status === 403
          ? ': the credential is not allowed this (a scoped API token may lack a scope, or your organization has not allowed the tool)'
          : status === 404
            ? ': not found'
            : '';
  return `${who} answered an error${status !== null ? ` (HTTP ${status})` : ''}${hint}; its other words are not shown`;
}

export type PayloadRead = { ok: true; payload: unknown } | { ok: false; code: string; reason: string };

/**
 * The ONE payload of a tool answer: the single text block holding JSON (other blocks, and text that is not JSON, are
 * left out, never passed on), `{data}` unwrapped. `structuredContent` is never read or passed on. An error, flagged by
 * `isError` or answered as an error envelope, is `vendor_error` with its HTTP status; a shape no reader knows is
 * `unknown_shape` with the answer's outline (block types, field names, array lengths; never a value).
 */
export function readPayload(result: Record<string, unknown>, who = 'the tracker', system: PmSystem | null = null): PayloadRead {
  const content = result['content'];
  const jsons: unknown[] = [];
  if (Array.isArray(content)) {
    for (const c of content) {
      if (!isObj(c) || c['type'] !== 'text' || typeof c['text'] !== 'string') continue;
      try {
        jsons.push(JSON.parse(c['text']) as unknown);
      } catch {
        // not JSON: left out
      }
    }
  }
  if (result['isError'] === true) {
    const j = jsons.length === 1 ? jsons[0] : null;
    const inner = unwrapData(j);
    return refuse('vendor_error', vendorErrorReason(who, isErrorEnvelope(j) ? j : isErrorEnvelope(inner) ? inner : j, system));
  }
  if (!Array.isArray(content) || jsons.length !== 1) return refuse('unknown_shape', `${who} answered a shape crew does not know (${resultOutline(result)})`);
  const p = jsons[0];
  if (isErrorEnvelope(p)) return refuse('vendor_error', vendorErrorReason(who, p, system));
  const inner = unwrapData(p);
  // An error wrapped in `data` is an error too.
  if (inner !== p && isErrorEnvelope(inner)) return refuse('vendor_error', vendorErrorReason(who, inner, system));
  return { ok: true, payload: inner };
}

/** {@link readPayload} for the projectors, with the binding's system (whose advice an error may carry). */
export function payloadOf(result: Record<string, unknown>, system: PmSystem | null = null): PayloadRead {
  return readPayload(result, 'the tracker', system);
}

/** A refusal for a payload that parsed, but not as the shape `what` needs: names its outline, never a value. */
export function unknownShape(who: string, what: string, payload: unknown): { ok: false; code: string; reason: string } {
  return refuse('unknown_shape', `${who} answered ${what} in a shape crew does not know (got ${outlineOf(payload)})`);
}

// ── Jira (the Atlassian remote MCP server; tenant = the site's cloudId) ─────────────────────────────────

/** A Jira issue key: project key (letters, digits, `_`; Jira keys have no hyphen) and a number. */
export const JIRA_ISSUE_KEY = /^([A-Z][A-Z0-9_]{0,19})-([1-9][0-9]{0,9})$/;

/** The tenant a Jira call goes to: the `cloudId` asked for when it is a linked tenant, else the one linked tenant. */
function jiraTenant(args: Record<string, unknown>, linked: readonly LinkedTracker[], keyFilter?: string): Prepared | { ok: true; tenant: string } {
  const pool = keyFilter === undefined ? linked : linked.filter((t) => t.key === keyFilter);
  const tenants = [...new Set(pool.map((t) => t.tenant))];
  const asked = str(args['cloudId']);
  if (asked !== null) {
    if (!tenants.includes(asked)) return refuse('outside_linked_set', keyFilter === undefined ? 'that Jira site is not linked to this step' : `${keyFilter} is not linked on that Jira site`);
    return { ok: true, tenant: asked };
  }
  if (tenants.length === 1) return { ok: true, tenant: tenants[0]! };
  if (tenants.length === 0) return refuse('outside_linked_set', keyFilter === undefined ? 'no Jira project is linked to this step' : `${keyFilter} is not a Jira project linked to this step`);
  return refuse('tenant_required', `${keyFilter ?? 'the linked projects'} are on ${tenants.length} Jira sites: pass cloudId, one of ${tenants.join(', ')}`);
}

/** The kept fields of one Jira issue (no URLs, no `self`, no site detail). A node with no `fields` keeps its own. */
function jiraIssueValue(issue: Record<string, unknown>, tenant: string, siteHost: string | null | undefined): Record<string, unknown> {
  const f = isObj(issue['fields']) ? issue['fields'] : issue;
  const name = (v: unknown): string | null => (isObj(v) ? str(v['name']) ?? str(v['displayName']) : null);
  const status = isObj(f['status']) ? f['status'] : null;
  const category = status !== null ? jiraCategory(status['statusCategory']) : null;
  const commentsRaw = isObj(f['comment']) && Array.isArray(f['comment']['comments']) ? (f['comment']['comments'] as unknown[]) : [];
  // An embedded comment is kept only when nothing it says contradicts the issue: an address on another site, or a
  // parent issue other than this one.
  const issueId = str(issue['id']) ?? (typeof issue['id'] === 'number' ? String(issue['id']) : null);
  const comments = commentsRaw
    .filter(isObj)
    .filter((c) => jiraProof(c, tenant, siteHost) !== 'contradicted' && commentParents(c).every((x) => x === issueId || x === issue['key']))
    .filter((c) => !jiraCommentRestricted(c))
    .slice(-PM_COMMENTS_MAX)
    .map((c) => ({ author: name(c['author']), created: str(c['created']), body: adfText(c['body'], 1_500) }));
  return {
    key: String(issue['key']),
    summary: vendorText(f['summary'], 400),
    status: name(f['status']),
    statusCategory: category,
    issuetype: name(f['issuetype']),
    priority: name(f['priority']),
    assignee: name(f['assignee']),
    reporter: name(f['reporter']),
    labels: Array.isArray(f['labels']) ? (f['labels'] as unknown[]).filter((l): l is string => typeof l === 'string').slice(0, 20) : [],
    created: str(f['created']),
    updated: str(f['updated']),
    description: adfText(f['description']),
    ...(comments.length > 0 ? { comments } : {}),
  };
}

/** A Jira status category (`{key: 'new'}`, or the key alone) as todo/doing/done. */
export function jiraCategory(v: unknown): 'todo' | 'doing' | 'done' | null {
  const k = String(isObj(v) ? (v['key'] ?? '') : (v ?? '')).toLowerCase();
  return k === 'new' || k === 'todo' || k === 'to_do' ? 'todo' : k === 'indeterminate' || k === 'in_progress' ? 'doing' : k === 'done' ? 'done' : null;
}

/** A comment Jira limits to a role or group, or a JSM internal note: withheld (the token's owner sees it; a project's agents may not). */
function jiraCommentRestricted(c: Record<string, unknown>): boolean {
  return (isObj(c['visibility']) && Object.keys(c['visibility']).length > 0) || c['jsdPublic'] === false;
}

/** The issue an address names: `/browse/<KEY>`, or `/issue/<id or key>` (a REST URL), from the parsed path. */
function addressIssue(a: string): string | null {
  try {
    const path = new URL(a).pathname;
    return /\/browse\/([A-Z][A-Z0-9_]{0,19}-[1-9][0-9]{0,9})\/?$/.exec(path)?.[1] ?? /\/issue\/([A-Za-z0-9_-]{1,40})(?:\/|$)/.exec(path)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Every parent issue a comment names (its `self` path, `issueId`, `issueKey`): all must be the issue asked for. */
function commentParents(c: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof c['self'] === 'string') {
    const m = addressIssue(c['self']);
    if (m !== null) out.push(m);
  }
  for (const k of ['issueId', 'issueKey']) if (typeof c[k] === 'string' || typeof c[k] === 'number') out.push(String(c[k]));
  return out;
}

/** An address on a Jira answer: `self` (a REST URL) and `webUrl` (a browse URL), when the answer carries them. */
function jiraAddresses(x: Record<string, unknown>): string[] {
  return [x['self'], x['webUrl']].filter((v) => v !== undefined && v !== null).map((v) => (typeof v === 'string' ? v : ''));
}

/**
 * Whether an answer's own addresses PROVE it is on the site crew called: the gateway form names the cloudId
 * (`https://api.atlassian.com/ex/jira/<cloudId>/…`), the site form the site's host confirmed at link time
 * (`https://acme.atlassian.net/…`). `absent`: it carries none; `contradicted`: one names another site or cannot be judged.
 */
export function jiraProof(x: Record<string, unknown>, tenant: string, siteHost: string | null | undefined): 'proved' | 'absent' | 'contradicted' {
  const addrs = jiraAddresses(x);
  if (addrs.length === 0) return 'absent';
  for (const a of addrs) {
    // Judged on the parsed URL; a path with dot segments or encoded separators cannot be judged.
    if (/%2e|%2f|%5c|\\|\/\.\.?(?:\/|$)/i.test(a)) return 'contradicted';
    let u: URL;
    try {
      u = new URL(a);
    } catch {
      return 'contradicted';
    }
    if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') return 'contradicted';
    const host = u.host.toLowerCase();
    if (host === 'api.atlassian.com') {
      const gw = /^\/ex\/jira\/([A-Za-z0-9-]{1,64})\//.exec(u.pathname);
      if (gw === null || gw[1] !== tenant) return 'contradicted';
      continue;
    }
    if (siteHost == null || host !== siteHost.toLowerCase()) return 'contradicted';
  }
  return 'proved';
}

/**
 * Whether a Jira issue answered for `tenant` is inside the linked set; its tracker when it is. The key's project must be
 * a linked key on `tenant` (and the issue's own `fields.project`, when named, the same project). Then its SITE must be
 * proved, one of two ways (DES-PM-001 §3.1, revised for the Atlassian v2 server, which answers no `self`):
 *
 * - its own address (`self`, `webUrl`) names the site, as {@link jiraProof} reads it; an address that names another
 *   site, or that cannot be judged, is never admitted, whatever else holds;
 * - it carries NO address, and `bound` holds: the call went to Atlassian's own server with the `cloudId` crew set from
 *   the linked tracker, the credential reaches that ONE site and no other (read from the vendor just now: so a server
 *   that ran the call on another site has no other site to have read), and the whole answer carries no address either
 *   (a server that addresses some items and not others is not trusted for the rest).
 *
 * A credential that reaches several sites gets no tenant proof: an address-free answer from it is `site_unproven`.
 * On any other server (a proxy, a fake) an issue without an address proves nothing and is not admitted.
 */
function jiraAdmit(issue: unknown, tenant: string, linked: readonly LinkedTracker[], bound: boolean): { tracker: LinkedTracker; key: string } | { unproven: true } | null {
  if (!isObj(issue)) return null;
  const key = str(issue['key']);
  const m = key === null ? null : JIRA_ISSUE_KEY.exec(key);
  if (m === null || key === null) return null;
  const f = isObj(issue['fields']) ? issue['fields'] : issue;
  // When the answer names the issue's project, it must be the key's own project.
  const pk = isObj(f['project']) ? str(f['project']['key']) : null;
  if (pk !== null && pk !== m[1]) return null;
  const tracker = linked.find((t) => t.tenant === tenant && t.key === m[1]);
  if (tracker === undefined) return null;
  const proof = jiraProof(issue, tenant, tracker.siteHost);
  // An address that names an issue must name THIS one: a key must be its key; an id, its own id (when it says one).
  const id = str(issue['id']) ?? (typeof issue['id'] === 'number' ? String(issue['id']) : null);
  for (const a of jiraAddresses(issue)) {
    const named = addressIssue(a);
    if (named === null || named === key) continue;
    if (JIRA_ISSUE_KEY.test(named) || (id !== null && named !== id)) return null;
  }
  if (proof === 'proved' || (proof === 'absent' && bound)) return { tracker, key };
  return proof === 'absent' ? { unproven: true } : null;
}

/** Why an address-free answer is not shown. */
const UNPROVEN = (what: string): string =>
  `Jira answered ${what} without an address, so crew cannot prove the site; it trusts the site it named only on Atlassian's own server and when the credential reaches that one site (use a token or account that reaches only the linked site); nothing is shown`;

const admitted = (a: ReturnType<typeof jiraAdmit>): a is { tracker: LinkedTracker; key: string } => a !== null && 'tracker' in a;

/** A Jira issue key asked for: one key of a linked project, and the tenant it is linked on. */
function jiraKeyArgs(args: Record<string, unknown>, linked: readonly LinkedTracker[]): { ok: true; key: string; project: string; tenant: string } | { ok: false; code: string; reason: string } {
  const key = str(args['issueIdOrKey']);
  const m = key === null ? null : JIRA_ISSUE_KEY.exec(key);
  if (m === null || key === null) return refuse('bad_request', 'issueIdOrKey is a Jira issue key such as PROJA-12 (a numeric id or a URL cannot be checked against the linked projects)');
  const t = jiraTenant(args, linked, m[1]);
  if (!t.ok) return t;
  return { ok: true, key, project: m[1]!, tenant: t.tenant };
}

const jiraGetIssue: PmToolBinding = {
  system: 'jira',
  tool: 'getJiraIssue',
  disclosure: 'rows',
  bindArgs(args, linked) {
    const k = jiraKeyArgs(args, linked);
    if (!k.ok) return k;
    const out: Record<string, unknown> = { cloudId: k.tenant, issueIdOrKey: k.key };
    if (Array.isArray(args['fields']) && (args['fields'] as unknown[]).every((x) => typeof x === 'string')) out['fields'] = (args['fields'] as string[]).slice(0, 50);
    return { ok: true, args: out, tenant: k.tenant, trackers: linked.filter((x) => x.tenant === k.tenant && x.key === k.project) };
  },
  project(result, prepared, opts) {
    const p = payloadOf(result, 'jira');
    if (!p.ok) return p;
    if (!isObj(p.payload) || str(p.payload['key']) === null) return unknownShape('the tracker', 'the issue', p.payload);
    const a = jiraAdmit(p.payload, prepared.tenant, prepared.trackers, tenantProves(opts, prepared.tenant));
    // Said apart, so a server that answers no address at all is seen at once: nothing can prove its site.
    if (a !== null && 'unproven' in a) return refuse('site_unproven', UNPROVEN('the issue'));
    // The issue asked for is not the one answered, or not a linked one: nothing of it is shown.
    if (!admitted(a) || a.key !== prepared.args['issueIdOrKey']) return refuse('outside_linked_set', 'the tracker answered an issue outside the projects linked to this step, so nothing is shown');
    return { ok: true, items: [{ trackerId: a.tracker.trackerId, ref: a.key, value: jiraIssueValue(p.payload, prepared.tenant, a.tracker.siteHost) }], next: null };
  },
};

/** The JQL a unit may run: `project in (<linked keys>) AND (<its JQL>)`, its ORDER BY kept last. */
export function boundJql(jql: string, keys: readonly string[]): string {
  // Found on a copy with quoted strings blanked (same length), so `"order by milk"` is text, not the clause.
  const blanked = jql.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (m) => ' '.repeat(m.length));
  const at = blanked.search(/\border\s+by\b(?![\s\S]*\border\s+by\b)/i);
  const where = (at === -1 ? jql : jql.slice(0, at)).trim();
  const order = at === -1 ? '' : ` ${jql.slice(at).trim()}`;
  const inList = `project in (${keys.map((k) => `"${k}"`).join(', ')})`;
  return `${where === '' ? inList : `${inList} AND (${where})`}${order}`;
}

/** The issue list of a Jira search answer: `issues: [...]` (REST, the v2 text) or `issues: {nodes: [...]}` (the v2 envelope). */
function jiraIssueList(p: unknown): unknown[] | null {
  if (!isObj(p)) return null;
  const i = p['issues'];
  if (Array.isArray(i)) return i;
  if (isObj(i) && Array.isArray(i['nodes'])) return i['nodes'] as unknown[];
  return null;
}

const jiraSearch: PmToolBinding = {
  system: 'jira',
  tool: 'searchJiraIssuesUsingJql',
  disclosure: 'rows',
  bindArgs(args, linked) {
    const jql = typeof args['jql'] === 'string' ? args['jql'] : '';
    if (jql.length > 4_000) return refuse('bad_request', 'jql is at most 4000 characters');
    const t = jiraTenant(args, linked);
    if (!t.ok) return t;
    const trackers = linked.filter((x) => x.tenant === t.tenant);
    const keys = [...new Set(trackers.map((x) => x.key))].sort();
    const max = typeof args['maxResults'] === 'number' && Number.isInteger(args['maxResults']) && args['maxResults'] > 0 ? Math.min(args['maxResults'], PM_PAGE_MAX) : 20;
    const out: Record<string, unknown> = { cloudId: t.tenant, jql: boundJql(jql, keys), maxResults: max };
    if (Array.isArray(args['fields']) && (args['fields'] as unknown[]).every((x) => typeof x === 'string')) out['fields'] = (args['fields'] as string[]).slice(0, 50);
    return { ok: true, args: out, tenant: t.tenant, trackers };
  },
  project(result, prepared, opts) {
    const p = payloadOf(result, 'jira');
    if (!p.ok) return p;
    const list = jiraIssueList(p.payload);
    if (list === null) return unknownShape('the tracker', 'its search', p.payload);
    // The tenant proof holds only for an answer with no address anywhere: one that addresses some items proves each.
    const bound = tenantProves(opts, prepared.tenant) && !list.some((i) => isObj(i) && jiraAddresses(i).length > 0);
    const items: PmItem[] = [];
    let unproven = 0;
    for (const issue of list) {
      const a = jiraAdmit(issue, prepared.tenant, prepared.trackers, bound);
      if (!admitted(a)) {
        if (a !== null) unproven++;
        continue;
      }
      items.push({ trackerId: a.tracker.trackerId, ref: a.key, value: jiraIssueValue(issue as Record<string, unknown>, prepared.tenant, a.tracker.siteHost) });
    }
    // Nothing admitted, and the linked items were answered without an address: say so, rather than an empty page that
    // reads as "no issues".
    if (items.length === 0 && unproven > 0) return refuse('site_unproven', UNPROVEN('its issues'));
    // Vendor cursors are not passed on: a cursor is the vendor's text, which nothing here can judge (narrow the JQL).
    return { ok: true, items: items.slice(0, PM_PAGE_MAX), next: null };
  },
};

/**
 * An issue's comments (`listJiraIssueComments`): bound like `getJiraIssue` (the key's project linked, crew sets the
 * site), one item per call (the issue) carrying its comments. A comment's own address, when it has one, must name the
 * site; one Jira limits to a role or group, or a JSM internal note, is withheld and counted.
 */
const jiraComments: PmToolBinding = {
  system: 'jira',
  tool: 'listJiraIssueComments',
  disclosure: 'rows',
  bindArgs(args, linked) {
    const k = jiraKeyArgs(args, linked);
    if (!k.ok) return k;
    const out: Record<string, unknown> = { cloudId: k.tenant, issueIdOrKey: k.key };
    out['maxResults'] = typeof args['maxResults'] === 'number' && Number.isInteger(args['maxResults']) && args['maxResults'] > 0 ? Math.min(args['maxResults'], PM_COMMENTS_MAX) : PM_COMMENTS_MAX;
    if (typeof args['startAt'] === 'number' && Number.isInteger(args['startAt']) && args['startAt'] >= 0 && args['startAt'] <= 100_000) out['startAt'] = args['startAt'];
    if (args['orderBy'] === 'created' || args['orderBy'] === '-created' || args['orderBy'] === '+created') out['orderBy'] = args['orderBy'];
    return { ok: true, args: out, tenant: k.tenant, trackers: linked.filter((x) => x.tenant === k.tenant && x.key === k.project) };
  },
  project(result, prepared, opts) {
    const p = payloadOf(result, 'jira');
    if (!p.ok) return p;
    const list = Array.isArray(p.payload) ? p.payload : isObj(p.payload) && Array.isArray(p.payload['comments']) ? (p.payload['comments'] as unknown[]) : null;
    if (list === null) return unknownShape('the tracker', 'the comments', p.payload);
    const tracker = prepared.trackers[0];
    const key = String(prepared.args['issueIdOrKey']);
    if (tracker === undefined) return refuse('outside_linked_set', `${key} is not a Jira project linked to this step`);
    // Every place the answer names its issue must name the one asked for.
    for (const k of ['issueKey', 'key']) {
      const named = isObj(p.payload) ? p.payload[k] : undefined;
      if (named !== undefined && named !== key) return refuse('outside_linked_set', 'the tracker answered the comments of another issue, so nothing is shown');
    }
    // crew asks for at most 20: an answer this long is not the page asked for, and is not read in part.
    if (list.length > 200) return refuse('unknown_shape', `the tracker answered ${list.length} comments for a page of ${String(prepared.args['maxResults'])}, so nothing is shown`);
    const bound = tenantProves(opts, prepared.tenant) && !list.some((c) => isObj(c) && jiraAddresses(c).length > 0);
    // Every comment that names its issue (`.../issue/<id>/comment/<id>`, an `issueId`) must name the same one: an answer
    // that mixes issues is not the one issue crew asked for.
    const parents = new Set<string>();
    const comments: Array<Record<string, unknown>> = [];
    let withheld = 0;
    let cut = 0;
    for (const c of list) {
      if (!isObj(c)) continue;
      const proof = jiraProof(c, prepared.tenant, tracker.siteHost);
      if (proof === 'contradicted') return refuse('outside_linked_set', 'the tracker answered a comment from another site, so nothing is shown');
      if (proof === 'absent' && !bound) return refuse('site_unproven', UNPROVEN('the comments'));
      // Every parent a comment names, by id or key: one issue across the answer, and a key named must be the one asked.
      for (const x of commentParents(c)) {
        if (JIRA_ISSUE_KEY.test(x) ? x !== key : false) return refuse('outside_linked_set', 'the tracker answered comments of another issue, so nothing is shown');
        if (!JIRA_ISSUE_KEY.test(x)) parents.add(x);
      }
      if (parents.size > 1) return refuse('outside_linked_set', 'the tracker answered comments of more than one issue, so nothing is shown');
      if (jiraCommentRestricted(c)) {
        withheld++;
        continue;
      }
      if (comments.length >= PM_COMMENTS_MAX) {
        cut++;
        continue;
      }
      const author = isObj(c['author']) ? str(c['author']['displayName']) ?? str(c['author']['name']) : null;
      comments.push({ author, created: str(c['created']), updated: str(c['updated']), body: adfText(c['body'], 1_500), ...(str(c['parentId']) !== null || typeof c['parentId'] === 'number' ? { reply: true } : {}) });
    }
    const pl = isObj(p.payload) ? p.payload : {};
    const total = typeof pl['total'] === 'number' && Number.isInteger(pl['total']) ? pl['total'] : null;
    // A page crew cut is not the last one, whatever the vendor said.
    const isLast = cut > 0 ? false : typeof pl['isLast'] === 'boolean' ? pl['isLast'] : null;
    return { ok: true, items: [{ trackerId: tracker.trackerId, ref: key, value: { key, comments, total, isLast, ...(withheld > 0 ? { withheld } : {}), ...(cut > 0 ? { cut } : {}) } }], next: null };
  },
};

/** The account a Jira credential belongs to (`atlassianUserInfo`): its `accountId` alone, no issue rows. */
const jiraAccount: PmToolBinding = {
  system: 'jira',
  tool: 'atlassianUserInfo',
  disclosure: 'structure',
  bindArgs(_args, linked) {
    const tenants = [...new Set(linked.map((t) => t.tenant))];
    if (tenants.length === 0) return refuse('outside_linked_set', 'no Jira project is linked to this step');
    return { ok: true, args: {}, tenant: tenants[0]!, trackers: [...linked] };
  },
  project(result, prepared) {
    const p = payloadOf(result, 'jira');
    if (!p.ok) return p;
    const id = isObj(p.payload) ? str(p.payload['accountId']) ?? str(p.payload['account_id']) : null;
    if (id === null || id.length > 128) return unknownShape('the tracker', 'its account', p.payload);
    return { ok: true, items: [{ trackerId: prepared.trackers[0]!.trackerId, ref: 'account', value: { accountId: id } }], next: null };
  },
};

/** The Jira sites of an answer to `getAccessibleAtlassianResources` (v2 `{resources}`, REST array); `null`: not that shape. */
export function jiraSitesOf(p: unknown): Array<{ id: string; label: string; host: string | null }> | null {
  const list = siteListOf(p);
  if (list === null) return null;
  const host = (u: unknown): string | null => {
    try {
      const x = new URL(String(u));
      return x.protocol === 'https:' && x.username === '' && x.password === '' ? x.host.toLowerCase() : null;
    } catch {
      return null;
    }
  };
  const out = new Map<string, { id: string; label: string; host: string | null }>();
  // Every host each site id is named at, across ALL entries (whatever their products): two hosts confirm none.
  const hosts = new Map<string, Set<string | null>>();
  for (const s of list) {
    const id = isObj(s) ? siteIdOf(s) : null;
    if (id !== null && id !== false) hosts.set(id, (hosts.get(id) ?? new Set()).add(host((s as Record<string, unknown>)['url'])));
  }
  let readable = 0;
  for (const s of list) {
    if (!isObj(s)) continue;
    const id = siteIdOf(s);
    if (id === false) return null;
    if (id === null) continue;
    readable++;
    // A site the answer says has no Jira (a Confluence-only site, an empty product list; the REST shape's entry whose
    // scopes are all another product's) is no tracker's site.
    const products = Array.isArray(s['products']) ? (s['products'] as unknown[]) : null;
    if (products !== null && !products.some((x) => /^jira/i.test(String(isObj(x) ? x['id'] ?? x['key'] ?? x['name'] ?? '' : x)))) continue;
    const scopes = products === null && Array.isArray(s['scopes']) ? (s['scopes'] as unknown[]) : null;
    if (scopes !== null && scopes.length > 0 && !scopes.some((x) => typeof x === 'string' && /jira/i.test(x))) continue;
    const named = [...(hosts.get(id) ?? [])];
    // One site named at two hosts (or once without one): no host is confirmed; a site-form address then proves nothing.
    const h = named.length === 1 ? named[0]! : null;
    const was = out.get(id);
    const name = typeof s['name'] === 'string' && s['name'].trim() !== '' ? vendorText(s['name'], 100) : null;
    out.set(id, { id, label: name ?? was?.label ?? h ?? named.find((x) => x !== null) ?? id, host: h });
  }
  // Entries, none of them readable as a site: not a shape crew knows.
  if (list.length > 0 && readable === 0) return null;
  return [...out.values()];
}

/** Every distinct site id an answer to `getAccessibleAtlassianResources` names, whatever its products; `null`: not that shape. */
export function atlassianSiteIdsOf(p: unknown): string[] | null {
  const list = siteListOf(p);
  if (list === null) return null;
  const ids = new Set<string>();
  for (const s of list) {
    const id = isObj(s) ? siteIdOf(s) : null;
    if (id === null || id === false) return null;
    ids.add(id);
  }
  return [...ids];
}

/** The ONE site list of an answer (an array, or `resources` / `sites` / `accessibleResources`); two lists = `null`. */
function siteListOf(p: unknown): unknown[] | null {
  if (Array.isArray(p)) return p;
  if (!isObj(p)) return null;
  const lists = [p['resources'], p['sites'], p['accessibleResources']].filter(Array.isArray);
  return lists.length === 1 ? (lists[0] as unknown[]) : null;
}

/** A site entry's id (`cloudId`, or `id`); `false` when both are named and disagree, `null` when neither is one. */
function siteIdOf(s: Record<string, unknown>): string | null | false {
  const a = str(s['cloudId']);
  const b = str(s['id']);
  if (a !== null && b !== null && a !== b) return false;
  const id = a ?? b;
  return id !== null && /^[A-Za-z0-9-]{1,64}$/.test(id) ? id : null;
}

/** The sites of `getAccessibleAtlassianResources`, cut to the tenants linked to this step: `{cloudId, url}` each. */
const jiraSites: PmToolBinding = {
  system: 'jira',
  tool: 'getAccessibleAtlassianResources',
  disclosure: 'structure',
  bindArgs(_args, linked) {
    const tenants = [...new Set(linked.map((t) => t.tenant))];
    if (tenants.length === 0) return refuse('outside_linked_set', 'no Jira project is linked to this step');
    return { ok: true, args: {}, tenant: tenants[0]!, trackers: [...linked] };
  },
  project(result, prepared) {
    const p = payloadOf(result, 'jira');
    if (!p.ok) return p;
    const sites = jiraSitesOf(p.payload);
    if (sites === null) return unknownShape('the tracker', 'its sites', p.payload);
    const items: PmItem[] = [];
    for (const s of sites) {
      const t = prepared.trackers.find((x) => x.tenant === s.id);
      // A site no tracker of this step is linked on is not shown (the credential may reach many).
      if (t === undefined) continue;
      // The site's address must be the host confirmed at link time, when one was.
      const host = t.siteHost != null ? (s.host === t.siteHost.toLowerCase() ? t.siteHost : null) : s.host;
      if (t.siteHost != null && host === null) continue;
      items.push({ trackerId: t.trackerId, ref: `site:${s.id}`, value: { cloudId: s.id, ...(host !== null ? { url: `https://${host}` } : {}) } });
    }
    return { ok: true, items, next: null };
  },
};

// ── GitHub (github/github-mcp-server; tenant = the host) ────────────────────────────────────────────────

export const GITHUB_TENANT = 'github.com';
const REPO_PART = /^[A-Za-z0-9_.-]{1,100}$/;

/** `owner/repo` lower-cased, or `null` when it is not one. */
export function repoKey(owner: unknown, repo: unknown): string | null {
  if (typeof owner !== 'string' || typeof repo !== 'string' || !REPO_PART.test(owner) || !REPO_PART.test(repo)) return null;
  return `${owner}/${repo}`.toLowerCase();
}

/** The owner/repo and issue number an `html_url` names (`https://github.com/o/r/issues/7`, `…#issuecomment-1`). */
export function githubUrlIdentity(url: unknown): { repo: string; number: number } | null {
  if (typeof url !== 'string') return null;
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/(?:issues|pull)\/([1-9][0-9]{0,9})(?:[#?].*)?$/.exec(url);
  return m === null ? null : { repo: `${m[1]}/${m[2]}`.toLowerCase(), number: Number(m[3]) };
}

function githubTracker(repo: string | null, linked: readonly LinkedTracker[]): LinkedTracker | null {
  if (repo === null) return null;
  return linked.find((t) => t.tenant === GITHUB_TENANT && t.key.toLowerCase() === repo) ?? null;
}

function githubIssueValue(i: Record<string, unknown>, number: number): Record<string, unknown> {
  const login = (v: unknown): string | null => (isObj(v) ? str(v['login']) : str(v));
  const labels = Array.isArray(i['labels']) ? (i['labels'] as unknown[]).map((l) => (isObj(l) ? str(l['name']) : str(l))).filter((l): l is string => l !== null).slice(0, 20) : [];
  return {
    number,
    title: vendorText(i['title'], 400),
    state: str(i['state']),
    ...(str(i['state_reason']) !== null ? { stateReason: str(i['state_reason']) } : {}),
    author: login(i['user']),
    labels,
    assignees: Array.isArray(i['assignees']) ? (i['assignees'] as unknown[]).map(login).filter((x): x is string => x !== null).slice(0, 20) : [],
    created: str(i['created_at']),
    updated: str(i['updated_at']),
    closed: str(i['closed_at']),
    comments: typeof i['comments'] === 'number' ? i['comments'] : null,
    body: vendorText(i['body']),
    url: String(i['html_url']),
  };
}

/** One GitHub issue admitted by its own `html_url`; a pull request in an issue list is not an issue of the tracker. */
function githubAdmit(i: unknown, linked: readonly LinkedTracker[], want?: { repo: string; number?: number }): PmItem | null {
  if (!isObj(i)) return null;
  const id = githubUrlIdentity(i['html_url']);
  if (id === null || !/\/issues\//.test(String(i['html_url']))) return null;
  if (i['number'] !== undefined && i['number'] !== id.number) return null;
  if (want !== undefined && (want.repo !== id.repo || (want.number !== undefined && want.number !== id.number))) return null;
  const t = githubTracker(id.repo, linked);
  if (t === null) return null;
  return { trackerId: t.trackerId, ref: `${t.key}#${id.number}`, value: githubIssueValue(i, id.number) };
}

function githubRepoArgs(args: Record<string, unknown>, linked: readonly LinkedTracker[]): { ok: true; repo: string; tracker: LinkedTracker } | { ok: false; code: string; reason: string } {
  const repo = repoKey(args['owner'], args['repo']);
  if (repo === null) return refuse('bad_request', 'owner and repo name a GitHub repository');
  const t = githubTracker(repo, linked);
  if (t === null) return refuse('outside_linked_set', `${repo} is not a GitHub tracker linked to this step`);
  return { ok: true, repo, tracker: t };
}

const githubIssueRead: PmToolBinding = {
  system: 'github',
  tool: 'issue_read',
  disclosure: 'rows',
  bindArgs(args, linked) {
    const method = args['method'];
    if (method !== 'get' && method !== 'get_comments') return refuse('method_unbound', 'issue_read is bound for method get and get_comments only');
    const r = githubRepoArgs(args, linked);
    if (!r.ok) return r;
    const n = args['issue_number'];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) return refuse('bad_request', 'issue_number is a positive integer');
    const [owner, repo] = r.tracker.key.split('/');
    const out: Record<string, unknown> = { method, owner, repo, issue_number: n };
    if (method === 'get_comments') out['perPage'] = typeof args['perPage'] === 'number' && args['perPage'] > 0 ? Math.min(Math.trunc(args['perPage']), PM_COMMENTS_MAX) : PM_COMMENTS_MAX;
    if (method === 'get_comments' && typeof args['page'] === 'number' && Number.isInteger(args['page']) && args['page'] > 0) out['page'] = args['page'];
    return { ok: true, args: out, tenant: GITHUB_TENANT, trackers: [r.tracker] };
  },
  project(result, prepared) {
    const p = payloadOf(result, 'github');
    if (!p.ok) return p;
    const repo = prepared.trackers[0]!.key.toLowerCase();
    const number = prepared.args['issue_number'] as number;
    if (prepared.args['method'] === 'get') {
      if (!isObj(p.payload)) return unknownShape('the tracker', 'the issue', p.payload);
      const item = githubAdmit(p.payload, prepared.trackers, { repo, number });
      if (item === null) return refuse('outside_linked_set', 'the tracker answered an issue outside the repositories linked to this step, so nothing is shown');
      return { ok: true, items: [item], next: null };
    }
    const list = Array.isArray(p.payload) ? p.payload : isObj(p.payload) && Array.isArray(p.payload['comments']) ? (p.payload['comments'] as unknown[]) : null;
    if (list === null) return unknownShape('the tracker', 'the comments', p.payload);
    const comments: Array<Record<string, unknown>> = [];
    let dropped = 0;
    for (const c of list.slice(0, 200)) {
      if (comments.length >= PM_COMMENTS_MAX) break;
      const id = isObj(c) ? githubUrlIdentity(c['html_url']) : null;
      if (!isObj(c) || id === null || id.repo !== repo || id.number !== number) {
        dropped++;
        continue;
      }
      comments.push({ author: isObj(c['user']) ? str(c['user']['login']) : null, created: str(c['created_at']), body: vendorText(c['body'], 1_500), url: String(c['html_url']) });
    }
    void dropped;
    return { ok: true, items: [{ trackerId: prepared.trackers[0]!.trackerId, ref: `${prepared.trackers[0]!.key}#${number}`, value: { number, comments } }], next: null };
  },
};

/**
 * The scope qualifiers of a GitHub search query (`repo:`, `org:`, `user:`, `owner:`), anywhere: quoted values and
 * negations included (`-repo:x`, `repo:"x"`), so the caller can refuse what it cannot bound. A qualifier inside a
 * quoted phrase is text, not a qualifier, but GitHub's parser is not ours to guess: it is reported too.
 */
export function searchQualifiers(q: string): Array<{ kind: string; value: string; negated: boolean; quoted: boolean }> {
  const out: Array<{ kind: string; value: string; negated: boolean; quoted: boolean }> = [];
  for (const m of q.matchAll(/(-)?\b(repo|org|user|owner)\s*:\s*("?)([^\s"]*)/gi)) out.push({ kind: m[2]!.toLowerCase(), value: m[4]!.toLowerCase(), negated: m[1] === '-', quoted: m[3] === '"' });
  return out;
}

const githubSearchIssues: PmToolBinding = {
  system: 'github',
  tool: 'search_issues',
  disclosure: 'rows',
  bindArgs(args, linked) {
    const q = typeof args['query'] === 'string' ? args['query'].trim() : '';
    if (q === '' || q.length > 1_000) return refuse('bad_request', 'query is a GitHub issue search of at most 1000 characters');
    const repos = linked.filter((t) => t.tenant === GITHUB_TENANT);
    const keys = repos.map((t) => t.key.toLowerCase());
    if (keys.length === 0) return refuse('outside_linked_set', 'no GitHub repository is linked to this step');
    const quals = searchQualifiers(q);
    if (quals.some((x) => x.kind !== 'repo')) return refuse('outside_linked_set', 'a search here names repositories with repo: only (org:, user: and owner: reach past the linked set)');
    if (quals.some((x) => x.negated || x.quoted || x.value === '')) return refuse('outside_linked_set', 'a search here names its repositories as plain repo:owner/name qualifiers (no negation, no quotes)');
    if (quals.some((x) => !keys.includes(x.value))) return refuse('outside_linked_set', 'the query names a repository that is not linked to this step');
    // `owner`/`repo` arguments become a qualifier on the server: judged the same way, then folded into the query.
    const add = new Set<string>();
    if (args['owner'] !== undefined || args['repo'] !== undefined) {
      const r = githubRepoArgs(args, linked);
      if (!r.ok) return r;
      if (!quals.some((x) => x.value === r.repo)) add.add(r.tracker.key.toLowerCase());
    }
    // A query that names no repository gets every linked one (GitHub ORs repo: qualifiers, ANDs the rest).
    if (quals.length === 0 && add.size === 0) for (const k of keys) add.add(k);
    const query = [q, ...[...add].map((k) => `repo:${k}`)].join(' ');
    const out: Record<string, unknown> = { query, perPage: typeof args['perPage'] === 'number' && args['perPage'] > 0 ? Math.min(Math.trunc(args['perPage']), PM_PAGE_MAX) : 20 };
    for (const k of ['sort', 'order'] as const) if (typeof args[k] === 'string' && (args[k] as string).length <= 40) out[k] = args[k];
    if (typeof args['page'] === 'number' && Number.isInteger(args['page']) && args['page'] > 0) out['page'] = args['page'];
    return { ok: true, args: out, tenant: GITHUB_TENANT, trackers: repos };
  },
  project(result, prepared) {
    const p = payloadOf(result, 'github');
    if (!p.ok) return p;
    if (!isObj(p.payload) || !Array.isArray(p.payload['items'])) return unknownShape('the tracker', 'its search', p.payload);
    const items: PmItem[] = [];
    for (const i of p.payload['items'] as unknown[]) {
      const item = githubAdmit(i, prepared.trackers);
      if (item !== null) items.push(item);
    }
    return { ok: true, items: items.slice(0, PM_PAGE_MAX), next: null };
  },
};

// `list_issues` is NOT bound: the server's GraphQL path answers issues without `html_url` (its MinimalIssue leaves it
// empty), so no item could prove its repository; `search_issues` (repo: qualifiers, `html_url`) serves listing.
const BINDINGS: readonly PmToolBinding[] = [jiraGetIssue, jiraSearch, jiraComments, jiraAccount, jiraSites, githubIssueRead, githubSearchIssues];

/** Crew's binding for a PM tool, or `null`: such a tool is unavailable to agents. */
export function bindingFor(system: PmSystem, tool: string): PmToolBinding | null {
  return BINDINGS.find((b) => b.system === system && b.tool === tool) ?? null;
}

/** The policy string a binding is stored under (`jira/getJiraIssue@1`). */
export function bindingPolicy(b: Pick<PmToolBinding, 'system' | 'tool'>): string {
  return `${b.system}/${b.tool}@${BINDING_POLICY_VERSION}`;
}

/** The binding a save stores for a tool of a PM entry: crew's current one, bound to the saved schema; `null` = none. */
export function bindingOnSave(system: PmSystem, tool: { name: string; schemaHash: string }): ToolBinding | null {
  const b = bindingFor(system, tool.name);
  return b === null ? null : { policy: bindingPolicy(b), schemaHash: tool.schemaHash };
}

/** The binding in force for a stored tool: crew's binding, when the stored one is its current policy on the saved schema. */
export function bindingInForce(system: PmSystem, t: { name: string; schemaHash: string | null; binding?: ToolBinding | null }): PmToolBinding | null {
  const b = bindingFor(system, t.name);
  const stored = t.binding ?? null;
  if (b === null || stored === null || t.schemaHash === null) return null;
  return stored.policy === bindingPolicy(b) && stored.schemaHash === t.schemaHash ? b : null;
}

/** Every tool name crew binds for `system` (the sheet and the tests). */
export function boundToolNames(system: PmSystem): string[] {
  return BINDINGS.filter((b) => b.system === system).map((b) => b.tool);
}
