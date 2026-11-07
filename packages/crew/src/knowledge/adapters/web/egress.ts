/**
 * The web source's egress proxy (CS9; DES-CATALOG-002 rev 8 §2.d piece 3): a loopback HTTP proxy crew serves, the
 * ONE way the page reader (`mcp-server-fetch`, run with `--proxy-url`) reaches the internet.
 *
 * - **Per call.** Each fetch call gets its own credential ({@link EgressProxy.open}); the hosts it reached, the bytes
 *   it downloaded and whether it was cut are that call's. The credential is revoked when the call ends.
 * - **Connect-time check.** Every connection goes through the dialer's `dialTcp` under {@link NO_CONFIRMATION}: the
 *   name is resolved once, every address is checked (global unicast only; link-local, metadata and the rest are
 *   always refused) and the socket goes to the checked address. A name that answers differently later is never
 *   resolved again for that connection, so DNS rebinding cannot steer it. Every NEW connection (a redirect to another
 *   origin, a robots.txt read) is checked and pinned; a same-origin redirect may reuse an already checked one.
 * - **Ports.** `CONNECT host:443` (HTTPS) and an absolute-form `GET`/`HEAD http://host/…` on port 80. Nothing else.
 * - **Download cap.** The bytes from upstream across all of a call's connections; at the cap every socket of the
 *   call is destroyed and the call is marked `cut`.
 * - **No credentials.** The plain-HTTP path drops `Cookie`, `Authorization` and every `Proxy-*` header before the
 *   request leaves. HTTPS is a tunnel crew cannot read; there the reader's bootstrap (`fetch.ts`: no cookie is ever
 *   kept, so none is sent; a minimal env; one process per call) is the control.
 * - **Bounded.** At most {@link MAX_CLIENTS} client connections at once (any more are closed at once), every accepted
 *   socket is tracked from its first byte, a request head must arrive whole within {@link HEAD_DEADLINE_MS}, and
 *   `stop()` destroys every socket. An oversized or late head closes the connection.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { type AddressInfo, createServer, type Server, type Socket } from 'node:net';

import { type AddressPolicy, DialRefusedError, dialTcp, NO_CONFIRMATION, type Resolver } from '../../../sources/dialer.js';

/** The most a fetch call may download, robots.txt and every redirect hop included. */
export const WEB_DOWNLOAD_CAP_BYTES = 2 * 1024 * 1024;
/** The largest request head the proxy reads. */
const HEAD_MAX_BYTES = 16 * 1024;
/** A connection idle this long is closed. */
const IDLE_MS = 30_000;
/** A request head must arrive whole within this (an absolute deadline, not an idle one). */
export const HEAD_DEADLINE_MS = 10_000;
/** Client connections open at once: a fetch call needs a handful. */
export const MAX_CLIENTS = 64;

/** Request headers never sent upstream on the plain-HTTP path. */
const DROPPED_HEADERS: ReadonlySet<string> = new Set(['cookie', 'cookie2', 'authorization', 'proxy-authorization', 'proxy-connection', 'proxy-authenticate', 'connection', 'keep-alive', 'te', 'upgrade']);

export interface EgressRefusal {
  host: string;
  code: string;
  reason: string;
}

/** What one call did through the proxy. */
export interface EgressReport {
  hosts: string[];
  bytes: number;
  cut: boolean;
  refused: EgressRefusal[];
}

export interface EgressSession {
  readonly id: string;
  /** `http://<id>:<secret>@127.0.0.1:<port>`: the reader's `--proxy-url`. */
  readonly proxyUrl: string;
}

interface SessionState {
  secret: Buffer;
  hosts: Set<string>;
  bytes: number;
  cut: boolean;
  refused: EgressRefusal[];
  sockets: Set<Socket>;
  closed: boolean;
}

export interface EgressProxyDeps {
  /** PRODUCTION: {@link NO_CONFIRMATION} (global unicast only). Tests confirm loopback to reach a local server. */
  policy?: AddressPolicy;
  resolver?: Resolver;
  capBytes?: number;
  connectTimeoutMs?: number;
  /** TESTS ONLY: the ports a local test server listens on (production: CONNECT 443, plain HTTP 80). */
  ports?: { connect: number[]; http: number[] };
  log?: (message: string) => void;
}

interface RequestHead {
  method: string;
  target: string;
  version: string;
  headers: Array<[string, string]>;
  rest: Buffer;
}

/** Parse an HTTP/1.x request head; `null` = malformed. */
export function parseHead(buf: Buffer): RequestHead | null {
  const end = buf.indexOf('\r\n\r\n');
  if (end < 0) return null;
  const lines = buf.subarray(0, end).toString('latin1').split('\r\n');
  const m = /^([A-Z]+) (\S+) (HTTP\/1\.[01])$/.exec(lines[0] ?? '');
  if (m === null) return null;
  const headers: Array<[string, string]> = [];
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i <= 0) return null;
    headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  return { method: m[1] as string, target: m[2] as string, version: m[3] as string, headers, rest: buf.subarray(end + 4) };
}

/** `host:port` (IPv6 in brackets) → its parts; `null` = not one. */
function hostPort(target: string): { host: string; port: number } | null {
  const m = /^(\[[0-9a-fA-F:.]+\]|[^:/[\]\s]+):(\d{1,5})$/.exec(target);
  if (m === null) return null;
  return { host: (m[1] as string).replace(/^\[|\]$/g, ''), port: Number(m[2]) };
}

export class EgressProxy {
  private server: Server | null = null;
  private port = 0;
  private starting: Promise<number> | null = null;
  private readonly sessions = new Map<string, SessionState>();
  /** Every accepted client socket, authenticated or not. */
  private readonly clients = new Set<Socket>();
  private readonly policy: AddressPolicy;
  private readonly cap: number;

  constructor(private readonly deps: EgressProxyDeps = {}) {
    this.policy = deps.policy ?? NO_CONFIRMATION;
    this.cap = deps.capBytes ?? WEB_DOWNLOAD_CAP_BYTES;
  }

  /** Listen on 127.0.0.1 (an ephemeral port), once; answers the port. */
  start(): Promise<number> {
    if (this.server !== null) return Promise.resolve(this.port);
    this.starting ??= new Promise<number>((resolve, reject) => {
      const srv = createServer((client) => this.accept(client));
      srv.once('error', (err) => {
        this.starting = null;
        reject(err);
      });
      srv.listen(0, '127.0.0.1', () => {
        this.server = srv;
        this.port = (srv.address() as AddressInfo).port;
        resolve(this.port);
      });
    });
    return this.starting;
  }

  /** A credential for one call. */
  async open(): Promise<EgressSession> {
    const port = await this.start();
    const id = randomBytes(9).toString('hex');
    const secret = randomBytes(24).toString('hex');
    this.sessions.set(id, { secret: Buffer.from(secret), hosts: new Set(), bytes: 0, cut: false, refused: [], sockets: new Set(), closed: false });
    return { id, proxyUrl: `http://${id}:${secret}@127.0.0.1:${port}` };
  }

  /** What the call did so far (the session stays open). */
  report(session: EgressSession): EgressReport {
    const s = this.sessions.get(session.id);
    if (s === undefined) return { hosts: [], bytes: 0, cut: false, refused: [] };
    return { hosts: [...s.hosts], bytes: s.bytes, cut: s.cut, refused: [...s.refused] };
  }

  /** Revoke the credential, drop its connections and answer what it did. */
  close(session: EgressSession): EgressReport {
    const out = this.report(session);
    const s = this.sessions.get(session.id);
    if (s !== undefined) {
      s.closed = true;
      for (const sock of s.sockets) sock.destroy();
      this.sessions.delete(session.id);
    }
    return out;
  }

  async stop(): Promise<void> {
    for (const s of this.sessions.values()) for (const sock of s.sockets) sock.destroy();
    this.sessions.clear();
    for (const c of this.clients) c.destroy();
    this.clients.clear();
    const srv = this.server;
    this.server = null;
    this.starting = null;
    if (srv !== null) await new Promise<void>((r) => srv.close(() => r()));
  }

  // ── One client connection ─────────────────────────────────────────────────────────────────────

  private accept(client: Socket): void {
    client.on('error', () => undefined);
    if (this.clients.size >= MAX_CLIENTS) {
      client.destroy();
      return;
    }
    this.clients.add(client);
    client.once('close', () => this.clients.delete(client));
    client.setTimeout(IDLE_MS, () => client.destroy());
    const headDeadline = setTimeout(() => client.destroy(), HEAD_DEADLINE_MS);
    headDeadline.unref();
    client.once('close', () => clearTimeout(headDeadline));
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.indexOf('\r\n\r\n') < 0) {
        if (buf.length > HEAD_MAX_BYTES) {
          // Nothing more is read: the head is refused and the connection closed.
          client.off('data', onData);
          clearTimeout(headDeadline);
          this.answer(client, 431, 'request head too large');
          client.destroySoon();
        }
        return;
      }
      clearTimeout(headDeadline);
      client.off('data', onData);
      if (buf.indexOf('\r\n\r\n') + 4 > HEAD_MAX_BYTES) {
        // A whole head, but too large: refused before it is parsed or routed.
        this.answer(client, 431, 'request head too large');
        client.destroySoon();
        return;
      }
      client.pause();
      const head = parseHead(buf);
      if (head === null) return this.answer(client, 400, 'malformed request');
      void this.route(client, head).catch((err: unknown) => {
        this.deps.log?.(`[web egress] ${err instanceof Error ? err.message : String(err)}`);
        if (!client.destroyed) this.answer(client, 502, 'the connection failed');
      });
    };
    client.on('data', onData);
  }

  private answer(client: Socket, status: number, reason: string, extra: string[] = []): void {
    const words: Record<number, string> = { 400: 'Bad Request', 403: 'Forbidden', 405: 'Method Not Allowed', 407: 'Proxy Authentication Required', 431: 'Request Header Fields Too Large', 502: 'Bad Gateway' };
    const body = `${reason}\n`;
    client.end([`HTTP/1.1 ${status} ${words[status] ?? 'Error'}`, 'Connection: close', 'Content-Type: text/plain; charset=utf-8', `Content-Length: ${Buffer.byteLength(body)}`, ...extra, '', body].join('\r\n'));
  }

  /** The session a request's Proxy-Authorization names; `null` = none, wrong, or revoked. */
  private sessionOf(head: RequestHead): SessionState | null {
    const auth = head.headers.find(([k]) => k.toLowerCase() === 'proxy-authorization')?.[1] ?? '';
    const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(auth);
    if (m === null) return null;
    const decoded = Buffer.from(m[1] as string, 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i <= 0) return null;
    const s = this.sessions.get(decoded.slice(0, i));
    if (s === undefined || s.closed) return null;
    const given = Buffer.from(decoded.slice(i + 1));
    return given.length === s.secret.length && timingSafeEqual(given, s.secret) ? s : null;
  }

  private async route(client: Socket, head: RequestHead): Promise<void> {
    const s = this.sessionOf(head);
    if (s === null) return this.answer(client, 407, 'crew web egress: no valid credential', ['Proxy-Authenticate: Basic realm="crew"']);
    s.sockets.add(client);
    client.once('close', () => s.sockets.delete(client));
    if (head.method === 'CONNECT') {
      const hp = hostPort(head.target);
      if (hp === null) return this.answer(client, 400, 'CONNECT names host:port');
      if (!(this.deps.ports?.connect ?? [443]).includes(hp.port)) return this.refuse(client, s, hp.host, 'port_refused', `port ${hp.port} is refused: the web source reaches https on 443 and http on 80 only`);
      const upstream = await this.dial(client, s, hp.host, hp.port);
      if (upstream === null) return;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.rest.length > 0) upstream.write(head.rest);
      this.pipe(client, upstream, s);
      return;
    }
    if (head.method !== 'GET' && head.method !== 'HEAD') return this.answer(client, 405, 'the web source only reads: GET or HEAD');
    let url: URL;
    try {
      url = new URL(head.target);
    } catch {
      return this.answer(client, 400, 'a proxy request names an absolute http:// URL');
    }
    if (url.protocol !== 'http:') return this.answer(client, 400, 'a proxy request names an absolute http:// URL (https goes through CONNECT)');
    const port = url.port === '' ? 80 : Number(url.port);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!(this.deps.ports?.http ?? [80]).includes(port)) return this.refuse(client, s, host, 'port_refused', `port ${port} is refused: the web source reaches https on 443 and http on 80 only`);
    if (url.username !== '' || url.password !== '') return this.refuse(client, s, host, 'credentials_refused', 'a URL carrying a user name or password is refused: the web source sends no credentials');
    const upstream = await this.dial(client, s, host, port);
    if (upstream === null) return;
    const lines = [`${head.method} ${url.pathname}${url.search} HTTP/1.1`, `Host: ${url.host}`];
    for (const [k, v] of head.headers) {
      const lk = k.toLowerCase();
      if (DROPPED_HEADERS.has(lk) || lk === 'host' || lk.startsWith('proxy-')) continue;
      lines.push(`${k}: ${v}`);
    }
    lines.push('Connection: close', '', '');
    upstream.write(lines.join('\r\n'));
    // A read carries no body, and nothing more of this client connection goes upstream: one request, then close.
    this.pipe(client, upstream, s, false);
  }

  private refuse(client: Socket, s: SessionState, host: string, code: string, reason: string): void {
    s.refused.push({ host, code, reason });
    this.answer(client, 403, reason);
  }

  private async dial(client: Socket, s: SessionState, host: string, port: number): Promise<Socket | null> {
    if (s.cut) {
      this.refuse(client, s, host, 'cap_reached', `the call already downloaded its ${this.cap} bytes`);
      return null;
    }
    try {
      const { socket } = await dialTcp(host, port, this.policy, {
        ...(this.deps.resolver !== undefined ? { resolver: this.deps.resolver } : {}),
        ...(this.deps.connectTimeoutMs !== undefined ? { connectTimeoutMs: this.deps.connectTimeoutMs } : {}),
      });
      if (s.closed) {
        socket.destroy();
        client.destroy();
        return null;
      }
      s.hosts.add(host.toLowerCase());
      s.sockets.add(socket);
      socket.once('close', () => s.sockets.delete(socket));
      socket.setTimeout(IDLE_MS, () => socket.destroy());
      socket.on('error', () => client.destroy());
      return socket;
    } catch (err) {
      if (err instanceof DialRefusedError) {
        this.refuse(client, s, host, err.code, err.message);
        return null;
      }
      this.answer(client, 502, `connecting to ${host}:${port} failed`);
      return null;
    }
  }

  /** upstream → client counted against the cap; client → upstream only for a tunnel. */
  private pipe(client: Socket, upstream: Socket, s: SessionState, both = true): void {
    upstream.on('data', (chunk: Buffer) => {
      s.bytes += chunk.length;
      if (s.bytes > this.cap) {
        s.cut = true;
        for (const sock of s.sockets) sock.destroy();
        return;
      }
      if (!client.write(chunk)) {
        upstream.pause();
        client.once('drain', () => upstream.resume());
      }
    });
    // End (not destroy) the client when upstream is done, so bytes still queued for it are delivered.
    upstream.on('end', () => client.end());
    upstream.on('close', () => {
      if (!client.writableEnded) client.end();
    });
    client.on('close', () => upstream.destroy());
    if (!both) {
      // Nothing more of this client goes upstream; read and drop it, so its close is seen.
      client.on('data', () => undefined);
      client.resume();
    }
    if (both) {
      client.on('data', (chunk: Buffer) => {
        if (!upstream.write(chunk)) {
          client.pause();
          upstream.once('drain', () => client.resume());
        }
      });
      client.on('end', () => upstream.end());
      client.resume();
    }
  }
}
