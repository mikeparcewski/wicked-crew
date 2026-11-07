// A fake of the Atlassian remote MCP server's Jira tools (DES-PM-001 PM-1 tests), shaped like the real ones
// (`getAccessibleAtlassianResources`, `listJiraProjects`, `getJiraIssue`, `searchJiraIssuesUsingJql`,
// `listJiraIssueTransitions`, `transitionJiraIssue`, `addOrEditJiraIssueComment`, `atlassianUserInfo`, Rovo `search`).
// No network, no real token: the credential is FAKE_PM_TOKEN (the registry's auth.env).
//
//   node fake-jira.mjs <log-dir>
//
// Every tools/call appends `{tool, args}` to <log-dir>/calls.ndjson BEFORE it answers.
// A file `<log-dir>/overbroad`: searches ignore the JQL and answer every issue of EVERY site (each with its own `self`), and a
// get answers the issue whatever was asked for; so only crew's response projector keeps foreign items out.
// Each issue carries `_debug: <token>`, so an answer that passed fields through would leak it.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const dir = process.argv[2];
const token = process.env.FAKE_PM_TOKEN ?? '';
const overbroad = existsSync(join(dir, 'overbroad'));
const SITES = [
  { id: 'c1', name: 'acme', url: 'https://acme.atlassian.net', projects: ['PROJA', 'PROJB', 'PROJC', 'PROJX', 'PROJ'] },
  { id: 'c2', name: 'acme-two', url: 'https://acme-two.atlassian.net', projects: ['PROJA', 'PROJ'] },
];
const issue = (site, key, n, extra = {}) => ({
  id: `${site.id}-${key}-${n}`,
  key: `${key}-${n}`,
  // `<log-dir>/siteform`: the site's own address form (`https://<site>.atlassian.net/…`) instead of the gateway's.
  self: existsSync(join(dir, 'siteform')) ? `${site.url}/rest/api/3/issue/${site.id}-${key}-${n}` : `https://api.atlassian.com/ex/jira/${site.id}/rest/api/3/issue/${site.id}-${key}-${n}`,
  _debug: token,
  fields: {
    summary: `${key}-${n} on ${site.name}`,
    status: { name: 'To Do', statusCategory: { key: 'new' } },
    project: { key, name: `${key} project` },
    issuetype: { name: 'Task' },
    description: extra.description ?? { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `Acceptance: ${key}-${n} works on ${site.name}. (leaked ${token})` }] }] },
    labels: ['pm', `t-${token}`],
  },
});
const ISSUES = SITES.flatMap((s) => s.projects.flatMap((k) => [1, 2].map((n) => ({ site: s.id, v: issue(s, k, n) }))));
const str = { type: 'string' };
const tools = [
  { name: 'getAccessibleAtlassianResources', description: 'sites', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'atlassianUserInfo', description: 'me', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'listJiraProjects', description: 'projects', inputSchema: { type: 'object', properties: { cloudId: str, searchString: str, startAt: { type: 'number' }, maxResults: { type: 'number' } }, required: ['cloudId'] }, annotations: { readOnlyHint: true } },
  { name: 'getJiraIssue', description: 'an issue', inputSchema: { type: 'object', properties: { cloudId: str, issueIdOrKey: str, fields: { type: 'array', items: str } }, required: ['cloudId', 'issueIdOrKey'] }, annotations: { readOnlyHint: true } },
  { name: 'searchJiraIssuesUsingJql', description: 'search', inputSchema: { type: 'object', properties: { cloudId: str, jql: str, maxResults: { type: 'number' }, nextPageToken: str, fields: { type: 'array', items: str } }, required: ['cloudId', 'jql'] }, annotations: { readOnlyHint: true } },
  { name: 'listJiraIssueTransitions', description: 'transitions', inputSchema: { type: 'object', properties: { cloudId: str, issueIdOrKey: str }, required: ['cloudId', 'issueIdOrKey'] }, annotations: { readOnlyHint: true } },
  { name: 'transitionJiraIssue', description: 'move', inputSchema: { type: 'object', properties: { cloudId: str, issueIdOrKey: str, transition: { type: 'object' } }, required: ['cloudId', 'issueIdOrKey', 'transition'] }, annotations: { destructiveHint: false } },
  { name: 'addOrEditJiraIssueComment', description: 'comment', inputSchema: { type: 'object', properties: { cloudId: str, issueIdOrKey: str, commentBody: str }, required: ['cloudId', 'issueIdOrKey', 'commentBody'] }, annotations: { destructiveHint: false } },
  { name: 'search', description: 'Rovo search across Jira and Confluence', inputSchema: { type: 'object', properties: { query: str } }, annotations: { readOnlyHint: true } },
  { name: 'listJiraProjectIssueTypesMetadata', description: 'issue types', inputSchema: { type: 'object', properties: { cloudId: str, projectIdOrKey: str }, required: ['cloudId', 'projectIdOrKey'] }, annotations: { readOnlyHint: true } },
  { name: 'listJiraStatuses', description: 'statuses', inputSchema: { type: 'object', properties: { cloudId: str, projectIdOrKey: str }, required: ['cloudId'] }, annotations: { readOnlyHint: true } },
];
const server = new Server({ name: 'fake-atlassian', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
const json = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = req.params.arguments ?? {};
  appendFileSync(join(dir, 'calls.ndjson'), `${JSON.stringify({ tool: name, args })}\n`);
  const site = SITES.find((s) => s.id === args.cloudId);
  // `<log-dir>/nosites`: an API token Atlassian cannot resolve sites for (a scoped token without read:account): every
  // site call answers the v2 server's in-band 401, whatever cloudId says (atlassian-mcp-server#285).
  if (existsSync(join(dir, 'nosites')) && (name === 'getAccessibleAtlassianResources' || args.cloudId !== undefined)) {
    return json({ error: true, message: 'Failed to fetch accessible products: 401', statusCode: 401 });
  }
  switch (name) {
    case 'getAccessibleAtlassianResources':
      return json(SITES.map((s) => ({ id: s.id, name: s.name, url: s.url, scopes: ['read:jira-work'] })));
    case 'atlassianUserInfo':
      return json({ account_id: 'acct-1', name: 'Pat Person', email: 'pat@example.invalid' });
    case 'listJiraProjects': {
      if (site === undefined) return { isError: true, content: [{ type: 'text', text: 'no such site' }] };
      const q = String(args.searchString ?? '').toUpperCase();
      const values = site.projects.filter((k) => q === '' || k.includes(q)).map((k) => ({ key: k, name: `${k} project`, id: `${site.id}-${k}` }));
      return json({ values, total: values.length, isLast: true, startAt: 0 });
    }
    case 'getJiraIssue': {
      // A crash that prints the credential (as a broken server might): crew's log must not keep it.
      if (args.issueIdOrKey === 'PROJA-666') {
        process.stderr.write(`fatal: auth ${token} ${JSON.stringify(token)}\n`);
        process.exit(3);
      }
      if (overbroad) return json(ISSUES.find((i) => i.v.key === 'PROJC-1').v);
      const hit = ISSUES.find((i) => i.site === args.cloudId && i.v.key === args.issueIdOrKey);
      if (hit === undefined) return { isError: true, content: [{ type: 'text', text: `Issue ${args.issueIdOrKey} does not exist` }] };
      if (existsSync(join(dir, 'body.txt'))) return json({ ...hit.v, fields: { ...hit.v.fields, description: readFileSync(join(dir, 'body.txt'), 'utf8') } });
      return json(hit.v);
    }
    case 'searchJiraIssuesUsingJql': {
      // Over-broad: every site's issues, plus a PROJA issue with no address at all (it cannot prove its site).
      if (overbroad) return json({ issues: [...ISSUES.map((i) => i.v), { ...issue(SITES[1], 'PROJA', 9), self: undefined }], total: ISSUES.length + 1, isLast: false, nextPageToken: 'tok-next' });
      // Every `project in (…)` clause is ANDed, as Jira does.
      const lists = [...String(args.jql ?? '').matchAll(/project\s+in\s*\(([^)]*)\)/gi)].map((m) => m[1].split(',').map((x) => x.trim().replace(/^"|"$/g, '')));
      const issues = ISSUES.filter((i) => i.site === args.cloudId && lists.every((l) => l.includes(i.v.fields.project.key))).map((i) => i.v);
      return json({ issues, total: issues.length, isLast: true });
    }
    case 'listJiraIssueTransitions':
      return json({ transitions: [{ id: '21', name: 'Start review', to: { name: 'In Review', statusCategory: { key: 'indeterminate' } } }, { id: '31', name: 'Done', to: { name: 'Done', statusCategory: { key: 'done' } } }] });
    case 'transitionJiraIssue':
      return json({ ok: true });
    case 'addOrEditJiraIssueComment':
      // `<log-dir>/commenterror`: the Atlassian v2 server's error answer, as data and without `isError`.
      if (existsSync(join(dir, 'commenterror'))) return json({ error: true, message: 'addOrEditJiraIssueComment failed: 403', statusCode: 403 });
      return json({ id: 'cm-1', body: args.commentBody });
    case 'listJiraProjectIssueTypesMetadata':
      return json({ issueTypes: [{ id: '1', name: 'Task' }, { id: '2', name: 'Bug' }], total: 2 });
    case 'listJiraStatuses':
      return json({ values: [{ name: 'To Do', statusCategory: 'TODO' }, { name: 'In Review', statusCategory: 'IN_PROGRESS' }, { name: 'Done', statusCategory: 'DONE' }] });
    case 'search':
      return json({ results: ISSUES.map((i) => i.v) });
    default:
      return { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] };
  }
});
await server.connect(new StdioServerTransport());
