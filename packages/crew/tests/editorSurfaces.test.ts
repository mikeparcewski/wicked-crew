// DES-EDITOR-PLUGIN-CONTRACT-001 §5, §8.2, §8.3 — protocol-2 editor surfaces in crew: the strict parser (a port of
// studio's `src/editors/surfaces.ts`), the manifest rule (required with protocol 2, refused without), the wire
// view (`EditorView.surfaces`, defaults filled), and the install conformance (cases 13-16 for a protocol-2 editor).

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { EditorConformanceSummary } from '../src/core/types.js';
import { CONFORMANCE_CASES, CONFORMANCE_CASES_V2, installPack, PackInstallError, requiredCases, type ConformanceRunner, type PackCheckRunner } from '../src/editors/pack-install.js';
import { EditorManifestSchema, EditorRegistry, EDITORS_STATE_FILENAME, PackEditorSchema, discoverStudioEditors, editorEntryDigest, sha256Of } from '../src/editors/registry.js';
import { canonicalSurfaces, parseSurfaces, usesDecisionWord } from '../src/editors/surfaces.js';

const scratches: string[] = [];
afterEach(() => {
  for (const s of scratches.splice(0)) rmSync(s, { recursive: true, force: true });
});
const scratch = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratches.push(d);
  return d;
};

/** Garden's scaffold default (scripts/editor/scaffold.py DEFAULT_SURFACES). */
const SURFACES = {
  card: { interactive: true, aspect: 'auto', actions: [{ id: 'next', label: 'Next part', verb: 'plugin' }, { id: 'ask', label: 'Ask about it', verb: 'host:ask' }] },
  options: { tabs: [
    { id: 'parts', label: 'Parts', render: 'plugin' },
    { id: 'view', label: 'View', render: 'controls', controls: [
      { id: 'density', label: 'Density', type: 'segmented', options: [{ id: 'roomy', label: 'Roomy' }, { id: 'compact', label: 'Compact' }] },
      { id: 'numbers', label: 'Show numbers', type: 'toggle' },
    ] },
  ] },
  full: { modes: ['simple', 'advanced'], default: 'simple' },
};

function entry(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'acme-notes', title: 'Notes', version: '0.1.0', protocol: [1, 2], kinds: ['page'], entry: 'editors/acme-notes/index.html', sha256: 'a'.repeat(64), sizes: ['inline', 'pane', 'full'], permissions: [{ id: 'artifact.read', why: 'to read it' }], surfaces: SURFACES, ...extra };
}

describe('the surfaces parser', () => {
  it('parses the scaffold default with its defaults filled, in studio\'s canonical form', () => {
    const r = parseSurfaces(SURFACES);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.card.actions[0]).toEqual({ id: 'next', label: 'Next part', primary: false, verb: 'plugin' });
    expect(r.value.full).toEqual({ modes: ['simple', 'advanced'], default: 'simple' });
    const cardOnly = parseSurfaces({ card: {} });
    expect(cardOnly.ok && canonicalSurfaces(cardOnly.value)).toBe('{"card":{"interactive":false,"aspect":"16:9","actions":[]},"options":null,"full":null}');
  });

  it.each([
    [{ card: { actions: [{ id: 'a', label: 'Approve', verb: 'plugin' }] } }, 'a word only the host'],
    [{ card: { actions: [{ id: 'a', label: 'Аpprove', verb: 'plugin' }] } }, 'plain characters'],
    [{ card: { actions: [{ id: 'a', label: 'De1iver', verb: 'plugin' }] } }, 'letters or digits'],
    [{ card: { actions: [{ id: 'a', label: 'Go', verb: 'host:approve' }] } }, 'verb is plugin'],
    [{ card: {}, extra: 1 }, 'unknown field "extra"'],
    [{ card: {}, full: { default: 'advanced' } }, 'default needs modes'],
    [{ card: {}, options: { tabs: [] } }, '1 to 5'],
  ])('refuses %j with its reason', (raw, needle) => {
    const r = parseSurfaces(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(needle);
  });

  it('folds look-alikes before the decision-word check, and lets an ordinary word through', () => {
    expect(usesDecisionWord('ApproveAll')).toBe(true);
    expect(usesDecisionWord('Shallow')).toBe(false);
  });
});

describe('the manifest rule (§8.2)', () => {
  it('a protocol-2 editor needs surfaces; a protocol-1 editor may not carry them', () => {
    expect(PackEditorSchema.safeParse(entry()).success).toBe(true);
    const missing = PackEditorSchema.safeParse(entry({ surfaces: undefined }));
    expect(missing.success).toBe(false);
    expect(JSON.stringify(missing.error?.issues)).toContain('declares its surfaces');
    const v1 = PackEditorSchema.safeParse(entry({ protocol: [1] }));
    expect(v1.success).toBe(false);
    expect(PackEditorSchema.safeParse(entry({ protocol: [1], surfaces: undefined })).success).toBe(true);
  });

  it('a refused declaration refuses the editor, with the host\'s reason', () => {
    const r = PackEditorSchema.safeParse(entry({ surfaces: { card: { actions: [{ id: 'm', label: 'Merge', verb: 'plugin' }] } } }));
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toContain('a word only the host');
  });

  it('a first-party protocol-2 editor in studio\'s dist is listed with its parsed surfaces; a bad one is skipped', () => {
    const root = scratch('ev2-studio-');
    const put = (id: string, surfaces: unknown): void => {
      mkdirSync(join(root, 'editors', id), { recursive: true });
      const m = entry({ id, surfaces });
      delete m['sha256'];
      writeFileSync(join(root, 'editors', id, 'editor.json'), JSON.stringify({ ...m, entry: 'index.html' }));
      writeFileSync(join(root, 'editors', id, 'index.html'), '<!doctype html><html><body>x</body></html>');
    };
    put('wicked-notes', SURFACES);
    put('wicked-bad', { card: { actions: [{ id: 'x', label: 'Install', verb: 'plugin' }] } });
    const logs: string[] = [];
    const found = discoverStudioEditors(root, (m) => logs.push(m));
    expect(found.map((r) => r.manifest.id)).toEqual(['wicked-notes']);
    expect(logs.join('\n')).toContain('wicked-bad: manifest refused');
    const view = EditorRegistry.view({ ...found[0]!, enabled: true });
    expect(view.surfaces?.card).toEqual({ interactive: true, aspect: 'auto', actions: [{ id: 'next', label: 'Next part', primary: false, verb: 'plugin' }, { id: 'ask', label: 'Ask about it', primary: false, verb: 'host:ask' }] });
    expect(view.surfaces?.options?.tabs.map((t) => t.id)).toEqual(['parts', 'view']);
  });

  it('an installed protocol-1 pack keeps the digest it was admitted with (no re-install forced)', () => {
    const e = entry({ protocol: [1], surfaces: undefined });
    // The pre-surfaces parse: the schema's own key order, then the pack fields `extend` appends.
    const before = { id: e['id'], title: e['title'], version: e['version'], protocol: e['protocol'], kinds: e['kinds'], entry: e['entry'], sizes: e['sizes'], permissions: e['permissions'], sha256: e['sha256'] };
    const legacy = createHash('sha256').update(JSON.stringify(before)).digest('hex');
    expect(editorEntryDigest(PackEditorSchema.parse(JSON.parse(JSON.stringify(e))))).toBe(legacy);
  });

  it('a protocol-1 editor\'s view has no surfaces field (the wire stays as it was)', () => {
    const r = EditorManifestSchema.safeParse({ ...entry({ protocol: [1], surfaces: undefined }), entry: 'index.html' });
    expect(r.success).toBe(true);
    if (r.success) expect('surfaces' in EditorRegistry.view({ manifest: r.data, sha256: 'a'.repeat(64), bytes: 1, entryPath: '/x', firstParty: true, source: 'studio-bundle', enabled: true })).toBe(false);
  });
});

describe('install conformance (§8.3)', () => {
  const HTML = '<!doctype html><html><body><p>notes</p></body></html>';
  function pack(protocol: number[]): string {
    const root = scratch('ev2-pack-');
    mkdirSync(join(root, 'editors', 'acme-notes'), { recursive: true });
    writeFileSync(join(root, 'editors', 'acme-notes', 'index.html'), HTML);
    const e = entry({ protocol, sha256: sha256Of(Buffer.from(HTML)), ...(protocol.includes(2) ? {} : { surfaces: undefined }) });
    writeFileSync(join(root, 'wicked-pack.json'), JSON.stringify({ spec: 2, name: 'acme-notes', vendor: 'acme', version: '0.1.0', editors: [JSON.parse(JSON.stringify(e))] }));
    return root;
  }
  const passCheck: PackCheckRunner = async () => ({ ok: true, errors: [], warnings: [] });
  const run = (cases: readonly string[]): ConformanceRunner => async (): Promise<EditorConformanceSummary> => ({
    ok: true, at: '2026-10-14T00:00:00.000Z',
    editors: [{ id: 'acme-notes', version: '0.1.0', sha256: sha256Of(Buffer.from(HTML)), ok: true, cases: Object.fromEntries(cases.map((c) => [c, { ok: true }])), gaps: [] }],
  });
  const registry = (): { reg: EditorRegistry; home: string } => {
    const home = scratch('ev2-home-');
    return { reg: new EditorRegistry({ stateHome: home }), home };
  };

  it('requires cases 13-16 only of a protocol-2 editor', () => {
    expect(requiredCases({ protocol: [1] })).toEqual([...CONFORMANCE_CASES]);
    expect(requiredCases({ protocol: [1, 2] })).toEqual([...CONFORMANCE_CASES, ...CONFORMANCE_CASES_V2]);
  });

  it('a protocol-2 editor whose run reports no protocol-2 cases (an older garden) is refused, naming them', async () => {
    const { reg } = registry();
    const err = await installPack(pack([1, 2]), undefined, { check: passCheck, conformance: run(CONFORMANCE_CASES), registry: reg }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PackInstallError);
    expect((err as PackInstallError).status).toBe(422);
    expect((err as PackInstallError).message).toContain('13-surfaces, 14-card, 15-options, 16-full');
  });

  it('a protocol-2 editor that passes every case installs, records its cases and lists its surfaces', async () => {
    const { reg, home } = registry();
    const res = await installPack(pack([1, 2]), undefined, { check: passCheck, conformance: run([...CONFORMANCE_CASES, ...CONFORMANCE_CASES_V2]), registry: reg });
    expect(res.editors[0]?.surfaces?.full).toEqual({ modes: ['simple', 'advanced'], default: 'simple' });
    const state = JSON.parse(readFileSync(join(home, EDITORS_STATE_FILENAME), 'utf8')) as { installed: Record<string, { conformance: { cases: string[] } }> };
    expect(state.installed['acme-notes']!.conformance.cases).toEqual([...CONFORMANCE_CASES, ...CONFORMANCE_CASES_V2]);
    expect(new EditorRegistry({ stateHome: home }).get('acme-notes')?.manifest.surfaces?.card.aspect).toBe('auto');
  });

  it('a protocol-1 editor still installs on cases 0-12 alone', async () => {
    const { reg } = registry();
    const res = await installPack(pack([1]), undefined, { check: passCheck, conformance: run(CONFORMANCE_CASES), registry: reg });
    expect(res.editors[0]?.surfaces).toBeUndefined();
  });
});
