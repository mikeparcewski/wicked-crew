import type { FastifyReply, FastifyRequest } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { AskError, AskUnsupportedError, type AskAdapter, type AskTicket, type AskUnit, type CoreEvent } from '../core/types.js';

const CONTINUE = 'Continue with your best judgment and state the assumption in your output.';
const inputSchema = z.object({
  question: z.string().min(1).max(8192),
  choices: z.array(z.string().min(1).max(512)).min(2).max(100).optional(),
  recommended: z.number().int().min(0).describe('index into choices you recommend').optional(),
  multi: z.object({
    min: z.number().int().min(1).optional(),
    max: z.number().int().min(1).optional(),
  }).strict().describe('let the operator pick several of choices: at least min (default 1), at most max (default all)').optional(),
}).strict();
const outputSchema = z.object({
  status: z.enum(['answered', 'declined', 'no_answer']),
  answer: z.string().optional(),
  /** A multi-select's picks, in the order of `choices`. */
  answers: z.array(z.string()).optional(),
  reason: z.enum(['timeout', 'cancelled', 'run_ended']).optional(),
});

function result(structuredContent: NonNullable<CallToolResult['structuredContent']>, text: string): CallToolResult {
  return { isError: false, structuredContent, content: [{ type: 'text', text }] };
}

function noAnswer(reason: 'timeout' | 'cancelled' | 'run_ended', seconds: number): CallToolResult {
  const text = reason === 'timeout'
    ? `the operator did not answer within ${seconds} s.`
    : reason === 'cancelled' ? 'the operator dismissed the question.' : 'the run ended.';
  return result({ status: 'no_answer', reason }, `No answer: ${text} ${CONTINUE}`);
}

/** A multi-select answer as the engine records it (a JSON array of the picked choices), or null. */
function pickedOf(answer: string): string[] | null {
  try {
    const v: unknown = JSON.parse(answer);
    return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null;
  } catch {
    return null;
  }
}

/** A JSON-RPC request id (a string or a number; null is not cancellable). */
function isRequestId(v: unknown): v is string | number {
  return typeof v === 'string' || typeof v === 'number';
}

/** The field a call names wrongly, by the engine's rules (byte caps, distinct choices, a recommended index). */
function badInput(args: z.infer<typeof inputSchema>): string | undefined {
  if (Buffer.byteLength(args.question, 'utf8') > 8192) return 'question must be at most 8192 bytes';
  if (args.choices?.some((c) => Buffer.byteLength(c, 'utf8') > 512)) return 'choices entries must be at most 512 bytes';
  if (args.choices !== undefined && new Set(args.choices).size < 2) return 'choices must hold at least 2 distinct entries';
  if (args.recommended !== undefined && (args.choices === undefined || args.recommended >= args.choices.length)) {
    return 'recommended must index choices';
  }
  if (args.multi !== undefined) {
    if (args.choices === undefined) return 'multi requires choices';
    const n = new Set(args.choices).size;
    const min = args.multi.min ?? 1;
    const max = args.multi.max ?? n;
    if (min > max || max > n) return `multi must pick 1 <= min <= max <= ${n} choices`;
  }
  return undefined;
}

/** One tool call, from arrival until it settles. `id` is set once the engine's ticket is back. */
interface Call {
  runId: string;
  id?: string;
  /** Its question's `elicitationResolved` frame arrived. */
  resolved: (event: CoreEvent) => void;
  /** Its run reached a terminal frame. */
  runEnded: () => void;
}

/** A resolved frame that beat its ticket back from the engine is kept this long, at most this many. */
const EARLY_MS = 60_000;
const EARLY_MAX = 256;
const TERMINAL = new Set(['sessionCompleted', 'runCancelled', 'sessionFailed']);

export interface AskServerDeps {
  adapter: AskAdapter;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

/**
 * The MCP `ask` tool (DES-CONTAINER-FLOOR step 5). The SDK speaks MCP; the ENGINE owns the questions: it verifies the
 * token, keeps one question open per run and queues the rest in arrival order (CONTRACT rev 2), and emits the
 * elicitation frames studio renders. This class only holds each call until its question's `elicitationResolved` frame,
 * its deadline, its client leaving, or its run ending.
 */
export class AskServer {
  private readonly calls = new Set<Call>();
  /**
   * In-flight tool calls by `<token> <JSON-RPC id>`. Each POST is its own stateless SDK server, so a client's
   * `notifications/cancelled` (a later POST) cannot reach the SDK's per-server abort controller; it is routed here,
   * scoped to the same verified token so one seat cannot cancel another's call.
   */
  private readonly inflight = new Map<string, AbortController>();
  private readonly early = new Map<string, { event: CoreEvent; at: number }>();
  private readonly now: () => number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;

  constructor(private readonly deps: AskServerDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? setTimeout;
    this.clearTimer = deps.clearTimer ?? clearTimeout;
  }

  async handle(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const arrived = this.now();
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization?.trim() ?? '')?.[1];
    if (token === undefined) {
      this.unauthorized(req, reply);
      return;
    }
    // MCP 2025-06-18 removed JSON-RPC batching; refusing a batch keeps every call (and its cancellation) one request.
    if (Array.isArray(req.body)) {
      reply.hijack();
      reply.raw.writeHead(400, { 'Content-Type': 'application/json' });
      reply.raw.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batch requests are not supported' } }));
      return;
    }
    const gone = new AbortController();
    const onClose = (): void => { if (!reply.raw.writableEnded) gone.abort(); };
    reply.raw.on('close', onClose);
    let server: McpServer | undefined;
    // A tools/call is cancellable from the moment it arrives (its cancellation may overtake its own token lookup).
    // The key keeps the JSON-RPC id's type: 7 and "7" are different requests.
    const body = req.body as { id?: unknown; method?: unknown; params?: { requestId?: unknown } } | undefined;
    const callKey = body?.method === 'tools/call' && isRequestId(body.id) ? JSON.stringify([token, body.id]) : undefined;
    const cancelled = new AbortController();
    if (callKey !== undefined) this.inflight.set(callKey, cancelled);
    try {
      const unit = await this.deps.adapter.askUnit(token);
      if (body?.method === 'notifications/cancelled') {
        // Acted on only after this POST's own token is verified, and only within that token's calls.
        if (isRequestId(body.params?.requestId)) this.inflight.get(JSON.stringify([token, body.params.requestId]))?.abort();
        reply.code(202).send();
        return;
      }
      server = new McpServer({ name: 'wicked', version: '1.0.0' });
      server.registerTool('ask', {
        title: 'Ask the operator',
        description: 'Ask the human operator a question and wait for the answer. Use it only when you cannot continue without a human decision. Give `choices` when the answer is one of a few options. Returns the operator\'s answer, or a no-answer result after the time limit; on no answer, continue with your best judgment and state the assumption in your output.',
        inputSchema,
        outputSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      }, async (args, extra) => {
        // Refused before the engine sees it: the engine's caps are UTF-8 bytes, zod counts UTF-16 units.
        const invalid = badInput(args);
        if (invalid !== undefined) return { isError: true, content: [{ type: 'text', text: `bad_request: ${invalid}` }] };
        const choices = args.choices === undefined ? undefined : [...new Set(args.choices)];
        // The recommendation follows its CHOICE through the dedupe (badInput proved it indexes the caller's list).
        const picked = args.recommended === undefined ? undefined : args.choices?.[args.recommended];
        const recommended = picked === undefined ? undefined : choices?.indexOf(picked);
        const signal = AbortSignal.any([gone.signal, extra.signal, cancelled.signal]);
        // Cancelled before it could open: the question is never shown.
        if (signal.aborted) return noAnswer('cancelled', unit.timeoutSecs);
        const opened = this.deps.adapter.openAsk({
          token, question: args.question,
          ...(choices !== undefined ? { choices } : {}),
          ...(recommended !== undefined ? { recommended } : {}),
          ...(args.multi !== undefined ? {
            multi: { ...(args.multi.min !== undefined ? { min: args.multi.min } : {}), ...(args.multi.max !== undefined ? { max: args.multi.max } : {}) },
          } : {}),
        });
        return this.wait(unit, opened, arrived + unit.timeoutSecs * 1000, signal, args.multi !== undefined);
      });
      // Omitting sessionIdGenerator leaves it undefined (stateless). The SDK's transport
      // declarations predate exactOptionalPropertyTypes; its runtime satisfies Transport.
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport as Transport);
      reply.hijack();
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (error) {
      if (error instanceof AskError && error.code === 'invalid_token') this.unauthorized(req, reply);
      else if (error instanceof AskUnsupportedError) reply.code(503).send({ error: 'ask_unsupported' });
      else throw error;
    } finally {
      if (callKey !== undefined && this.inflight.get(callKey) === cancelled) this.inflight.delete(callKey);
      reply.raw.off('close', onClose);
      await server?.close();
    }
  }

  private unauthorized(req: FastifyRequest, reply: FastifyReply): void {
    const body = req.body as { id?: unknown } | undefined;
    const id = typeof body?.id === 'string' || typeof body?.id === 'number' ? body.id : null;
    if (reply.raw.writableEnded) return;
    reply.hijack();
    reply.raw.writeHead(401, { 'Content-Type': 'application/json' });
    reply.raw.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32001, message: 'invalid_token' } }));
  }

  /**
   * Hold the call until its question ends. The deadline, the client leaving and the run ending all count from arrival,
   * even while the engine's ticket is still on its way (a late ticket is closed at once). A close that fails cannot wedge
   * anything: the engine owns the run's queue.
   */
  private wait(unit: AskUnit, opened: Promise<AskTicket>, deadline: number, signal: AbortSignal, multi = false): Promise<CallToolResult> {
    return new Promise((resolve, reject) => {
      const remaining = deadline - this.now();
      // The callback runs later, after every binding below exists.
      const timer = remaining > 0 ? this.setTimer(() => settle(noAnswer('timeout', unit.timeoutSecs), 'timeout'), remaining) : undefined;
      let closeAs: 'timeout' | 'teardown' | undefined;
      let settled = false;
      const close = (id: string, reason: 'timeout' | 'teardown'): void => {
        void this.deps.adapter.closeAsk(id, reason).catch(() => false);
      };
      const settle = (value: CallToolResult | Error, reason?: 'timeout' | 'teardown'): void => {
        if (settled) return;
        settled = true;
        this.calls.delete(call);
        if (timer !== undefined) this.clearTimer(timer);
        signal.removeEventListener('abort', onAbort);
        closeAs = reason;
        if (reason !== undefined && call.id !== undefined) close(call.id, reason);
        if (value instanceof Error) reject(value);
        else resolve(value);
      };
      const onAbort = (): void => settle(noAnswer('cancelled', unit.timeoutSecs), 'teardown');
      const call: Call = {
        runId: unit.runId,
        resolved: (event) => settle(this.outcome(event, deadline, unit.timeoutSecs, multi)),
        runEnded: () => settle(noAnswer('run_ended', unit.timeoutSecs)),
      };
      this.calls.add(call);
      opened.then((ticket) => {
        call.id = ticket.elicitationId;
        if (settled) {
          if (closeAs !== undefined) close(ticket.elicitationId, closeAs);
          return;
        }
        const early = this.early.get(ticket.elicitationId);
        this.early.delete(ticket.elicitationId);
        if (early !== undefined) call.resolved(early.event);
      }, (error: unknown) => {
        if (error instanceof AskError && error.code === 'run_ended') settle(noAnswer('run_ended', unit.timeoutSecs));
        // Any other refusal is the tool's error. An unbinding here (the unit ended after askUnit) is not a 401 on
        // purpose: MCP clients read a 401 as "this server wants OAuth", and the seat is ending anyway (CONTRACT rev 3).
        else settle(error instanceof Error ? error : new Error(String(error)));
      });
      if (signal.aborted) return onAbort();
      if (timer === undefined) return settle(noAnswer('timeout', unit.timeoutSecs), 'timeout');
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private outcome(event: CoreEvent, deadline: number, seconds: number, multi = false): CallToolResult {
    if (event.reason === 'timeout' || this.now() >= deadline) return noAnswer('timeout', seconds);
    if (event.reason === 'teardown') return noAnswer('run_ended', seconds);
    if (event.action === 'accept') {
      const answer = typeof event.answer === 'string' ? event.answer : '';
      const answers = multi ? pickedOf(answer) : null;
      if (answers !== null) {
        const words = answers.join(', ');
        return result({ status: 'answered', answer: words, answers }, `The operator picked: ${words}`);
      }
      return result({ status: 'answered', answer }, `The operator answered: ${answer}`);
    }
    if (event.action === 'decline') return result({ status: 'declined' }, `The operator declined to answer. ${CONTINUE}`);
    return noAnswer('cancelled', seconds);
  }

  ingest(event: CoreEvent): void {
    if (typeof event.session !== 'string') return;
    if (TERMINAL.has(event.type)) {
      // The engine's terminal sweep closes the run's questions itself; the calls just end.
      for (const call of [...this.calls].filter((c) => c.runId === event.session)) call.runEnded();
      return;
    }
    if (event.type !== 'elicitationResolved' || typeof event.elicitationId !== 'string') return;
    const id = event.elicitationId;
    const call = [...this.calls].find((c) => c.id === id);
    if (call !== undefined) {
      call.resolved(event);
      return;
    }
    if (!id.startsWith('ask-')) return;
    // The frame beat the ticket back (or belongs to no call here); keep it briefly, bounded.
    const now = this.now();
    for (const [k, v] of this.early) if (now - v.at > EARLY_MS || this.early.size >= EARLY_MAX) this.early.delete(k);
    this.early.set(id, { event, at: now });
  }
}
