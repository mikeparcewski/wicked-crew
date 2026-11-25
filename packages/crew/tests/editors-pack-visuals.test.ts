// crew#1702 — a pack editor's one line (`description`) and look (`visuals`) reach `GET /editors`, read through
// `resolveVisuals` against the installed pack's root (inside it, never through a link, within the caps, sniffed), as
// `data:` URLs. A missing, linked or oversized image is dropped with a logged reason and the editor still serves. The
// install digest ignores both keys: a new icon is not a new build needing consent, and an editor installed before
// this change keeps reading back under the digest it was recorded with.
//
// The fixture `tests/fixtures/editor-packs/acme-terms-editor` is garden's real sample as the product stages it:
// garden's documented editor-only recipe (wicked-garden docs/extending.md:221-233, run over
// tests/fixtures/packs/acme-terms at 2bd63acd) and then install.py `stage()` (scripts/editor/install.py:176-200), which
// copies `wicked-pack.json`, each editor's entry and its card images at their manifest paths (pack-root relative).

import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { EditorConformanceSummary, ListEditorsResponse } from '../src/core/types.js';
import { CONFORMANCE_CASES, CONFORMANCE_CASES_V2, installPack, type ConformanceRunner, type PackCheckRunner } from '../src/editors/pack-install.js';
import { EDITORS_STATE_FILENAME, EditorRegistry, editorEntryDigest, PackEditorSchema, packEditorDigest, sha256Of } from '../src/editors/registry.js';
import { registerEditorRoutes } from '../src/editors/routes.js';
import { ICON_CAP_BYTES, PREVIEW_CAP_BYTES } from '../src/editors/visuals.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'editor-packs', 'acme-terms-editor');
const ICON = readFileSync(join(FIXTURE, 'editors', 'acme-terms', 'icon.svg'));
const ICON_URL = `data:image/svg+xml;base64,${ICON.toString('base64')}`;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

const scratches: string[] = [];
afterEach(() => {
  for (const s of scratches.splice(0)) rmSync(s, { recursive: true, force: true });
});
function scratch(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratches.push(d);
  return d;
}

/** A staged copy of the sample (install.py stages it under `<install root>/<name>/current`), optionally edited. */
function stagedPack(edit?: (m: { editors: Array<Record<string, unknown>> }, root: string) => void): string {
  const root = join(scratch('editors-pack-visuals-'), 'current');
  cpSync(FIXTURE, root, { recursive: true });
  if (edit !== undefined) {
    const path = join(root, 'wicked-pack.json');
    const m = JSON.parse(readFileSync(path, 'utf8')) as { editors: Array<Record<string, unknown>> };
    edit(m, root);
    writeFileSync(path, `${JSON.stringify(m, null, 2)}\n`);
  }
  return root;
}

const passCheck: PackCheckRunner = async () => ({ ok: true, errors: [], warnings: [] });
/** Garden's runner passing every case for every editor in the pack, at the bytes on disk. */
const conformant: ConformanceRunner = async (packRoot): Promise<EditorConformanceSummary> => {
  const m = JSON.parse(readFileSync(join(packRoot, 'wicked-pack.json'), 'utf8')) as { editors: Array<{ id: string; version: string; entry: string }> };
  return {
    ok: true,
    at: '2026-11-23T00:00:00.000Z',
    editors: m.editors.map((e) => ({ id: e.id, version: e.version, sha256: sha256Of(readFileSync(join(packRoot, e.entry))), ok: true, cases: Object.fromEntries([...CONFORMANCE_CASES, ...CONFORMANCE_CASES_V2].map((c) => [c, { ok: true }])), gaps: [] })),
  };
};

async function daemon(home: string, logs: string[]) {
  const registry = new EditorRegistry({ stateHome: home, log: (m) => logs.push(m) });
  const app = Fastify({ logger: false });
  app.decorateRequest('actor', null as unknown as never);
  app.addHook('onRequest', async (req) => {
    (req as unknown as { actor: unknown }).actor = { id: 'human-1', kind: 'human', trust: 'operator' };
  });
  registerEditorRoutes(app, { registry, adapter: {}, packCheck: passCheck, conformance: conformant, log: (m) => logs.push(m) });
  await app.ready();
  return app;
}

describe('a pack editor’s description and visuals reach GET /editors (crew#1702)', () => {
  it('garden’s staged acme-terms sample lists its line, its icon (as a data: URL) and its colour, and still does after a restart', async () => {
    const home = scratch('editors-home-');
    const logs: string[] = [];
    const root = stagedPack();
    const app = await daemon(home, logs);
    const installed = await app.inject({ method: 'POST', url: '/api/v1/editors', payload: { packRoot: root } });
    expect(installed.statusCode, installed.body).toBe(200);
    const listed = (await app.inject({ method: 'GET', url: '/api/v1/editors' })).json() as ListEditorsResponse;
    const row = listed.editors.find((e) => e.id === 'acme-terms');
    expect(row).toMatchObject({
      source: 'pack',
      description: 'Find banned terms, point at their sentences, and replace them in one saved version.',
      visuals: { icon: ICON_URL, color: '#224a5e' },
    });
    // No path of the pack reaches the browser.
    expect(JSON.stringify(row)).not.toContain(root);
    await app.close();
    const again = await daemon(home, logs);
    const relisted = (await again.inject({ method: 'GET', url: '/api/v1/editors' })).json() as ListEditorsResponse;
    expect(relisted.editors.find((e) => e.id === 'acme-terms')).toMatchObject({ visuals: { icon: ICON_URL, color: '#224a5e' } });
    await again.close();
  });

  it('a light and dark preview inside the pack is read; a linked icon and an oversized preview are dropped with a reason, and the editor still serves', async () => {
    const reg = (): EditorRegistry => new EditorRegistry({ stateHome: scratch('editors-home-'), log: (m) => logs.push(m) });
    const logs: string[] = [];
    const good = stagedPack((m, root) => {
      writeFileSync(join(root, 'editors', 'acme-terms', 'light.png'), PNG);
      writeFileSync(join(root, 'editors', 'acme-terms', 'dark.png'), PNG);
      m.editors[0]!['visuals'] = { icon: 'editors/acme-terms/icon.svg', color: '#224a5e', preview: { light: 'editors/acme-terms/light.png', dark: 'editors/acme-terms/dark.png' } };
    });
    const res = await installPack(good, undefined, { check: passCheck, conformance: conformant, registry: reg() });
    const png = `data:image/png;base64,${PNG.toString('base64')}`;
    expect(res.editors[0]!.visuals).toEqual({ icon: ICON_URL, color: '#224a5e', preview: { light: png, dark: png } });

    const outside = scratch('editors-outside-');
    writeFileSync(join(outside, 'icon.svg'), ICON);
    const bad = stagedPack((m, root) => {
      rmSync(join(root, 'editors', 'acme-terms', 'icon.svg'));
      symlinkSync(join(outside, 'icon.svg'), join(root, 'editors', 'acme-terms', 'icon.svg'));
      writeFileSync(join(root, 'editors', 'acme-terms', 'big.png'), Buffer.concat([PNG, Buffer.alloc(PREVIEW_CAP_BYTES)]));
      m.editors[0]!['visuals'] = { icon: 'editors/acme-terms/icon.svg', color: '#224a5e', preview: 'editors/acme-terms/big.png' };
    });
    logs.length = 0;
    const res2 = await installPack(bad, undefined, { check: passCheck, conformance: conformant, registry: reg() });
    expect(res2.editors[0]).toMatchObject({ id: 'acme-terms', source: 'pack', visuals: { color: '#224a5e' } });
    expect(res2.editors[0]!.visuals).not.toHaveProperty('icon');
    expect(res2.editors[0]!.visuals).not.toHaveProperty('preview');
    expect(logs.some((l) => l.includes('acme-terms') && l.includes('icon.svg is a symlink'))).toBe(true);
    expect(logs.some((l) => l.includes('acme-terms') && l.includes(`big.png is over its ${PREVIEW_CAP_BYTES}-byte cap`))).toBe(true);
    expect(ICON.byteLength).toBeLessThan(ICON_CAP_BYTES);
  });

  it('the install digest ignores description and visuals: an editor installed before this change still reads back, and a new icon needs no new install', async () => {
    const root = stagedPack();
    const entry = (JSON.parse(readFileSync(join(root, 'wicked-pack.json'), 'utf8')) as { editors: Array<Record<string, unknown>> }).editors[0]!;
    const parsed = PackEditorSchema.parse(entry);
    // What crew main (28f992f) recorded for this entry before crew#1702, when the parse omitted both keys: unchanged.
    const without: Partial<typeof parsed> = { ...parsed };
    delete without.description;
    delete without.visuals;
    expect(packEditorDigest(parsed)).toBe(editorEntryDigest(without));
    expect(packEditorDigest(parsed)).toBe('e406f68af17f147196ceb905645158b75e038debe9bf9a65cd15648bc1d4d654');

    const home = scratch('editors-home-');
    await installPack(root, undefined, { check: passCheck, conformance: conformant, registry: new EditorRegistry({ stateHome: home }) });
    const state = JSON.parse(readFileSync(join(home, EDITORS_STATE_FILENAME), 'utf8')) as { installed: Record<string, { manifestSha256: string }> };
    expect(state.installed['acme-terms']!.manifestSha256).toBe(packEditorDigest(parsed));
    // The author changes the line and the colour after install: still served, with the new look.
    const path = join(root, 'wicked-pack.json');
    const m = JSON.parse(readFileSync(path, 'utf8')) as { editors: Array<Record<string, unknown>> };
    m.editors[0]!['description'] = 'A new line.';
    m.editors[0]!['visuals'] = { icon: 'editors/acme-terms/icon.svg', color: '#000000' };
    writeFileSync(path, JSON.stringify(m));
    const logs: string[] = [];
    const again = new EditorRegistry({ stateHome: home, log: (l) => logs.push(l) });
    expect(EditorRegistry.view(again.get('acme-terms')!)).toMatchObject({ description: 'A new line.', visuals: { icon: ICON_URL, color: '#000000' } });
    // A real change (a permission) is still a new build: skipped until it is installed again.
    m.editors[0]!['permissions'] = [{ id: 'artifact.read', why: 'to read the document’s text' }];
    writeFileSync(path, JSON.stringify(m));
    expect(new EditorRegistry({ stateHome: home, log: (l) => logs.push(l) }).get('acme-terms')).toBeNull();
    expect(logs.some((l) => l.includes('changed since it was installed'))).toBe(true);
  });
});
