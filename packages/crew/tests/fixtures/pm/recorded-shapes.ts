// Recorded result shapes of the REAL vendor MCP servers, as an MCP client that is not on the vendor's allowlist gets
// them (crew's clientInfo is `wicked-crew-mcp-broker`, so no `structuredContent`). Values are synthetic; the structure
// (block types, wrappers, field names, where ids and addresses sit) is the recorded one. Sources, all public:
//
// Atlassian remote MCP server, `https://mcp.atlassian.com/v2/mcp` (closed source; recordings and reports):
//  - A1 a client's recorded v2 responses, 2026-10-12 (chief-builder/stewardry docs/connected/2026-10-12/responses.json):
//    `atlassianUserInfo`, `getAccessibleAtlassianResources`, `getJiraIssue`, and an error answer.
//  - A2 atlassian/atlassian-mcp-server#275 (v2, API-token Basic auth, direct JSON-RPC client): `getJiraIssue` answers
//    `{"data": {"appliedContentFormat", "id", "key", "fields"}}`, no `self`.
//  - A3 atlassian/atlassian-mcp-server#285, #241 and yurifws/aidlc-sandbox src/aidlc/jira/mcp_client.py: errors answer
//    `{"error": true, "message", "statusCode"}`, often WITHOUT `isError`; "Insufficient scopes. Required: read:me, read:account".
//  - A4 evanstern/praxisflux specs/056 phase-1 findings (live) and zero4573/tix internal/mcp/mcptest/server.go: search
//    answers `{issues, nextPageToken, isLast}` (issues `{key, fields}`), comments `{appliedContentFormat, comments}`.
//  - A5 atlassian/atlassian-mcp-server#118, #221, #225: the enveloped search `{issues: {totalCount, nodes, remainingCount,
//    webUrl, pageInfo}}`, nodes carrying `webUrl` (`https://<site>/browse/<KEY>`).
//  - A6 `listJiraIssueComments` (v2 tool description, the server's tools/list): `{comments, startAt, maxResults, total,
//    isLast}`, each comment with `visibility`, `jsdPublic`, `parentId`.
//
// GitHub `github/github-mcp-server` at main 99d6d6503a7b2a133e2f8a595d6d0ba24b4086d3 (source):
//  - G1 search_issues: pkg/github/search_utils.go searchHandler marshals go-github's IssuesSearchResult
//    (`{total_count, incomplete_results, items: [Issue]}`, items with `html_url`) into ONE text block.
//  - G2 issue_read get: pkg/github/issues.go getIssue -> MinimalIssue (minimal_types.go): labels and assignees as strings.
//  - G3 issue_read get_comments: a JSON array of MinimalIssueComment (`{id, body, html_url, user, created_at}`).
//  - G4 get_me: MinimalUser `{login, id, profile_url, avatar_url, details}`.
//  - G5 search_repositories: MinimalSearchRepositoriesResult `{total_count, incomplete_results, items: [{full_name}]}`.
//  - G6 errors: utils.NewToolResultError -> `{isError: true, content: [{type: 'text', text: '<words>'}]}` (not JSON).

const text = (v: unknown): Record<string, unknown> => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] });

export const SITE_ID = '11111111-2222-4333-8444-555555555555';
export const SITE_URL = 'https://example-site.atlassian.net';
export const SITE_HOST = 'example-site.atlassian.net';

export const atlassianV2 = {
  /** A1, verbatim structure. */
  userInfo: text('{"data":{"accountId":"712020:00000000-0000-4000-8000-000000000001"}}'),
  /** A1, verbatim structure: `cloudId` (not `id`), `url`, `products`; no `name`. */
  resources: text(`{"data":{"resources":[{"cloudId":"${SITE_ID}","url":"${SITE_URL}","products":[{"id":"jira","access":"read-only"},{"id":"confluence","access":"read-only"}]}]}}`),
  /** A1 shape with a Confluence-only site beside the Jira one. */
  resourcesConfluenceOnly: text(`{"data":{"resources":[{"cloudId":"${SITE_ID}","url":"${SITE_URL}","products":[{"id":"jira","access":"read-write"}]},{"cloudId":"99999999-2222-4333-8444-555555555555","url":"https://wiki-only.atlassian.net","products":[{"id":"confluence","access":"read-only"}]}]}}`),
  /** The REST accessible-resources shape (A3 #283: one entry per product, the same site twice). */
  resourcesRest: text([
    { id: SITE_ID, url: SITE_URL, name: 'example-site', scopes: ['read:jira-work'], avatarUrl: 'https://example.invalid/a.png' },
    { id: SITE_ID, url: SITE_URL, name: 'example-site', scopes: ['read:page:confluence'], avatarUrl: 'https://example.invalid/a.png' },
  ]),
  /** A1 + A2, verbatim structure: no `self`, `appliedContentFormat` INSIDE `data`. */
  issue: text('{"data":{"appliedContentFormat":"markdown","id":"10036","key":"SQR-1","fields":{"summary":"Security questionnaire (synthetic)","status":{"name":"To Do","statusCategory":{"key":"new"}},"assignee":{"displayName":"Pat Person","accountId":"712020:x"},"priority":{"name":"Medium"},"updated":"2026-10-12T17:36:57.781+0000","description":"Steps:\\n\\n1. do it","customFields":{},"attachment":[]}}}'),
  /** A4: the search text (`{data: {issues, nextPageToken, isLast}}`), issues `{id, key, fields}`, no `self`. */
  search: text('{"data":{"issues":[{"id":"10036","key":"SQR-1","fields":{"summary":"One","status":{"name":"To Do","statusCategory":{"key":"new"}},"project":{"key":"SQR","name":"Questionnaires"}}},{"id":"10037","key":"SQR-2","fields":{"summary":"Two","status":{"name":"Done","statusCategory":{"key":"done"}}}},{"id":"20001","key":"OTHER-1","fields":{"summary":"Not linked"}}],"isLast":true}}'),
  /** A5: the enveloped search, nodes carrying `webUrl`. */
  searchEnvelope: text(`{"issues":{"totalCount":2,"nodes":[{"key":"SQR-1","webUrl":"${SITE_URL}/browse/SQR-1","fields":{"summary":"One"}},{"key":"SQR-2","webUrl":"${SITE_URL}/browse/SQR-2","fields":{"summary":"Two"}}],"remainingCount":0,"webUrl":"${SITE_URL}/issues?jql=x","pageInfo":{"hasNextPage":false,"endCursor":null}}}`),
  /** A6 + A4: comments, one limited to a role, one JSM-internal, one a reply. */
  comments: text('{"data":{"appliedContentFormat":"markdown","comments":[{"id":"100","author":{"displayName":"Pat Person","accountId":"712020:x"},"created":"2026-10-12T10:00:00.000+0000","updated":"2026-10-12T10:00:00.000+0000","body":"Looks good","jsdPublic":true},{"id":"101","author":{"displayName":"Sam"},"created":"2026-10-12T11:00:00.000+0000","body":"Admins only","visibility":{"type":"role","value":"Administrators"}},{"id":"102","author":{"displayName":"Agent"},"created":"2026-10-12T12:00:00.000+0000","body":"internal note","jsdPublic":false},{"id":"103","author":{"displayName":"Pat Person"},"created":"2026-10-12T13:00:00.000+0000","body":"reply","parentId":"100"}],"startAt":0,"maxResults":20,"total":4,"isLast":true}}'),
  /** A3: an error envelope with no `isError` (the shape the 503 on :7721 most likely hid). */
  scopeError: text('{"error":true,"message":"Insufficient scopes. Required: read:me, read:account","statusCode":403}'),
  /** A3: a 401 envelope. */
  authError: text('{"error":true,"message":"Failed to fetch accessible products: 401","statusCode":401}'),
  /** A1: an error flagged `isError`, its words naming a vendor detail. */
  flaggedError: { isError: true, content: [{ type: 'text', text: '{"error":true,"message":"getJiraIssue failed: 404. Details: {\\"errors\\":[{\\"status\\":404}]}","statusCode":404}' }] },
  /** A #213-style answer with a `context` sibling beside `data`. */
  resourcesWithContext: text(`{"data":{"resources":[{"cloudId":"${SITE_ID}","url":"${SITE_URL}","products":[{"id":"jira"}]}]},"context":{"mcpClientName":"unknown","endpoint":"v2:streamable-http"}}`),
};

export const githubMcp = {
  /** G1: the raw search result, items with `html_url` (a pull request item too). */
  searchIssues: text({
    total_count: 2,
    incomplete_results: false,
    items: [
      { id: 1, number: 7, title: 'Bug', state: 'open', html_url: 'https://github.com/owner/app/issues/7', url: 'https://api.github.com/repos/owner/app/issues/7', repository_url: 'https://api.github.com/repos/owner/app', user: { login: 'pat' }, labels: [{ name: 'bug' }], assignees: [], comments: 1, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z', body: 'it breaks' },
      { id: 2, number: 8, title: 'PR', state: 'open', html_url: 'https://github.com/owner/app/pull/8', pull_request: { url: 'x' }, user: { login: 'pat' } },
    ],
  }),
  /** G2: MinimalIssue. */
  issue: text({ number: 7, title: 'Bug', body: 'it breaks', state: 'open', html_url: 'https://github.com/owner/app/issues/7', user: { login: 'pat', id: 1, profile_url: 'https://github.com/pat' }, labels: ['bug'], assignees: ['sam'], comments: 1, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z', closed_by_pull_requests: { total_count: 0, references: [] } }),
  /** G3: an array of MinimalIssueComment. */
  comments: text([{ id: 11, body: 'me too', html_url: 'https://github.com/owner/app/issues/7#issuecomment-11', user: { login: 'sam' }, created_at: '2026-10-03T00:00:00Z' }]),
  /** G4: MinimalUser. */
  me: text({ login: 'pat', id: 1, profile_url: 'https://github.com/pat', avatar_url: 'https://avatars.example/1', details: { name: 'Pat' } }),
  /** G5: MinimalSearchRepositoriesResult. */
  repos: text({ total_count: 1, incomplete_results: false, items: [{ id: 3, name: 'app', full_name: 'owner/app', html_url: 'https://github.com/owner/app' }] }),
  /** G6: an error, words not JSON. */
  error: { isError: true, content: [{ type: 'text', text: 'failed to search issues: GET https://api.github.com/search/issues: 422 Validation Failed' }] },
};
