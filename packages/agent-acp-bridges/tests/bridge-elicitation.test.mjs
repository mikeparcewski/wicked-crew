/**
 * In-process bridge tests: session/create_elicitation + session/elicitation_resolved (DES-002).
 *
 * The bridge is driven entirely through injectable streams (_streams / _exit) so no real
 * child process is spawned and no process.exit fires. Each test gets its own bridge instance
 * via createTestBridge().
 *
 * Test inventory (21):
 *   1.  initialize → protocolVersion:1 + serverInfo
 *   2.  session/new → sessionId UUID
 *   3.  session/new sets currentSessionId for elicitation routing
 *   4.  create_elicitation with mismatched sessionId → -32602
 *   5.  create_elicitation valid → notification then blocked (pending)
 *   6.  elicitation_resolved accept → resolves create_elicitation response
 *   7.  elicitation_resolved decline → result.action='decline'
 *   8.  elicitation_resolved cancel → result.action='cancel'
 *   9.  elicitation_resolved notification (no id) → no ack sent; still resolves
 *  10.  mode absent → treated as form (no error)
 *  11.  mode:'other' → -32602
 *  12.  missing requestedSchema → -32602
 *  13.  extra top-level key in requestedSchema → -32602
 *  14.  requestedSchema.type !== 'object' → -32602
 *  15.  requestedSchema.required has non-response element → -32602
 *  16.  properties not exactly {response} → -32602
 *  17.  response property type !== 'string' → -32602
 *  18.  extra key in response property → -32602
 *  19.  enum with non-string member → -32602
 *  20.  empty enum → -32602
 *  21.  session/new while create_elicitation pending → prior resolves with cancel
 */

import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runBridge } from '../bridge.mjs';

// ── Test harness ───────────────────────────────────────────────────────────────

/**
 * Creates a wired bridge instance with injectable stdin/stdout and a spy exit.
 *
 * Returns helpers:
 *   send(msg)   – write one JSON-RPC message to stdin
 *   next()      – promise for the next line on stdout (FIFO across concurrent calls)
 *   close()     – push EOF to stdin (triggers rl 'close')
 *   exitSpy     – vi.fn() replacing process.exit
 */
function createTestBridge(invocationFn = () => ({ bin: 'true', args: [] })) {
  const input = new PassThrough();
  const output = new PassThrough();
  const exitSpy = vi.fn();

  runBridge({
    name: 'test-bridge',
    version: '0.0.0',
    invocation: invocationFn,
    _streams: { input, output },
    _exit: exitSpy,
  });

  const received = [];
  const waiters = [];
  let buf = '';

  output.on('data', (chunk) => {
    buf += chunk.toString();
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    for (const line of parts) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (waiters.length > 0) waiters.shift()(msg);
      else received.push(msg);
    }
  });

  function send(msg) {
    input.write(JSON.stringify(msg) + '\n');
  }

  function next(timeoutMs = 1000) {
    if (received.length > 0) return Promise.resolve(received.shift());
    return new Promise((resolve, reject) => {
      waiters.push(resolve);
      setTimeout(() => {
        const idx = waiters.indexOf(resolve);
        if (idx !== -1) {
          waiters.splice(idx, 1);
          reject(new Error('bridge next() timed out'));
        }
      }, timeoutMs);
    });
  }

  function close() {
    input.push(null);
  }

  return { send, next, close, exitSpy };
}

/** Minimal valid requestedSchema for a free-text response. */
const FREE_TEXT_SCHEMA = {
  type: 'object',
  properties: { response: { type: 'string' } },
};

/** Minimal valid requestedSchema with an enum. */
const ENUM_SCHEMA = {
  type: 'object',
  required: ['response'],
  properties: { response: { type: 'string', enum: ['yes', 'no'] } },
};

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Perform initialize + session/new and return sessionId. */
async function handshake(b) {
  b.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const initRes = await b.next();
  expect(initRes.result).toBeDefined();

  b.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} });
  const newRes = await b.next();
  return newRes.result.sessionId;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('bridge initialize + session/new', () => {
  it('1. initialize responds with protocolVersion:1 and serverInfo', async () => {
    const b = createTestBridge();
    b.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const res = await b.next();
    expect(res.id).toBe(1);
    expect(res.result.protocolVersion).toBe(1);
    expect(res.result.serverInfo.name).toBe('test-bridge');
  });

  it('2. session/new responds with a UUID sessionId', async () => {
    const b = createTestBridge();
    b.send({ jsonrpc: '2.0', id: 1, method: 'session/new', params: {} });
    const res = await b.next();
    expect(res.id).toBe(1);
    expect(res.result.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});

describe('bridge session/create_elicitation routing', () => {
  it('3. create_elicitation with wrong sessionId → -32602 (unknown session)', async () => {
    const b = createTestBridge();
    await handshake(b);
    b.send({
      jsonrpc: '2.0', id: 3, method: 'session/create_elicitation',
      params: { sessionId: 'bad-session-id', message: 'Q?', requestedSchema: FREE_TEXT_SCHEMA },
    });
    const res = await b.next();
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toMatch(/unknown sessionId/i);
  });

  it('4. create_elicitation valid → emits pending notification before resolving', async () => {
    const b = createTestBridge();
    const sid = await handshake(b);

    b.send({
      jsonrpc: '2.0', id: 3, method: 'session/create_elicitation',
      params: { sessionId: sid, message: 'What colour?', requestedSchema: FREE_TEXT_SCHEMA },
    });

    // Bridge emits the notification immediately; does NOT yet respond to id:3.
    const notification = await b.next();
    expect(notification.method).toBe('session/elicitation_pending');
    expect(notification.params.sessionId).toBe(sid);
    expect(notification.params.message).toBe('What colour?');
    expect(notification.params.elicitationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});

describe('bridge session/elicitation_resolved', () => {
  it('5. resolved accept → ack for id:4 then response for id:3 with action:accept', async () => {
    const b = createTestBridge();
    const sid = await handshake(b);

    b.send({
      jsonrpc: '2.0', id: 3, method: 'session/create_elicitation',
      params: { sessionId: sid, message: 'Colour?', requestedSchema: FREE_TEXT_SCHEMA },
    });
    const notification = await b.next();
    const elicitationId = notification.params.elicitationId;

    b.send({
      jsonrpc: '2.0', id: 4, method: 'session/elicitation_resolved',
      params: { sessionId: sid, elicitationId, action: 'accept', content: { response: 'blue' } },
    });

    // First: ack for resolved (id:4)
    const ack = await b.next();
    expect(ack.id).toBe(4);
    expect(ack.result).toEqual({ ok: true });

    // Second: response to create_elicitation (id:3)
    const elicitRes = await b.next();
    expect(elicitRes.id).toBe(3);
    expect(elicitRes.result.action).toBe('accept');
    expect(elicitRes.result.content).toEqual({ response: 'blue' });
  });

  it('6. resolved decline → result.action=decline, no content', async () => {
    const b = createTestBridge();
    const sid = await handshake(b);

    b.send({
      jsonrpc: '2.0', id: 3, method: 'session/create_elicitation',
      params: { sessionId: sid, message: 'Yes/no?', requestedSchema: ENUM_SCHEMA },
    });
    const { params: { elicitationId } } = await b.next();

    b.send({
      jsonrpc: '2.0', id: 4, method: 'session/elicitation_resolved',
      params: { sessionId: sid, elicitationId, action: 'decline' },
    });
    await b.next(); // ack
    const res = await b.next();
    expect(res.result.action).toBe('decline');
    expect(res.result.content).toBeUndefined();
  });

  it('7. resolved cancel → result.action=cancel', async () => {
    const b = createTestBridge();
    const sid = await handshake(b);

    b.send({
      jsonrpc: '2.0', id: 3, method: 'session/create_elicitation',
      params: { sessionId: sid, message: 'Pick?', requestedSchema: FREE_TEXT_SCHEMA },
    });
    const { params: { elicitationId } } = await b.next();

    b.send({
      jsonrpc: '2.0', id: 4, method: 'session/elicitation_resolved',
      params: { sessionId: sid, elicitationId, action: 'cancel' },
    });
    await b.next(); // ack
    const res = await b.next();
    expect(res.result.action).toBe('cancel');
  });

  it('8. resolved as notification (no id) → no ack but still resolves create_elicitation', async () => {
    const b = createTestBridge();
    const sid = await handshake(b);

    b.send({
      jsonrpc: '2.0', id: 3, method: 'session/create_elicitation',
      params: { sessionId: sid, message: 'Q?', requestedSchema: FREE_TEXT_SCHEMA },
    });
    const { params: { elicitationId } } = await b.next();

    // No id → notification; bridge must not respond to it
    b.send({
      jsonrpc: '2.0', method: 'session/elicitation_resolved',
      params: { sessionId: sid, elicitationId, action: 'cancel' },
    });

    // Only one output: the response to id:3 (no ack)
    const res = await b.next();
    expect(res.id).toBe(3);
    expect(res.result.action).toBe('cancel');
  });
});

describe('bridge mode handling', () => {
  it('9. absent mode treated as form (backward compat) → notification emitted', async () => {
    const b = createTestBridge();
    const sid = await handshake(b);

    b.send({
      jsonrpc: '2.0', id: 3, method: 'session/create_elicitation',
      params: { sessionId: sid, message: 'Q?', requestedSchema: FREE_TEXT_SCHEMA /* no mode */ },
    });
    const msg = await b.next();
    // Notification, not an error
    expect(msg.method).toBe('session/elicitation_pending');
  });

  it('10. mode:null treated as form (backward compat) → notification emitted', async () => {
    const b = createTestBridge();
    const sid = await handshake(b);

    b.send({
      jsonrpc: '2.0', id: 3, method: 'session/create_elicitation',
      params: { sessionId: sid, mode: null, message: 'Q?', requestedSchema: FREE_TEXT_SCHEMA },
    });
    const msg = await b.next();
    expect(msg.method).toBe('session/elicitation_pending');
  });

  it('11. unsupported mode → -32602', async () => {
    const b = createTestBridge();
    const sid = await handshake(b);

    b.send({
      jsonrpc: '2.0', id: 3, method: 'session/create_elicitation',
      params: { sessionId: sid, mode: 'voice', message: 'Q?', requestedSchema: FREE_TEXT_SCHEMA },
    });
    const res = await b.next();
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toMatch(/unsupported mode/i);
  });
});

describe('bridge requestedSchema validation', () => {
  async function trySchema(schema) {
    const b = createTestBridge();
    const sid = await handshake(b);
    b.send({
      jsonrpc: '2.0', id: 3, method: 'session/create_elicitation',
      params: { sessionId: sid, message: 'Q?', requestedSchema: schema },
    });
    return b.next();
  }

  it('12. missing requestedSchema → -32602', async () => {
    const b = createTestBridge();
    const sid = await handshake(b);
    b.send({
      jsonrpc: '2.0', id: 3, method: 'session/create_elicitation',
      params: { sessionId: sid, message: 'Q?' /* no requestedSchema */ },
    });
    const res = await b.next();
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toMatch(/requestedSchema/i);
  });

  it('13. extra top-level key → -32602', async () => {
    const res = await trySchema({ ...FREE_TEXT_SCHEMA, title: 'bad' });
    expect(res.error.code).toBe(-32602);
  });

  it('14. type !== "object" → -32602', async () => {
    const res = await trySchema({ type: 'string', properties: { response: { type: 'string' } } });
    expect(res.error.code).toBe(-32602);
  });

  it('15. required has non-"response" element → -32602', async () => {
    const res = await trySchema({
      ...FREE_TEXT_SCHEMA,
      required: ['response', 'extra'],
    });
    expect(res.error.code).toBe(-32602);
  });

  it('16. properties not exactly {response} → -32602', async () => {
    const res = await trySchema({
      type: 'object',
      properties: { answer: { type: 'string' } },
    });
    expect(res.error.code).toBe(-32602);
  });

  it('17. response property type !== "string" → -32602', async () => {
    const res = await trySchema({
      type: 'object',
      properties: { response: { type: 'number' } },
    });
    expect(res.error.code).toBe(-32602);
  });

  it('18. extra key on response property → -32602', async () => {
    const res = await trySchema({
      type: 'object',
      properties: { response: { type: 'string', description: 'bad' } },
    });
    expect(res.error.code).toBe(-32602);
  });

  it('19. enum member that is not a string → -32602', async () => {
    const res = await trySchema({
      type: 'object',
      properties: { response: { type: 'string', enum: ['yes', 42] } },
    });
    expect(res.error.code).toBe(-32602);
  });

  it('20. empty enum → -32602', async () => {
    const res = await trySchema({
      type: 'object',
      properties: { response: { type: 'string', enum: [] } },
    });
    expect(res.error.code).toBe(-32602);
  });

  it('20b. enum member that is an empty string → -32602', async () => {
    const res = await trySchema({
      type: 'object',
      properties: { response: { type: 'string', enum: ['yes', ''] } },
    });
    expect(res.error.code).toBe(-32602);
  });
});

describe('bridge session/new supersession', () => {
  it('21. session/new while create_elicitation pending → prior resolves with cancel', async () => {
    const b = createTestBridge();
    const sid = await handshake(b);

    b.send({
      jsonrpc: '2.0', id: 3, method: 'session/create_elicitation',
      params: { sessionId: sid, message: 'Pick?', requestedSchema: FREE_TEXT_SCHEMA },
    });
    await b.next(); // discard pending notification

    // A new session cancels all pending elicitations
    b.send({ jsonrpc: '2.0', id: 5, method: 'session/new', params: {} });

    // Both the cancellation (id:3) and the new session ack (id:5) arrive; order is:
    // cancel resolves → id:3 result first; then id:5 ack (or the reverse, both valid)
    const msgs = await Promise.all([b.next(), b.next()]);
    const createRes = msgs.find((m) => m.id === 3);
    const newRes = msgs.find((m) => m.id === 5);

    expect(createRes?.result.action).toBe('cancel');
    expect(newRes?.result.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});

describe('bridge F6 regression: tightened result guard', () => {
  it('23. resolved accept with empty-string content.response → -32603 (F6)', async () => {
    // An empty-string response is not valid — the bridge must enforce non-empty.
    const b = createTestBridge();
    const sid = await handshake(b);

    b.send({
      jsonrpc: '2.0', id: 3, method: 'session/create_elicitation',
      params: { sessionId: sid, message: 'Q?', requestedSchema: FREE_TEXT_SCHEMA },
    });
    const { params: { elicitationId } } = await b.next();

    b.send({
      jsonrpc: '2.0', id: 4, method: 'session/elicitation_resolved',
      params: { sessionId: sid, elicitationId, action: 'accept', content: { response: '' } },
    });
    await b.next(); // ack id:4
    const res = await b.next();
    expect(res.id).toBe(3);
    expect(res.error?.code).toBe(-32603);
  });

  it('24. resolved with unknown action → -32603 (F6)', async () => {
    const b = createTestBridge();
    const sid = await handshake(b);

    b.send({
      jsonrpc: '2.0', id: 3, method: 'session/create_elicitation',
      params: { sessionId: sid, message: 'Q?', requestedSchema: FREE_TEXT_SCHEMA },
    });
    const { params: { elicitationId } } = await b.next();

    b.send({
      jsonrpc: '2.0', id: 4, method: 'session/elicitation_resolved',
      params: { sessionId: sid, elicitationId, action: 'approve' },
    });
    await b.next(); // ack id:4
    const res = await b.next();
    expect(res.id).toBe(3);
    expect(res.error?.code).toBe(-32603);
  });
});

describe('bridge F3 regression: accept result guard', () => {
  it('22. resolved accept without content.response → -32603, not forwarded (F3)', async () => {
    // If session/elicitation_resolved carries action:'accept' but no content.response,
    // the bridge must reject with -32603 rather than forwarding an incomplete result.
    const b = createTestBridge();
    const sid = await handshake(b);

    b.send({
      jsonrpc: '2.0', id: 3, method: 'session/create_elicitation',
      params: { sessionId: sid, message: 'Q?', requestedSchema: FREE_TEXT_SCHEMA },
    });
    const { params: { elicitationId } } = await b.next();

    // Resolve with accept but no content — protocol violation
    b.send({
      jsonrpc: '2.0', id: 4, method: 'session/elicitation_resolved',
      params: { sessionId: sid, elicitationId, action: 'accept' /* no content */ },
    });

    // ack for session/elicitation_resolved is still sent first (id:4)
    const ack = await b.next();
    expect(ack.id).toBe(4);
    expect(ack.result).toEqual({ ok: true });

    // Then the create_elicitation request gets -32603, not a success
    const res = await b.next();
    expect(res.id).toBe(3);
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(-32603);
  });
});
