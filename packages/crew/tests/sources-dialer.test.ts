// DES-APPS-001 §5.2 / S10 — the ONE dialer. Every refusal here would have connected (or followed a
// redirect) through the plain `fetch`/`net.connect` the dialer replaces: the tests count what
// reached a real local server, and how often a name was resolved.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from 'node:zlib';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createOidcVerifier, oidcAddressPolicy } from '../src/api/auth.js';
import { openTransport } from '../src/mcp-inspect/routes.js';
import { probeMcpServerWithin, transportFor } from '../src/mcp/probe.js';
import { probeRestServer, restEgress } from '../src/mcp/rest.js';
import {
  checkScheme,
  classifyAddress,
  dialFetch,
  DialRedirectRefusedError,
  DialRefusedError,
  dialTcp,
  exactRangesFor,
  NO_CONFIRMATION,
  resolveTarget,
  type Resolver,
  sameAddress,
  validateAllowRanges,
} from '../src/sources/dialer.js';

const LOOPBACK = { allow: ['127.0.0.0/8', '::1/128'], plaintext: false };
const NONE = { allow: [], plaintext: false };

/** A resolver that answers from a table and counts its calls per name. */
function table(map: Record<string, string[] | (() => string[])>): Resolver & { calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const r = (async (host: string) => {
    calls[host] = (calls[host] ?? 0) + 1;
    const v = map[host];
    return typeof v === 'function' ? v() : (v ?? []);
  }) as Resolver & { calls: Record<string, number> };
  r.calls = calls;
  return r;
}

const servers: Server[] = [];
afterEach(async () => {
  // Close open connections too: a failed test must not leave an endless body holding a server open.
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

/** A local HTTP server counting requests AND raw TCP connections (a refusal must open neither). */
async function httpServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ port: number; hits: IncomingMessage[]; connections: () => number }> {
  const hits: IncomingMessage[] = [];
  let connections = 0;
  const server = createHttpServer((req, res) => {
    hits.push(req);
    handler(req, res);
  });
  server.on('connection', () => connections++);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { port: (server.address() as AddressInfo).port, hits, connections: () => connections };
}

/** A local MCP server over streamable HTTP, one tool. */
async function mcpHttpServer(): Promise<{ port: number; hits: IncomingMessage[]; connections: () => number }> {
  return httpServer((req, res) => {
    void (async () => {
      const server = new McpServer({ name: 'pinned', version: '1.0.0' });
      server.registerTool('ping', { description: 'ping' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport as never);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      await transport.handleRequest(req, res, body);
      res.on('close', () => void server.close());
    })();
  });
}

describe('addresses: normalized, then classed (DES §5.2)', () => {
  it.each([
    ['93.184.216.34', 'global'],
    ['2606:4700::1111', 'global'],
    ['127.0.0.1', 'loopback'],
    ['127.9.9.9', 'loopback'],
    ['::1', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['[::ffff:127.0.0.1]', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.0.1', 'private'],
    ['fd12:3456::1', 'private'],
    ['::ffff:10.0.0.1', 'private'],
    ['169.254.169.254', 'refused'],
    ['::ffff:169.254.169.254', 'refused'],
    ['::ffff:a9fe:a9fe', 'refused'],
    ['fd00:ec2::254', 'refused'],
    ['fd20:ce::254', 'refused'],
    ['fd20:00ce:0000::0254', 'refused'],
    ['0.0.0.0', 'refused'],
    ['0.1.2.3', 'refused'],
    ['100.64.0.1', 'refused'],
    ['100.127.255.254', 'refused'],
    ['fe80::1', 'refused'],
    ['fe80::1%eth0', 'refused'],
    ['64:ff9b::7f00:1', 'refused'],
    ['64:ff9b:1::a00:1', 'refused'],
    ['2002:7f00:1::1', 'refused'],
    ['2001::1', 'refused'],
    ['::127.0.0.1', 'refused'],
    ['::ffff:0:7f00:1', 'refused'],
    ['::', 'refused'],
    ['224.0.0.1', 'refused'],
    ['255.255.255.255', 'refused'],
    ['ff02::1', 'refused'],
    ['192.0.2.10', 'refused'],
    ['198.18.0.1', 'refused'],
    ['example.com', 'refused'],
  ])('%s is %s', (ip, cls) => {
    expect(classifyAddress(ip).cls).toBe(cls);
  });

  it('dials an IPv4-mapped address as its IPv4 form, and compares spellings as one address', () => {
    expect(classifyAddress('::ffff:127.0.0.1')).toMatchObject({ address: '127.0.0.1', family: 4 });
    expect(sameAddress('::ffff:7f00:1', '127.0.0.1')).toBe(true);
    expect(sameAddress('2001:0db8:0000::0001', '2001:db8::1')).toBe(true);
    expect(sameAddress('127.0.0.1', '127.0.0.2')).toBe(false);
  });

  it('a confirmation names only loopback or private ranges; the always-refused can never be confirmed', () => {
    for (const ok of [['127.0.0.0/8'], ['10.0.0.0/8', '192.168.1.5/32'], ['::1/128', 'fc00::/7', 'fd12::/16'], ['172.20.0.0/16']]) {
      expect(validateAllowRanges(ok), ok.join()).toBeNull();
    }
    for (const bad of ['169.254.0.0/16', '169.254.169.254/32', '0.0.0.0/0', '100.64.0.0/10', '8.8.8.0/24', '10.0.0.0/7', 'fe80::/10', '::/0', 'nonsense', '10.0.0.1']) {
      expect(validateAllowRanges([bad]), bad).not.toBeNull();
    }
  });
});

describe('resolveTarget: resolve once, check EVERY address', () => {
  it('refuses a name with one public and one metadata address, whichever comes first', async () => {
    for (const answers of [['93.184.216.34', '169.254.169.254'], ['169.254.169.254', '93.184.216.34']]) {
      await expect(resolveTarget('api.test', LOOPBACK, table({ 'api.test': answers }))).rejects.toMatchObject({ code: 'address_refused' });
    }
  });

  it('judges a resolver answer of ::ffff:127.0.0.1 as loopback, unconfirmed unless a range covers it', async () => {
    const r = table({ 'api.test': ['::ffff:127.0.0.1'] });
    await expect(resolveTarget('api.test', NONE, r)).rejects.toMatchObject({ code: 'address_unconfirmed' });
    await expect(resolveTarget('api.test', LOOPBACK, r)).resolves.toMatchObject({ address: '127.0.0.1', family: 4, cls: 'loopback' });
  });

  it('refuses an unconfirmed private range, allows a confirmed one, and never lets a policy reach metadata', async () => {
    await expect(resolveTarget('db.internal', NONE, table({ 'db.internal': ['10.0.0.5'] }))).rejects.toMatchObject({ code: 'address_unconfirmed' });
    await expect(resolveTarget('db.internal', { allow: ['10.0.0.0/8'], plaintext: false }, table({ 'db.internal': ['10.0.0.5'] }))).resolves.toMatchObject({ address: '10.0.0.5' });
    await expect(resolveTarget('db.internal', { allow: ['10.0.0.0/8'], plaintext: false }, table({ 'db.internal': ['10.0.0.5', '10.9.9.9', '192.168.0.1'] }))).rejects.toMatchObject({ code: 'address_unconfirmed' });
    // A hand-built policy that names the metadata range is still refused: the class wins.
    await expect(resolveTarget('169.254.169.254', { allow: ['169.254.0.0/16'], plaintext: true }, table({}))).rejects.toMatchObject({ code: 'address_refused' });
  });

  it('refuses a name that does not resolve: crew cannot check where it goes', async () => {
    await expect(resolveTarget('nowhere.test', LOOPBACK, table({}))).rejects.toMatchObject({ code: 'unresolved' });
  });
});

describe('dialFetch: the request reaches the checked address, or nothing at all', () => {
  it('connects to the address checked once, never re-resolving: a rebinding answer is never used', async () => {
    const { port, hits } = await httpServer((_req, res) => res.end('ok'));
    let n = 0;
    // First answer: confirmed loopback. Any later answer: the metadata address.
    const r = table({ 'api.test': () => (n++ === 0 ? ['127.0.0.1'] : ['169.254.169.254']) });
    const res = await dialFetch(`http://api.test:${port}/x`, {}, LOOPBACK, { resolver: r });
    expect(await res.text()).toBe('ok');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.headers.host).toBe(`api.test:${port}`);
    expect(r.calls['api.test']).toBe(1);
  });

  it('a host resolving to 169.254.169.254 or ::ffff:127.0.0.1 (unconfirmed) never gets a connection', async () => {
    const { port, hits, connections } = await httpServer((_req, res) => res.end('ok'));
    await expect(dialFetch(`http://meta.test:${port}/latest/meta-data/`, {}, LOOPBACK, { resolver: table({ 'meta.test': ['169.254.169.254'] }) })).rejects.toBeInstanceOf(DialRefusedError);
    await expect(dialFetch(`http://mapped.test:${port}/`, {}, NONE, { resolver: table({ 'mapped.test': ['::ffff:127.0.0.1'] }) })).rejects.toMatchObject({ code: 'address_unconfirmed' });
    await expect(dialFetch(`http://[::ffff:127.0.0.1]:${port}/`, {}, NONE)).rejects.toMatchObject({ code: 'address_unconfirmed' });
    await expect(dialFetch(`http://[::ffff:a9fe:a9fe]:${port}/`, {}, LOOPBACK)).rejects.toMatchObject({ code: 'address_refused' });
    expect(hits).toHaveLength(0);
    expect(connections()).toBe(0);
  });

  it('IPv6 special-purpose ranges are refused, and an always-refused /128 cannot be confirmed (codex r1)', () => {
    for (const ip of ['2001:2::1', '2001:2:0:ffff::1', '3fff::1', '3fff:fff::1', '5f00::1', '2001:1ff::1']) expect(classifyAddress(ip).cls, ip).toBe('refused');
    expect(classifyAddress('2001:200::1').cls).toBe('global'); // just past 2001::/23
    expect(classifyAddress('4000::1').cls).toBe('refused'); // outside 2000::/3
    expect(validateAllowRanges(['fd00:ec2::254/128'])).not.toBeNull();
    expect(validateAllowRanges(['fd20:ce::254/128'])).not.toBeNull();
    expect(validateAllowRanges(['fd00:ec2::/64'])).toBeNull(); // a wider private range: the metadata address is refused at dial time
  });

  it('falls back across the checked addresses of a dual-stack name, never resolving again (codex r1)', async () => {
    const { port, hits } = await httpServer((_req, res) => res.end('v4'));
    const r = table({ 'dual.test': ['::1', '127.0.0.1'] });
    const res = await dialFetch(`http://dual.test:${port}/`, {}, LOOPBACK, { resolver: r });
    expect(await res.text()).toBe('v4');
    expect(hits).toHaveLength(1);
    expect(r.calls['dual.test']).toBe(1);
    const { socket, target } = await dialTcp('dual.test', port, LOOPBACK, { resolver: table({ 'dual.test': ['::1', '127.0.0.1'] }) });
    expect(target.address).toBe('127.0.0.1');
    socket.destroy();
  });

  it('an HTTP 101 or a connection closed before an answer rejects; it never hangs (codex r1)', async () => {
    const raw = createTcpServer((s) => {
      s.once('data', () => s.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: Upgrade\r\n\r\n'));
    });
    await new Promise<void>((r) => raw.listen(0, '127.0.0.1', r));
    const closer = createTcpServer((s) => s.once('data', () => s.destroy()));
    await new Promise<void>((r) => closer.listen(0, '127.0.0.1', r));
    try {
      const timeout = AbortSignal.timeout(3_000);
      await expect(dialFetch(`http://127.0.0.1:${(raw.address() as AddressInfo).port}/`, { signal: timeout }, LOOPBACK)).rejects.toThrow(/101|closed/);
      expect(timeout.aborted).toBe(false);
      await expect(dialFetch(`http://127.0.0.1:${(closer.address() as AddressInfo).port}/`, {}, LOOPBACK)).rejects.toThrow();
    } finally {
      await new Promise<void>((r) => raw.close(() => r()));
      await new Promise<void>((r) => closer.close(() => r()));
    }
  });

  it('decodes a gzip body, as fetch did (codex r1)', async () => {
    const { port } = await httpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(gzipSync(JSON.stringify({ openapi: '3.0.3' })));
    });
    const res = await dialFetch(`http://127.0.0.1:${port}/`, {}, LOOPBACK);
    expect(await res.json()).toEqual({ openapi: '3.0.3' });
    expect(res.headers.get('content-encoding')).toBeNull();
  });

  it('an abort while resolution is still pending rejects at once, and nothing dials once it resolves (codex r1, r2)', async () => {
    const { port, hits, connections } = await httpServer((_req, res) => res.end('late'));
    const ctrl = new AbortController();
    let release: (v: string[]) => void = () => undefined;
    const resolver: Resolver = () => new Promise<string[]>((r) => (release = r));
    const pending = dialFetch(`http://slow.test:${port}/`, { signal: ctrl.signal }, LOOPBACK, { resolver });
    const outcome = pending.then(() => 'resolved', (e: unknown) => (e as Error).message);
    await new Promise((r) => setTimeout(r, 20));
    ctrl.abort(new Error('deadline'));
    expect(await outcome).toBe('deadline'); // before the name ever resolved
    release(['127.0.0.1']);
    await new Promise((r) => setTimeout(r, 50));
    expect(hits).toHaveLength(0);
    expect(connections()).toBe(0);
    // dialTcp, too: an abort before the connection is used refuses it.
    const ctrl2 = new AbortController();
    ctrl2.abort(new Error('gone'));
    await expect(dialTcp('127.0.0.1', port, LOOPBACK, { signal: ctrl2.signal })).rejects.toThrow('gone');
  });

  it('decodes as fetch does: coding lists in reverse, raw deflate, an empty gzip body (codex r2)', async () => {
    const json = JSON.stringify({ ok: true });
    const cases: Array<[string, Buffer]> = [
      ['gzip, br', brotliCompressSync(gzipSync(json))],
      ['deflate', deflateRawSync(json)],
      ['deflate', deflateSync(json)], // zlib-wrapped
      ['gzip', Buffer.alloc(0)],
    ];
    for (const [enc, body] of cases) {
      const { port } = await httpServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': enc });
        res.end(body);
      });
      const res = await dialFetch(`http://127.0.0.1:${port}/`, {}, LOOPBACK);
      expect(await res.text(), enc).toBe(body.length === 0 ? '' : json);
    }
  });

  it('an abort after the answer arrived errors the exposed body, decoded chunks included (codex r2)', async () => {
    const big = gzipSync(Buffer.alloc(2 * 1024 * 1024, 'a'));
    const { port } = await httpServer((_req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.end(big);
    });
    const ctrl = new AbortController();
    const res = await dialFetch(`http://127.0.0.1:${port}/`, { signal: ctrl.signal }, LOOPBACK);
    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort(new Error('call deadline'));
    await expect(res.text()).rejects.toThrow();
  });

  it('a small body that fully arrived but was not read is still errored by an abort (codex r3)', async () => {
    for (const enc of ['identity', 'gzip']) {
      const payload = JSON.stringify({ small: true });
      const { port } = await httpServer((_req, res) => {
        res.writeHead(200, enc === 'gzip' ? { 'content-encoding': 'gzip' } : {});
        res.end(enc === 'gzip' ? gzipSync(payload) : payload);
      });
      const ctrl = new AbortController();
      const res = await dialFetch(`http://127.0.0.1:${port}/`, { signal: ctrl.signal }, LOOPBACK);
      await new Promise((r) => setTimeout(r, 100)); // the whole body has arrived and the wire closed
      ctrl.abort(new Error('call deadline'));
      await expect(res.text(), enc).rejects.toThrow('call deadline');
    }
  });

  it('a deflate body is decoded with backpressure, and cancelling the body closes the connection (codex r3, r4)', async () => {
    // The server streams a deflate body that never ends, writing only while the socket takes it.
    let written = 0;
    let socketClosed: () => void = () => undefined;
    const closed = new Promise<void>((r) => (socketClosed = r));
    const chunk = deflateRawSync(Buffer.alloc(256 * 1024, 'z'), { finishFlush: 2 /* Z_SYNC_FLUSH */ });
    const { port } = await httpServer((req, res) => {
      req.socket.once('close', () => socketClosed());
      res.writeHead(200, { 'content-encoding': 'deflate' });
      const pump = (): void => {
        while (!res.destroyed) {
          written += chunk.length;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
      };
      pump();
    });
    const res = await dialFetch(`http://127.0.0.1:${port}/`, {}, LOOPBACK);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let cancelled = false;
    try {
      expect((await reader.read()).done).toBe(false);
      await new Promise((r) => setTimeout(r, 400)); // the reader stops reading
      const whilePaused = written;
      await new Promise((r) => setTimeout(r, 400));
      // Bounded: nothing pulls the wire while nobody reads (eager decoding would keep draining it).
      expect(written - whilePaused).toBeLessThan(chunk.length * 4);
      expect(written).toBeLessThan(64 * 1024 * 1024);
      await reader.cancel();
      cancelled = true;
      await closed; // the client's cancel closed the connection (the server never ends this body)
    } finally {
      // An assertion that failed above must not leave the endless body holding the server open.
      if (!cancelled) await reader.cancel().catch(() => undefined);
    }
  });

  it('an abort landing between the answer and the decoder setup is not lost (codex r5)', async () => {
    let socketClosed: () => void = () => undefined;
    const closed = new Promise<void>((r) => (socketClosed = r));
    const { port } = await httpServer((req, res) => {
      req.socket.once('close', () => socketClosed());
      res.writeHead(200, { 'content-encoding': 'deflate' });
      res.flushHeaders(); // headers, never a body
    });
    // The abort fires exactly when the request's own listener is removed (the answer arrived), before
    // anything else listens: the window an event-only check would miss.
    const ctrl = new AbortController();
    let removals = 0;
    const signal = new Proxy(ctrl.signal, {
      get(t, k) {
        if (k === 'removeEventListener') {
          return (...a: Parameters<AbortSignal['removeEventListener']>) => {
            t.removeEventListener(...a);
            if (++removals === 1) ctrl.abort(new Error('handoff'));
          };
        }
        const v = Reflect.get(t, k) as unknown;
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
      },
    });
    const out = await Promise.race([
      dialFetch(`http://127.0.0.1:${port}/`, { signal }, LOOPBACK).then(() => 'answered', (e: unknown) => (e as Error).message),
      new Promise<string>((r) => setTimeout(() => r('still pending'), 2_000)),
    ]);
    expect(out).toBe('handoff');
    await closed;
  });

  it('an abort while waiting for a deflate answer\'s first byte rejects and closes the connection (codex r4)', async () => {
    let socketClosed: () => void = () => undefined;
    const closed = new Promise<void>((r) => (socketClosed = r));
    const { port } = await httpServer((req, res) => {
      req.socket.once('close', () => socketClosed());
      res.writeHead(200, { 'content-encoding': 'deflate' });
      res.flushHeaders(); // headers now, body never
    });
    const ctrl = new AbortController();
    const pending = dialFetch(`http://127.0.0.1:${port}/`, { signal: ctrl.signal }, LOOPBACK).then(() => 'answered', (e: unknown) => (e as Error).message);
    await new Promise((r) => setTimeout(r, 200));
    ctrl.abort(new Error('deadline'));
    expect(await pending).toBe('deadline');
    await closed;
  });

  it('more than five content codings are refused before any decoder is built (codex r4)', async () => {
    const { port } = await httpServer((_req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip, gzip, gzip, gzip, gzip, gzip' });
      res.end('x');
    });
    await expect(dialFetch(`http://127.0.0.1:${port}/`, {}, LOOPBACK)).rejects.toThrow(/at most 5 codings/);
  });

  it('a null-body answer (205) closes the connection instead of waiting on a body that never ends (codex r3)', async () => {
    let socketClosed = false;
    const raw = createTcpServer((sock) => {
      sock.on('close', () => (socketClosed = true));
      sock.once('data', () => sock.write('HTTP/1.1 205 Reset Content\r\ncontent-length: 10\r\n\r\nab'));
    });
    await new Promise<void>((r) => raw.listen(0, '127.0.0.1', r));
    try {
      const res = await dialFetch(`http://127.0.0.1:${(raw.address() as AddressInfo).port}/`, {}, LOOPBACK);
      expect(res.status).toBe(205);
      expect(res.body).toBeNull();
      await new Promise((r) => setTimeout(r, 200));
      expect(socketClosed).toBe(true);
    } finally {
      await new Promise<void>((r) => raw.close(() => r()));
    }
  });

  it('a REST egress reports a private address when ANY checked address is one (codex r2)', () => {
    const e = restEgress(new URL('https://api.example.com/v1'), {}, null, { cls: 'global', addresses: [{ address: '8.8.8.8', family: 4, cls: 'global' }, { address: '10.0.0.1', family: 4, cls: 'private' }] });
    expect(e.privateAddress).toBe(true);
  });

  it('a REST preview refuses a plaintext base URL every call would refuse (codex r1)', async () => {
    const spec = { openapi: '3.0.3', info: { title: 'x', version: '1' }, servers: [{ url: 'http://api.example.com/v1' }], paths: { '/a': { get: { operationId: 'a' } } } };
    const pub = await probeRestServer({ name: 'p', kind: 'rest', command: null, args: [], url: 'http://api.example.com/v1', auth: null, openapi: spec }, null, { resolver: table({ 'api.example.com': ['93.184.216.34'] }) });
    expect(pub).toMatchObject({ ok: false, error: expect.stringContaining('plaintext http') });
    const priv = await probeRestServer({ name: 'p', kind: 'rest', command: null, args: [], url: 'http://db.internal/v1', auth: null, openapi: spec, address: { allow: ['10.0.0.0/8'], plaintext: false } }, null, { resolver: table({ 'db.internal': ['10.0.0.5'] }) });
    expect(priv).toMatchObject({ ok: false, error: expect.stringContaining('plaintext http') });
  });

  it('refuses a redirect instead of following it (the target is never contacted)', async () => {
    const target = await httpServer((_req, res) => res.end('secret'));
    const { port, hits } = await httpServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${target.port}/x` });
      res.end();
    });
    const err = await dialFetch(`http://127.0.0.1:${port}/`, {}, LOOPBACK).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DialRedirectRefusedError);
    expect((err as DialRedirectRefusedError).status).toBe(302);
    expect(hits).toHaveLength(1);
    expect(target.hits).toHaveLength(0);
  });

  it('plaintext only to loopback or a private range confirmed as plaintext; never to a global host', async () => {
    await expect(dialFetch('http://api.example.com/', {}, NONE, { resolver: table({ 'api.example.com': ['93.184.216.34'] }) })).rejects.toMatchObject({ code: 'plaintext_refused' });
    await expect(dialFetch('http://db.internal/', {}, { allow: ['10.0.0.0/8'], plaintext: false }, { resolver: table({ 'db.internal': ['10.0.0.5'] }) })).rejects.toMatchObject({ code: 'plaintext_refused' });
  });

  it('plaintext is accepted on a private range confirmed as plaintext, and on loopback (pi r1)', () => {
    const priv = { hostname: 'db.internal', address: '10.0.0.5', family: 4 as const, cls: 'private' as const, addresses: [{ address: '10.0.0.5', family: 4 as const, cls: 'private' as const }] };
    expect(() => checkScheme(new URL('http://db.internal/'), priv, { allow: ['10.0.0.0/8'], plaintext: true })).not.toThrow();
    expect(() => checkScheme(new URL('http://db.internal/'), priv, { allow: ['10.0.0.0/8'], plaintext: false })).toThrow(/plaintext/);
    const lo = { ...priv, address: '127.0.0.1', cls: 'loopback' as const, addresses: [{ address: '127.0.0.1', family: 4 as const, cls: 'loopback' as const }] };
    expect(() => checkScheme(new URL('http://localhost/'), lo, LOOPBACK)).not.toThrow();
  });

  it('refuses CONNECT, a port outside 1-65535 and an empty host (pi r3)', async () => {
    await expect(dialFetch('http://127.0.0.1:9/', { method: 'CONNECT' }, LOOPBACK)).rejects.toMatchObject({ code: 'url_refused' });
    await expect(dialTcp('127.0.0.1', 0, LOOPBACK)).rejects.toMatchObject({ code: 'url_refused' });
    await expect(dialTcp('127.0.0.1', 70_000, LOOPBACK)).rejects.toMatchObject({ code: 'url_refused' });
    await expect(resolveTarget('', LOOPBACK)).rejects.toMatchObject({ code: 'url_refused' });
  });

  it('refuses credentials in the URL and non-http schemes', async () => {
    await expect(dialFetch('https://user:pw@api.example.com/', {}, NONE)).rejects.toMatchObject({ code: 'url_refused' });
    await expect(dialFetch('file:///etc/passwd', {}, NONE)).rejects.toMatchObject({ code: 'url_refused' });
  });

  it('streams the body and passes method, headers and body through', async () => {
    const { port, hits } = await httpServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => res.end(JSON.stringify({ method: req.method, body, h: req.headers['x-a'] })));
    });
    const res = await dialFetch(`http://localhost:${port}/`, { method: 'POST', headers: { 'x-a': '1' }, body: 'hello' }, LOOPBACK, { resolver: table({ localhost: ['127.0.0.1'] }) });
    expect(await res.json()).toEqual({ method: 'POST', body: 'hello', h: '1' });
    expect(hits).toHaveLength(1);
  });
});

describe('dialTcp: the database drivers connect to the checked address', () => {
  it('connects through a name to the pinned address, and refuses metadata with no connection', async () => {
    let accepted = 0;
    const server = createTcpServer((s) => {
      accepted++;
      s.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const { socket, target } = await dialTcp('db.test', port, LOOPBACK, { resolver: table({ 'db.test': ['::ffff:127.0.0.1'] }) });
      expect(target.address).toBe('127.0.0.1');
      socket.destroy();
      await expect(dialTcp('db.test', port, LOOPBACK, { resolver: table({ 'db.test': ['169.254.169.254'] }) })).rejects.toMatchObject({ code: 'address_refused' });
      await expect(dialTcp('db.test', port, NONE, { resolver: table({ 'db.test': ['127.0.0.1'] }) })).rejects.toMatchObject({ code: 'address_unconfirmed' });
      await new Promise((r) => setTimeout(r, 50));
      expect(accepted).toBe(1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// TLS keeps the hostname while the connection goes to the pinned address. Certificates are made
// with openssl at test time (no key material in the repo); without openssl these say so and skip.
const OPENSSL = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!OPENSSL)('dialFetch over TLS: SNI and certificate checks use the hostname, not the pinned address', () => {
  let dir = '';
  let port = 0;
  let server: Server | null = null;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dialer-tls-'));
    const run = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
    run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=dialer test CA']);
    run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=api.test']);
    writeFileSync(join(dir, 'ext.cnf'), 'subjectAltName=DNS:api.test\n');
    run(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '2', '-extfile', 'ext.cnf']);
    server = createHttpsServer({ key: readFileSync(join(dir, 'leaf.key')), cert: readFileSync(join(dir, 'leaf.pem')) }, (_req, res) => res.end('tls ok'));
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    if (server !== null) await new Promise<void>((r) => server?.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('verifies the certificate against the name (passes with its CA), and refuses an unknown CA', async () => {
    const ca = readFileSync(join(dir, 'ca.pem'), 'utf8');
    const res = await dialFetch(`https://api.test:${port}/`, {}, LOOPBACK, { resolver: table({ 'api.test': ['127.0.0.1'] }), tls: { ca } });
    expect(await res.text()).toBe('tls ok');
    // No CA: Node's default verification refuses the self-signed chain.
    await expect(dialFetch(`https://api.test:${port}/`, {}, LOOPBACK, { resolver: table({ 'api.test': ['127.0.0.1'] }) })).rejects.toThrow();
    // A name the certificate does not carry is refused even though the address is the same.
    await expect(dialFetch(`https://other.test:${port}/`, {}, LOOPBACK, { resolver: table({ 'other.test': ['127.0.0.1'] }), tls: { ca } })).rejects.toThrow(/other\.test|altnames|Hostname/i);
    // A caller's Host header cannot move the certificate check to the name the certificate carries.
    await expect(dialFetch(`https://other.test:${port}/`, { headers: { host: 'api.test' } }, LOOPBACK, { resolver: table({ 'other.test': ['127.0.0.1'] }), tls: { ca } })).rejects.toThrow(/other\.test|altnames|Hostname/i);
  });
});

describe('an mcp-http server is reached only through the dialer', () => {
  it('every request of a session is checked: a name that rebinds after initialize is refused at the next request (codex r1)', async () => {
    const { port, hits } = await mcpHttpServer();
    let n = 0;
    const resolver: Resolver = async () => (n++ === 0 ? ['127.0.0.1'] : ['169.254.169.254']);
    const r = await probeMcpServerWithin({ name: 'h', kind: 'mcp-http', command: null, args: [], url: `http://mcp.test:${port}/mcp`, auth: null, address: LOOPBACK }, null, { budgetMs: 2_000, retryDelaysMs: [100], sleep: async () => undefined, now: Date.now }, { resolver });
    expect(r.ok).toBe(false);
    expect(hits).toHaveLength(1);
    // The same server, through a name that keeps resolving to the confirmed address: the whole session works.
    const ok = await probeMcpServerWithin({ name: 'h', kind: 'mcp-http', command: null, args: [], url: `http://mcp.test:${port}/mcp`, auth: null, address: LOOPBACK }, null, { budgetMs: 5_000, retryDelaysMs: [100], sleep: async () => undefined, now: Date.now }, { resolver: table({ 'mcp.test': ['127.0.0.1'] }) });
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
  });

  it('a dual-stack name whose server starts late keeps the probe retrying (codex r2)', async () => {
    const reserve = createTcpServer();
    await new Promise<void>((r) => reserve.listen(0, '127.0.0.1', r));
    const port = (reserve.address() as AddressInfo).port;
    await new Promise<void>((r) => reserve.close(() => r()));
    let late: Server | null = null;
    const starter = setTimeout(() => {
      late = createHttpServer((req, res) => {
        void (async () => {
          const server = new McpServer({ name: 'late', version: '1.0.0' });
          server.registerTool('ping', { description: 'ping' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
          const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
          await server.connect(transport as never);
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          await transport.handleRequest(req, res, chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined);
          res.on('close', () => void server.close());
        })();
      });
      late.listen(port, '127.0.0.1');
    }, 600);
    try {
      const r = await probeMcpServerWithin(
        { name: 'late', kind: 'mcp-http', command: null, args: [], url: `http://dual.test:${port}/mcp`, auth: null, address: LOOPBACK },
        null,
        { budgetMs: 6_000, retryDelaysMs: [200, 400], sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now },
        { resolver: table({ 'dual.test': ['::1', '127.0.0.1'] }) },
      );
      expect(r.ok, JSON.stringify(r)).toBe(true);
    } finally {
      clearTimeout(starter);
      if (late !== null) await new Promise<void>((r) => (late as unknown as Server).close(() => r()));
    }
  });

  it('a stateful session: GET stream, tools and the session DELETE each go through the dialer (codex r2)', async () => {
    const { randomUUID } = await import('node:crypto');
    const transports = new Map<string, StreamableHTTPServerTransport>();
    const methods: string[] = [];
    const { port } = await httpServer((req, res) => {
      methods.push(req.method ?? '');
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
        const sid = req.headers['mcp-session-id'];
        let t = typeof sid === 'string' ? transports.get(sid) : undefined;
        if (t === undefined) {
          t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => void transports.set(id, t as StreamableHTTPServerTransport) });
          const server = new McpServer({ name: 'stateful', version: '1.0.0' });
          server.registerTool('ping', { description: 'ping' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
          await server.connect(t as never);
        }
        await t.handleRequest(req, res, body);
      })();
    });
    let flip = false;
    const resolver: Resolver = async () => (flip ? ['169.254.169.254'] : ['127.0.0.1']);
    const { transport } = transportFor({ name: 's', kind: 'mcp-http', command: null, args: [], url: `http://mcp.test:${port}/mcp`, auth: null, address: LOOPBACK }, null, { resolver });
    const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
    await client.connect(transport);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['ping']);
    await new Promise((r) => setTimeout(r, 100));
    expect(methods).toContain('GET'); // the session's stream opened, through the dialer (mcp.test resolves nowhere else)
    const before = methods.length;
    flip = true; // the name now answers the metadata address
    await expect((transport as unknown as { terminateSession: () => Promise<void> }).terminateSession()).rejects.toThrow();
    await expect(client.listTools()).rejects.toThrow();
    expect(methods.length).toBe(before); // neither the DELETE nor the call reached anything
    await client.close().catch(() => undefined);
    for (const t of transports.values()) await t.close().catch(() => undefined);
  });

  it('the MCP inspector dials under the target address policy (codex r1)', async () => {
    const { port, hits, connections } = await mcpHttpServer();
    const refused = openTransport({ kind: 'streamable-http', url: `http://127.0.0.1:${port}/mcp`, headers: {}, address: NO_CONFIRMATION });
    const c1 = new Client({ name: 't', version: '1' }, { capabilities: {} });
    await expect(c1.connect(refused.transport)).rejects.toThrow(/loopback address/);
    expect(connections()).toBe(0);
    for (const kind of ['streamable-http', 'sse'] as const) {
      const sse = openTransport({ kind, url: `http://127.0.0.1:${port}/mcp`, headers: {}, address: NO_CONFIRMATION });
      const c = new Client({ name: 't', version: '1' }, { capabilities: {} });
      await expect(c.connect(sse.transport), kind).rejects.toThrow(/loopback address/);
    }
    expect(hits).toHaveLength(0);
    const allowed = openTransport({ kind: 'streamable-http', url: `http://127.0.0.1:${port}/mcp`, headers: {}, address: { allow: exactRangesFor(`http://127.0.0.1:${port}/mcp`), plaintext: false } });
    const c2 = new Client({ name: 't', version: '1' }, { capabilities: {} });
    await c2.connect(allowed.transport);
    expect((await c2.listTools()).tools.map((t) => t.name)).toEqual(['ping']);
    await c2.close();
  });

  const budget = { budgetMs: 2_000, retryDelaysMs: [100], sleep: async () => undefined, now: Date.now };
  it('an unconfirmed loopback server is never contacted; a redirect is refused, not followed', async () => {
    const target = await httpServer((_req, res) => res.end('{}'));
    const { port, hits } = await httpServer((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${target.port}/mcp` });
      res.end();
    });
    const url = `http://127.0.0.1:${port}/mcp`;
    const unconfirmed = await probeMcpServerWithin({ name: 'h', kind: 'mcp-http', command: null, args: [], url, auth: null }, null, budget);
    expect(unconfirmed).toMatchObject({ ok: false, error: expect.stringContaining('loopback address') });
    expect(hits).toHaveLength(0);
    const redirected = await probeMcpServerWithin({ name: 'h', kind: 'mcp-http', command: null, args: [], url, auth: null, address: LOOPBACK }, null, budget);
    expect(redirected.ok).toBe(false);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(target.hits).toHaveLength(0);
  });
});

describe.skipIf(!OPENSSL)('OIDC discovery through the dialer: a discovery document cannot widen the policy (codex r2)', () => {
  let dir = '';
  let ca = '';
  let port = 0;
  let server: Server | null = null;
  let jwksUri = '';
  const hits: string[] = [];
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'oidc-tls-'));
    const run = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
    run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=oidc test CA']);
    run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=idp.test']);
    writeFileSync(join(dir, 'ext.cnf'), 'subjectAltName=DNS:idp.test,DNS:keys.internal\n');
    run(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '2', '-extfile', 'ext.cnf']);
    ca = readFileSync(join(dir, 'ca.pem'), 'utf8');
    server = createHttpsServer({ key: readFileSync(join(dir, 'leaf.key')), cert: readFileSync(join(dir, 'leaf.pem')) }, (req, res) => {
      hits.push(req.url ?? '');
      res.setHeader('content-type', 'application/json');
      if ((req.url ?? '').endsWith('/.well-known/openid-configuration')) res.end(JSON.stringify({ jwks_uri: jwksUri }));
      else res.end(JSON.stringify({ keys: [] }));
    });
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    if (server !== null) await new Promise<void>((r) => server?.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });
  const token = (iss: string, kid: string): string => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString('base64url');
    const p = Buffer.from(JSON.stringify({ iss, aud: 'a', sub: 'u', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    return `${h}.${p}.sig`;
  };

  it('a jwks_uri at a loopback address outside the configured one is never connected to (codex r3)', async () => {
    let v6Connections = 0;
    const v6 = createTcpServer((sock) => {
      v6Connections++;
      sock.destroy();
    });
    const listening = await new Promise<boolean>((r) => {
      v6.once('error', () => r(false));
      v6.listen(port, '::1', () => r(true));
    });
    try {
      if (!listening) return; // no IPv6 loopback on this runner: the private-address case below still holds
      const iss = `https://idp.test:${port}/v6`;
      jwksUri = `https://keys.test:${port}/keys`;
      hits.length = 0;
      const v = createOidcVerifier({ issuer: iss, audience: 'a', allowRanges: ['127.0.0.1/32'] }, { dial: { resolver: table({ 'idp.test': ['127.0.0.1'], 'keys.test': ['::1'] }), tls: { ca } } });
      expect(await v.verify(token(iss, 'k3'))).toBeNull();
      expect(hits).toEqual(['/v6/.well-known/openid-configuration']);
      expect(v6Connections).toBe(0);
    } finally {
      await new Promise<void>((r) => v6.close(() => r()));
    }
  });

  it('a jwks_uri at an unconfigured private address is never contacted; one on the configured host is', async () => {
    const resolver = table({ 'idp.test': ['127.0.0.1'] });
    // The configured range is idp.test's loopback address; the discovery document names a host at a private one.
    const resolver2 = table({ 'idp.test': ['127.0.0.1'], 'keys.internal': ['10.0.0.5'] });
    const iss = `https://idp.test:${port}`;
    jwksUri = `https://keys.internal:${port}/keys`;
    hits.length = 0;
    const v = createOidcVerifier({ issuer: iss, audience: 'a', allowRanges: ['127.0.0.1/32'] }, { dial: { resolver: resolver2, tls: { ca } } });
    expect(await v.verify(token(iss, 'k1'))).toBeNull();
    expect(hits).toEqual(['/.well-known/openid-configuration']); // discovery only: the keys host was refused
    // Control: a jwks_uri on the configured host is fetched.
    const iss2 = `https://idp.test:${port}/t2`;
    jwksUri = `https://idp.test:${port}/keys`;
    hits.length = 0;
    const v2 = createOidcVerifier({ issuer: iss2, audience: 'a', allowRanges: ['127.0.0.1/32'] }, { dial: { resolver, tls: { ca } } });
    expect(await v2.verify(token(iss2, 'k2'))).toBeNull();
    expect(hits).toEqual(['/t2/.well-known/openid-configuration', '/keys']);
  });
});

describe('OIDC discovery and keys go through the dialer (S10)', () => {
  it('a JWKS answer that redirects is refused, not followed', async () => {
    const target = await httpServer((_req, res) => res.end(JSON.stringify({ keys: [] })));
    const jwks = await httpServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${target.port}/keys` });
      res.end();
    });
    const v = createOidcVerifier({ issuer: 'https://127.0.0.1:1', audience: 'wicked-crew', jwksUri: `http://127.0.0.1:${jwks.port}/keys` });
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k-redirect' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: 'https://127.0.0.1:1', aud: 'wicked-crew', sub: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    expect(await v.verify(`${header}.${payload}.sig`)).toBeNull();
    expect(jwks.hits.length).toBeGreaterThanOrEqual(1);
    expect(target.hits).toHaveLength(0);
  });

  it('the IdP policy is what the operator configured, never widened by discovery (codex r1)', async () => {
    // A public issuer confirms nothing: a discovery document naming a private or loopback jwks_uri is refused.
    expect(oidcAddressPolicy({ issuer: 'https://idp.example.com' })).toEqual({ allow: [], plaintext: false });
    expect(oidcAddressPolicy({ issuer: 'https://10.1.2.3', jwksUri: 'https://localhost/keys' })).toEqual({ allow: ['10.1.2.3/32', '127.0.0.0/8', '::1/128'], plaintext: false });
    expect(oidcAddressPolicy({ issuer: 'https://idp.corp', allowRanges: ['10.20.0.0/16'] }).allow).toEqual(['10.20.0.0/16']);
    const pub = oidcAddressPolicy({ issuer: 'https://idp.example.com' });
    await expect(dialFetch('http://127.0.0.1:9/keys', {}, pub)).rejects.toMatchObject({ code: 'address_unconfirmed' });
    await expect(dialFetch('https://169.254.169.254/.well-known/jwks.json', {}, oidcAddressPolicy({ issuer: 'https://169.254.169.254' }))).rejects.toMatchObject({ code: 'address_refused' });
    expect(() => createOidcVerifier({ issuer: 'https://idp.example.com', audience: 'a', allowRanges: ['169.254.0.0/16'] })).toThrow(/allowRanges/);
  });
});
