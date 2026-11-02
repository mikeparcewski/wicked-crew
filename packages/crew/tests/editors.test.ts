// EP-C1 — editors: the registry (first-party editors discovered in studio's bundle, flags in
// daemon-editors.json), the bundle route with EXACTLY the §8.2 headers (re-hashed per serve, refused
// on a hash mismatch or a path that is not a registry record), the grants route (the engine's decided
// set), human-only install/remove/enable under auth=required, and third-party pack installs: garden's
// fail-closed gate, then crew's own conformance run, then the registry (operator ruling X3); a pack
// with skills or blocks is refused with its approval list.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConformanceRule, EditorConformanceSummary, EditorGrantsResponse, EditorView, InstallEditorRefusal, InstallEditorResponse, ListEditorsResponse } from '../src/core/types.js';
import { registerFrameGuard } from '../src/api/frame-guard.js';
import { BUNDLE_CSP_BASE, bundleHeaders, requestOrigin, shellCsp } from '../src/editors/csp.js';
import { CONFORMANCE_CASES, gardenConformance, gardenPackCheck, installPack, PackInstallError, type ConformanceRunner, type PackCheckRunner } from '../src/editors/pack-install.js';
import { EditorRegistry, EDITORS_STATE_FILENAME, discoverStudioEditors, externalReferences, readCapped, sha256Of } from '../src/editors/registry.js';
import { registerEditorRoutes, serveBundle } from '../src/editors/routes.js';
import { readNoFollow } from '../src/editors/visuals.js';
import { guardBundle } from '../src/editors/webrtc-guard.js';

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
        "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src blob:; font-src data:; frame-src 'none'; child-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; worker-src 'none'; manifest-src 'none'",
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
    // A third-party bundle never gets the network, and runs only the scripts crew hashed (webrtc-guard.ts).
    const third = bundleHeaders({ firstParty: false, manifest: manifest('acme-page') as never }, ['h1=']);
    expect(third['Content-Security-Policy']).toBe(`${plain['Content-Security-Policy']!.replace("script-src 'unsafe-inline'", "script-src 'sha256-h1='")}, script-src 'unsafe-inline'`);
    expect(BUNDLE_CSP_BASE).toContain('{MEDIA}');
    expect(BUNDLE_CSP_BASE).toContain('{SCRIPTS}');
  });

  it('shell policy: frame-src names crew\'s own editors route and interactive proxy for the request\'s origin, plus blob: and data:', () => {
    expect(shellCsp('http://localhost:7701')).toBe('frame-src http://localhost:7701/api/v1/editors/ http://localhost:7701/api/v1/projects/ blob: data:');
    expect(requestOrigin({ protocol: 'http', headers: { host: '127.0.0.1:7701' } })).toBe('http://127.0.0.1:7701');
    expect(requestOrigin({ protocol: 'https', headers: { host: 'crew.example' } })).toBe('https://crew.example');
    expect(requestOrigin({ headers: {} })).toBe('http://localhost');
  });
});

const EDITOR_HTML = '<!doctype html><html><body><p>terms</p><script>parent.postMessage(1, "*")</script></body></html>';

/** A pack directory: editor-only by default, with its entry on disk and its true hash pinned. */
function makePack(opts: { name?: string; id?: string; html?: string; blocks?: boolean; skills?: string[]; version?: string; permissions?: Array<{ id: string; why: string }>; editorExtra?: Record<string, unknown> } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'editors-pack-'));
  scratches.push(root);
  const id = opts.id ?? 'acme-terms';
  const html = opts.html ?? EDITOR_HTML;
  mkdirSync(join(root, 'editors', id), { recursive: true });
  writeFileSync(join(root, 'editors', id, 'index.html'), html);
  writeFileSync(
    join(root, 'wicked-pack.json'),
    JSON.stringify({
      spec: 2,
      name: opts.name ?? 'acme-terms',
      vendor: 'acme',
      version: opts.version ?? '0.1.0',
      editors: [{ id, title: 'Terms checker', version: opts.version ?? '0.1.0', protocol: [1], kinds: ['document'], entry: `editors/${id}/index.html`, sha256: sha256Of(Buffer.from(html)), sizes: ['inline', 'pane'], permissions: opts.permissions ?? [{ id: 'artifact.read', why: 'to read the document' }], ...opts.editorExtra }],
      ...(opts.blocks === true ? { blocks: [{ id: 'acme-terms-review', label: 'Check our terms', preset: 'presets/terms-review.json', produces_kind: 'document', skills: ['acme-terms-checker'] }], skills_dir: 'skills' } : {}),
    }),
  );
  for (const sk of opts.skills ?? []) mkdirSync(join(root, 'skills', sk), { recursive: true });
  return root;
}

const passCheck: PackCheckRunner = async () => ({ ok: true, errors: [], warnings: [] });
/** A passing run over whatever the pack holds right now (its ids, versions and entry hashes, as garden's runner reports them). */
function conformant(): ConformanceRunner {
  return vi.fn(async (packRoot: string): Promise<EditorConformanceSummary> => {
    const m = JSON.parse(readFileSync(join(packRoot, 'wicked-pack.json'), 'utf8')) as { editors: Array<{ id: string; version: string; entry: string }> };
    return {
      ok: true,
      at: '2026-10-10T00:00:00.000Z',
      editors: m.editors.map((e) => ({ id: e.id, version: e.version, sha256: sha256Of(readFileSync(join(packRoot, e.entry))), ok: true, cases: Object.fromEntries(CONFORMANCE_CASES.map((c) => [c, { ok: true }])), gaps: ['case 7'] })),
    };
  });
}

describe('pack install: the gate, crew\'s conformance run, then the registry', () => {
  function registry(): { reg: EditorRegistry; home: string } {
    const home = mkdtempSync(join(tmpdir(), 'editors-home-'));
    scratches.push(home);
    return { reg: new EditorRegistry({ stateHome: home, studioRoot: studioRoot() }), home };
  }
  const fail: PackCheckRunner = async () => ({ ok: false, errors: [{ level: 'error', code: 'editor-entry-hash', message: 'sha256 mismatch', path: 'editors/acme-terms/index.html' }], warnings: [] });

  it('garden\'s gate runs FIRST and fails closed: a refused pack is a 422 with the verdict, and the conformance run never starts', async () => {
    const { reg } = registry();
    const conformance = conformant();
    await expect(installPack(makePack(), undefined, { check: fail, conformance, registry: reg })).rejects.toMatchObject({ status: 422, check: { ok: false } });
    await expect(installPack('relative/path', undefined, { check: passCheck, conformance, registry: reg })).rejects.toMatchObject({ status: 400 });
    await expect(installPack(join(tmpdir(), 'editors-does-not-exist-xyz'), undefined, { check: passCheck, conformance, registry: reg })).rejects.toMatchObject({ status: 404 });
    expect(conformance).not.toHaveBeenCalled();
  });

  it('an editor-only pack that passes both installs: recorded with its pinned hash, served from the pack, and read back after a restart', async () => {
    const { reg, home } = registry();
    const root = makePack();
    const conformance = conformant();
    const res: InstallEditorResponse = await installPack(root, undefined, { check: passCheck, conformance, registry: reg });
    // The pack's editors ride along: they size the run's overall cap (tests/editor-conformance-cap.test.ts).
    expect(conformance).toHaveBeenCalledWith(root, [expect.objectContaining({ id: expect.any(String) })]);
    expect(res.installed).toBe(true);
    expect(res.updated).toBe(false);
    expect(res.editors).toHaveLength(1);
    expect(res.editors[0]).toMatchObject({ id: 'acme-terms', source: 'pack', first_party: false, enabled: true, sha256: sha256Of(Buffer.from(EDITOR_HTML)) });
    expect(JSON.stringify(res.editors)).not.toContain(root);
    const state = JSON.parse(readFileSync(join(home, EDITORS_STATE_FILENAME), 'utf8')) as { installed: Record<string, { root: string; entry: string; conformance: { ok: boolean; cases: string[] } }> };
    expect(state.installed['acme-terms']).toMatchObject({ root, entry: 'editors/acme-terms/index.html', conformance: { ok: true } });
    expect(state.installed['acme-terms']!.conformance.cases).toEqual([...CONFORMANCE_CASES]);
    const again = new EditorRegistry({ stateHome: home });
    expect(again.get('acme-terms')).toMatchObject({ source: 'pack', firstParty: false, enabled: true });
    expect(again.get('acme-terms')!.entryPath).toBe(join(root, 'editors', 'acme-terms', 'index.html'));
  });

  it('a pack editor carries no visuals yet (garden’s gate refuses the keys): its digest and wire view are as before', async () => {
    const { reg } = registry();
    const root = makePack();
    const res = await installPack(root, undefined, { check: passCheck, conformance: conformant(), registry: reg });
    expect(res.editors[0]).not.toHaveProperty('visuals');
    expect(res.editors[0]).not.toHaveProperty('description');
  });

  it('a failed or impossible conformance run installs nothing (422), naming the cases that did not pass', async () => {
    const { reg, home } = registry();
    const failing: ConformanceRunner = async () => ({ ok: false, at: 'x', editors: [{ id: 'acme-terms', version: '0.1.0', sha256: sha256Of(Buffer.from(EDITOR_HTML)), ok: false, cases: { '0-manifest': { ok: true }, '1-handshake': { ok: false } }, gaps: [] }] });
    const err = await installPack(makePack(), undefined, { check: passCheck, conformance: failing, registry: reg }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PackInstallError);
    expect((err as PackInstallError).status).toBe(422);
    expect((err as PackInstallError).body).toMatchObject({ code: 'editor_not_conformant' });
    expect((err as PackInstallError).message).toMatch(/1-handshake/);
    const noBrowser: ConformanceRunner = async () => ({ ok: false, at: 'x', editors: [], error: 'no headless browser' });
    const err2 = await installPack(makePack(), undefined, { check: passCheck, conformance: noBrowser, registry: reg }).catch((e: unknown) => e);
    expect((err2 as PackInstallError).body).toMatchObject({ code: 'conformance_unavailable' });
    // A report that claims ok but leaves a case out is not a pass either.
    const partial: ConformanceRunner = async () => ({ ok: true, at: 'x', editors: [{ id: 'acme-terms', version: '0.1.0', sha256: sha256Of(Buffer.from(EDITOR_HTML)), ok: true, cases: { '0-manifest': { ok: true } }, gaps: [] }] });
    await expect(installPack(makePack(), undefined, { check: passCheck, conformance: partial, registry: reg })).rejects.toMatchObject({ status: 422 });
    expect(reg.get('acme-terms')).toBeNull();
    expect(() => readFileSync(join(home, EDITORS_STATE_FILENAME), 'utf8')).toThrow();
  });

  it('a pack that also ships skills or blocks is refused (501) with its approval list; nothing runs or is written', async () => {
    const { reg } = registry();
    const conformance = conformant();
    const err = await installPack(makePack({ blocks: true, skills: ['acme-terms-checker'] }), undefined, { check: passCheck, conformance, registry: reg }).catch((e: unknown) => e);
    expect((err as PackInstallError).status).toBe(501);
    const body = (err as PackInstallError).body as unknown as InstallEditorRefusal;
    expect(body.code).toBe('pack_ships_skills_or_blocks');
    expect(body.pack.blocks).toEqual([{ id: 'acme-terms-review', label: 'Check our terms', produces_kind: 'document', skills: ['acme-terms-checker'] }]);
    expect(body.pack.skills).toEqual(['acme-terms-checker']);
    expect(conformance).not.toHaveBeenCalled();
    expect(reg.get('acme-terms')).toBeNull();
  });

  it('the same pack again is an update in place (keeps the operator\'s switch); another pack with the id is a 409', async () => {
    const { reg } = registry();
    const root = makePack();
    await installPack(root, false, { check: passCheck, conformance: conformant(), registry: reg });
    expect(reg.get('acme-terms')!.enabled).toBe(false);
    const v2 = makePack({ version: '0.2.0', html: EDITOR_HTML.replace('terms', 'terms v2') });
    const res = await installPack(v2, undefined, { check: passCheck, conformance: conformant(), registry: reg });
    expect(res.updated).toBe(true);
    expect(res.editors[0]).toMatchObject({ version: '0.2.0', enabled: false });
    await expect(installPack(makePack({ name: 'other-pack' }), undefined, { check: passCheck, conformance: conformant(), registry: reg })).rejects.toMatchObject({ status: 409 });
  });

  it('an installed entry changed on disk is skipped at boot (never served), and a first-party id is never taken', async () => {
    const { reg, home } = registry();
    const root = makePack();
    await installPack(root, undefined, { check: passCheck, conformance: conformant(), registry: reg });
    writeFileSync(join(root, 'editors', 'acme-terms', 'index.html'), '<script>fetch("https://evil")</script>');
    const logs: string[] = [];
    const again = new EditorRegistry({ stateHome: home, log: (m) => logs.push(m) });
    expect(again.get('acme-terms')).toBeNull();
    expect(logs.some((l) => /no longer matches the hash/.test(l))).toBe(true);
    expect(again.isInstalled('acme-terms')).toBe(true);
    await expect(installPack(makePack({ id: 'wicked-page', name: 'acme-page' }), undefined, { check: passCheck, conformance: conformant(), registry: reg })).rejects.toMatchObject({ status: 409 });
  });

  it('codex r1 (P1): a passing report counts only for the bytes being installed — another hash or version is a 422', async () => {
    const { reg } = registry();
    const root = makePack();
    const passing = await conformant()(root);
    const otherBytes: ConformanceRunner = async () => ({ ...passing, editors: passing.editors.map((e) => ({ ...e, sha256: 'b'.repeat(64) })) });
    await expect(installPack(root, undefined, { check: passCheck, conformance: otherBytes, registry: reg })).rejects.toMatchObject({ status: 422, message: /not this entry/ });
    const otherVersion: ConformanceRunner = async () => ({ ...passing, editors: passing.editors.map((e) => ({ ...e, version: '9.9.9' })) });
    await expect(installPack(root, undefined, { check: passCheck, conformance: otherVersion, registry: reg })).rejects.toMatchObject({ status: 422 });
    expect(reg.get('acme-terms')).toBeNull();
  });

  it('codex r1: a manifest edited after install (a permission added, same HTML) is skipped at boot until installed again', async () => {
    const { reg, home } = registry();
    const root = makePack();
    await installPack(root, undefined, { check: passCheck, conformance: conformant(), registry: reg });
    const mp = join(root, 'wicked-pack.json');
    const m = JSON.parse(readFileSync(mp, 'utf8')) as { editors: Array<{ permissions: Array<{ id: string; why: string }> }> };
    m.editors[0]!.permissions.push({ id: 'artifact.write', why: 'quietly' });
    writeFileSync(mp, JSON.stringify(m));
    const logs: string[] = [];
    expect(new EditorRegistry({ stateHome: home, log: (l) => logs.push(l) }).get('acme-terms')).toBeNull();
    expect(logs.some((l) => /manifest entry changed since it was installed/.test(l))).toBe(true);
  });

  it('codex r1: a reinstall of an editor skipped at boot keeps the operator\'s "off"', async () => {
    const { reg, home } = registry();
    const root = makePack();
    await installPack(root, false, { check: passCheck, conformance: conformant(), registry: reg });
    const entry = join(root, 'editors', 'acme-terms', 'index.html');
    writeFileSync(entry, 'tampered');
    const booted = new EditorRegistry({ stateHome: home });
    expect(booted.get('acme-terms')).toBeNull();
    writeFileSync(entry, EDITOR_HTML);
    const res = await installPack(root, undefined, { check: passCheck, conformance: conformant(), registry: booted });
    expect(res.editors[0]!.enabled).toBe(false);
  });

  it('codex r1: a state write that fails leaves memory as the file is (install and remove)', async () => {
    const { reg, home } = registry();
    const root = makePack();
    await installPack(root, undefined, { check: passCheck, conformance: conformant(), registry: reg });
    chmodSync(home, 0o500);
    try {
      expect(() => reg.removeInstalled('acme-terms')).toThrow();
      expect(reg.get('acme-terms')).not.toBeNull();
      expect(reg.isInstalled('acme-terms')).toBe(true);
      await expect(installPack(makePack({ version: '0.3.0' }), undefined, { check: passCheck, conformance: conformant(), registry: reg })).rejects.toThrow();
      expect(reg.get('acme-terms')!.manifest.version).toBe('0.1.0');
    } finally {
      chmodSync(home, 0o700);
    }
  });

  it('codex r4: a failed removal of a boot-skipped "off" editor keeps the "off" for its reinstall', async () => {
    const { reg, home } = registry();
    const root = makePack();
    await installPack(root, false, { check: passCheck, conformance: conformant(), registry: reg });
    const entry = join(root, 'editors', 'acme-terms', 'index.html');
    writeFileSync(entry, 'tampered');
    const booted = new EditorRegistry({ stateHome: home });
    chmodSync(home, 0o500);
    try {
      expect(() => booted.removeInstalled('acme-terms')).toThrow();
    } finally {
      chmodSync(home, 0o700);
    }
    writeFileSync(entry, EDITOR_HTML);
    const res = await installPack(root, undefined, { check: passCheck, conformance: conformant(), registry: booted });
    expect(res.editors[0]!.enabled).toBe(false);
  });

  it('codex r5: an editor id that is an Object prototype key (constructor) still gets a boolean switch', async () => {
    const { reg, home } = registry();
    const res = await installPack(makePack({ id: 'constructor', name: 'acme-ctor' }), undefined, { check: passCheck, conformance: conformant(), registry: reg });
    expect(res.editors[0]!.enabled).toBe(true);
    expect(new EditorRegistry({ stateHome: home }).get('constructor')!.enabled).toBe(true);
  });

  it('codex r1: readCapped never reads past the cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'editors-cap-'));
    scratches.push(dir);
    writeFileSync(join(dir, 'big.html'), Buffer.alloc(2048, 0x61));
    expect(readCapped(join(dir, 'big.html'), 1024)).toBeNull();
    expect(readCapped(join(dir, 'big.html'), 4096)!.byteLength).toBe(2048);
  });

  it('gardenPackCheck and gardenConformance without a garden FAIL (never pass), and spawn nothing', async () => {
    const verdict = await gardenPackCheck(null)('/anywhere');
    expect(verdict.ok).toBe(false);
    expect(verdict.errors[0]!.code).toBe('garden-missing');
    const noScript = mkdtempSync(join(tmpdir(), 'editors-garden-'));
    scratches.push(noScript);
    expect((await gardenPackCheck(noScript)('/anywhere')).errors[0]!.code).toBe('garden-too-old');
    expect(await gardenConformance(null, () => 'http://127.0.0.1:1')('/anywhere')).toMatchObject({ ok: false, editors: [] });
    expect((await gardenConformance(noScript, () => 'http://127.0.0.1:1')('/anywhere')).error).toMatch(/no scripts\/editor\/conformance\.py/);
    mkdirSync(join(noScript, 'scripts', 'editor'), { recursive: true });
    writeFileSync(join(noScript, 'scripts', 'editor', 'conformance.py'), '');
    expect((await gardenConformance(noScript, () => null)('/anywhere')).error).toMatch(/own URL/);
  });
});

describe('the routes', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    for (const a of apps.splice(0)) await a.close();
  });

  async function harness(opts: { grants?: boolean; packCheck?: PackCheckRunner; conformance?: ConformanceRunner; ledger?: { excludes: string[] } | null; home?: string; frameGuard?: boolean } = {}) {
    const root = studioRoot();
    const home = opts.home ?? mkdtempSync(join(tmpdir(), 'editors-home-'));
    if (opts.home === undefined) scratches.push(home);
    const registry = new EditorRegistry({ stateHome: home, studioRoot: root });
    const evaluateEditorGrants = vi.fn(async (req: { editorId: string; version: string; sha256: string; permissions: string[]; project?: string; firstParty: boolean }): Promise<EditorGrantsResponse> => ({
      editorId: req.editorId,
      version: req.version,
      sha256: req.sha256,
      project: req.project ?? null,
      firstParty: req.firstParty,
      grants: req.permissions.map((p) => ({ permission: p, decision: p === 'network.media' && req.project === 'kestrel' ? 'deny' : 'allow', ruleIds: ['EDITOR-BUILTIN'], token: `editor:${req.editorId}@${req.version}#${req.sha256}/${p}` })),
    }));
    const ledger = opts.ledger ?? null;
    const upsertConformanceRule = vi.fn(async (rule: ConformanceRule) => {
      if (ledger !== null) ledger.excludes = [...(rule.excludes ?? [])];
    });
    const rules = {
      listConformanceRules: async (): Promise<ConformanceRule[]> => (ledger === null ? [] : [{ id: 'EDITOR-GRANTS', excludes: [...ledger.excludes] } as unknown as ConformanceRule]),
      upsertConformanceRule,
    };
    const adapter = opts.grants === false ? {} : { editorGrantsSupported: () => true, evaluateEditorGrants, ...rules };
    const app = Fastify({ logger: false });
    if (opts.frameGuard === true) registerFrameGuard(app, { allowedOrigins: null });
    app.decorateRequest('actor', null as unknown as never);
    app.addHook('onRequest', async (req) => {
      const h = req.headers['x-actor'];
      if (typeof h === 'string') {
        const [kind, trust] = h.split(':');
        (req as unknown as { actor: unknown }).actor = { id: `${kind}-1`, kind, trust };
      }
    });
    const logs: string[] = [];
    registerEditorRoutes(app, { registry, adapter, packCheck: opts.packCheck ?? (async () => ({ ok: true, errors: [], warnings: [] })), conformance: opts.conformance ?? conformant(), log: (m) => logs.push(m) });
    await app.ready();
    apps.push(app);
    return { app, registry, root, home, evaluateEditorGrants, logs, upsertConformanceRule };
  }
  const HUMAN = { 'x-actor': 'human:operator' };
  const AGENT = { 'x-actor': 'agent:operator' };

  it('the bundle keeps its sandbox policy and gains the clickjacking guard (frame-ancestors merged, X-Frame-Options)', async () => {
    const h = await harness({ frameGuard: true });
    const listed = (await h.app.inject({ method: 'GET', url: '/api/v1/editors', headers: { 'x-actor': 'human:operator' } })).json() as ListEditorsResponse;
    const page = listed.editors.find((e) => e.id === 'wicked-page')!;
    const served = await h.app.inject({ method: 'GET', url: page.entry_url });
    expect(served.statusCode).toBe(200);
    expect(served.headers['x-frame-options']).toBe('SAMEORIGIN');
    const csp = String(served.headers['content-security-policy']);
    expect(csp.startsWith(bundleHeaders({ manifest: { permissions: page.permissions } as never, firstParty: true })['Content-Security-Policy']!)).toBe(true);
    expect(csp.endsWith("; frame-ancestors 'self' http://127.0.0.1:4200 http://localhost:4200")).toBe(true);
  });
  const OBSERVER = { 'x-actor': 'human:observer' };

  it('GET /editors lists the registry (operator+; observer 403) and says installs need the conformance run', async () => {
    const h = await harness();
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/editors', headers: HUMAN });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ListEditorsResponse;
    expect(body.installs).toBe('conformance_required');
    expect(body.editors.map((e) => e.id)).toEqual(['wicked-doc', 'wicked-page']);
    expect(JSON.stringify(body)).not.toContain(h.root);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/editors', headers: OBSERVER })).statusCode).toBe(403);
  });

  it('GET /editors/:id/:version/entry serves the bundle with EXACTLY the §8.2 headers; a wrong version, a disabled editor or a path-shaped id is 404; a changed file is 409 and never served', async () => {
    const h = await harness();
    const ok = await h.app.inject({ method: 'GET', url: '/api/v1/editors/wicked-page/0.6.0/entry' });
    expect(ok.statusCode).toBe(200);
    // The pinned bytes, with the WebRTC prelude at the start of the inline script.
    expect(ok.body).toBe(guardBundle(Buffer.from(PAGE_HTML)).body.toString('utf8'));
    expect(ok.body).toMatch(/<script>\(function\(w,o\)\{.*\n?parent;<\/script>/s);
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

  it('install, remove, enable are HUMAN-only: an agent token is refused (403) and nothing changes; a human installs, serves and removes', async () => {
    const h = await harness();
    const packRoot = makePack();
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/editors', headers: AGENT, payload: { packRoot } })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'DELETE', url: '/api/v1/editors/wicked-page', headers: AGENT })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/editors/wicked-page/enabled', headers: AGENT, payload: { enabled: false } })).statusCode).toBe(403);
    expect(h.registry.get('wicked-page')!.enabled).toBe(true);
    expect(h.registry.get('acme-terms')).toBeNull();
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/editors', headers: HUMAN, payload: { nope: 1 } })).statusCode).toBe(400);
    const installed = await h.app.inject({ method: 'POST', url: '/api/v1/editors', headers: HUMAN, payload: { packRoot } });
    expect(installed.statusCode, installed.body).toBe(200);
    expect((installed.json() as InstallEditorResponse).editors[0]).toMatchObject({ id: 'acme-terms', source: 'pack' });
    const listed = (await h.app.inject({ method: 'GET', url: '/api/v1/editors', headers: HUMAN })).json() as ListEditorsResponse;
    expect(listed.editors.map((e) => e.id)).toEqual(['wicked-doc', 'wicked-page', 'acme-terms']);
    const served = await h.app.inject({ method: 'GET', url: '/api/v1/editors/acme-terms/0.1.0/entry' });
    expect(served.statusCode).toBe(200);
    const guarded = guardBundle(Buffer.from(EDITOR_HTML));
    expect(served.body).toBe(guarded.body.toString('utf8'));
    expect(guarded.scriptHashes).toHaveLength(1);
    expect(served.headers['content-security-policy']).toBe(
      `${BUNDLE_CSP_BASE.replaceAll('{MEDIA}', '').replace('{SCRIPTS}', `'sha256-${guarded.scriptHashes[0]}'`)}, script-src 'unsafe-inline'`,
    );
    expect((await h.app.inject({ method: 'DELETE', url: '/api/v1/editors/wicked-page', headers: HUMAN })).statusCode).toBe(409);
    expect((await h.app.inject({ method: 'DELETE', url: '/api/v1/editors/acme-terms', headers: AGENT })).statusCode).toBe(403);
    const removed = await h.app.inject({ method: 'DELETE', url: '/api/v1/editors/acme-terms', headers: HUMAN });
    expect(removed.statusCode).toBe(200);
    expect(h.registry.get('acme-terms')).toBeNull();
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/editors/acme-terms/0.1.0/entry' })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'DELETE', url: '/api/v1/editors/acme-terms', headers: HUMAN })).statusCode).toBe(404);
    const toggled = await h.app.inject({ method: 'POST', url: '/api/v1/editors/wicked-page/enabled', headers: HUMAN, payload: { enabled: false } });
    expect(toggled.statusCode).toBe(200);
    expect((toggled.json() as EditorView).enabled).toBe(false);
    expect(JSON.parse(readFileSync(join(h.home, EDITORS_STATE_FILENAME), 'utf8'))).toEqual({ v: 1, enabled: { 'wicked-page': false } });
  });

  it('mcp.session is granted by the install consent only: per build, only to a declaring editor, withdrawn on remove (DES-MCP-INSPECTOR-001 §6)', async () => {
    const ledger = { excludes: ['editor:other@1.0.0#' + 'a'.repeat(64) + '/mcp.session', 'mcp:unrelated'] };
    const h = await harness({ ledger });
    const inspector = [{ id: 'artifact.read', why: 'r' }, { id: 'mcp.session', why: 'to talk to the MCP server you connect' }];
    // An agent's install is refused, and writes nothing.
    const packRoot = makePack({ id: 'acme-inspect', name: 'acme-inspect', permissions: inspector });
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/editors', headers: AGENT, payload: { packRoot } })).statusCode).toBe(403);
    expect(h.upsertConformanceRule).not.toHaveBeenCalled();
    // An editor that does not declare it is granted nothing.
    const plain = await h.app.inject({ method: 'POST', url: '/api/v1/editors', headers: HUMAN, payload: { packRoot: makePack() } });
    expect(plain.statusCode, plain.body).toBe(200);
    expect((plain.json() as InstallEditorResponse).granted).toBeUndefined();
    expect(h.upsertConformanceRule).not.toHaveBeenCalled();
    // The human install of a declaring editor writes exactly its build's token.
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/editors', headers: HUMAN, payload: { packRoot } });
    expect(res.statusCode, res.body).toBe(200);
    const sha = h.registry.get('acme-inspect')!.sha256;
    const token = `editor:acme-inspect@0.1.0#${sha}/mcp.session`;
    expect((res.json() as InstallEditorResponse).granted).toEqual([token]);
    expect(ledger.excludes).toEqual(['editor:other@1.0.0#' + 'a'.repeat(64) + '/mcp.session', 'mcp:unrelated', token]);
    // An update replaces the earlier build's token (the new hash is a new grant).
    const v2 = makePack({ id: 'acme-inspect', name: 'acme-inspect', version: '0.2.0', permissions: inspector, html: EDITOR_HTML.replace('</body>', '<!-- v2 --></body>') });
    const updated = await h.app.inject({ method: 'POST', url: '/api/v1/editors', headers: HUMAN, payload: { packRoot: v2 } });
    expect(updated.statusCode, updated.body).toBe(200);
    const token2 = `editor:acme-inspect@0.2.0#${h.registry.get('acme-inspect')!.sha256}/mcp.session`;
    expect(ledger.excludes.filter((t) => t.startsWith('editor:acme-inspect@'))).toEqual([token2]);
    // An update that no longer declares it keeps no grant (codex r1).
    const v3 = makePack({ id: 'acme-inspect', name: 'acme-inspect', version: '0.3.0', html: EDITOR_HTML.replace('</body>', '<!-- v3 --></body>') });
    const dropped = await h.app.inject({ method: 'POST', url: '/api/v1/editors', headers: HUMAN, payload: { packRoot: v3 } });
    expect(dropped.statusCode, dropped.body).toBe(200);
    expect((dropped.json() as InstallEditorResponse).granted).toBeUndefined();
    expect(ledger.excludes.some((t) => t.startsWith('editor:acme-inspect@'))).toBe(false);
    const v4 = makePack({ id: 'acme-inspect', name: 'acme-inspect', version: '0.4.0', permissions: inspector, html: EDITOR_HTML.replace('</body>', '<!-- v4 --></body>') });
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/editors', headers: HUMAN, payload: { packRoot: v4 } })).statusCode).toBe(200);
    // A withdrawal that cannot be written keeps the editor installed (a retry can reach it), 503.
    h.upsertConformanceRule.mockRejectedValueOnce(new Error('store busy'));
    const busy = await h.app.inject({ method: 'DELETE', url: '/api/v1/editors/acme-inspect', headers: HUMAN });
    expect(busy.statusCode).toBe(503);
    expect(h.registry.get('acme-inspect')).not.toBeNull();
    // Removing it withdraws the grant; another editor's token is untouched.
    expect((await h.app.inject({ method: 'DELETE', url: '/api/v1/editors/acme-inspect', headers: HUMAN })).statusCode).toBe(200);
    expect(ledger.excludes).toEqual(['editor:other@1.0.0#' + 'a'.repeat(64) + '/mcp.session', 'mcp:unrelated']);
  });

  it('codex r2: a boot-skipped editor is removable, and its grant is withdrawn', async () => {
    const ledger = { excludes: ['mcp:unrelated'] };
    const first = await harness({ ledger });
    const packRoot = makePack({ id: 'acme-inspect', name: 'acme-inspect', permissions: [{ id: 'mcp.session', why: 'x' }] });
    expect((await first.app.inject({ method: 'POST', url: '/api/v1/editors', headers: HUMAN, payload: { packRoot } })).statusCode).toBe(200);
    expect(ledger.excludes.some((t) => t.startsWith('editor:acme-inspect@'))).toBe(true);
    writeFileSync(join(packRoot, 'editors', 'acme-inspect', 'index.html'), 'tampered');
    const booted = await harness({ ledger, home: first.home });
    expect(booted.registry.get('acme-inspect')).toBeNull();
    expect(booted.registry.isInstalled('acme-inspect')).toBe(true);
    const res = await booted.app.inject({ method: 'DELETE', url: '/api/v1/editors/acme-inspect', headers: HUMAN });
    expect(res.statusCode, res.body).toBe(200);
    expect(booted.registry.isInstalled('acme-inspect')).toBe(false);
    expect(ledger.excludes).toEqual(['mcp:unrelated']);
  });

  it('codex r2: an update that drops mcp.session says so when the earlier grant cannot be withdrawn', async () => {
    const ledger = { excludes: [] as string[] };
    const h = await harness({ ledger });
    const v1 = makePack({ id: 'acme-inspect', name: 'acme-inspect', permissions: [{ id: 'mcp.session', why: 'x' }] });
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/editors', headers: HUMAN, payload: { packRoot: v1 } })).statusCode).toBe(200);
    h.upsertConformanceRule.mockRejectedValueOnce(new Error('store busy'));
    const v2 = makePack({ id: 'acme-inspect', name: 'acme-inspect', version: '0.2.0', html: EDITOR_HTML.replace('</body>', '<!-- v2 --></body>') });
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/editors', headers: HUMAN, payload: { packRoot: v2 } });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as InstallEditorResponse).grantError).toMatch(/earlier build's mcp\.session grant was not withdrawn: store busy/);
  });

  it('codex r2: a removal and an install never interleave: the editor and its grant agree afterwards', async () => {
    const ledger = { excludes: [] as string[] };
    const h = await harness({ ledger });
    const perms = [{ id: 'mcp.session', why: 'x' }];
    const v1 = makePack({ id: 'acme-inspect', name: 'acme-inspect', permissions: perms });
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/editors', headers: HUMAN, payload: { packRoot: v1 } })).statusCode).toBe(200);
    // The removal's withdrawal is slow; the install of v2 arrives while it is in flight.
    const real = h.upsertConformanceRule.getMockImplementation()!;
    h.upsertConformanceRule.mockImplementationOnce(async (rule) => {
      await new Promise((r) => setTimeout(r, 150));
      return real(rule);
    });
    const v2 = makePack({ id: 'acme-inspect', name: 'acme-inspect', version: '0.2.0', permissions: perms, html: EDITOR_HTML.replace('</body>', '<!-- v2 --></body>') });
    const [del, inst] = await Promise.all([
      h.app.inject({ method: 'DELETE', url: '/api/v1/editors/acme-inspect', headers: HUMAN }),
      h.app.inject({ method: 'POST', url: '/api/v1/editors', headers: HUMAN, payload: { packRoot: v2 } }),
    ]);
    expect(del.statusCode, del.body).toBe(200);
    expect(inst.statusCode, inst.body).toBe(200);
    // Whichever ran first, the other ran after it: never a grant for a removed editor.
    const live = h.registry.get('acme-inspect');
    if (live === null) expect(ledger.excludes).toEqual([]);
    else expect(ledger.excludes).toEqual([`editor:acme-inspect@${live.manifest.version}#${live.sha256}/mcp.session`]);
    expect(live === null || live.manifest.version === '0.2.0').toBe(true);
  });

  it('an install whose mcp.session grant cannot be written still installs, and says it asks', async () => {
    const h = await harness({ ledger: null });
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/editors', headers: HUMAN, payload: { packRoot: makePack({ id: 'acme-inspect', name: 'acme-inspect', permissions: [{ id: 'mcp.session', why: 'x' }] }) } });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as InstallEditorResponse;
    expect(body.granted).toBeUndefined();
    expect(body.grantError).toMatch(/EDITOR-GRANTS ledger is not in the policy store/);
    expect(h.registry.get('acme-inspect')).not.toBeNull();
  });

  it('a conformance failure through the route is a 422 carrying the report; a skills pack a 501 with the approval list', async () => {
    const failing: ConformanceRunner = async () => ({ ok: false, at: 'x', editors: [{ id: 'acme-terms', version: '0.1.0', sha256: sha256Of(Buffer.from(EDITOR_HTML)), ok: false, cases: { '3-no-network': { ok: false } }, gaps: [] }] });
    const h = await harness({ conformance: failing });
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/editors', headers: HUMAN, payload: { packRoot: makePack() } });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'editor_not_conformant', conformance: { ok: false }, check: { ok: true } });
    const skills = await h.app.inject({ method: 'POST', url: '/api/v1/editors', headers: HUMAN, payload: { packRoot: makePack({ blocks: true, skills: ['acme-terms-checker'] }) } });
    expect(skills.statusCode).toBe(501);
    expect((skills.json() as InstallEditorRefusal).code).toBe('pack_ships_skills_or_blocks');
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

describe('visuals: how an editor looks on the Plugins page (program DES-LEARN §2)', () => {
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>';
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]);

  function withVisuals(visuals: unknown, files: Record<string, string | Buffer>, extra: Record<string, unknown> = {}): string {
    const root = mkdtempSync(join(tmpdir(), 'editors-visuals-'));
    scratches.push(root);
    const dir = join(root, 'editors', 'wicked-page');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'editor.json'), JSON.stringify(manifest('wicked-page', { visuals, ...extra })));
    writeFileSync(join(dir, 'index.html'), PAGE_HTML);
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      writeFileSync(join(dir, name), body);
    }
    return root;
  }

  it('reads the icon and previews beside the manifest into data: URLs, with the colour and one line, onto the wire view', () => {
    const root = withVisuals({ icon: 'icon.svg', color: '#7c3aed', preview: { light: 'shots/light.png', dark: 'shots/dark.png' }, live: true },
      { 'icon.svg': SVG, 'shots/light.png': PNG, 'shots/dark.png': PNG }, { description: '  Opens pages:\n point at any element.  ' });
    const reg = new EditorRegistry({ stateHome: mkdtempSync(join(tmpdir(), 'editors-home-')), studioRoot: root });
    const view = EditorRegistry.view(reg.get('wicked-page')!);
    expect(view.description).toBe('Opens pages: point at any element.');
    expect(view.visuals).toEqual({
      icon: `data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`,
      color: '#7c3aed',
      preview: { light: `data:image/png;base64,${PNG.toString('base64')}`, dark: `data:image/png;base64,${PNG.toString('base64')}` },
      live: true,
    });
    // No path is on the wire.
    expect(JSON.stringify(view)).not.toContain(root);
  });

  it('a missing, oversized, linked, mistyped or escaping image is left out with a reason; the editor is still served', () => {
    const outside = mkdtempSync(join(tmpdir(), 'editors-outside-'));
    scratches.push(outside);
    writeFileSync(join(outside, 'x.svg'), SVG);
    const root = withVisuals({ icon: 'linked.svg', preview: { light: 'big.png', dark: 'fake.png' }, color: 'purple' },
      { 'big.png': Buffer.concat([PNG, Buffer.alloc(201 * 1024)]), 'fake.png': '<html>not a png</html>' });
    symlinkSync(join(outside, 'x.svg'), join(root, 'editors', 'wicked-page', 'linked.svg'));
    const logs: string[] = [];
    const found = discoverStudioEditors(root, (m) => logs.push(m));
    expect(found.map((r) => r.manifest.id)).toEqual(['wicked-page']);
    expect(found[0]!.visuals).toBeUndefined();
    expect(logs.find((l) => l.includes('linked.svg'))).toMatch(/symlink/);
    expect(logs.find((l) => l.includes('big.png'))).toMatch(/over its 204800-byte cap/);
    expect(logs.find((l) => l.includes('fake.png'))).toMatch(/not a png image/);
    // codex on crew#1234: what was checked is what is read. A link at the open is refused (O_NOFOLLOW), and a file
    // replaced after its check (another inode) is not read.
    const dir = mkdtempSync(join(tmpdir(), 'editors-swap-'));
    scratches.push(dir);
    writeFileSync(join(dir, 'a.svg'), SVG);
    symlinkSync(join(outside, 'x.svg'), join(dir, 'link.svg'));
    expect(() => readNoFollow(join(dir, 'link.svg'), 1024)).toThrow(/ELOOP|EMLINK/);
    const checked = statSync(join(dir, 'a.svg'));
    rmSync(join(dir, 'a.svg'));
    writeFileSync(join(dir, 'b.tmp'), SVG);
    writeFileSync(join(dir, 'a.svg'), SVG);
    rmSync(join(dir, 'b.tmp'));
    expect(readNoFollow(join(dir, 'a.svg'), 1024, checked)).toBeNull();
    expect(readNoFollow(join(dir, 'a.svg'), 1024)?.toString()).toBe(SVG);
    // A path out of the directory, a remote URL or an unknown type is never even tried.
    const escaping = withVisuals({ icon: '../../index.html', preview: 'https://cdn.example/p.png', color: '#123456' }, {});
    const r = discoverStudioEditors(escaping)[0]!;
    expect(r.visuals).toEqual({ color: '#123456' });
  });

  it('a malformed visuals value is dropped, never a reason to refuse the editor; a manifest without one has none on the wire', () => {
    const root = withVisuals('icon.svg', {}, { description: 42 });
    const reg = new EditorRegistry({ stateHome: mkdtempSync(join(tmpdir(), 'editors-home-')), studioRoot: root });
    const view = EditorRegistry.view(reg.get('wicked-page')!);
    expect(view).not.toHaveProperty('visuals');
    expect(view).not.toHaveProperty('description');
    const plain = EditorRegistry.view(new EditorRegistry({ stateHome: mkdtempSync(join(tmpdir(), 'editors-home-')), studioRoot: studioRoot() }).get('wicked-page')!);
    expect(Object.keys(plain)).not.toContain('visuals');
  });
});
