// A public site over a REST source (DES-APPS-001 §8.2, S14, S16): no database needed. The REST service is
// registered through crew's own preview and save (its tools hashed by crew), the app checked by crew's source
// stage, published with crew's manifest. The site probes the service live: when the operation changes, the query
// is refused by name; when it is back as published, the query runs again. A public visitor is limited per address.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildManifest } from '../../crew/src/apps/publish/manifest.js';
import { writeSite } from '../../crew/src/apps/publish/pack.js';
import type { AppQuery } from '../../crew/src/core/types.js';
import { appsHarness, type Harness, specWith } from '../../crew/tests/support/apps-harness.js';
import { startSite, type RunningSite } from '../src/main.js';
import { call, FAKE_RUNTIME } from './support/published.js';

const ITEMS = { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } } } } };
const op = (extraParams: unknown[] = []) => ({ get: { operationId: 'listItems', parameters: extraParams, responses: { '200': { description: 'ok', content: { 'application/json': { schema: ITEMS } } } } } });

describe('a public site over a REST source', () => {
  let svc: Server;
  let origin = '';
  let doc: Record<string, unknown> = {};
  let h: Harness;
  let site: RunningSite;
  const dirs: string[] = [];

  beforeAll(async () => {
    svc = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/openapi.json') res.end(JSON.stringify(doc));
      else if ((req.url ?? '').startsWith('/v1/items')) res.end(JSON.stringify({ items: [{ id: 1, name: 'alpha' }, { id: 2, name: 'beta' }] }));
      else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    await new Promise<void>((r) => svc.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(svc.address() as AddressInfo).port}`;
    doc = { openapi: '3.0.3', info: { title: 'items', version: '1' }, servers: [{ url: `${origin}/v1` }], paths: { '/items': op() } };
    h = await appsHarness();
    await h.register({ name: 'items-api', kind: 'rest', url: `${origin}/v1`, openapiUrl: `${origin}/openapi.json`, address: { allow: ['127.0.0.0/8'] } });
    await h.newApp('desk');
    const q: AppQuery = { id: 'items', source: 'items-api', kind: 'rest', rowPath: '$.items[*]', output: [{ name: 'id', type: 'integer' }, { name: 'name', type: 'string' }], public: true };
    const landed = await h.land('desk', specWith([q]), { items: JSON.stringify({ tool: 'listItems', args: {} }) });
    expect(landed.status, JSON.stringify(landed.body)).toBe(200);
    const head = (await h.store.detail('desk')).head.version;
    const at = await h.store.acceptedFiles('desk', head);
    const out = await buildManifest({
      app: { slug: 'desk', name: 'Desk', version: head, tree: at.tree, commit: at.commit },
      files: at.files,
      body: { base: head, targets: ['site', 'embed'], site: { origin: 'http://localhost:8080' }, identity: null, audience: { kind: 'public' }, embedOrigins: ['https://intranet.example.com'] },
      registry: h.registry,
      grantOf: () => null,
      endpoints: null,
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (!out.ok) return;
    expect(out.sources.sources['items-api']!.tools.map((t) => t.name)).toEqual(['listItems']);
    const dir = mkdtempSync(join(tmpdir(), 'apps-k6-rest-'));
    const data = mkdtempSync(join(tmpdir(), 'apps-k6-rdata-'));
    dirs.push(dir, data);
    writeSite(dir, { spec: at.files.spec, specText: JSON.stringify(at.files.spec), lockText: JSON.stringify(at.files.lock), queryText: at.files.queryText, manifest: out.manifest, sources: out.sources, runtime: FAKE_RUNTIME });
    site = await startSite({ siteDir: dir, dataDir: data, hostJs: 'void 0;', hostCss: '', port: 0, host: '127.0.0.1', env: {}, isMount: () => false, out: () => undefined });
  });
  afterAll(async () => {
    await site?.close();
    await h?.close();
    await new Promise<void>((r) => (svc === undefined ? r() : svc.close(() => r())));
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('serves without sign-in, frameable only by the embed origin', async () => {
    const spec = await call(site.port, 'GET', '/spec');
    expect(spec.status).toBe(200);
    expect(spec.json['viewer']).toBeNull();
    const page = await call(site.port, 'GET', '/');
    expect(String(page.headers['content-security-policy'])).toContain('frame-ancestors https://intranet.example.com');
    expect(page.headers['x-frame-options']).toBeUndefined();
    const r = await call(site.port, 'POST', '/q/items', { body: {} });
    expect(r.status, r.text).toBe(200);
    expect(r.json['rows']).toEqual([[1, 'alpha'], [2, 'beta']]);
  });

  it('when the operation changes at the service, the query is refused by name; when it is back, it runs (S14)', async () => {
    doc = { ...doc, paths: { '/items': op([{ name: 'region', in: 'query', required: true, schema: { type: 'string' } }]) } };
    await site.refresh();
    expect(site.state.list()).toEqual([expect.objectContaining({ kind: 'query', id: 'items', reason: expect.stringMatching(/contract_changed/) })]);
    expect((await call(site.port, 'POST', '/q/items', { body: {} })).json.code).toBe('contract_changed');
    doc = { ...doc, paths: { '/items': op() } };
    await site.refresh();
    expect(site.state.list()).toEqual([]);
    expect((await call(site.port, 'POST', '/q/items', { body: {} })).status).toBe(200);
  });

  it('a public visitor is limited per address: past 60 a minute, 429 with Retry-After (S16)', async () => {
    let last = 0;
    let retry: string | string[] | undefined;
    for (let i = 0; i < 70 && last !== 429; i++) {
      const r = await call(site.port, 'POST', '/q/items', { body: {} });
      last = r.status;
      retry = r.headers['retry-after'];
    }
    expect(last).toBe(429);
    expect(Number(retry)).toBeGreaterThan(0);
  });
});
