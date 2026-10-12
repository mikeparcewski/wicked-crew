/**
 * The MCP inspector bridge's sessions (DES-MCP-INSPECTOR-001 §3).
 *
 * One session = one live transport to one MCP server, opened on the operator's explicit start and
 * driven by studio's host for an `mcp-server` editor plugin. The SDK's transports are used WITHOUT
 * the SDK `Client`, so every JSON-RPC message in both directions is seen and logged raw.
 *
 *  - The bridge owns the handshake: `initialize` (no client capabilities) then
 *    `notifications/initialized`. A server request (sampling, elicitation, roots, anything) is
 *    answered `-32601` and logged.
 *  - Only {@link INSPECT_METHODS} may be sent.
 *  - The log is a ring (1000 entries, 4 MB); each entry's text is capped at 64 KB.
 *  - Secrets: every value the bridge injected (the registry secret, each typed env/header value) is
 *    scrubbed from every entry and every reply, and credential-shaped strings are replaced. Field-name
 *    redaction is NOT applied: it would blank the `session`/`token`-named fields being debugged.
 *  - Lifetime: at most {@link MAX_SESSIONS}; idle (no rpc, no poll) for {@link IDLE_MS} = closed;
 *    `closeAll` on the daemon's close; `killAllSync` on process exit (a stdio child gets SIGKILL).
 */

import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import type { Readable } from 'node:stream';

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import type {
  McpInspectInitialize,
  McpInspectLogEntry,
  McpInspectLogResponse,
  McpInspectRpcResponse,
  McpInspectSessionView,
  McpInspectState,
} from '../core/types.js';
import { redactString } from '../mcp/redact.js';
import { scrubSecrets } from '../mcp/secrets.js';

/** The methods a plugin may send. The bridge itself owns `initialize`. */
export const INSPECT_METHODS: ReadonlySet<string> = new Set([
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/templates/list',
  'resources/read',
  'prompts/list',
  'prompts/get',
  'completion/complete',
  'logging/setLevel',
  'ping',
]);

export const MAX_SESSIONS = 4;
export const IDLE_MS = 10 * 60_000;
export const INIT_TIMEOUT_MS = 15_000;
export const CALL_TIMEOUT_MS = 60_000;
export const LOG_MAX_ENTRIES = 1000;
export const LOG_MAX_BYTES = 4 * 1024 * 1024;
export const ENTRY_MAX_CHARS = 64 * 1024;
export const REPLY_MAX_CHARS = 1024 * 1024;
export const POLL_MAX_MS = 20_000;
const CLIENT_INFO = { name: 'wicked-mcp-inspector', version: '1' };
const PROTOCOL_VERSION = '2025-06-18';

export class InspectError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** An opened transport, before `start()`. */
export interface OpenedTransport {
  transport: Transport;
  stderr: Readable | null;
  pid: () => number | null;
}

export type TargetDescription = McpInspectSessionView['target'];

/**
 * Every form a secret can take in what the bridge emits: the value itself and its JSON-escaped body
 * (a quote, backslash or newline in a secret changes its serialized form; codex r1).
 */
export function secretForms(secrets: readonly string[]): string[] {
  const out = new Set<string>();
  for (const v of secrets) {
    if (v.length === 0) continue;
    out.add(v);
    out.add(JSON.stringify(v).slice(1, -1));
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** Scrub exact secrets (every form), then credential shapes, from any JSON value or string. */
export function scrub<T>(value: T, forms: readonly string[]): T {
  const exact = scrubSecrets(value, forms);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactString(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v as Record<string, unknown>)) out[k] = walk(inner);
      return out;
    }
    return v;
  };
  return walk(exact) as T;
}

function cap(text: string, max: number): { text: string; truncated: boolean } {
  return text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true };
}

type Msg = Record<string, unknown>;

interface Pending {
  method: string;
  resolve: (r: McpInspectRpcResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** At most this many timed-out requests keep their send time (for a late answer's round trip). */
const SENT_AT_MAX = 256;
/** Stderr is logged by line; a partial line is flushed after this long without more output. */
const STDERR_FLUSH_MS = 250;
const STDERR_LINE_MAX = 8 * 1024;
const CLOSE_MS = 2_000;

export class InspectSession {
  readonly id = randomBytes(12).toString('hex');
  readonly startedAt: string;
  state: McpInspectState = 'connecting';
  error: string | null = null;
  initialize: McpInspectInitialize | null = null;
  lastSeen: number;
  private seq = 0;
  private log: McpInspectLogEntry[] = [];
  private bytes = 0;
  private nextId = 1;
  private pending = new Map<string | number, Pending>();
  /** When each request went out, so a response that lands after its timeout still shows its time. */
  private sentAt = new Map<string | number, number>();
  private waiters = new Set<() => void>();
  private readonly forms: string[];
  private stderrBuf = '';
  private stderrTimer: NodeJS.Timeout | null = null;
  private closing: Promise<void> | null = null;

  constructor(
    private readonly rawTarget: TargetDescription,
    private readonly opened: OpenedTransport,
    secrets: readonly string[],
    private readonly now: () => number = Date.now,
    private readonly callTimeoutMs: number = CALL_TIMEOUT_MS,
  ) {
    this.forms = secretForms(secrets);
    this.startedAt = new Date(now()).toISOString();
    this.lastSeen = now();
  }

  /** The target as anyone outside may see it: a secret the operator also typed into an argument is scrubbed (codex r1). */
  get target(): TargetDescription {
    return scrub(this.rawTarget, this.forms);
  }

  /** Scrub a message meant for a reply, an error or a daemon log line. */
  scrubText(text: string): string {
    return scrub(text, this.forms);
  }

  view(): McpInspectSessionView {
    return { id: this.id, target: this.target, state: this.state, initialize: this.initialize, error: this.error, startedAt: this.startedAt, lastSeq: this.seq };
  }

  touch(): void {
    this.lastSeen = this.now();
  }

  /**
   * Connect and run the handshake, all of it (transport start, `initialize`, `initialized`) under
   * ONE deadline (codex r1: a legacy SSE endpoint that never sends its `endpoint` event hung the
   * start). Never throws: a failure is the session's `failed` state.
   */
  async start(initTimeoutMs = INIT_TIMEOUT_MS): Promise<void> {
    const { transport, stderr } = this.opened;
    stderr?.on('data', (chunk: Buffer | string) => this.stderrData(typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
    transport.onmessage = (m) => this.received(m as unknown as Msg);
    transport.onerror = (e) => this.append({ dir: 'host', kind: 'state', error: true, text: `transport error: ${e.message}` });
    transport.onclose = () => this.closed('the connection closed');
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer to the handshake in ${Math.round(initTimeoutMs / 1000)} s`)), initTimeoutMs);
    });
    const handshake = (async (): Promise<void> => {
      await transport.start();
      this.append({ dir: 'host', kind: 'state', text: 'connected' });
      const init = await this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, initTimeoutMs);
      if (init.response.error !== undefined) throw new Error(`initialize failed: ${init.response.error.message}`);
      const r = (init.response.result ?? {}) as Msg;
      const info = r['serverInfo'];
      this.initialize = {
        protocolVersion: typeof r['protocolVersion'] === 'string' ? r['protocolVersion'] : null,
        serverInfo: info !== null && typeof info === 'object' ? (info as McpInspectInitialize['serverInfo']) : null,
        capabilities: r['capabilities'] !== null && typeof r['capabilities'] === 'object' ? (r['capabilities'] as Msg) : {},
        instructions: typeof r['instructions'] === 'string' ? r['instructions'] : null,
      };
      const setter = (transport as { setProtocolVersion?: (v: string) => void }).setProtocolVersion;
      if (typeof setter === 'function' && this.initialize.protocolVersion !== null) setter.call(transport, this.initialize.protocolVersion);
      await this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    })();
    try {
      await Promise.race([handshake, deadline]);
      if (this.state === 'connecting') {
        this.state = 'ready';
        this.append({ dir: 'host', kind: 'state', text: 'ready' });
      }
    } catch (err) {
      handshake.catch(() => undefined);
      this.fail(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  /** Send one allowed request and wait for its answer. */
  async rpc(method: string, params: Record<string, unknown> | undefined): Promise<McpInspectRpcResponse> {
    this.touch();
    if (!INSPECT_METHODS.has(method)) throw new InspectError(400, 'method_not_allowed', `${method} is not a method the inspector sends`);
    if (this.state !== 'ready') throw new InspectError(409, 'not_connected', `the session is ${this.state}`);
    return this.request(method, params, this.callTimeoutMs);
  }

  private request(method: string, params: Record<string, unknown> | undefined, timeoutMs: number): Promise<McpInspectRpcResponse> {
    const id = this.nextId++;
    const msg: Msg = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
    return new Promise<McpInspectRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Kept (bounded) so a late answer still shows its round trip in the log.
        while (this.sentAt.size > SENT_AT_MAX) this.sentAt.delete(this.sentAt.keys().next().value as string | number);
        reject(new InspectError(504, 'timeout', `${method}: no answer in ${Math.round(timeoutMs / 1000)} s (it may still answer; watch the log)`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.sentAt.set(id, this.now());
      this.send(msg).catch((err: unknown) => {
        clearTimeout(timer);
        this.pending.delete(id);
        this.sentAt.delete(id);
        // An SDK error can carry the upstream's response body, which can echo a secret (codex r1).
        reject(new InspectError(502, 'send_failed', this.scrubText(`could not send ${method}: ${err instanceof Error ? err.message : String(err)}`)));
      });
    });
  }

  private async send(msg: Msg): Promise<void> {
    const id = msg['id'] as string | number | undefined;
    const method = msg['method'] as string | undefined;
    const kind = method === undefined ? 'response' : id === undefined ? 'notification' : 'request';
    this.append({ dir: 'out', kind, ...(method !== undefined ? { method } : {}), ...(id !== undefined ? { rpcId: id } : {}) }, msg);
    await this.opened.transport.send(msg as unknown as JSONRPCMessage);
  }

  private received(msg: Msg): void {
    const id = msg['id'] as string | number | undefined;
    const method = typeof msg['method'] === 'string' ? (msg['method'] as string) : undefined;
    if (method === undefined && id !== undefined) {
      const sentAt = this.sentAt.get(id);
      this.sentAt.delete(id);
      const ms = sentAt === undefined ? undefined : this.now() - sentAt;
      const isError = msg['error'] !== undefined;
      const entry = this.append({ dir: 'in', kind: 'response', rpcId: id, ...(ms !== undefined ? { ms } : {}), ...(isError ? { error: true } : {}) }, msg);
      const p = this.pending.get(id);
      if (p !== undefined) {
        this.pending.delete(id);
        clearTimeout(p.timer);
        const scrubbed = scrub(isError ? { error: msg['error'] } : { result: msg['result'] }, this.forms) as McpInspectRpcResponse['response'];
        const raw = JSON.stringify(scrubbed);
        const truncated = raw.length > REPLY_MAX_CHARS;
        p.resolve({ response: truncated ? { result: { truncated: true, text: raw.slice(0, REPLY_MAX_CHARS) } } : scrubbed, ms: ms ?? 0, truncated: truncated || entry.truncated === true });
      }
      return;
    }
    if (method !== undefined && id !== undefined) {
      // A server request: the inspector declares no client capabilities, so it serves none.
      this.append({ dir: 'in', kind: 'request', method, rpcId: id }, msg);
      void this.send({ jsonrpc: '2.0', id, error: { code: -32601, message: `the MCP inspector does not serve ${method}` } }).catch(() => undefined);
      return;
    }
    this.append({ dir: 'in', kind: 'notification', ...(method !== undefined ? { method } : {}) }, msg);
  }

  /** Stderr by line, so a secret split across two chunks is whole when it is scrubbed (codex r1). */
  private stderrData(text: string): void {
    this.stderrBuf += text;
    let nl = this.stderrBuf.lastIndexOf('\n');
    if (nl === -1 && this.stderrBuf.length > STDERR_LINE_MAX) nl = this.stderrBuf.length - 1;
    if (nl !== -1) {
      const lines = this.stderrBuf.slice(0, nl + 1);
      this.stderrBuf = this.stderrBuf.slice(nl + 1);
      this.append({ dir: 'in', kind: 'stderr', text: lines });
    }
    if (this.stderrTimer !== null) clearTimeout(this.stderrTimer);
    this.stderrTimer = this.stderrBuf === '' ? null : setTimeout(() => this.flushStderr(), STDERR_FLUSH_MS);
  }

  private flushStderr(): void {
    if (this.stderrTimer !== null) clearTimeout(this.stderrTimer);
    this.stderrTimer = null;
    if (this.stderrBuf === '') return;
    const rest = this.stderrBuf;
    this.stderrBuf = '';
    this.append({ dir: 'in', kind: 'stderr', text: rest });
  }

  /**
   * One log entry. A JSON-RPC message is scrubbed as a VALUE, then serialized (codex r1: scrubbing
   * the serialized text missed escaped secrets), and so are `method` and `rpcId`.
   */
  private append(e: Omit<McpInspectLogEntry, 'seq' | 'at' | 'text'> & { text?: string }, message?: Msg): McpInspectLogEntry {
    const clean = scrub({ ...e, ...(message !== undefined ? { text: JSON.stringify(scrub(message, this.forms)) } : {}) }, this.forms);
    const { text, truncated } = cap(clean.text ?? '', ENTRY_MAX_CHARS);
    this.seq += 1;
    const entry: McpInspectLogEntry = { ...clean, seq: this.seq, at: new Date(this.now()).toISOString(), text, ...(truncated ? { truncated: true } : {}) };
    this.log.push(entry);
    this.bytes += text.length;
    while (this.log.length > LOG_MAX_ENTRIES || (this.bytes > LOG_MAX_BYTES && this.log.length > 1)) {
      const gone = this.log.shift() as McpInspectLogEntry;
      this.bytes -= gone.text.length;
    }
    for (const w of [...this.waiters]) w();
    return entry;
  }

  /** Entries after `after`, at once if any, else when one lands or `waitMs` passes. */
  async entries(after: number, waitMs: number): Promise<McpInspectLogResponse> {
    this.touch();
    if (this.seq <= after && waitMs > 0 && this.state !== 'closed' && this.state !== 'failed') {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          this.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, Math.min(waitMs, POLL_MAX_MS));
        this.waiters.add(done);
      });
      this.touch();
    }
    const entries = this.log.filter((x) => x.seq > after);
    return { entries, next: this.seq, first: this.log[0]?.seq ?? this.seq + 1, state: this.state, error: this.error };
  }

  private fail(message: string): void {
    if (this.state === 'closed' || this.state === 'failed') return;
    const msg = this.scrubText(message);
    this.state = 'failed';
    this.error = msg;
    this.append({ dir: 'host', kind: 'state', error: true, text: `failed: ${msg}` });
    void this.close('failed');
  }

  private closed(reason: string): void {
    if (this.state === 'closed' || this.state === 'failed') return;
    this.flushStderr();
    const pid = this.opened.pid();
    this.state = this.state === 'connecting' ? 'failed' : 'closed';
    if (this.state === 'failed') this.error = reason;
    this.append({ dir: 'host', kind: 'state', text: `${reason}${pid !== null ? ` (pid ${pid})` : ''}` });
    this.rejectPending(reason);
  }

  private rejectPending(reason: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new InspectError(409, 'not_connected', `${p.method}: ${reason}`));
      this.pending.delete(id);
    }
    this.sentAt.clear();
    for (const w of [...this.waiters]) w();
  }

  /**
   * Close it. A streamable-HTTP session is terminated upstream first (its DELETE, codex r1), then the
   * transport is closed (a stdio child is terminated by the SDK). Bounded and idempotent.
   */
  close(reason = 'closed by the operator'): Promise<void> {
    if (this.state !== 'failed') this.closed(reason);
    else this.rejectPending(reason);
    this.flushStderr();
    this.closing ??= (async () => {
      const t = this.opened.transport as Transport & { terminateSession?: () => Promise<void>; sessionId?: string };
      const bounded = (p: Promise<unknown>): Promise<unknown> => Promise.race([p.catch(() => undefined), new Promise((r) => setTimeout(r, CLOSE_MS).unref())]);
      if (typeof t.terminateSession === 'function' && t.sessionId !== undefined) await bounded(t.terminateSession());
      await bounded(t.close());
    })();
    return this.closing;
  }

  /** Process exit: no awaiting, so a stdio child is killed outright. */
  killSync(): void {
    const pid = this.opened.pid();
    if (pid === null) return;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/** A short, path-free name for a stdio command (`node build/index.js` → `index.js`). */
export function commandName(command: string, args: readonly string[]): string {
  const script = args.find((a) => !a.startsWith('-'));
  return (basename(script ?? command) || command).slice(0, 60);
}

export class InspectSessions {
  private sessions = new Map<string, InspectSession>();
  private sweeper: NodeJS.Timeout | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  get size(): number {
    return this.sessions.size;
  }

  add(s: InspectSession): void {
    if (this.sessions.size >= MAX_SESSIONS) throw new InspectError(429, 'too_many_sessions', `at most ${MAX_SESSIONS} inspector sessions at once; disconnect one first`);
    this.sessions.set(s.id, s);
    if (this.sweeper === null) {
      this.sweeper = setInterval(() => void this.sweep(), 30_000);
      this.sweeper.unref();
    }
  }

  /** Reserve a slot before the (slow) connect, so concurrent starts cannot exceed the cap. */
  hasRoom(): boolean {
    return this.sessions.size < MAX_SESSIONS;
  }

  get(id: string): InspectSession | null {
    return this.sessions.get(id) ?? null;
  }

  async remove(id: string, reason?: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (s === undefined) return false;
    this.sessions.delete(id);
    await s.close(reason);
    return true;
  }

  async sweep(): Promise<void> {
    const t = this.now();
    for (const s of [...this.sessions.values()]) {
      if (t - s.lastSeen > IDLE_MS) await this.remove(s.id, 'closed after 10 minutes idle');
    }
  }

  async closeAll(): Promise<void> {
    if (this.sweeper !== null) clearInterval(this.sweeper);
    this.sweeper = null;
    await Promise.all([...this.sessions.keys()].map((id) => this.remove(id, 'the daemon is stopping')));
  }

  killAllSync(): void {
    for (const s of this.sessions.values()) s.killSync();
  }
}
