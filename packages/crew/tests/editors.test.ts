// EP-C1 — editors: the registry (first-party editors discovered in studio's bundle, flags in
// daemon-editors.json), the bundle route with EXACTLY the §8.2 headers (re-hashed per serve, refused
// on a hash mismatch or a path that is not a registry record), the grants route (the engine's decided
// set), human-only install/remove/enable under auth=required, and third-party installs refused after
// garden's fail-closed gate has run and the approval list has been read (EP-C8 is later).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EditorGrantsResponse, EditorView, InstallEditorRefusal, ListEditorsResponse } from '../src/core/types.js';
import { BUNDLE_CSP_BASE, bundleHeaders, requestOrigin, shellCsp } from '../src/editors/csp.js';
import { gardenPackCheck, previewPackInstall, PackInstallError, type PackCheckRunner } from '../src/editors/pack-install.js';
import { EditorRegistry, EDITORS_STATE_FILENAME, discoverStudioEditors, externalReferences, sha256Of } from '../src/editors/registry.js';
import { registerEditorRoutes, serveBundle } from '../src/editors/routes.js';

const scratches: string[] = [];
afterEach(() => {
  for (const s of scratches.splice(0)) rmSync(s, { recursive: true, force: true });
});

const PAGE_HTML = '<!doctype html><html><head><style>body{margin:0}</style></head><body><script>parent;</script></body></html>';

function manifest(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: 'Page editor',
    version: '0.6.0',
    protocol: [1],
    kinds: ['page', 'document'],
    sizes: ['inline', 'pane', 'full'],
    panels: ['checks'],
    permissions: [
      { id: 'artifact.read', why: 'to read the page' },
      { id: 'artifact.write', why: 'to change it as versions you can undo' },
      { id: 'network.media', why: 'pages use web images' },
    ],
    ...extra,
  };
}

/** A studio dist with one good editor and a few that must be skipped. */
function studioRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'editors-studio-'));
  scratches.push(root);
  const put = (id: string, m: Record<string, unknown> | null, html: string | null): void => {
    mkdirSync(join(root, 'editors', id), { recursive: true });
    if (m !== null) writeFileSync(join(root, 'editors', id, 'editor.json'), JSON.stringify(m));
    if (html !== null) writeFileSync(join(root, 'editors', id, 'index.html'), html);
  };
  put('wicked-page', manifest('wicked-page'), PAGE_HTML);
  put('wicked-doc', manifest('wicked-doc', { permissions: [{ id: 'artifact.read', why: 'r' }] }), '<html><body>doc</body></html>');
  put('acme-terms', manifest('acme-terms'), PAGE_HTML); // not first-party: skipped
  put('wicked-bad-perm', manifest('wicked-bad-perm', { permissions: [{ id: 'network.fetch', why: 'x' }] }), PAGE_HTML);
  put('wicked-external', manifest('wicked-external'), '<html><head><script src="https://cdn.example/x.js"></script></head></html>');
  put('wicked-fat', manifest('wicked-fat', { limits: { bundleBytes: 10 } }), PAGE_HTML);
  put('wicked-noentry', manifest('wicked-noentry'), null);
  put('wicked-mismatch', manifest('wicked-other'), PAGE_HTML); // dir name ≠ id
  writeFileSync(join(root, 'index.html'), '<!doctype html><div id="root"></div>');
  return root;
}

describe('the registry', () => {
  it('discovers the first-party editors a studio bundle ships, pins sha256 + bytes, and skips what it cannot serve honestly — with a reason each', () => {
    const logs: string[] = [];
    const found = discoverStudioEditors(studioRoot(), (m) => logs.push(m));
    expect(found.map((r) => r.manifest.id)).toEqual(['wicked-doc', 'wicked-page']);
    const page = found.find((r) => r.manifest.id === 'wicked-page')!;
    expect(page.sha256).toBe(sha256Of(Buffer.from(PAGE_HTML)));
    expect(page.bytes).toBe(Buffer.byteLength(PAGE_HTML));
    expect(page.firstParty).toBe(true);
    expect(page.source).toBe('studio-bundle');
    for (const skipped of ['acme-terms', 'wicked-bad-perm', 'wicked-external', 'wicked-fat', 'wicked-noentry', 'wicked-mismatch']) {
      expect(logs.some((l) => l.includes(skipped)), skipped).toBe(true);
    }
    expect(logs.find((l) => l.includes('wicked-external'))).toMatch(/outside itself/);
    expect(logs.find((l) => l.includes('wicked-fat'))).toMatch(/over its 10-byte cap/);
  });

  it('codex r1: a symlinked editor directory, manifest or entry is never followed — skipped with the reason, and never served', () => {
    const root = studioRoot();
    const outside = mkdtempSync(join(tmpdir(), 'editors-outside-'));
    scratches.push(outside);
    mkdirSync(join(outside, 'wicked-linked'), { recursive: true });
    writeFileSync(join(outside, 'wicked-linked', 'editor.json'), JSON.stringify(manifest('wicked-linked')));
    writeFileSync(join(outside, 'wicked-linked', 'index.html'), PAGE_HTML);
    symlinkSync(join(outside, 'wicked-linked'), join(root, 'editors', 'wicked-linked'));
    mkdirSync(join(root, 'editors', 'wicked-linkedentry'));
    writeFileSync(join(root, 'editors', 'wicked-linkedentry', 'editor.json'), JSON.stringify(manifest('wicked-linkedentry')));
    writeFileSync(join(outside, 'entry.html'), PAGE_HTML);
    symlinkSync(join(outside, 'entry.html'), join(root, 'editors', 'wicked-linkedentry', 'index.html'));
    mkdirSync(join(root, 'editors', 'wicked-linkedmanifest'));
    writeFileSync(join(outside, 'editor.json'), JSON.stringify(manifest('wicked-linkedmanifest')));
    symlinkSync(join(outside, 'editor.json'), join(root, 'editors', 'wicked-linkedmanifest', 'editor.json'));
    writeFileSync(join(root, 'editors', 'wicked-linkedmanifest', 'index.html'), PAGE_HTML);
    const logs: string[] = [];
    const found = discoverStudioEditors(root, (m) => logs.push(m));
    expect(found.map((r) => r.manifest.id)).toEqual(['wicked-doc', 'wicked-page']);
    for (const id of ['wicked-linked', 'wicked-linkedentry', 'wicked-linkedmanifest']) {
      expect(logs.find((l) => l.includes(id)), id).toMatch(/symlink/);
    }
    // And at serve time: an entry replaced by a link after discovery is refused, not read through.
    const reg = new EditorRegistry({ stateHome: mkdtempSync(join(tmpdir(), 'editors-home-')), studioRoot: root });
    const page = reg.get('wicked-page')!;
    rmSync(page.entryPath);
    symlinkSync(join(outside, 'entry.html'), page.entryPath);
    const sent: Array<{ code: number; body: unknown }> = [];
    const reply = {
      code(c: number) {
        return { send: (b: unknown) => sent.push({ code: c, body: b }) };
      },
      header() {
        return this;
      },
      type() {
        return { send: (b: unknown) => sent.push({ code: 200, body: b }) };
      },
    } as unknown as Parameters<typeof serveBundle>[1];
    serveBundle(page, reply, (m) => logs.push(m));
    expect(sent[0]!.code).toBe(404);
    expect(logs.at(-1)).toMatch(/symlink/);
  });

  it('externalReferences: scripts, stylesheets and frames loaded from outside the file are named; inline, data:, blob: are fine', () => {
    expect(externalReferences('<script src="https://x/y.js"></script><link rel="stylesheet" href="//cdn/x.css"><iframe src="http://e/"></iframe>')).toEqual([
      'script https://x/y.js',
      'link //cdn/x.css',
      'iframe http://e/',
    ]);
    expect(externalReferences('<script>1</script><link rel="icon" href="https://x/i.png"><img src="https://x/a.png"><iframe src="data:text/html,hi"></iframe>')).toEqual([]);
  });

  it('the wire view carries no path and names the hashed entry route; enable/disable persists in daemon-editors.json (0600) and survives a re-read', () => {
    const root = studioRoot();
    const home = mkdtempSync(join(tmpdir(), 'editors-home-'));
    scratches.push(home);
    const reg = new EditorRegistry({ stateHome: home, studioRoot: root });
    const view = EditorRegistry.view(reg.get('wicked-page')!);
    expect(JSON.stringify(view)).not.toContain(root);
    expect(view).toMatchObject({ id: 'wicked-page', version: '0.6.0', first_party: true, enabled: true, source: 'studio-bundle', entry_url: '/api/v1/editors/wicked-page/0.6.0/entry' });
    expect(view.permissions.map((p) => p.id)).toEqual(['artifact.read', 'artifact.write', 'network.media']);
    expect(reg.setEnabled('wicked-page', false)!.enabled).toBe(false);
    expect(reg.setEnabled('nope', false)).toBeNull();
    const file = join(home, EDITORS_STATE_FILENAME);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 1, enabled: { 'wicked-page': false } });
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    const again = new EditorRegistry({ stateHome: home, studioRoot: root });
    expect(again.get('wicked-page')!.enabled).toBe(false);
    expect(again.get('wicked-doc')!.enabled).toBe(true);
    expect(again.list().map((r) => r.manifest.id)).toEqual(['wicked-doc', 'wicked-page']);
  });

  it('no studio bundle, no editors — and no state file is written until a flag changes', () => {
    const home = mkdtempSync(join(tmpdir(), 'editors-home-'));
    scratches.push(home);
    const reg = new EditorRegistry({ stateHome: home });
    expect(reg.list()).toEqual([]);
    expect(() => statSync(join(home, EDITORS_STATE_FILENAME))).toThrow();
  });
});

describe('the two policies (§8.2), pinned to the letter', () => {
  it('bundle headers: the exact set; `network.media` widens img/font to https: for a first-party editor only', () => {
    const plain = bundleHeaders({ firstParty: true, manifest: manifest('wicked-doc', { permissions: [{ id: 'artifact.read', why: 'r' }] }) as never });
    expect(plain).toEqual({
      'Content-Security-Policy':
        "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src blob:; font-src data:; frame-src blob: data: about:; child-src blob: data: about:; connect-src 'none'; form-action 'none'; base-uri 'none'; worker-src 'none'; manifest-src 'none'",
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-DNS-Prefetch-Control': 'off',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    });
    expect(plain['Content-Security-Policy']).not.toMatch(/navigate-to|prefetch-src/);
    const media = bundleHeaders({ firstParty: true, manifest: manifest('wicked-page') as never });
    expect(media['Content-Security-Policy']).toContain('img-src data: blob: https:;');
    expect(media['Content-Security-Policy']).toContain('font-src data: https:;');
    expect(media['Content-Security-Policy']).toContain("connect-src 'none'");
    const third = bundleHeaders({ firstParty: false, manifest: manifest('acme-page') as never });
    expect(third['Content-Security-Policy']).toBe(plain['Content-Security-Policy']);
    expect(BUNDLE_CSP_BASE).toContain('{MEDIA}');
  });

  it('shell policy: frame-src names crew\'s own editors route and interactive proxy for the request\'s origin, plus blob: and data:', () => {
    expect(shellCsp('http://localhost:7701')).toBe('frame-src http://localhost:7701/api/v1/editors/ http://localhost:7701/api/v1/projects/ blob: data:');
    expect(requestOrigin({ protocol: 'http', headers: { host: '127.0.0.1:7701' } })).toBe('http://127.0.0.1:7701');
    expect(requestOrigin({ protocol: 'https', headers: { host: 'crew.example' } })).toBe('https://crew.example');
    expect(requestOrigin({ headers: {} })).toBe('http://localhost');
  });
});

describe('pack install (refused until EP-C8)', () => {
  function pack(extra: Record<string, unknown> = {}, opts: { skills?: string[] } = {}): string {
    const root = mkdtempSync(join(tmpdir(), 'editors-pack-'));
    scratches.push(root);
    writeFileSync(
      join(root, 'wicked-pack.json'),
      JSON.stringify({
        spec: 2,
        name: 'acme-terms',
        vendor: 'acme',
        version: '0.1.0',
        editors: [{ id: 'acme-terms', title: 'Terms checker', version: '0.1.0', protocol: [1], kinds: ['document'], entry: 'editors/acme-terms/index.html', sha256: 'a'.repeat(64), sizes: ['inline'], permissions: [{ id: 'artifact.read', why: 'to read the document' }] }],
        blocks: [{ id: 'acme-terms-review', label: 'Check our terms', preset: 'presets/terms-review.json', produces_kind: 'document', skills: ['acme-terms-checker'] }],
        skills_dir: 'skills',
        ...extra,
      }),
    );
    for (const s of opts.skills ?? ['acme-terms-checker']) mkdirSync(join(root, 'skills', s), { recursive: true });
    return root;
  }
  const pass: PackCheckRunner = async () => ({ ok: true, errors: [], warnings: [{ level: 'warn', code: 'w1', message: 'fine' }] });
  const fail: PackCheckRunner = async () => ({ ok: false, errors: [{ level: 'error', code: 'editor-entry-hash', message: 'sha256 mismatch', path: 'editors/acme-terms/index.html' }], warnings: [] });

  it('garden\'s gate runs FIRST and fails closed: a refused pack is a 422 with the verdict, nothing read past it', async () => {
    await expect(previewPackInstall(pack(), fail)).rejects.toMatchObject({ status: 422, check: { ok: false } });
    await expect(previewPackInstall('relative/path', pass)).rejects.toMatchObject({ status: 400 });
    await expect(previewPackInstall(join(tmpdir(), 'editors-does-not-exist-xyz'), pass)).rejects.toMatchObject({ status: 404 });
    const noEditors = pack({ editors: undefined, spec: 1 });
    await expect(previewPackInstall(noEditors, pass)).rejects.toMatchObject({ status: 400 });
    const err = await previewPackInstall(noEditors, pass).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PackInstallError);
    expect((err as PackInstallError).message).toMatch(/declares no editors/);
  });

  it('a pack that passes is still refused (501 shape) with the approval list: editors, blocks and the pack\'s skills', async () => {
    const refusal = await previewPackInstall(pack(), pass);
    expect(refusal.code).toBe('third_party_editors_not_available');
    expect(refusal.error).toMatch(/EP-C8/);
    expect(refusal.check.ok).toBe(true);
    expect(refusal.pack).toEqual({
      name: 'acme-terms',
      vendor: 'acme',
      version: '0.1.0',
      editors: [{ id: 'acme-terms', title: 'Terms checker', version: '0.1.0', kinds: ['document'], permissions: [{ id: 'artifact.read', why: 'to read the document' }] }],
      blocks: [{ id: 'acme-terms-review', label: 'Check our terms', produces_kind: 'document', skills: ['acme-terms-checker'] }],
      skills: ['acme-terms-checker'],
    });
  });

  it('gardenPackCheck without a garden is a FAILED check (never a pass), and spawns nothing', async () => {
    const verdict = await gardenPackCheck(null)('/anywhere');
    expect(verdict.ok).toBe(false);
    expect(verdict.errors[0]!.code).toBe('garden-missing');
    const noScript = mkdtempSync(join(tmpdir(), 'editors-garden-'));
    scratches.push(noScript);
    expect((await gardenPackCheck(noScript)('/anywhere')).errors[0]!.code).toBe('garden-too-old');
  });
});

describe('the routes', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    for (const a of apps.splice(0)) await a.close();
  });

  async function harness(opts: { grants?: boolean; packCheck?: PackCheckRunner } = {}) {
    const root = studioRoot();
    const home = mkdtempSync(join(tmpdir(), 'editors-home-'));
    scratches.push(home);
    const registry = new EditorRegistry({ stateHome: home, studioRoot: root });
    const evaluateEditorGrants = vi.fn(async (req: { editorId: string; version: string; sha256: string; permissions: string[]; project?: string; firstParty: boolean }): Promise<EditorGrantsResponse> => ({
      editorId: req.editorId,
      version: req.version,
      sha256: req.sha256,
      project: req.project ?? null,
      firstParty: req.firstParty,
      grants: req.permissions.map((p) => ({ permission: p, decision: p === 'network.media' && req.project === 'kestrel' ? 'deny' : 'allow', ruleIds: ['EDITOR-BUILTIN'], token: `editor:${req.editorId}@${req.version}#${req.sha256}/${p}` })),
    }));
    const adapter = opts.grants === false ? {} : { editorGrantsSupported: () => true, evaluateEditorGrants };
    const app = Fastify({ logger: false });
    app.decorateRequest('actor', null as unknown as never);
    app.addHook('onRequest', async (req) => {
      const h = req.headers['x-actor'];
      if (typeof h === 'string') {
        const [kind, trust] = h.split(':');
        (req as unknown as { actor: unknown }).actor = { id: `${kind}-1`, kind, trust };
      }
    });
    const logs: string[] = [];
    registerEditorRoutes(app, { registry, adapter, packCheck: opts.packCheck ?? (async () => ({ ok: true, errors: [], warnings: [] })), log: (m) => logs.push(m) });
    await app.ready();
    apps.push(app);
    return { app, registry, root, home, evaluateEditorGrants, logs };
  }
  const HUMAN = { 'x-actor': 'human:operator' };
  const AGENT = { 'x-actor': 'agent:operator' };
  const OBSERVER = { 'x-actor': 'human:observer' };

  it('GET /editors lists the registry (operator+; observer 403) and says installs are refused', async () => {
    const h = await harness();
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/editors', headers: HUMAN });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ListEditorsResponse;
    expect(body.installs).toBe('refused_until_conformance');
    expect(body.editors.map((e) => e.id)).toEqual(['wicked-doc', 'wicked-page']);
    expect(JSON.stringify(body)).not.toContain(h.root);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/editors', headers: OBSERVER })).statusCode).toBe(403);
  });

  it('GET /editors/:id/:version/entry serves the bundle with EXACTLY the §8.2 headers; a wrong version, a disabled editor or a path-shaped id is 404; a changed file is 409 and never served', async () => {
    const h = await harness();
    const ok = await h.app.inject({ method: 'GET', url: '/api/v1/editors/wicked-page/0.6.0/entry' });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe(PAGE_HTML);
    expect(ok.headers['content-type']).toMatch(/^text\/html; charset=utf-8/);
    const expected = bundleHeaders(h.registry.get('wicked-page')!);
    for (const [k, v] of Object.entries(expected)) expect(ok.headers[k.toLowerCase()], k).toBe(v);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/editors/wicked-page/0.5.0/entry' })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/editors/..%2F..%2Fetc/0.6.0/entry' })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/editors/wicked-page/..%2F0.6.0/entry' })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/editors/acme-terms/0.6.0/entry' })).statusCode).toBe(404);
    // Disabled: not served.
    h.registry.setEnabled('wicked-page', false);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/editors/wicked-page/0.6.0/entry' })).statusCode).toBe(404);
    h.registry.setEnabled('wicked-page', true);
    // The file changed under the pin: refused with the code, the new bytes never leave.
    writeFileSync(join(h.root, 'editors', 'wicked-page', 'index.html'), '<script>fetch("https://evil")</script>');
    const changed = await h.app.inject({ method: 'GET', url: '/api/v1/editors/wicked-page/0.6.0/entry' });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({ code: 'bundle_hash_mismatch' });
    expect(changed.body).not.toContain('evil');
    expect(h.logs.some((l) => /hash changed on disk/.test(l))).toBe(true);
  });

  it('GET /editors/:id/grants?project= hands the engine the pinned version + hash + permissions and returns its decided set; 501 without the binding', async () => {
    const h = await harness();
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/editors/wicked-page/grants?project=kestrel', headers: HUMAN });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as EditorGrantsResponse;
    expect(h.evaluateEditorGrants).toHaveBeenCalledWith({
      editorId: 'wicked-page',
      version: '0.6.0',
      sha256: sha256Of(Buffer.from(PAGE_HTML)),
      permissions: ['artifact.read', 'artifact.write', 'network.media'],
      project: 'kestrel',
      firstParty: true,
    });
    expect(body.project).toBe('kestrel');
    expect(body.grants.find((g) => g.permission === 'network.media')!.decision).toBe('deny');
    expect(body.grants[0]!.token).toBe(`editor:wicked-page@0.6.0#${sha256Of(Buffer.from(PAGE_HTML))}/artifact.read`);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/editors/nope/grants', headers: HUMAN })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/editors/wicked-page/grants', headers: OBSERVER })).statusCode).toBe(403);
    const old = await harness({ grants: false });
    expect((await old.app.inject({ method: 'GET', url: '/api/v1/editors/wicked-page/grants', headers: HUMAN })).statusCode).toBe(501);
  });

  it('install, remove, enable are HUMAN-only: an agent token is refused (403) and nothing changes; a human gets the gate + the refusal', async () => {
    const h = await harness();
    const packRoot = mkdtempSync(join(tmpdir(), 'editors-pack-'));
    scratches.push(packRoot);
    writeFileSync(join(packRoot, 'wicked-pack.json'), JSON.stringify({ spec: 2, name: 'acme-terms', vendor: 'acme', version: '0.1.0', editors: [{ id: 'acme-terms', title: 'T', version: '0.1.0', protocol: [1], kinds: ['document'], entry: 'e.html', sha256: 'a'.repeat(64), sizes: ['inline'], permissions: [] }] }));
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/editors', headers: AGENT, payload: { packRoot } })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'DELETE', url: '/api/v1/editors/wicked-page', headers: AGENT })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/editors/wicked-page/enabled', headers: AGENT, payload: { enabled: false } })).statusCode).toBe(403);
    expect(h.registry.get('wicked-page')!.enabled).toBe(true);
    const refused = await h.app.inject({ method: 'POST', url: '/api/v1/editors', headers: HUMAN, payload: { packRoot } });
    expect(refused.statusCode).toBe(501);
    expect((refused.json() as InstallEditorRefusal).pack.editors[0]!.id).toBe('acme-terms');
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/editors', headers: HUMAN, payload: { nope: 1 } })).statusCode).toBe(400);
    const removed = await h.app.inject({ method: 'DELETE', url: '/api/v1/editors/wicked-page', headers: HUMAN });
    expect(removed.statusCode).toBe(409);
    expect((await h.app.inject({ method: 'DELETE', url: '/api/v1/editors/acme-terms', headers: HUMAN })).statusCode).toBe(404);
    const toggled = await h.app.inject({ method: 'POST', url: '/api/v1/editors/wicked-page/enabled', headers: HUMAN, payload: { enabled: false } });
    expect(toggled.statusCode).toBe(200);
    expect((toggled.json() as EditorView).enabled).toBe(false);
    expect(JSON.parse(readFileSync(join(h.home, EDITORS_STATE_FILENAME), 'utf8'))).toEqual({ v: 1, enabled: { 'wicked-page': false } });
  });

  it('a failing gate is a 422 carrying the verdict', async () => {
    const h = await harness({ packCheck: async () => ({ ok: false, errors: [{ level: 'error', code: 'editor-entry-outside', message: 'loads from outside' }], warnings: [] }) });
    const packRoot = mkdtempSync(join(tmpdir(), 'editors-pack-'));
    scratches.push(packRoot);
    writeFileSync(join(packRoot, 'wicked-pack.json'), '{"spec":2,"name":"acme","vendor":"acme","version":"0.1.0","editors":[{}]}');
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/editors', headers: HUMAN, payload: { packRoot } });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ check: { ok: false, errors: [{ code: 'editor-entry-outside' }] } });
  });
});
