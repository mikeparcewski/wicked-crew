// PM-1 against the REAL vendor servers' result shapes (tests/fixtures/pm/recorded-shapes.ts names each source):
// Atlassian's v2 remote MCP server and github/github-mcp-server. Each parser test fails on the PM-1 code that was
// built against fake stdio servers only (the lane's red runs are in its ledger lines).

import { describe, expect, it } from 'vitest';

import { bindingFor, type LinkedTracker, outlineOf, readPayload, resultOutline, vendorBindsTenant } from '../src/knowledge/trackers/bindings.js';
import { listSourceTrackers, lookupTracker } from '../src/knowledge/trackers/routes.js';
import type { PmEntry } from '../src/knowledge/trackers/set.js';
import { atlassianV2, githubMcp, SITE_HOST, SITE_ID, SITE_URL } from './fixtures/pm/recorded-shapes.js';

const V2 = { vendorBindsTenant: true };
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
    const auth = await listSourceTrackers(stub({ getAccessibleAtlassianResources: atlassianV2.authError }).pm, entry('jira', ['getAccessibleAtlassianResources']), '', {}, null);
    expect(auth.ok === false && auth.reason).toMatch(/HTTP 401.*credential was refused/);
    expect(auth.ok === false && auth.reason).not.toContain('accessible products');
  });
});

describe('an unknown shape names its structure, never a value', () => {
  const secretish = 'SECRET-VALUE-zz9';
  const weird = { content: [{ type: 'text', text: JSON.stringify({ result: { sites: 'none', [`${secretish}`]: 1, items: [{ cloud: secretish, n: 42 }] } }) }, { type: 'image', data: secretish }] };
  it('the outline names block types, field names and lengths', () => {
    const o = resultOutline(weird);
    expect(o).toContain('content 2 blocks');
    expect(o).toContain('text JSON object{result:object{sites:string,items:array(1)[object{cloud,n}],+1 other key}}');
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
      expect(page.reason).toContain('object{sites2:array(1)[object{cloud:string}]}');
      expect(page.reason).not.toContain(secretish);
    }
    const two = readPayload({ content: [{ type: 'text', text: '{"a":1}' }, { type: 'text', text: '{"b":"x"}' }] }, 'jira (t)');
    expect(two).toMatchObject({ ok: false, code: 'unknown_shape' });
    expect(two.ok === false && two.reason).toContain('content 2 blocks: [text JSON object{a:number}; text JSON object{b:string}]');
  });
  it('a value that is not a plain field name is counted, not printed', () => {
    expect(outlineOf({ 'PROJA-1': { x: 1 }, 'Story Points': 3, ok: true })).toBe('object{ok:boolean,+2 other keys}');
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
