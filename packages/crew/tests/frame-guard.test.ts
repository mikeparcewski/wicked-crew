// Clickjacking guard (src/api/frame-guard.ts): who may frame the daemon's pages, merged into any
// policy a route already sets and kept on hijacked responses.
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { bundleHeaders } from '../src/editors/csp.js';
import { frameAncestors, keepFrameGuard, mergeFrameAncestors, registerFrameGuard } from '../src/api/frame-guard.js';

const DEV = "frame-ancestors 'self' http://127.0.0.1:4200 http://localhost:4200";

describe('frameAncestors', () => {
  it("is 'self' plus studio's dev server when no origins are allowed", () => {
    expect(frameAncestors({ allowedOrigins: null })).toBe(DEV);
    expect(frameAncestors({ allowedOrigins: [] })).toBe(DEV);
  });

  it('adds the allowed origins, canonical and de-duplicated', () => {
    expect(frameAncestors({ allowedOrigins: ['https://Studio.Example.com', ' http://localhost:4200 ', 'http://10.0.0.5:8080/'] }))
      .toBe(`${DEV} https://studio.example.com http://10.0.0.5:8080`);
  });

  it('drops anything that is not a plain http(s) origin, so an allowlist entry cannot widen or end the directive', () => {
    const d = frameAncestors({ allowedOrigins: ['*', "https://a.example; script-src 'unsafe-inline'", 'javascript:alert(1)', 'ftp://x.example', 'not a url', 'https://ok.example'] });
    expect(d).toBe(`${DEV} https://ok.example`);
    expect(d).not.toContain(';');
    expect(d).not.toContain('*');
  });
});

describe('mergeFrameAncestors', () => {
  it('sets the directive alone when there is no policy', () => {
    expect(mergeFrameAncestors(undefined, DEV)).toBe(DEV);
    expect(mergeFrameAncestors('  ', DEV)).toBe(DEV);
  });

  it('appends to an existing policy instead of replacing it', () => {
    expect(mergeFrameAncestors('frame-src blob: data:', DEV)).toBe(`frame-src blob: data:; ${DEV}`);
    expect(mergeFrameAncestors("default-src 'none';", DEV)).toBe(`default-src 'none'; ${DEV}`);
    const bundle = bundleHeaders({ manifest: { permissions: [] } as never, firstParty: true })['Content-Security-Policy']!;
    const merged = mergeFrameAncestors(bundle, DEV) as string;
    expect(merged.startsWith(bundle)).toBe(true);
    expect(merged).toContain('sandbox allow-scripts');
    expect(merged).toContain("connect-src 'none'");
    expect(merged.endsWith(DEV)).toBe(true);
  });

  it('keeps a policy that already names its frame ancestors (it can only be stricter)', () => {
    expect(mergeFrameAncestors("default-src 'self'; frame-ancestors 'none'", DEV)).toBe("default-src 'self'; frame-ancestors 'none'");
    expect(mergeFrameAncestors(["img-src 'self'", "frame-ancestors 'none'"], DEV)).toEqual(["img-src 'self'", "frame-ancestors 'none'"]);
  });

  it('adds a separate policy beside an array of policies', () => {
    expect(mergeFrameAncestors(["img-src 'self'", 'sandbox allow-scripts'], DEV)).toEqual(["img-src 'self'", 'sandbox allow-scripts', DEV]);
  });
});

describe('registerFrameGuard', () => {
  const closers: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    while (closers.length > 0) await closers.pop()!();
  });

  async function app() {
    const a = Fastify({ logger: false });
    registerFrameGuard(a, { allowedOrigins: ['https://skin.example'] });
    a.get('/plain', async () => ({ ok: true }));
    a.get('/shell', async (_req, reply) => reply.header('Content-Security-Policy', 'frame-src blob:').type('text/html').send('<p>hi</p>'));
    a.get('/strict', async (_req, reply) => reply.header('Content-Security-Policy', "frame-ancestors 'none'").send('x'));
    a.get('/boom', async () => { throw new Error('boom'); });
    // A hijacked reply that writes its own head without a policy (the ask MCP route's shape).
    a.get('/hijack', async (_req, reply) => {
      reply.hijack();
      reply.raw.writeHead(401, { 'content-type': 'application/json' });
      reply.raw.end('{}');
    });
    // A hijacked reply that writes its OWN policy, the interactive proxy's shape.
    a.get('/hijack-csp', async (_req, reply) => {
      reply.hijack();
      const head: Record<string, string | string[]> = { 'content-type': 'text/html', 'content-security-policy': keepFrameGuard(reply.raw, 'sandbox allow-scripts')! };
      reply.raw.writeHead(200, head);
      reply.raw.end('<p>doc</p>');
    });
    await a.listen({ port: 0, host: '127.0.0.1' });
    closers.push(() => a.close());
    const addr = a.server.address();
    return typeof addr === 'object' && addr !== null ? addr.port : 0;
  }

  function get(port: number, path: string): Promise<{ status: number; headers: IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      httpRequest({ host: '127.0.0.1', port, path }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      }).on('error', reject).end();
    });
  }

  const D = `${DEV} https://skin.example`;

  it('guards plain, merged, strict, error and 404 replies', async () => {
    const port = await app();
    const plain = await get(port, '/plain');
    expect(plain.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(plain.headers['content-security-policy']).toBe(D);
    const shell = await get(port, '/shell');
    expect(shell.headers['content-security-policy']).toBe(`frame-src blob:; ${D}`);
    expect(shell.headers['x-frame-options']).toBe('SAMEORIGIN');
    const strict = await get(port, '/strict');
    expect(strict.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    const boom = await get(port, '/boom');
    expect(boom.status).toBe(500);
    expect(boom.headers['content-security-policy']).toBe(D);
    expect(boom.headers['x-frame-options']).toBe('SAMEORIGIN');
    const missing = await get(port, '/nope');
    expect(missing.status).toBe(404);
    expect(missing.headers['content-security-policy']).toBe(D);
    expect(missing.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('guards hijacked replies, and keeps the guard beside a policy a hijacked reply writes', async () => {
    const port = await app();
    const hijack = await get(port, '/hijack');
    expect(hijack.status).toBe(401);
    expect(hijack.headers['content-security-policy']).toBe(D);
    expect(hijack.headers['x-frame-options']).toBe('SAMEORIGIN');
    const doc = await get(port, '/hijack-csp');
    // node joins repeated headers with ", ": two policies, both enforced.
    expect(doc.headers['content-security-policy']).toBe(`${D}, sandbox allow-scripts`);
    expect(doc.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('keepFrameGuard leaves a response with no guard as it was', () => {
    const raw = { getHeader: () => undefined } as unknown as Parameters<typeof keepFrameGuard>[0];
    expect(keepFrameGuard(raw, 'sandbox allow-scripts')).toBe('sandbox allow-scripts');
    expect(keepFrameGuard(raw, undefined)).toBeUndefined();
  });
});
