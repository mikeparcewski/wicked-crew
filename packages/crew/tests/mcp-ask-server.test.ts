import Fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AskServer } from '../src/mcp/ask-server.js';
import { registerMcpRoutes } from '../src/api/mcp.js';
import { LOCAL_ACTOR, registerAuthHooks } from '../src/api/auth.js';
import { AskError, type AskAdapter, type AskTicket, type AskUnit, type CoreEvent } from '../src/core/types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(timeoutSecs = 5, supported = true, now = Date.now) {
  const unit: AskUnit = { runId: 'run-1', ord: 3, attempt: 2, seat: 'codex', timeoutSecs };
  let serial = 0;
  const adapter = {
    askUnit: vi.fn<AskAdapter['askUnit']>(async () => unit),
    openAsk: vi.fn<AskAdapter['openAsk']>(async () => ({ ...unit, elicitationId: `ask-${++serial}` })),
    closeAsk: vi.fn<AskAdapter['closeAsk']>(async () => true),
  };
  const ask = new AskServer({ adapter, now });
  const app = Fastify({ forceCloseConnections: true });
  const disconnected = vi.fn<(question: string) => void>();
  app.addHook('preHandler', async (req, reply) => {
    const body = req.body as { method?: string; params?: { arguments?: { question?: string } } } | undefined;
    const question = body?.params?.arguments?.question;
    if (body?.method === 'tools/call' && question !== undefined) {
      reply.raw.on('close', () => { if (!reply.raw.writableEnded) disconnected(question); });
    }
  });
  const verify = vi.fn(async () => LOCAL_ACTOR);
  registerAuthHooks(app, { mode: 'required', verifiers: [{ name: 'test', verify }], allowedOrigins: null });
  registerMcpRoutes(app, {
    ...(supported ? { askServer: ask } : {}),
    audit: { record: vi.fn() }, actorOf: () => LOCAL_ACTOR,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP server');
  const url = new URL(`http://127.0.0.1:${address.port}/api/v1/mcp/ask`);
  cleanups.push(() => app.close());
  async function client(token = 'wmt_test') {
    const c = new Client({ name: 'ask-test', version: '1.0.0' });
    await c.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }) as Transport);
    cleanups.push(() => c.close());
    return c;
  }
  const ingest = (event: Partial<CoreEvent> = {}) => ask.ingest({ type: 'elicitationResolved', session: unit.runId, elicitationId: 'ask-1', action: 'accept', reason: 'human', answer: 'B', ...event });
  const post = (headers: Record<string, string> = { Authorization: 'Bearer wmt_test' }, body: unknown = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'ask', arguments: { question: 'Which?' } } }) => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body),
  });
  return { app, adapter, ask, unit, client, ingest, post, url, verify, disconnected };
}

describe('ask MCP over HTTP', () => {
  it('advertises the contract schema and annotations through the SDK', async () => {
    const f = await fixture();
    const c = await f.client();
    const { tools } = await c.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: 'ask', title: 'Ask the operator',
      inputSchema: {
        type: 'object', required: ['question'], additionalProperties: false,
        properties: {
          question: { type: 'string', minLength: 1, maxLength: 8192 },
          choices: { type: 'array', minItems: 2, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 512 } },
          recommended: { type: 'integer', minimum: 0, description: 'index into choices you recommend' },
        },
      },
      outputSchema: { type: 'object', required: ['status'], properties: { status: { enum: ['answered', 'declined', 'no_answer'] }, reason: { enum: ['timeout', 'cancelled', 'run_ended'] } } },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    });
    expect(f.adapter.openAsk).not.toHaveBeenCalled();
    expect(f.verify).not.toHaveBeenCalled();
  });

  it.each([
    ['accept', { status: 'answered', answer: 'B' }, 'The operator answered: B'],
    ['decline', { status: 'declined' }, 'The operator declined to answer. Continue with your best judgment and state the assumption in your output.'],
    ['cancel', { status: 'no_answer', reason: 'cancelled' }, 'No answer: the operator dismissed the question. Continue with your best judgment and state the assumption in your output.'],
  ])('returns the operator outcome %s', async (action, structuredContent, text) => {
    const f = await fixture();
    const c = await f.client();
    const pending = c.callTool({ name: 'ask', arguments: { question: 'Which?', choices: ['A', 'B'], recommended: 1 } });
    await vi.waitFor(() => expect(f.adapter.openAsk).toHaveBeenCalledTimes(1));
    f.ingest({ elicitationId: 'some-other-id' });
    f.ingest({ action });
    expect(await pending).toMatchObject({ isError: false, structuredContent, content: [{ type: 'text', text }] });
    expect(f.adapter.openAsk).toHaveBeenCalledWith({ token: 'wmt_test', question: 'Which?', choices: ['A', 'B'], recommended: 1 });
    expect(f.adapter.closeAsk).not.toHaveBeenCalled();
  });

  it('times out without waiting for closeAsk to settle', async () => {
    const f = await fixture(0.05);
    f.adapter.closeAsk.mockImplementation(() => new Promise(() => {}));
    const c = await f.client();
    const answer = await c.callTool({ name: 'ask', arguments: { question: 'Which?' } });
    expect(answer).toMatchObject({ isError: false, structuredContent: { status: 'no_answer', reason: 'timeout' }, content: [{ type: 'text', text: 'No answer: the operator did not answer within 0.05 s. Continue with your best judgment and state the assumption in your output.' }] });
    expect(f.adapter.closeAsk).toHaveBeenCalledExactlyOnceWith('ask-1', 'timeout');
  });

  it('a cancelled call (notifications/cancelled on a later POST) closes its question; another token cannot cancel it', async () => {
    const f = await fixture();
    const c = await f.client();
    const ctl = new AbortController();
    const pending = c.callTool({ name: 'ask', arguments: { question: 'Which?' } }, undefined, { signal: ctl.signal }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(f.adapter.openAsk).toHaveBeenCalledTimes(1));
    // A different seat naming the same JSON-RPC id is scoped out by its token.
    const other = await f.post({ Authorization: 'Bearer wmt_other' }, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
    expect(other.status).toBe(202);
    expect(f.adapter.closeAsk).not.toHaveBeenCalled();
    ctl.abort('operator moved on');
    await pending;
    await vi.waitFor(() => expect(f.adapter.closeAsk).toHaveBeenCalledExactlyOnceWith('ask-1', 'teardown'));
  });

  it('a cancellation that overtakes its call\'s token lookup still cancels it; the question never opens', async () => {
    const f = await fixture();
    let release!: (u: AskUnit) => void;
    f.adapter.askUnit.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const call = f.post(undefined, { jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'ask', arguments: { question: 'Which?' } } });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const cancel = await f.post(undefined, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 41 } });
    expect(cancel.status).toBe(202);
    release(f.unit);
    const body = await (await call).json() as { result?: { structuredContent?: unknown } };
    expect(body.result?.structuredContent).toMatchObject({ status: 'no_answer', reason: 'cancelled' });
    expect(f.adapter.openAsk).not.toHaveBeenCalled();
  });

  it('cancellation keeps the JSON-RPC id type: cancelling 7 leaves "7" waiting', async () => {
    const f = await fixture();
    const num = f.post(undefined, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'ask', arguments: { question: 'Numeric?' } } });
    await vi.waitFor(() => expect(f.adapter.openAsk).toHaveBeenCalledTimes(1));
    const str = f.post(undefined, { jsonrpc: '2.0', id: '7', method: 'tools/call', params: { name: 'ask', arguments: { question: 'String?' } } });
    await vi.waitFor(() => expect(f.adapter.openAsk).toHaveBeenCalledTimes(2));
    await f.post(undefined, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } });
    await vi.waitFor(() => expect(f.adapter.closeAsk).toHaveBeenCalledExactlyOnceWith('ask-1', 'teardown'));
    expect(await (await num).json()).toMatchObject({ result: { structuredContent: { reason: 'cancelled' } } });
    f.ingest({ elicitationId: 'ask-2', answer: 'S' });
    expect(await (await str).json()).toMatchObject({ result: { structuredContent: { status: 'answered', answer: 'S' } } });
  });

  it('refuses a JSON-RPC batch (MCP 2025-06-18 removed batching) before the engine sees it', async () => {
    const f = await fixture();
    const res = await f.post(undefined, [
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'ask', arguments: { question: 'One?' } } },
      { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'ask', arguments: { question: 'Two?' } } },
    ]);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: -32600 } });
    expect(f.adapter.askUnit).not.toHaveBeenCalled();
    expect(f.adapter.openAsk).not.toHaveBeenCalled();
  });

  it('closes an open prompt when the client aborts', async () => {
    const f = await fixture();
    const c = await f.client();
    const pending = c.callTool({ name: 'ask', arguments: { question: 'Which?' } }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(f.adapter.openAsk).toHaveBeenCalledTimes(1));
    await c.close();
    await pending;
    await vi.waitFor(() => expect(f.adapter.closeAsk).toHaveBeenCalledWith('ask-1', 'teardown'));
  });

  it.each(['sessionCompleted', 'runCancelled', 'sessionFailed'])('ends every call of the run on %s (the engine sweeps its questions)', async (type) => {
    const f = await fixture();
    const c = await f.client();
    const first = c.callTool({ name: 'ask', arguments: { question: 'First?' } });
    const second = c.callTool({ name: 'ask', arguments: { question: 'Second?' } });
    await vi.waitFor(() => expect(f.adapter.openAsk).toHaveBeenCalledTimes(2));
    f.ingest({ type, session: 'another-run' });
    f.ingest({ type });
    for (const value of await Promise.all([first, second])) expect(value).toMatchObject({ isError: false, structuredContent: { status: 'no_answer', reason: 'run_ended' } });
    expect(f.adapter.closeAsk).not.toHaveBeenCalled();
  });

  it('each call waits for its own question (the engine queues them per run; crew keeps no queue)', async () => {
    const f = await fixture();
    const c = await f.client();
    const first = c.callTool({ name: 'ask', arguments: { question: 'First?' } });
    await vi.waitFor(() => expect(f.adapter.openAsk).toHaveBeenCalledTimes(1));
    const second = c.callTool({ name: 'ask', arguments: { question: 'Second?' } });
    await vi.waitFor(() => expect(f.adapter.openAsk).toHaveBeenCalledTimes(2));
    f.ingest({ elicitationId: 'ask-2', answer: 'C' });
    expect(await second).toMatchObject({ structuredContent: { status: 'answered', answer: 'C' } });
    f.ingest({ elicitationId: 'ask-2', answer: 'stale' });
    f.ingest();
    expect(await first).toMatchObject({ structuredContent: { status: 'answered', answer: 'B' } });
  });

  it('a call that times out while its question is still queued closes it (the engine drops it unshown)', async () => {
    const f = await fixture();
    const c = await f.client();
    const first = c.callTool({ name: 'ask', arguments: { question: 'First?' } });
    await vi.waitFor(() => expect(f.adapter.openAsk).toHaveBeenCalledTimes(1));
    f.adapter.askUnit.mockResolvedValue({ ...f.unit, timeoutSecs: 0.05 });
    expect(await c.callTool({ name: 'ask', arguments: { question: 'Second?' } })).toMatchObject({ structuredContent: { reason: 'timeout' } });
    expect(f.adapter.closeAsk).toHaveBeenCalledExactlyOnceWith('ask-2', 'timeout');
    f.ingest();
    expect(await first).toMatchObject({ structuredContent: { status: 'answered' } });
  });

  it('a closeAsk that rejects or never settles neither wedges nor delays later calls', async () => {
    const f = await fixture(0.05);
    f.adapter.closeAsk.mockRejectedValueOnce(new Error('actor stopped')).mockImplementationOnce(() => new Promise(() => {}));
    const c = await f.client();
    for (const q of ['One?', 'Two?']) {
      expect(await c.callTool({ name: 'ask', arguments: { question: q } })).toMatchObject({ structuredContent: { reason: 'timeout' } });
    }
    f.adapter.askUnit.mockResolvedValue({ ...f.unit, timeoutSecs: 5 });
    const third = c.callTool({ name: 'ask', arguments: { question: 'Three?' } });
    await vi.waitFor(() => expect(f.adapter.openAsk).toHaveBeenCalledTimes(3));
    f.ingest({ elicitationId: 'ask-3', answer: 'A' });
    expect(await third).toMatchObject({ structuredContent: { status: 'answered', answer: 'A' } });
  });

  it.each([{}, { Authorization: 'Basic nope' }, { Authorization: 'Bearer two tokens' }])('refuses missing or malformed Authorization: %j', async (headers) => {
    const f = await fixture();
    const response = await f.post(headers);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 7, error: { code: -32001, message: 'invalid_token' } });
    expect(f.adapter.askUnit).not.toHaveBeenCalled();
    expect(f.verify).not.toHaveBeenCalled();
  });

  it('returns HTTP 401 for an unbound token (askUnit)', async () => {
    const f = await fixture();
    f.adapter.askUnit.mockRejectedValue(new AskError('invalid_token', 'invalid_token: expired'));
    const response = await f.post();
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: -32001, message: 'invalid_token' } });
  });

  it('a token unbound after askUnit is the tool error (the seat is going away)', async () => {
    const f = await fixture();
    f.adapter.openAsk.mockRejectedValue(new AskError('invalid_token', 'invalid_token: expired'));
    const response = await f.post();
    expect(response.status).toBe(200);
    const body = await response.json() as { result?: { isError?: boolean; content?: { text: string }[] } };
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain('invalid_token');
  });

  it.each([
    [{ question: '' }, 'question'],
    [{ question: 'Which?', choices: ['A'] }, 'choices'],
    [{ question: 'Which?', recommended: -1 }, 'recommended'],
    [{ question: 'Which?', recommended: 0 }, 'recommended'],
    [{ question: 'Which?', choices: ['A', 'B'], recommended: 2 }, 'recommended'],
    [{ question: 'Which?', choices: ['A', 'A'] }, 'choices'],
    [{ question: 'é'.repeat(4097) }, 'question'],
    [{ question: 'Which?', choices: ['A', 'é'.repeat(257)] }, 'choices'],
    [{ question: 'Which?', unexpected: true }, 'unexpected'],
  ])('returns a named tool error for invalid input %j', async (args, field) => {
    const f = await fixture();
    const c = await f.client();
    const response = await c.callTool({ name: 'ask', arguments: args });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toContain(field);
    expect(f.adapter.openAsk).not.toHaveBeenCalled();
  });

  it.each([
    [['A', 'B', 'A'], 2, ['A', 'B'], 0],
    [['A', 'A', 'B', 'C'], 2, ['A', 'B', 'C'], 1],
  ])('deduplicates choices %j and keeps the recommended CHOICE (index %i)', async (raw, rec, deduped, mapped) => {
    const f = await fixture();
    const c = await f.client();
    const pending = c.callTool({ name: 'ask', arguments: { question: 'Which?', choices: raw, recommended: rec } });
    await vi.waitFor(() => expect(f.adapter.openAsk).toHaveBeenCalledWith({ token: 'wmt_test', question: 'Which?', choices: deduped, recommended: mapped }));
    f.ingest();
    await pending;
  });

  it.each(['bad_request', 'run_ended'] as const)('maps openAsk %s', async (code) => {
    const f = await fixture();
    f.adapter.openAsk.mockRejectedValue(new AskError(code, `${code}: question`));
    const c = await f.client();
    const value = await c.callTool({ name: 'ask', arguments: { question: 'Which?' } });
    if (code === 'bad_request') expect(value).toMatchObject({ isError: true, content: [{ type: 'text', text: 'bad_request: question' }] });
    else expect(value).toMatchObject({ isError: false, structuredContent: { status: 'no_answer', reason: 'run_ended' } });
  });

  it.each(['GET', 'DELETE'])('refuses %s with Allow: POST', async (method) => {
    const f = await fixture();
    const response = await fetch(f.url, { method, headers: { Authorization: 'Bearer wmt_test' } });
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
    expect(f.verify).not.toHaveBeenCalled();
  });

  it('returns 503 when the addon has no ask seam', async () => {
    const f = await fixture(5, false);
    const response = await f.post();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'ask_unsupported' });
  });

  it('a multi-select: multi reaches the engine, and the picks come back as answers (guided asks)', async () => {
    const f = await fixture();
    f.adapter.openAsk.mockImplementation(async () => {
      f.ingest({ answer: '["main","develop"]' });
      return { ...f.unit, elicitationId: 'ask-1' };
    });
    const c = await f.client();
    const res = await c.callTool({ name: 'ask', arguments: { question: 'Which?', choices: ['main', 'release', 'develop'], multi: { max: 2 } } });
    expect(f.adapter.openAsk).toHaveBeenCalledWith(expect.objectContaining({ choices: ['main', 'release', 'develop'], multi: { max: 2 } }));
    expect(res).toMatchObject({ structuredContent: { status: 'answered', answer: 'main, develop', answers: ['main', 'develop'] }, content: [{ type: 'text', text: 'The operator picked: main, develop' }] });
  });

  it.each([
    [{ multi: {} }, 'multi requires choices'],
    [{ choices: ['a', 'b'], multi: { min: 2, max: 1 } }, 'multi must pick'],
    [{ choices: ['a', 'a', 'b'], multi: { max: 3 } }, 'multi must pick'],
  ])('refuses a malformed multi %j before the engine sees it', async (extra, words) => {
    const f = await fixture();
    const c = await f.client();
    const res = await c.callTool({ name: 'ask', arguments: { question: 'Which?', ...extra } });
    expect(res).toMatchObject({ isError: true });
    expect(JSON.stringify(res.content)).toContain(words);
    expect(f.adapter.openAsk).not.toHaveBeenCalled();
  });

  it('a single-choice answer that looks like an array stays the answer', async () => {
    const f = await fixture();
    f.adapter.openAsk.mockImplementation(async () => {
      f.ingest({ answer: '["x"]' });
      return { ...f.unit, elicitationId: 'ask-1' };
    });
    const c = await f.client();
    expect(await c.callTool({ name: 'ask', arguments: { question: 'Which?', choices: ['["x"]', 'y'] } })).toMatchObject({ structuredContent: { status: 'answered', answer: '["x"]' } });
  });

  it('keeps an answer that arrives before the open ticket', async () => {
    const f = await fixture();
    f.adapter.openAsk.mockImplementation(async () => {
      f.ingest();
      return { ...f.unit, elicitationId: 'ask-1' };
    });
    const c = await f.client();
    expect(await c.callTool({ name: 'ask', arguments: { question: 'Which?' } })).toMatchObject({ structuredContent: { status: 'answered', answer: 'B' } });
  });

  it.each(['timeout', 'run_ended', 'disconnect'] as const)('handles a ticket arriving after %s', async (outcome) => {
    const f = await fixture(outcome === 'timeout' ? 0.05 : 5);
    const c = await f.client();
    let opened!: (ticket: AskTicket) => void;
    f.adapter.openAsk.mockImplementation(() => new Promise((resolve) => { opened = resolve; }));
    const pending = c.callTool({ name: 'ask', arguments: { question: 'Which?' } }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(f.adapter.openAsk).toHaveBeenCalledTimes(1));
    if (outcome === 'run_ended') f.ingest({ type: 'runCancelled' });
    else if (outcome === 'disconnect') {
      await c.close();
      await vi.waitFor(() => expect(f.disconnected).toHaveBeenCalledWith('Which?'));
    }
    const value = await pending;
    if (outcome !== 'disconnect') expect(value).toMatchObject({ structuredContent: { status: 'no_answer', reason: outcome } });
    expect(f.adapter.closeAsk).not.toHaveBeenCalled();
    opened({ ...f.unit, elicitationId: 'late-ticket' });
    // A run that ended swept its own questions in the engine; a timeout or a client gone closes the late ticket.
    if (outcome === 'run_ended') {
      await new Promise((r) => setTimeout(r, 20));
      expect(f.adapter.closeAsk).not.toHaveBeenCalled();
    } else await vi.waitFor(() => expect(f.adapter.closeAsk).toHaveBeenCalledExactlyOnceWith('late-ticket', outcome === 'timeout' ? 'timeout' : 'teardown'));
  });

  it('a terminal frame during token lookup: the engine refuses the open with run_ended', async () => {
    const f = await fixture();
    const c = await f.client();
    let bound!: (unit: AskUnit) => void;
    f.adapter.askUnit.mockImplementation(() => new Promise((resolve) => { bound = resolve; }));
    const pending = c.callTool({ name: 'ask', arguments: { question: 'Which?' } });
    await vi.waitFor(() => expect(bound).toBeTypeOf('function'));
    f.ingest({ type: 'sessionCompleted' });
    // The engine, not crew, knows the run ended: its openAsk refuses a terminal run.
    f.adapter.openAsk.mockRejectedValueOnce(new AskError('run_ended', 'run_ended: run-1'));
    bound(f.unit);
    expect(await pending).toMatchObject({ structuredContent: { status: 'no_answer', reason: 'run_ended' } });
    expect(f.adapter.closeAsk).not.toHaveBeenCalled();
  });

  it('allows different runs to wait independently', async () => {
    const f = await fixture();
    f.adapter.askUnit.mockImplementation(async (token) => ({ ...f.unit, runId: token === 'wmt_other' ? 'run-2' : 'run-1' }));
    const firstClient = await f.client();
    const secondClient = await f.client('wmt_other');
    const first = firstClient.callTool({ name: 'ask', arguments: { question: 'First?' } });
    await vi.waitFor(() => expect(f.adapter.openAsk).toHaveBeenCalledTimes(1));
    const second = secondClient.callTool({ name: 'ask', arguments: { question: 'Second?' } });
    await vi.waitFor(() => expect(f.adapter.openAsk).toHaveBeenCalledTimes(2));
    f.ingest({ session: 'run-2', elicitationId: 'ask-2', answer: 'C' });
    expect(await second).toMatchObject({ structuredContent: { status: 'answered', answer: 'C' } });
    f.ingest();
    expect(await first).toMatchObject({ structuredContent: { status: 'answered', answer: 'B' } });
  });

  it('honors the deadline even when an event arrives before an overdue timer is dispatched', async () => {
    let now = 0;
    const f = await fixture(5, true, () => now);
    const c = await f.client();
    const first = c.callTool({ name: 'ask', arguments: { question: 'First?' } });
    await vi.waitFor(() => expect(f.adapter.openAsk).toHaveBeenCalledTimes(1));
    now = 5001;
    f.ingest();
    expect(await first).toMatchObject({ structuredContent: { status: 'no_answer', reason: 'timeout' } });
  });
});
