// The site's page in real browsers (DES-APPS-001 §7.1, §8.2; S8): the production sign-in (authorization code +
// PKCE against a real HTTPS issuer), the runtime drawing live rows under the exact CSP with 0 violations, the
// host-drawn card, the share link opened by a second signed-in user, the sign-in page for an unsigned visitor and
// the refusal for someone outside the audience; and framing: an unlisted origin cannot frame the site, and a
// signed-in framed site refuses `data.action` in its host with no request to the server.
//
// Needs APPS_PG16_URL (or 17) and the built server (`npm run build -w packages/apps-server`). The real runtime is
// studio's standalone build: APPS_RUNTIME_DIR (a `<studio dist>/apps-standalone`), else the installed
// wicked-studio's; without one the real-runtime case is skipped and says so. APPS_BROWSERS=chromium,firefox,webkit.

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Browser, chromium, firefox, webkit } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppPublishBody } from '../../crew/src/core/types.js';
import { LOGINS, writeRig, type WriteRig } from '../../crew/tests/support/apps-writes.js';
import { specWith } from '../../crew/tests/support/apps-harness.js';
import { type FreshPg, freshPgDatabase, PG_TARGETS } from '../../crew/tests/support/sources-db.js';
import { startSite, type RunningSite } from '../src/main.js';
import { IDP_HOST, startIdp, type TestIdp } from './support/idp.js';
import { ASSIGN, publishSite, TICKETS, TICKETS_SQL } from './support/published.js';

const here = dirname(fileURLToPath(import.meta.url));
const SHIM = join(here, '..', 'dist', 'server', 'shim');
const PG = PG_TARGETS[0];
const ENV = { APPS_SRC_WRITER_PASSWORD: LOGINS.writer.password };

function runtimeDir(): string | null {
  const env = process.env['APPS_RUNTIME_DIR'];
  if (env !== undefined && env !== '') return env;
  try {
    const d = join(dirname(createRequire(join(here, '..', '..', 'crew', 'package.json')).resolve('wicked-studio/package.json')), 'dist', 'apps-standalone');
    return existsSync(join(d, 'runtime.js')) ? d : null;
  } catch {
    return null;
  }
}
const RUNTIME = runtimeDir();
// Set where the studio build carries the standalone entry: a missing runtime is then a failure, not a skip.
if (RUNTIME === null && process.env['APPS_RUNTIME_REQUIRED'] === '1') throw new Error('APPS_RUNTIME_REQUIRED=1, but no wicked-apps standalone runtime was found (APPS_RUNTIME_DIR or the installed wicked-studio)');
const ENGINES = { chromium, firefox, webkit };
const BROWSERS = (process.env['APPS_BROWSERS'] ?? 'chromium').split(',').map((b) => b.trim()) as Array<keyof typeof ENGINES>;

/** A runtime that ignores what it is told and sends `data.action` straight to its host, then shows the answer. */
const HOSTILE_RUNTIME = `var wickedAppsStandalone = { boot: function (port, hello) {
  document.body.setAttribute('data-k6-framed', String(hello.app.framed));
  document.body.setAttribute('data-k6-url', JSON.stringify(hello.app.url));
  port.onmessage = function (m) { var d = m.data; if (d && d.re === 'x1') document.body.setAttribute('data-k6-action', JSON.stringify({ ok: d.ok, error: d.error || null, payload: d.payload })); };
  port.postMessage({ p: 'wicked.editor', v: 1, type: 'data.action', id: 'x1', payload: { action: 'assign', params: { id: 4821 } } });
} };`;

async function freePort(): Promise<number> {
  const s = createNetServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

const PAGES = [
  {
    id: 'main',
    title: 'Tickets',
    components: [
      { id: 'tickets_table', type: 'table', title: 'Tickets', box: { x: 0, y: 0, w: 12, h: 6 }, data: { query: 'tickets' }, columns: [{ column: 'id', label: 'Ticket' }, { column: 'owner', label: 'Owner' }, { column: 'region', label: 'Region' }], rowActions: [{ label: 'Assign to me', action: 'assign', params: { id: 'row.id' } }] },
    ],
  },
];

describe.skipIf(PG === undefined)('the site page in a browser', () => {
  let idp: TestIdp;
  let db: FreshPg;
  let rig: WriteRig;
  const dirs: string[] = [];
  const sites: RunningSite[] = [];
  let parent: Server;
  let parentPort = 0;
  let realPort = 0;
  let framedPort = 0;
  let framedToken = '';

  const user = (sub: string, email: string, groups = ['support-ops']): Record<string, unknown> => ({ sub, email, email_verified: true, groups, name: sub });

  beforeAll(async () => {
    idp = await startIdp();
    db = await freshPgDatabase(PG!);
    rig = await writeRig(db, ['writer']);
    const r = await rig.h.land('desk', specWith([TICKETS], [ASSIGN], { name: 'Desk', pages: PAGES } as never), { tickets: TICKETS_SQL });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // The rig tracks its head through land(); this landing went straight to the harness.
    const head = (await rig.h.store.detail('desk')).head.version;
    (rig as { version: () => number }).version = () => head;
    expect((await rig.grant('assign', head)).status).toBe(200);
    const body = (origin: string): AppPublishBody => ({ base: head, targets: ['site'], site: { origin }, identity: { profile: 'oidc', issuer: idp.issuer, clientId: 'desk-site', allowRanges: ['127.0.0.1/32'] }, audience: { kind: 'oidc-groups', groups: ['support-ops'] } });

    parentPort = await freePort();
    realPort = await freePort();
    framedPort = await freePort();
    const start = async (dir: string, port: number, hostJs: string): Promise<void> => {
      const data = mkdtempSync(join(tmpdir(), 'apps-k6-bdata-'));
      dirs.push(data);
      sites.push(await startSite({ siteDir: dir, dataDir: data, hostJs, hostCss: readFileSync(join(SHIM, 'host.css'), 'utf8'), port, host: '127.0.0.1', env: ENV, dial: idp.dial, isMount: () => true, out: () => undefined }));
    };
    if (!existsSync(join(SHIM, 'host.js'))) throw new Error('build the server first: npm run build -w packages/apps-server');
    // 1. The real runtime, top-level only (frame-ancestors 'none').
    if (RUNTIME !== null) {
      const { dir } = await publishSite(rig, body(`http://localhost:${realPort}`), idp.endpoints);
      dirs.push(dir);
      cpSync(join(RUNTIME, 'runtime.js'), join(dir, 'runtime', 'runtime.js'));
      cpSync(join(RUNTIME, 'runtime.css'), join(dir, 'runtime', 'runtime.css'));
      await start(dir, realPort, readFileSync(join(SHIM, 'host.js'), 'utf8'));
    }
    // 2. The hostile runtime on a site the test parent may frame (a test-only manifest edit), with the test host.
    const { dir: framedDir } = await publishSite(rig, body(`http://localhost:${framedPort}`), idp.endpoints);
    dirs.push(framedDir);
    writeFileSync(join(framedDir, 'runtime', 'runtime.js'), HOSTILE_RUNTIME);
    const m = JSON.parse(readFileSync(join(framedDir, 'manifest.json'), 'utf8')) as { embedOrigins: string[] };
    writeFileSync(join(framedDir, 'manifest.json'), JSON.stringify({ ...m, embedOrigins: [`http://127.0.0.1:${parentPort}`] }));
    await start(framedDir, framedPort, readFileSync(join(SHIM, 'host.test.js'), 'utf8'));

    framedToken = idp.token({ aud: 'desk-site', ...user('u-teams', 'teams@example.com') });
    parent = createServer((req, res) => {
      const target = new URL(req.url ?? '/', `http://127.0.0.1:${parentPort}`).searchParams.get('site') ?? '';
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><body><iframe id="f" src="${target}" width="900" height="500"></iframe><script>
        window.addEventListener('message', function (e) { if (e.data && e.data.type === 'wk-test-token-request') e.source.postMessage({ type: 'wk-test-token', token: ${JSON.stringify(framedToken)} }, '*'); });
      </script></body>`);
    });
    await new Promise<void>((r) => parent.listen(parentPort, '127.0.0.1', r));
  });

  afterAll(async () => {
    for (const s of sites) await s.close();
    await new Promise<void>((r) => (parent === undefined ? r() : parent.close(() => r())));
    await rig?.h.close();
    await db?.drop();
    await idp?.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  for (const name of BROWSERS) {
    describe(name, () => {
      let browser: Browser;
      beforeAll(async () => {
        // The issuer's name resolves to loopback in the browser (WebKit has no such switch: it skips the sign-in legs).
        browser = await ENGINES[name].launch(name === 'chromium' ? { args: [`--host-resolver-rules=MAP ${IDP_HOST} 127.0.0.1`] } : name === 'firefox' ? { firefoxUserPrefs: { 'network.dns.localDomains': IDP_HOST } } : {});
      });
      afterAll(async () => {
        await browser?.close();
      });
      const context = async () => {
        const c = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 700 } });
        await c.addInitScript(() => {
          (window as unknown as { __csp: string[] }).__csp = [];
          document.addEventListener('securitypolicyviolation', (e) => (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
        });
        return c;
      };

      it.skipIf(RUNTIME === null || name === 'webkit')('signs in with code + PKCE, draws live rows under the CSP with 0 violations, runs the card; a second user opens the share link; unsigned and outsiders are stopped', async () => {
        const share = `http://localhost:${realPort}/`;
        // User 1.
        idp.signInAs = user('u-priya', 'priya@example.com');
        const a = await context();
        const pa = await a.newPage();
        const errors: string[] = [];
        pa.on('pageerror', (e) => errors.push(e.message));
        await pa.goto(share);
        await pa.getByTestId('apps-sign-in').click();
        await pa.waitForURL(share);
        await expect.poll(async () => pa.locator('[data-testid="apps-runtime"]').innerText(), { timeout: 20_000 }).toContain('4821');
        await pa.locator('[data-action="assign"]').first().click();
        const card = pa.getByTestId('apps-card');
        await card.waitFor();
        expect(await card.innerText()).toMatch(/UPDATE s\.tickets[\s\S]*priya@example\.com[\s\S]*your sign-in/);
        await pa.getByTestId('apps-card-run').click();
        await card.waitFor({ state: 'detached' });
        await expect.poll(async () => rig.one('SELECT owner AS v FROM s.tickets WHERE id = 4821'), { timeout: 10_000 }).toBe('priya@example.com');
        await expect.poll(async () => pa.locator('[data-testid="apps-runtime"]').innerText(), { timeout: 10_000 }).toContain('priya@example.com');
        expect(await pa.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
        expect(await pa.locator('[style]').count()).toBe(0);
        expect(errors).toEqual([]);
        // The verifier, state and nonce lived in sessionStorage only across the redirect.
        expect(await pa.evaluate(() => sessionStorage.length)).toBe(0);
        // User 2, in a second browser context, opens the same share link.
        idp.signInAs = user('u-sam', 'sam@example.com');
        const b = await context();
        const pb = await b.newPage();
        await pb.goto(share);
        await pb.getByTestId('apps-sign-in').click();
        await expect.poll(async () => pb.locator('[data-testid="apps-runtime"]').innerText(), { timeout: 20_000 }).toContain('4822');
        // An unsigned visitor gets the sign-in page and no data.
        const c = await context();
        const pc = await c.newPage();
        await pc.goto(share);
        await pc.getByTestId('apps-sign-in').waitFor();
        expect(await pc.locator('[data-testid="apps-runtime"]').count()).toBe(0);
        // Someone outside the audience is refused in place.
        idp.signInAs = user('u-olga', 'olga@example.com', ['finance']);
        const d = await context();
        const pd = await d.newPage();
        await pd.goto(share);
        await pd.getByTestId('apps-sign-in').click();
        await expect.poll(async () => pd.getByTestId('apps-gate').innerText(), { timeout: 20_000 }).toMatch(/don't have access/);
        // A sign-in that ends while the app is drawn: the gate comes up ABOVE it, and its button is what is under it.
        idp.signInAs = { ...user('u-short', 'short@example.com'), exp: Math.floor(Date.now() / 1000) + 6 };
        const e = await context();
        const pe = await e.newPage();
        await pe.goto(share);
        await pe.getByTestId('apps-sign-in').click();
        await expect.poll(async () => pe.locator('[data-testid="apps-runtime"]').innerText(), { timeout: 20_000 }).toContain('4823');
        await pe.waitForTimeout(7_000);
        await pe.locator('[data-action="assign"]').last().click();
        await pe.getByTestId('apps-sign-in').waitFor({ timeout: 10_000 });
        const box = (await pe.getByTestId('apps-sign-in').boundingBox())!;
        expect(await pe.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.getAttribute('data-testid') ?? null, [box.x + box.width / 2, box.y + box.height / 2])).toBe('apps-sign-in');
        for (const x of [a, b, c, d, e]) await x.close();
      });

      it('an unlisted origin cannot frame the site; a framed signed-in site refuses data.action in its host, with no request to the server; top-level the action runs (S8)', async () => {
        const ctx = await context();
        const actionRequests: string[] = [];
        ctx.on('request', (r) => {
          if (/\/a\//.test(new URL(r.url()).pathname)) actionRequests.push(r.url());
        });
        // Framed by the allowed parent: the host refuses before any request.
        const page = await ctx.newPage();
        await page.goto(`http://127.0.0.1:${parentPort}/?site=${encodeURIComponent(`http://localhost:${framedPort}/`)}`);
        const frame = page.frameLocator('#f');
        await expect.poll(async () => frame.locator('body').getAttribute('data-k6-action'), { timeout: 20_000 }).not.toBeNull();
        const answer = JSON.parse((await frame.locator('body').getAttribute('data-k6-action'))!) as { ok: boolean; error: { code: string; message: string } | null };
        expect(await frame.locator('body').getAttribute('data-k6-framed')).toBe('true');
        expect(answer).toMatchObject({ ok: false, error: { code: 'refused', message: 'Open to make changes' } });
        expect(actionRequests).toEqual([]);
        // The real site (frame-ancestors 'none') refuses to be framed by the same parent.
        if (RUNTIME !== null) {
          const p2 = await ctx.newPage();
          await p2.goto(`http://127.0.0.1:${parentPort}/?site=${encodeURIComponent(`http://localhost:${realPort}/`)}`);
          await p2.waitForTimeout(1500);
          expect(await p2.frameLocator('#f').locator('[data-testid="apps-host"]').count()).toBe(0);
        }
        if (name === 'webkit') return void (await ctx.close());
        // Top-level, the same action reaches the card and runs once the person presses Run.
        idp.signInAs = user('u-teams', 'teams@example.com');
        const top = await ctx.newPage();
        // Opened with a query (url.<name> bindings): it comes back after the sign-in redirect.
        await top.goto(`http://localhost:${framedPort}/?region=EMEA`);
        await top.getByTestId('apps-sign-in').click();
        const card = top.getByTestId('apps-card');
        await card.waitFor({ timeout: 20_000 });
        expect(JSON.parse((await top.locator('body').getAttribute('data-k6-url'))!)).toEqual({ region: 'EMEA' });
        expect(new URL(top.url()).search).toBe('?region=EMEA');
        await top.getByTestId('apps-card-run').click();
        await expect.poll(async () => top.locator('body').getAttribute('data-k6-action'), { timeout: 10_000 }).toContain('succeeded');
        expect(actionRequests.filter((u) => u.endsWith('/prepare'))).toHaveLength(1);
        expect(await rig.one('SELECT owner AS v FROM s.tickets WHERE id = 4821')).toBe('teams@example.com');
        await ctx.close();
      });
    });
  }
});
