// DES-APPS-001 shared fixtures: the test services an Apps source reads from (K1 adds them; K2b, K6
// and the E2E reuse them). Each starts on 127.0.0.1 on an ephemeral port and answers its own
// origin. Plain ESM so any lane (vitest, a script, a container) can import it.
//
//   startOpenApiService()  an OpenAPI 3 service: GET /tickets?page=N answers a NESTED paginated body
//                          ({ data: { items: [...], page: { next } } }), GET /tickets/{id},
//                          POST /tickets/{id}/assign (a write); the document at /openapi.json.
//   startGraphqlServer()   POST /graphql: query { tickets(status) { id owner status } ticket(id) },
//                          mutation assign(id, owner); enum Status; introspection on.
//   startMcpServer()       the reference MCP server over streamable HTTP at /mcp: `list_tickets`
//                          (readOnlyHint) and `assign_ticket` (a write).
//
// Every server records what reached it (`hits`), so a test can prove a refused call never did.

import { createServer } from 'node:http';

import { buildSchema, graphql } from 'graphql';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export const TICKETS = Array.from({ length: 25 }, (_v, i) => ({
  id: 4800 + i,
  owner: i % 3 === 0 ? 'nobody' : `agent${i % 5}`,
  status: i % 4 === 0 ? 'CLOSED' : 'OPEN',
  region: ['EMEA', 'AMER', 'APAC'][i % 3],
}));

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { port, origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

async function bodyOf(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

export const OPENAPI_DOC = (origin) => ({
  openapi: '3.0.3',
  info: { title: 'Tickets test service', version: '1.0.0' },
  servers: [{ url: `${origin}/v1` }],
  paths: {
    '/tickets': {
      get: {
        operationId: 'listTickets',
        summary: 'List tickets, one page at a time',
        parameters: [{ name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } }],
        responses: { 200: { description: 'a page', content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
    '/tickets/{id}': {
      get: { operationId: 'getTicket', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'one ticket' } } },
    },
    '/tickets/{id}/assign': {
      post: {
        operationId: 'assignTicket',
        summary: 'Assign a ticket',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { owner: { type: 'string' } }, required: ['owner'] } } } },
        responses: { 200: { description: 'assigned' } },
      },
    },
  },
});

/** The OpenAPI test service. Page size 10; `page.next` is null on the last page. */
export async function startOpenApiService() {
  const hits = [];
  const tickets = TICKETS.map((t) => ({ ...t }));
  let origin = '';
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin);
    const body = await bodyOf(req);
    hits.push({ method: req.method, path: url.pathname + url.search, body, headers: req.headers });
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/openapi.json') return json(200, OPENAPI_DOC(origin));
    if (req.method === 'GET' && url.pathname === '/v1/tickets') {
      const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));
      const items = tickets.slice((page - 1) * 10, page * 10);
      return json(200, { data: { items, page: { number: page, next: page * 10 < tickets.length ? page + 1 : null } } });
    }
    const one = /^\/v1\/tickets\/(\d+)(\/assign)?$/.exec(url.pathname);
    if (one !== null) {
      const t = tickets.find((x) => x.id === Number(one[1]));
      if (t === undefined) return json(404, { error: 'no such ticket' });
      if (one[2] === undefined && req.method === 'GET') return json(200, t);
      if (one[2] !== undefined && req.method === 'POST') {
        t.owner = JSON.parse(body || '{}').owner ?? t.owner;
        return json(200, t);
      }
    }
    return json(404, { error: 'not found' });
  });
  const l = await listen(server);
  origin = l.origin;
  return { ...l, hits, tickets };
}

const GRAPHQL_SDL = `
  enum Status { OPEN CLOSED }
  type Ticket { id: Int! owner: String! status: Status! region: String! }
  type Query { tickets(status: Status): [Ticket!]! ticket(id: Int!): Ticket }
  type Mutation { assign(id: Int!, owner: String!): Ticket }
`;

/** The GraphQL test server. */
export async function startGraphqlServer() {
  const hits = [];
  const tickets = TICKETS.map((t) => ({ ...t }));
  const schema = buildSchema(GRAPHQL_SDL);
  const root = {
    tickets: ({ status }) => tickets.filter((t) => status === undefined || status === null || t.status === status),
    ticket: ({ id }) => tickets.find((t) => t.id === id) ?? null,
    assign: ({ id, owner }) => {
      const t = tickets.find((x) => x.id === id);
      if (t !== undefined) t.owner = owner;
      return t ?? null;
    },
  };
  const server = createServer(async (req, res) => {
    const body = await bodyOf(req);
    hits.push({ method: req.method, path: req.url, body, headers: req.headers });
    if (req.method !== 'POST' || req.url !== '/graphql') {
      res.writeHead(404).end();
      return;
    }
    const { query, variables } = JSON.parse(body || '{}');
    const result = await graphql({ schema, source: query, rootValue: root, variableValues: variables });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  });
  return { ...(await listen(server)), hits, tickets };
}

/** The reference MCP server, over streamable HTTP (stateless, JSON responses). */
export async function startMcpServer() {
  const hits = [];
  const tickets = TICKETS.map((t) => ({ ...t }));
  const server = createServer(async (req, res) => {
    const body = await bodyOf(req);
    hits.push({ method: req.method, path: req.url, body });
    const mcp = new McpServer({ name: 'tickets-reference', version: '1.0.0' });
    mcp.registerTool(
      'list_tickets',
      { description: 'List tickets', inputSchema: { status: z.enum(['OPEN', 'CLOSED']).optional() }, annotations: { readOnlyHint: true } },
      async ({ status }) => {
        const rows = tickets.filter((t) => status === undefined || t.status === status);
        return { content: [{ type: 'text', text: JSON.stringify(rows) }], structuredContent: { tickets: rows } };
      },
    );
    mcp.registerTool(
      'assign_ticket',
      { description: 'Assign a ticket', inputSchema: { id: z.int(), owner: z.string() }, annotations: { readOnlyHint: false, destructiveHint: false } },
      async ({ id, owner }) => {
        const t = tickets.find((x) => x.id === id);
        if (t !== undefined) t.owner = owner;
        return { content: [{ type: 'text', text: JSON.stringify(t ?? null) }] };
      },
    );
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body === '' ? undefined : JSON.parse(body));
    res.on('close', () => void mcp.close());
  });
  return { ...(await listen(server)), hits, tickets };
}
