// A fake of github/github-mcp-server's issue tools (DES-PM-001 PM-1 tests), shaped like the real ones: `get_me`,
// `search_repositories` (MinimalSearchRepositoriesResult), `issue_read` (method get | get_comments; MinimalIssue,
// MinimalIssueComment), `list_issues` (MinimalIssuesResponse), `search_issues` ({total_count, items}),
// `add_issue_comment`, `issue_write`. No network, no real token: the credential is FAKE_PM_TOKEN.
//
//   node fake-github.mjs <log-dir>
//
// Every tools/call appends `{tool, args}` to <log-dir>/calls.ndjson. `search_issues` ignores its query and answers
// issues of owner/app AND owner/other; `list_issues` slips in one foreign issue; so only crew's response projector
// keeps foreign items out. Each item carries `_debug: <token>`. `<log-dir>/body.txt`, when present, is every issue's body.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const dir = process.argv[2];
const token = process.env.FAKE_PM_TOKEN ?? '';
const issue = (repo, n) => ({
  number: n,
  title: `${repo} issue ${n}`,
  body: (existsSync(join(dir, 'body.txt')) ? readFileSync(join(dir, 'body.txt'), 'utf8') : `Acceptance: ${repo}#${n} works.`),
  state: 'open',
  html_url: `https://github.com/${repo}/issues/${n}`,
  repository_url: `https://api.github.com/repos/${repo}`,
  user: { login: 'filer', avatar_url: 'https://avatars.example.invalid/u' },
  labels: ['bug', `t-${token}`],
  assignees: [],
  _debug: token,
});
const REPOS = ['owner/app', 'owner/other'];
const str = { type: 'string' };
const tools = [
  { name: 'get_me', description: 'me', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'search_repositories', description: 'repos', inputSchema: { type: 'object', properties: { query: str, page: { type: 'number' }, perPage: { type: 'number' } }, required: ['query'] }, annotations: { readOnlyHint: true } },
  { name: 'issue_read', description: 'read an issue', inputSchema: { type: 'object', properties: { method: str, owner: str, repo: str, issue_number: { type: 'number' }, page: { type: 'number' }, perPage: { type: 'number' } }, required: ['method', 'owner', 'repo', 'issue_number'] }, annotations: { readOnlyHint: true } },
  { name: 'list_issues', description: 'list issues', inputSchema: { type: 'object', properties: { owner: str, repo: str, state: str, perPage: { type: 'number' }, after: str }, required: ['owner', 'repo'] }, annotations: { readOnlyHint: true } },
  { name: 'search_issues', description: 'search issues', inputSchema: { type: 'object', properties: { query: str, owner: str, repo: str, perPage: { type: 'number' }, page: { type: 'number' } }, required: ['query'] }, annotations: { readOnlyHint: true } },
  { name: 'add_issue_comment', description: 'comment', inputSchema: { type: 'object', properties: { owner: str, repo: str, issue_number: { type: 'number' }, body: str }, required: ['owner', 'repo', 'issue_number', 'body'] }, annotations: { destructiveHint: false } },
  { name: 'issue_write', description: 'write an issue', inputSchema: { type: 'object', properties: { method: str, owner: str, repo: str, issue_number: { type: 'number' }, state: str }, required: ['method', 'owner', 'repo'] }, annotations: { destructiveHint: false } },
];
const server = new Server({ name: 'fake-github', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
const json = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = req.params.arguments ?? {};
  appendFileSync(join(dir, 'calls.ndjson'), `${JSON.stringify({ tool: name, args })}\n`);
  const repo = `${args.owner}/${args.repo}`;
  switch (name) {
    case 'get_me':
      return json({ login: 'pat-bot', id: 7 });
    case 'search_repositories': {
      const q = String(args.query ?? '');
      const m = /repo:([^\s]+)/.exec(q);
      const items = REPOS.filter((r) => (m ? r === m[1].toLowerCase() : true)).map((r, i) => ({ id: i + 1, name: r.split('/')[1], full_name: r, html_url: `https://github.com/${r}`, private: false, fork: false, archived: false, stargazers_count: 0, forks_count: 0, open_issues_count: 2 }));
      return json({ total_count: items.length, incomplete_results: false, items });
    }
    case 'issue_read':
      if (!REPOS.includes(repo)) return { isError: true, content: [{ type: 'text', text: 'Not Found' }] };
      if (args.method === 'get_comments') return json([{ id: 1, body: 'a comment', html_url: `https://github.com/${repo}/issues/${args.issue_number}#issuecomment-1`, user: { login: 'filer' } }, { id: 2, body: 'foreign', html_url: 'https://github.com/owner/other/issues/9#issuecomment-2', user: { login: 'x' } }]);
      return json(issue(repo, args.issue_number));
    case 'list_issues':
      return json({ issues: [issue(repo, 1), issue(repo, 2), issue('owner/other', 5)], totalCount: 3, pageInfo: { hasNextPage: true, endCursor: 'cur-2' } });
    case 'search_issues':
      return json({ total_count: 4, incomplete_results: false, items: [issue('owner/app', 1), issue('owner/other', 1), issue('owner/app', 2), issue('owner/other', 2)] });
    case 'add_issue_comment':
      return json({ id: 99, body: args.body, html_url: `https://github.com/${repo}/issues/${args.issue_number}#issuecomment-99` });
    case 'issue_write':
      return json({ ...issue(repo, args.issue_number), state: args.state ?? 'open' });
    default:
      return { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] };
  }
});
await server.connect(new StdioServerTransport());
