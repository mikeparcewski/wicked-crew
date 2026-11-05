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
 * A tool with no binding here (Rovo `search`, `executeRead`, every write, `get_me`, …) is unavailable to agents.
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

export interface PmToolBinding {
  system: PmSystem;
  tool: string;
  /** What the answer discloses: issue content is `rows` (needs "query"). */
  disclosure: 'rows';
  bindArgs(args: Record<string, unknown>, linked: readonly LinkedTracker[]): Prepared;
  project(result: Record<string, unknown>, prepared: Extract<Prepared, { ok: true }>): Projected;
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
 * The Atlassian v2 server wraps an answer as `{data: …}` (with `appliedContentFormat` beside it): the payload is
 * what `data` holds. Any other object is its own payload.
 */
export function unwrapData(p: unknown): unknown {
  if (!isObj(p) || !('data' in p)) return p;
  const others = Object.keys(p).filter((k) => k !== 'data' && k !== 'appliedContentFormat');
  return others.length === 0 && (isObj(p['data']) || Array.isArray(p['data'])) ? p['data'] : p;
}

/**
 * The ONE payload of a tool answer: the JSON of its single text content. A result with several text parts, no JSON,
 * or an error is not a shape any projector knows. `structuredContent` is never read or passed on.
 */
export function payloadOf(result: Record<string, unknown>): { ok: true; payload: unknown } | { ok: false; code: string; reason: string } {
  if (result['isError'] === true) return refuse('vendor_error', 'the tracker answered an error; its words are not shown');
  const content = result['content'];
  if (!Array.isArray(content)) return refuse('unknown_shape', 'the tracker answered no content');
  const texts = content.filter((c) => isObj(c) && c['type'] === 'text');
  if (texts.length !== 1 || content.length !== 1) return refuse('unknown_shape', 'the tracker answered a shape crew does not know');
  try {
    return { ok: true, payload: unwrapData(JSON.parse(String((texts[0] as Record<string, unknown>)['text'])) as unknown) };
  } catch {
    return refuse('unknown_shape', 'the tracker answered text that is not the JSON crew expects');
  }
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

/** The kept fields of one Jira issue (no URLs, no `self`, no site detail). */
function jiraIssueValue(issue: Record<string, unknown>): Record<string, unknown> {
  const f = isObj(issue['fields']) ? issue['fields'] : {};
  const name = (v: unknown): string | null => (isObj(v) ? str(v['name']) ?? str(v['displayName']) : null);
  const status = isObj(f['status']) ? f['status'] : null;
  const category = status !== null && isObj(status['statusCategory']) ? str(status['statusCategory']['key']) : null;
  const commentsRaw = isObj(f['comment']) && Array.isArray(f['comment']['comments']) ? (f['comment']['comments'] as unknown[]) : [];
  const comments = commentsRaw
    .filter(isObj)
    .slice(-PM_COMMENTS_MAX)
    .map((c) => ({ author: name(c['author']), created: str(c['created']), body: adfText(c['body'], 1_500) }));
  return {
    key: String(issue['key']),
    summary: vendorText(f['summary'], 400),
    status: name(f['status']),
    statusCategory: category === 'new' ? 'todo' : category === 'indeterminate' ? 'doing' : category === 'done' ? 'done' : null,
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

/** Whether a Jira issue answered for `tenant` is inside the linked set; its tracker when it is. */
function jiraAdmit(issue: unknown, tenant: string, linked: readonly LinkedTracker[]): { tracker: LinkedTracker; key: string } | null {
  if (!isObj(issue)) return null;
  const key = str(issue['key']);
  const m = key === null ? null : JIRA_ISSUE_KEY.exec(key);
  if (m === null || key === null) return null;
  const f = isObj(issue['fields']) ? issue['fields'] : null;
  // When the answer names the issue's project, it must be the key's own project.
  const pk = f !== null && isObj(f['project']) ? str(f['project']['key']) : null;
  if (pk !== null && pk !== m[1]) return null;
  const tracker = linked.find((t) => t.tenant === tenant && t.key === m[1]);
  if (tracker === undefined) return null;
  // The issue's own address must PROVE it is on the site crew called: the gateway form names the cloudId
  // (`https://api.atlassian.com/ex/jira/<cloudId>/…`), the site form the site's host confirmed at link time. An issue
  // with no address, or one this cannot judge, is not admitted (an untrusted server could answer another site's PROJA).
  const self = str(issue['self']);
  if (self === null) return null;
  const gw = /^https:\/\/api\.atlassian\.com\/ex\/jira\/([A-Za-z0-9-]{1,64})\//.exec(self);
  if (gw !== null) return gw[1] === tenant ? { tracker, key } : null;
  let host: string | null = null;
  try {
    const u = new URL(self);
    host = u.protocol === 'https:' ? u.host.toLowerCase() : null;
  } catch {
    host = null;
  }
  return host !== null && tracker.siteHost != null && host === tracker.siteHost.toLowerCase() ? { tracker, key } : null;
}

const jiraGetIssue: PmToolBinding = {
  system: 'jira',
  tool: 'getJiraIssue',
  disclosure: 'rows',
  bindArgs(args, linked) {
    const key = str(args['issueIdOrKey']);
    const m = key === null ? null : JIRA_ISSUE_KEY.exec(key);
    if (m === null || key === null) return refuse('bad_request', 'issueIdOrKey is a Jira issue key such as PROJA-12 (a numeric id cannot be checked against the linked projects)');
    const t = jiraTenant(args, linked, m[1]);
    if (!t.ok) return t;
    const out: Record<string, unknown> = { cloudId: t.tenant, issueIdOrKey: key };
    if (Array.isArray(args['fields']) && (args['fields'] as unknown[]).every((x) => typeof x === 'string')) out['fields'] = (args['fields'] as string[]).slice(0, 50);
    return { ok: true, args: out, tenant: t.tenant, trackers: linked.filter((x) => x.tenant === t.tenant && x.key === m[1]) };
  },
  project(result, prepared) {
    const p = payloadOf(result);
    if (!p.ok) return p;
    if (!isObj(p.payload) || str(p.payload['key']) === null) return refuse('unknown_shape', 'the tracker answered a shape crew does not know');
    const admitted = jiraAdmit(p.payload, prepared.tenant, prepared.trackers);
    // Said apart, so a server that answers no address at all is seen at once: nothing can prove its site.
    if (admitted === null && str(p.payload['self']) === null) return refuse('site_unproven', 'Jira answered the issue without its own address, so crew cannot prove it is on the linked site; nothing is shown');
    // The issue asked for is not the one answered, or not a linked one: nothing of it is shown.
    if (admitted === null || admitted.key !== prepared.args['issueIdOrKey']) return refuse('outside_linked_set', 'the tracker answered an issue outside the projects linked to this step, so nothing is shown');
    return { ok: true, items: [{ trackerId: admitted.tracker.trackerId, ref: admitted.key, value: jiraIssueValue(p.payload) }], next: null };
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
  project(result, prepared) {
    const p = payloadOf(result);
    if (!p.ok) return p;
    if (!isObj(p.payload) || !Array.isArray(p.payload['issues'])) return refuse('unknown_shape', 'the tracker answered a shape crew does not know');
    const items: PmItem[] = [];
    let dropped = 0;
    let unproven = 0;
    const list = p.payload['issues'] as unknown[];
    for (const issue of list) {
      const a = jiraAdmit(issue, prepared.tenant, prepared.trackers);
      if (a === null) {
        dropped++;
        if (isObj(issue) && str(issue['self']) === null) unproven++;
        continue;
      }
      items.push({ trackerId: a.tracker.trackerId, ref: a.key, value: jiraIssueValue(issue as Record<string, unknown>) });
    }
    // Every item answered without an address: say so, rather than an empty page that reads as "no issues".
    if (items.length === 0 && list.length > 0 && unproven === list.length) return refuse('site_unproven', 'Jira answered its issues without their own addresses, so crew cannot prove they are on the linked site; nothing is shown');
    // Vendor cursors are not passed on: a cursor is the vendor's text, which nothing here can judge (narrow the JQL).
    void dropped;
    return { ok: true, items: items.slice(0, PM_PAGE_MAX), next: null };
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
    const p = payloadOf(result);
    if (!p.ok) return p;
    const repo = prepared.trackers[0]!.key.toLowerCase();
    const number = prepared.args['issue_number'] as number;
    if (prepared.args['method'] === 'get') {
      if (!isObj(p.payload)) return refuse('unknown_shape', 'the tracker answered a shape crew does not know');
      const item = githubAdmit(p.payload, prepared.trackers, { repo, number });
      if (item === null) return refuse('outside_linked_set', 'the tracker answered an issue outside the repositories linked to this step, so nothing is shown');
      return { ok: true, items: [item], next: null };
    }
    const list = Array.isArray(p.payload) ? p.payload : isObj(p.payload) && Array.isArray(p.payload['comments']) ? (p.payload['comments'] as unknown[]) : null;
    if (list === null) return refuse('unknown_shape', 'the tracker answered a shape crew does not know');
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
    const p = payloadOf(result);
    if (!p.ok) return p;
    if (!isObj(p.payload) || !Array.isArray(p.payload['items'])) return refuse('unknown_shape', 'the tracker answered a shape crew does not know');
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
const BINDINGS: readonly PmToolBinding[] = [jiraGetIssue, jiraSearch, githubIssueRead, githubSearchIssues];

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
