// PM-1 against the REAL vendor servers' result shapes (tests/fixtures/pm/recorded-shapes.ts names each source):
// Atlassian's v2 remote MCP server and github/github-mcp-server. Each parser test fails on the PM-1 code that was
// built against fake stdio servers only (the lane's red runs are in its ledger lines).

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { atlassianSiteIdsOf, bindingFor, jiraProof, jiraSitesOf, type LinkedTracker, outlineOf, readPayload, resultOutline, vendorBindsTenant } from '../src/knowledge/trackers/bindings.js';
import { PmGate } from '../src/knowledge/trackers/gate-pm.js';
import { listSourceTrackers, lookupTracker } from '../src/knowledge/trackers/routes.js';
import type { PmEntry } from '../src/knowledge/trackers/set.js';
import { atlassianV2, githubMcp, SITE_HOST, SITE_ID, SITE_URL } from './fixtures/pm/recorded-shapes.js';

/** Atlassian's own server, and a credential that reaches the linked site only (read from the vendor at call time). */
const V2 = { vendorBindsTenant: true, soleSite: SITE_ID };
const linked: LinkedTracker[] = [{ trackerId: 'trk_sqr', tenant: SITE_ID, key: 'SQR', siteHost: SITE_HOST }];

function entry(system: 'jira' | 'github', tools: string[], url = system === 'jira' ? 'https://mcp.atlassian.com/v2/mcp' : 'https://api.githubcopilot.com/mcp/'): PmEntry {
  return {
    id: 'e1',
    name: system,
    system,
    enabled: true,
    access: { see: true, query: true, projects: [], everyProject: true },
    trackers: [],
    record: { name: system, kind: 'mcp-http', url, command: null, args: [], auth: null, tools: tools.map((name) => ({ name, present: true })) } as unknown as PmEntry['record'],
  };
}

/** A person-read stub answering each tool from `answers` (executeRead answers by its operation name). */
function stub(answers: Record<string, Record<string, unknown>>) {
  const calls: string[] = [];
  const answer = (tool: string) => {
    calls.push(tool);
    const r = answers[tool];
    return Promise.resolve(r === undefined ? { ok: false as const, code: 'tool_missing', reason: `no ${tool}` } : { ok: true as const, result: r });
  };
  return { calls, pm: { personCall: (_e: PmEntry, tool: string) => answer(tool), personOp: (_e: PmEntry, name: string) => answer(name) } };
}

const prep = (tool: string, args: Record<string, unknown>, l: LinkedTracker[] = linked) => {
  const b = bindingFor(tool === 'search_issues' || tool === 'issue_read' ? 'github' : 'jira', tool)!;
  const p = b.bindArgs(args, l);
  if (!p.ok) throw new Error(`prepare ${tool}: ${p.reason}`);
  return { b, p };
};

describe('getAccessibleAtlassianResources: the v2 site list (the 503 the operator saw)', () => {
  it('lists the site from {data:{resources:[{cloudId,url,products}]}}', async () => {
    const { pm } = stub({ getAccessibleAtlassianResources: atlassianV2.resources, listJiraProjects: { content: [{ type: 'text', text: JSON.stringify({ data: { values: [{ key: 'SQR', name: 'Questionnaires' }], isLast: true } }) }] } });
    const page = await listSourceTrackers(pm, entry('jira', ['getAccessibleAtlassianResources', 'executeRead']), '', {}, null);
    expect(page).toMatchObject({ ok: true, rows: [{ tenant: SITE_ID, tenantLabel: SITE_HOST, key: 'SQR', label: 'Questionnaires' }] });
  });
  it('a context sibling beside data, and the REST array shape (a site listed once per product), both read', async () => {
    for (const r of [atlassianV2.resourcesWithContext, atlassianV2.resourcesRest]) {
      const { pm } = stub({ getAccessibleAtlassianResources: r, listJiraProjects: { content: [{ type: 'text', text: '{"values":[{"key":"SQR","name":"Q"}],"isLast":true}' }] } });
      const page = await listSourceTrackers(pm, entry('jira', ['getAccessibleAtlassianResources']), '', {}, null);
      expect(page).toMatchObject({ ok: true, rows: [{ tenant: SITE_ID, key: 'SQR' }] });
      if (page.ok) expect(page.rows).toHaveLength(1);
    }
  });
  it('a Confluence-only site is no Jira site; the link lookup confirms the site host from `url`', async () => {
    const { pm, calls } = stub({ getAccessibleAtlassianResources: atlassianV2.resourcesConfluenceOnly, listJiraProjects: { content: [{ type: 'text', text: '{"data":{"values":[{"key":"SQR","name":"Q"}],"isLast":true}}' }] } });
    const page = await listSourceTrackers(pm, entry('jira', ['getAccessibleAtlassianResources']), '', {}, null);
    expect(page.ok && page.rows.map((r) => r.tenant)).toEqual([SITE_ID]);
    expect(calls.filter((c) => c === 'listJiraProjects')).toHaveLength(1);
    expect(await lookupTracker(pm, entry('jira', ['getAccessibleAtlassianResources']), SITE_ID, 'SQR')).toMatchObject({ ok: true, siteHost: SITE_HOST });
  });
  it('an error envelope without isError is the vendor error with its status and the scopes it names', async () => {
    const { pm } = stub({ getAccessibleAtlassianResources: atlassianV2.scopeError });
    const page = await listSourceTrackers(pm, entry('jira', ['getAccessibleAtlassianResources']), '', {}, null);
    expect(page).toMatchObject({ ok: false, code: 'vendor_error' });
    if (!page.ok) {
      expect(page.reason).toContain('HTTP 403');
      expect(page.reason).toContain('read:me, read:account');
      expect(page.reason).not.toContain('Insufficient');
    }
  });
  it("Atlassian's 401 when it cannot find a token's sites names the call and read:account, not a refused credential (#285)", async () => {
    const auth = await listSourceTrackers(stub({ getAccessibleAtlassianResources: atlassianV2.authError }).pm, entry('jira', ['getAccessibleAtlassianResources']), '', {}, null);
    expect(auth).toMatchObject({ ok: false, code: 'vendor_error' });
    if (!auth.ok) {
      expect(auth.reason).toContain('jira (getAccessibleAtlassianResources) answered an error (HTTP 401)');
      expect(auth.reason).toContain('could not find the sites this API token reaches');
      expect(auth.reason).toContain('read:account');
      expect(auth.reason).not.toContain('credential was refused');
      expect(auth.reason).not.toContain('accessible products');
    }
    // The same words on a site-scoped read (Atlassian answers them for every call) say the same.
    const { b, p } = prep('searchJiraIssuesUsingJql', { jql: 'order by updated' });
    const r = b.project(atlassianV2.authError, p, V2);
    expect(r.ok === false && r.reason).toContain('read:account');
    // Any other Jira 401 says the sign-in reached the server and names the checks, repeating none of the vendor's words.
    const env = (message: string, statusCode?: number) => ({ content: [{ type: 'text', text: JSON.stringify({ error: true, message, ...(statusCode !== undefined ? { statusCode } : {}) }) }] });
    const other = readPayload(env('Unauthorized for acme-customer-x', 401), 'jira (getJiraIssue)', 'jira');
    expect(other).toMatchObject({ ok: false, code: 'vendor_error' });
    if (!other.ok) {
      expect(other.reason).toContain('jira (getJiraIssue) answered an error (HTTP 401)');
      expect(other.reason).toContain('although the sign-in reached its server');
      expect(other.reason).toContain('read:account');
      expect(other.reason).not.toContain('credential was refused');
      expect(other.reason).not.toContain('acme');
    }
    // The phrase only counts at the start of Atlassian's message: the same words later in it are another 401.
    const later = readPayload(env('x Failed to fetch accessible products', 401), 'jira (x)', 'jira');
    expect(later.ok === false && later.reason).not.toContain('could not find the sites');
    // The same words on a 429, a 500 or with no status are not a scope problem: no token advice.
    for (const st of [429, 500, undefined]) {
      const r = readPayload(env('Failed to fetch accessible products: 500', st), 'jira (x)', 'jira');
      expect(r.ok === false && r.reason, String(st)).not.toContain('read:account');
    }
    // Words after the recognised phrase (a credential, a private name) are never repeated.
    const echo = readPayload(env('Failed to fetch accessible products: 401 for SECRET-zz9 canary-private-77', 401), 'jira (x)', 'jira');
    expect(echo.ok === false && echo.reason).toContain('read:account');
    expect(echo.ok === false && echo.reason).not.toMatch(/SECRET-zz9|canary-private-77/);
  });
  it("a GitHub source's in-band 401 (or one of an unnamed source) carries no Atlassian advice", async () => {
    const env401 = (message: string) => ({ content: [{ type: 'text', text: JSON.stringify({ error: true, message, statusCode: 401 }) }] });
    const gh = await listSourceTrackers(stub({ get_me: env401('Failed to fetch accessible products: 401') }).pm, entry('github', ['get_me', 'search_repositories']), '', {}, null);
    expect(gh).toMatchObject({ ok: false, code: 'vendor_error' });
    for (const r of [gh, readPayload(env401('Bad credentials')), readPayload(env401('Bad credentials'), 'gh (issue_read)', 'github')]) {
      expect(r.ok === false && r.reason).toContain('HTTP 401');
      expect(r.ok === false && r.reason).toContain('the sign-in reached it (check the token and its scopes)');
      expect(r.ok === false && r.reason).not.toMatch(/Atlassian|read:account|Jira/);
    }
  });
});

describe('an unknown shape names its structure, never a value', () => {
  const secretish = 'SECRET-VALUE-zz9';
  const weird = { content: [{ type: 'text', text: JSON.stringify({ result: { sites: 'none', [`${secretish}`]: 1, items: [{ cloud: secretish, n: 42 }] } }) }, { type: 'image', data: secretish }] };
  it('the outline names block types, field names and lengths', () => {
    const o = resultOutline(weird);
    expect(o).toContain('content 2 blocks');
    expect(o).toContain('text JSON object{result:object{sites:string,items:array(1)[object{+2 other keys}],+1 other key}}');
    expect(o).toContain('image');
    expect(o).not.toContain(secretish);
    expect(o).not.toContain('none');
    expect(o).not.toContain('42');
  });
  it('the site list refusal carries the outline (route reason), with no value', async () => {
    const { pm } = stub({ getAccessibleAtlassianResources: { content: [{ type: 'text', text: JSON.stringify({ data: { sites2: [{ cloud: secretish }] } }) }] } });
    const page = await listSourceTrackers(pm, entry('jira', ['getAccessibleAtlassianResources']), '', {}, null);
    expect(page).toMatchObject({ ok: false, code: 'unknown_shape' });
    if (!page.ok) {
      expect(page.reason).toContain('(got object{+1 other key})');
      expect(page.reason).not.toContain(secretish);
    }
    const two = readPayload({ content: [{ type: 'text', text: '{"total":1,"alice":2}' }, { type: 'text', text: '{"key":"x"}' }] }, 'jira (t)');
    expect(two).toMatchObject({ ok: false, code: 'unknown_shape' });
    expect(two.ok === false && two.reason).toContain('content 2 blocks: [text JSON object{total:number,+1 other key}; text JSON object{key:string}]');
    expect(two.ok === false && two.reason).not.toContain('alice');
  });
  it('a value that is not a plain field name is counted, not printed', () => {
    // Only crew's known field names are printed: a plain-looking key may be vendor data (a customer's name).
    expect(outlineOf({ 'PROJA-1': { x: 1 }, 'Story Points': 3, ConfidentialCustomerName: 1, key: 'K' })).toBe('object{key:string,+3 other keys}');
    expect(resultOutline({ content: [{ type: 'secret-ish-type', text: 'x' }] })).toContain('[other]');
    // Bounded, whatever the tree.
    const wide: Record<string, unknown> = {};
    for (const k of ['data', 'issues', 'fields', 'summary', 'status', 'key', 'self', 'id', 'url', 'name', 'items', 'values']) wide[k] = { data: { issues: { fields: { summary: { status: 1, key: 2, self: 3, id: 4, url: 5, name: 6 } } } } };
    expect(outlineOf(wide, 6).length).toBeLessThanOrEqual(701);
  });
});

describe('Jira v2 issues: no `self`, the site the gate bound is the proof', () => {
  it('getJiraIssue admits the recorded v2 issue on the vendor server, and not on any other server', () => {
    const { b, p } = prep('getJiraIssue', { issueIdOrKey: 'SQR-1' });
    expect(b.project(atlassianV2.issue, p, V2)).toMatchObject({ ok: true, items: [{ ref: 'SQR-1', trackerId: 'trk_sqr', value: { summary: 'Security questionnaire (synthetic)', statusCategory: 'todo', assignee: 'Pat Person', description: 'Steps:\n\n1. do it' } }] });
    expect(b.project(atlassianV2.issue, p)).toMatchObject({ ok: false, code: 'site_unproven' });
  });
  it('an answered key other than the one asked, or a project not linked, is refused even on the vendor server', () => {
    const { b, p } = prep('getJiraIssue', { issueIdOrKey: 'SQR-2' });
    expect(b.project(atlassianV2.issue, p, V2)).toMatchObject({ ok: false, code: 'outside_linked_set' });
  });
  it('an address, when present, must still prove the site: another site is refused on the vendor server too', () => {
    const { b, p } = prep('getJiraIssue', { issueIdOrKey: 'SQR-1' });
    const withSelf = (self: string) => ({ content: [{ type: 'text', text: JSON.stringify({ data: { key: 'SQR-1', self, fields: { summary: 's' } } }) }] });
    expect(b.project(withSelf(`https://api.atlassian.com/ex/jira/${SITE_ID}/rest/api/3/issue/1`), p, V2)).toMatchObject({ ok: true });
    expect(b.project(withSelf('https://api.atlassian.com/ex/jira/other-cloud/rest/api/3/issue/1'), p, V2)).toMatchObject({ ok: false, code: 'outside_linked_set' });
    expect(b.project(withSelf('https://evil.atlassian.net/rest/api/3/issue/1'), p, V2)).toMatchObject({ ok: false });
  });
  it('search reads the recorded {data:{issues,isLast}} and drops a project not linked', () => {
    const { b, p } = prep('searchJiraIssuesUsingJql', { jql: 'status = "To Do"' });
    const r = b.project(atlassianV2.search, p, V2);
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.items.map((i) => i.ref)).toEqual(['SQR-1', 'SQR-2']);
    expect(r.ok && r.items[1]!.value['statusCategory']).toBe('done');
    // Not the vendor's server: nothing proves a site.
    expect(b.project(atlassianV2.search, p)).toMatchObject({ ok: false, code: 'site_unproven' });
  });
  it('search reads the enveloped {issues:{nodes}} shape by its webUrl, and refuses a node on another host', () => {
    const { b, p } = prep('searchJiraIssuesUsingJql', { jql: '' });
    expect(b.project(atlassianV2.searchEnvelope, p)).toMatchObject({ ok: true, items: [{ ref: 'SQR-1' }, { ref: 'SQR-2' }] });
    const foreign = { content: [{ type: 'text', text: JSON.stringify({ issues: { nodes: [{ key: 'SQR-1', webUrl: 'https://other.atlassian.net/browse/SQR-1', fields: {} }] } }) }] };
    expect(b.project(foreign, p, V2)).toMatchObject({ ok: true, items: [] });
  });
  it('a mixed answer (some items addressed) proves each item: an unaddressed one is not admitted by the tenant', () => {
    const { b, p } = prep('searchJiraIssuesUsingJql', { jql: '' });
    const mixed = { content: [{ type: 'text', text: JSON.stringify({ issues: [{ key: 'SQR-1', self: `https://api.atlassian.com/ex/jira/${SITE_ID}/rest/api/3/issue/1`, fields: {} }, { key: 'SQR-2', fields: {} }] }) }] };
    const r = b.project(mixed, p, V2);
    expect(r.ok && r.items.map((i) => i.ref)).toEqual(['SQR-1']);
  });
  it('only an https mcp-http entry on mcp.atlassian.com is the vendor server', () => {
    expect(vendorBindsTenant({ kind: 'mcp-http', url: 'https://mcp.atlassian.com/v2/mcp' }, 'jira')).toBe(true);
    expect(vendorBindsTenant({ kind: 'mcp-http', url: 'https://mcp.atlassian.com.evil.example/v2/mcp' }, 'jira')).toBe(false);
    expect(vendorBindsTenant({ kind: 'mcp-http', url: 'https://user:pw@mcp.atlassian.com/v2/mcp' }, 'jira')).toBe(false);
    expect(vendorBindsTenant({ kind: 'mcp-http', url: 'http://mcp.atlassian.com/v2/mcp' }, 'jira')).toBe(false);
    expect(vendorBindsTenant({ kind: 'mcp-stdio', url: null }, 'jira')).toBe(false);
    expect(vendorBindsTenant({ kind: 'mcp-http', url: 'https://mcp.atlassian.com/v2/mcp' }, 'github')).toBe(false);
  });
  it('the tenant proves an address-free answer only when the credential reaches that one site', () => {
    const { b, p } = prep('getJiraIssue', { issueIdOrKey: 'SQR-1' });
    expect(b.project(atlassianV2.issue, p, { vendorBindsTenant: true, soleSite: null })).toMatchObject({ ok: false, code: 'site_unproven', reason: expect.stringContaining('reaches that one site') });
    expect(b.project(atlassianV2.issue, p, { vendorBindsTenant: true, soleSite: 'another-site' })).toMatchObject({ ok: false, code: 'site_unproven' });
    expect(b.project(atlassianV2.issue, p, { vendorBindsTenant: false, soleSite: SITE_ID })).toMatchObject({ ok: false, code: 'site_unproven' });
    const s = prep('searchJiraIssuesUsingJql', { jql: '' });
    expect(s.b.project(atlassianV2.search, s.p, { vendorBindsTenant: true, soleSite: null })).toMatchObject({ ok: false, code: 'site_unproven' });
  });
  it('an address is judged on the parsed URL: dot segments, encoded separators and another gateway tenant prove nothing', () => {
    expect(jiraProof({ self: `https://api.atlassian.com/ex/jira/${SITE_ID}/rest/api/3/issue/1` }, SITE_ID, SITE_HOST)).toBe('proved');
    expect(jiraProof({ webUrl: `https://api.atlassian.com/ex/jira/${SITE_ID}/../other/rest/api/3/issue/1` }, SITE_ID, SITE_HOST)).toBe('contradicted');
    expect(jiraProof({ self: `https://api.atlassian.com/ex/jira/${SITE_ID}%2F..%2Fother/x` }, SITE_ID, SITE_HOST)).toBe('contradicted');
    expect(jiraProof({ webUrl: `${SITE_URL}/browse/SQR-1` }, SITE_ID, SITE_HOST)).toBe('proved');
    expect(jiraProof({ webUrl: `https://user@${SITE_HOST}/browse/SQR-1` }, SITE_ID, SITE_HOST)).toBe('contradicted');
    expect(jiraProof({ self: 7 }, SITE_ID, SITE_HOST)).toBe('contradicted');
  });
  it('an error wrapped in data, or an error beside data, is the vendor error', () => {
    expect(readPayload({ content: [{ type: 'text', text: '{"data":{"error":true,"statusCode":403}}' }] })).toMatchObject({ ok: false, code: 'vendor_error', reason: expect.stringContaining('HTTP 403') });
    expect(readPayload({ content: [{ type: 'text', text: '{"error":{"status":401},"data":{"key":"SQR-1"}}' }] })).toMatchObject({ ok: false, code: 'vendor_error', reason: expect.stringContaining('HTTP 401') });
  });
  it('only an Atlassian scope is repeated from an error; any other text is not', () => {
    const r = (m: string) => readPayload({ content: [{ type: 'text', text: JSON.stringify({ error: true, message: m, statusCode: 403 }) }] });
    expect(r('Insufficient scopes. Required: read:me, read:account').ok === false && (r('Insufficient scopes. Required: read:me, read:account') as { reason: string }).reason).toContain('read:me, read:account');
    const shaped = r('Insufficient scopes. Required: read:acme-customer-x:jira');
    expect(shaped.ok === false && shaped.reason).not.toContain('acme');
    const leak = r('Insufficient scopes. Required: customer:confidential');
    expect(leak.ok === false && leak.reason).not.toContain('confidential');
    expect(leak.ok === false && leak.reason).toContain('HTTP 403');
  });
  it('an address that names another issue than the one answered is refused, even on its own site', () => {
    const { b, p } = prep('getJiraIssue', { issueIdOrKey: 'SQR-1' });
    const at = (extra: Record<string, unknown>) => ({ content: [{ type: 'text', text: JSON.stringify({ data: { key: 'SQR-1', id: '10036', fields: {}, ...extra } }) }] });
    expect(b.project(at({ webUrl: `${SITE_URL}/browse/SQR-1` }), p, V2)).toMatchObject({ ok: true });
    expect(b.project(at({ webUrl: `${SITE_URL}/browse/OTHER-9` }), p, V2)).toMatchObject({ ok: false, code: 'outside_linked_set' });
    expect(b.project(at({ self: `https://api.atlassian.com/ex/jira/${SITE_ID}/rest/api/3/issue/10036` }), p, V2)).toMatchObject({ ok: true });
    expect(b.project(at({ self: `https://api.atlassian.com/ex/jira/${SITE_ID}/rest/api/3/issue/20001` }), p, V2)).toMatchObject({ ok: false });
  });
  it('an embedded comment from another site or another issue is left out of the issue', () => {
    const { b, p } = prep('getJiraIssue', { issueIdOrKey: 'SQR-1' });
    const c = (self: string, body: string) => ({ self, body, author: { displayName: 'P' } });
    const r = b.project({ content: [{ type: 'text', text: JSON.stringify({ data: { key: 'SQR-1', id: '10036', fields: { comment: { comments: [
      c(`https://api.atlassian.com/ex/jira/${SITE_ID}/rest/api/3/issue/10036/comment/1`, 'mine'),
      c(`https://api.atlassian.com/ex/jira/${SITE_ID}/rest/api/3/issue/20001/comment/2`, 'other issue'),
      c('https://api.atlassian.com/ex/jira/other-site/rest/api/3/issue/10036/comment/3', 'other site'),
    ] } } } }) }] }, p, V2);
    expect(r.ok && (r.items[0]!.value['comments'] as Array<{ body: string }>).map((x) => x.body)).toEqual(['mine']);
  });
  it('Jira errorMessages dominate the data beside them; a flagged error inside data keeps its status', () => {
    expect(readPayload({ content: [{ type: 'text', text: '{"errorMessages":["x"],"issues":[{"key":"SQR-1"}]}' }] })).toMatchObject({ ok: false, code: 'vendor_error' });
    expect(readPayload({ isError: true, content: [{ type: 'text', text: '{"data":{"error":true,"statusCode":401}}' }] })).toMatchObject({ ok: false, code: 'vendor_error', reason: expect.stringContaining('HTTP 401') });
  });
  it('an error answered as data is the vendor error, not an empty page', () => {
    const { b, p } = prep('searchJiraIssuesUsingJql', { jql: '' });
    expect(b.project(atlassianV2.authError, p, V2)).toMatchObject({ ok: false, code: 'vendor_error' });
    expect(b.project(atlassianV2.flaggedError, p, V2)).toMatchObject({ ok: false, code: 'vendor_error', reason: expect.stringContaining('HTTP 404') });
  });
});

describe('listJiraIssueComments: bound to a linked key, restricted comments withheld', () => {
  it('binds the key, sets the site, caps the page, drops other arguments', () => {
    const { p } = prep('listJiraIssueComments', { issueIdOrKey: 'SQR-1', maxResults: 100, view: 'full', expand: 'renderedBody', cloudId: SITE_ID });
    expect(p.args).toEqual({ cloudId: SITE_ID, issueIdOrKey: 'SQR-1', maxResults: 20 });
    expect(bindingFor('jira', 'listJiraIssueComments')!.bindArgs({ issueIdOrKey: 'OTHER-1' }, linked)).toMatchObject({ ok: false, code: 'outside_linked_set' });
  });
  it('projects the recorded comments; role-limited and JSM-internal ones are withheld and counted', () => {
    const { b, p } = prep('listJiraIssueComments', { issueIdOrKey: 'SQR-1' });
    const r = b.project(atlassianV2.comments, p, V2);
    expect(r).toMatchObject({ ok: true, items: [{ ref: 'SQR-1', value: { key: 'SQR-1', total: 4, isLast: true, withheld: 2 } }] });
    const value = r.ok ? r.items[0]!.value : {};
    expect((value['comments'] as Array<Record<string, unknown>>).map((c) => c['body'])).toEqual(['Looks good', 'reply']);
    expect(JSON.stringify(value)).not.toContain('Admins only');
    expect(JSON.stringify(value)).not.toContain('internal note');
    expect(b.project(atlassianV2.comments, p)).toMatchObject({ ok: false, code: 'site_unproven' });
  });
});

describe('listJiraIssueComments: one issue, and a cut page is not the last', () => {
  const answer = (comments: unknown[], extra: Record<string, unknown> = {}) => ({ content: [{ type: 'text', text: JSON.stringify({ data: { comments, isLast: true, ...extra } }) }] });
  const at = (issue: string, id: number) => ({ id: String(id), self: `https://api.atlassian.com/ex/jira/${SITE_ID}/rest/api/3/issue/${issue}/comment/${id}`, body: `c${id}`, author: { displayName: 'P' } });
  it('comments of two issues in one answer are refused; an answer naming another issue anywhere is refused', () => {
    const { b, p } = prep('listJiraIssueComments', { issueIdOrKey: 'SQR-1' });
    expect(b.project(answer([at('10036', 1), at('10036', 2)]), p)).toMatchObject({ ok: true });
    expect(b.project(answer([at('10036', 1), at('20001', 2)]), p)).toMatchObject({ ok: false, code: 'outside_linked_set' });
    expect(b.project(answer([at('10036', 1)], { issueKey: 'OTHER-9' }), p)).toMatchObject({ ok: false, code: 'outside_linked_set' });
    expect(b.project(answer([at('10036', 1)], { issueKey: 'SQR-1', key: 'OTHER-9' }), p)).toMatchObject({ ok: false, code: 'outside_linked_set' });
    expect(b.project(answer([{ ...at('10036', 1), issueId: '20001' }]), p)).toMatchObject({ ok: false, code: 'outside_linked_set' });
    expect(b.project(answer([{ ...at('10036', 1), issueKey: 'OTHER-9' }]), p)).toMatchObject({ ok: false, code: 'outside_linked_set' });
    expect(b.project(answer(Array.from({ length: 201 }, (_, i) => at('10036', i + 1))), p)).toMatchObject({ ok: false, code: 'unknown_shape' });
  });
  it('a page crew cut says so and is not the last, whatever the vendor said', () => {
    const { b, p } = prep('listJiraIssueComments', { issueIdOrKey: 'SQR-1' });
    const r = b.project(answer(Array.from({ length: 25 }, (_, i) => at('10036', i + 1))), p);
    expect(r).toMatchObject({ ok: true, items: [{ value: { isLast: false, cut: 5 } }] });
    expect(r.ok && (r.items[0]!.value['comments'] as unknown[]).length).toBe(20);
  });
});

describe('the sites a credential reaches', () => {
  const sites = (list: unknown[]) => jiraSitesOf({ resources: list });
  it('an empty product list, or REST scopes of another product only, is no Jira site', () => {
    expect(sites([{ cloudId: 'a', url: 'https://a.atlassian.net', products: [] }])).toEqual([]);
    expect(jiraSitesOf([{ id: 'a', url: 'https://a.atlassian.net', scopes: ['read:page:confluence'] }])).toEqual([]);
    expect(jiraSitesOf([{ id: 'a', url: 'https://a.atlassian.net', scopes: [] }])).toHaveLength(1);
  });
  it('one site named at two hosts confirms neither host', () => {
    expect(jiraSitesOf([{ id: 'a', url: 'https://a.atlassian.net', scopes: ['read:jira-work'] }, { id: 'a', url: 'https://evil.atlassian.net', scopes: ['read:jira-work'] }])).toEqual([{ id: 'a', label: 'a.atlassian.net', host: null }]);
  });
  it('every distinct site id counts toward the sole site, whatever its products', () => {
    expect(atlassianSiteIdsOf({ resources: [{ cloudId: 'a', products: [{ id: 'jira' }] }, { cloudId: 'b', products: [{ id: 'confluence' }] }] })).toEqual(['a', 'b']);
    expect(atlassianSiteIdsOf([{ id: 'a' }, { id: 'a' }])).toEqual(['a']);
    expect(atlassianSiteIdsOf({ resources: [{ name: 'no id' }] })).toBeNull();
  });
  it('the gate reads the sole site from the vendor (Atlassian\'s own server only), with the answer\'s credential, for a minute', async () => {
    const invoked: string[] = [];
    let answer = atlassianV2.resources;
    let clock = 1_000;
    let secret = 'not-a-real-credential';
    const cred = (x: string) => createHash('sha256').update(x).digest('hex');
    const gate = new PmGate({
      store: { read: async () => ({ version: 1, servers: [] }) as never },
      secret: async () => secret,
      record: { append: async () => undefined },
      audit: { record: () => undefined },
      schedulers: { for: () => ({ admit: async () => ({ done: () => undefined }) }) } as never,
      invoke: (async (_config: unknown, _secret: unknown, tool: string) => { invoked.push(tool); return answer; }) as never,
      now: () => clock,
    });
    const e = { ...entry('jira', ['getAccessibleAtlassianResources']), record: { ...entry('jira', ['getAccessibleAtlassianResources']).record, auth: { ref: 'keychain:wicked-mcp/jira', header: 'Authorization', prefix: 'Basic ' } } as PmEntry['record'] };
    const c1 = cred(secret);
    expect(await gate.projectOpts(e, c1)).toEqual({ vendorBindsTenant: true, soleSite: SITE_ID });
    answer = { content: [{ type: 'text', text: JSON.stringify({ data: { resources: [{ cloudId: SITE_ID }, { cloudId: 'other' }] } }) }] };
    // Kept: within the minute, same credential.
    expect(await gate.projectOpts(e, c1)).toEqual({ vendorBindsTenant: true, soleSite: SITE_ID });
    expect(invoked).toEqual(['getAccessibleAtlassianResources']);
    // Past the minute: read again, and the token now reaches two sites.
    clock += 60_000;
    expect(await gate.projectOpts(e, c1)).toEqual({ vendorBindsTenant: true, soleSite: null });
    expect(invoked).toHaveLength(2);
    // The credential changed under the same reference: the cached proof is not reused, and a proof read with another
    // credential than the answer's proves nothing.
    answer = atlassianV2.resources;
    clock += 1;
    secret = 'another-credential';
    expect(await gate.projectOpts(e, c1)).toEqual({ vendorBindsTenant: true, soleSite: null });
    expect(await gate.projectOpts(e, cred('another-credential'))).toEqual({ vendorBindsTenant: true, soleSite: SITE_ID });
    expect(invoked).toHaveLength(3);
    const proxy = { ...e, id: 'e3', record: { ...e.record, url: 'https://jira-proxy.example/mcp' } as PmEntry['record'] };
    expect(await gate.projectOpts(proxy, c1)).toEqual({ vendorBindsTenant: false, soleSite: null });
    expect(invoked).toHaveLength(3);
  });
  it('two site lists, or a site whose cloudId and id disagree, prove no sole site; hosts conflict across products', () => {
    expect(atlassianSiteIdsOf({ resources: [{ cloudId: 'a' }], sites: [{ cloudId: 'a' }, { cloudId: 'b' }] })).toBeNull();
    expect(atlassianSiteIdsOf({ resources: [{ cloudId: 'a', id: 'b' }] })).toBeNull();
    expect(jiraSitesOf({ resources: [{ cloudId: 'a', url: 'https://a.atlassian.net', products: [{ id: 'jira' }] }, { cloudId: 'a', url: 'https://b.atlassian.net', products: [{ id: 'confluence' }] }] })).toEqual([{ id: 'a', label: 'a.atlassian.net', host: null }]);
  });
});

describe('account metadata: no issue rows', () => {
  it('atlassianUserInfo answers the account id only', () => {
    const { b, p } = prep('atlassianUserInfo', { anything: 1 });
    expect(p.args).toEqual({});
    expect(b.disclosure).toBe('structure');
    expect(b.project(atlassianV2.userInfo, p)).toMatchObject({ ok: true, items: [{ ref: 'account', value: { accountId: '712020:00000000-0000-4000-8000-000000000001' } }] });
  });
  it('getAccessibleAtlassianResources answers only the sites of the linked trackers', () => {
    const { b, p } = prep('getAccessibleAtlassianResources', {});
    expect(b.disclosure).toBe('structure');
    const r = b.project(atlassianV2.resourcesConfluenceOnly, p);
    expect(r).toMatchObject({ ok: true, items: [{ ref: `site:${SITE_ID}`, value: { cloudId: SITE_ID, url: SITE_URL } }] });
    expect(r.ok && r.items).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain('wiki-only');
  });
  it('Confluence, Teamwork Graph, Loom, People and the generic tools stay unbound', () => {
    for (const t of ['getConfluenceContent', 'searchConfluence', 'createConfluenceContent', 'getGraphContext', 'getGraphObject', 'addGraphContext', 'getLoomObjectsContent', 'getCollaborators', 'getPeopleInfo', 'getWorkActivity', 'getWorkPortfolio', 'discover', 'search', 'executeRead', 'executeWrite', 'executeDestructive', 'createJiraIssue', 'editJiraIssue', 'transitionJiraIssue', 'addOrEditJiraIssueComment']) {
      expect(bindingFor('jira', t)).toBeNull();
    }
  });
});

describe('github/github-mcp-server shapes (main 99d6d65)', () => {
  const gl: LinkedTracker[] = [{ trackerId: 'trk_app', tenant: 'github.com', key: 'owner/app', siteHost: null }];
  it('search_issues reads the raw search result and drops the pull request', () => {
    const { b, p } = prep('search_issues', { query: 'bug' }, gl);
    expect(b.project(githubMcp.searchIssues, p)).toMatchObject({ ok: true, items: [{ ref: 'owner/app#7', value: { title: 'Bug', labels: ['bug'] } }] });
  });
  it('issue_read get reads MinimalIssue (labels and assignees as strings)', () => {
    const { b, p } = prep('issue_read', { method: 'get', owner: 'owner', repo: 'app', issue_number: 7 }, gl);
    expect(b.project(githubMcp.issue, p)).toMatchObject({ ok: true, items: [{ ref: 'owner/app#7', value: { labels: ['bug'], assignees: ['sam'], author: 'pat' } }] });
  });
  it('issue_read get_comments reads the array of MinimalIssueComment', () => {
    const { b, p } = prep('issue_read', { method: 'get_comments', owner: 'owner', repo: 'app', issue_number: 7 }, gl);
    expect(b.project(githubMcp.comments, p)).toMatchObject({ ok: true, items: [{ value: { comments: [{ author: 'sam', body: 'me too' }] } }] });
  });
  it('get_me and search_repositories list the repositories; an error is the vendor error', async () => {
    const { pm } = stub({ get_me: githubMcp.me, search_repositories: githubMcp.repos });
    expect(await listSourceTrackers(pm, entry('github', ['get_me', 'search_repositories']), '', {}, null)).toMatchObject({ ok: true, rows: [{ tenant: 'github.com', key: 'owner/app' }] });
    const { b, p } = prep('search_issues', { query: 'bug' }, gl);
    expect(b.project(githubMcp.error, p)).toMatchObject({ ok: false, code: 'vendor_error' });
    expect(JSON.stringify(b.project(githubMcp.error, p))).not.toContain('Validation');
  });
});
