// CS7 — third-party RUN PLUGINS (the observe tier): a spec-2 pack that declares `plugins[]` installs when its
// report carries every run case (r0-r5), is matched against the report's `plugins[]` rows (id + version + sha256,
// fail closed), lists as an `EditorView` row with `inline:'run-thread'` and its granted topics, and has its
// `observe:<topic>` grant tokens written by the install consent and withdrawn on remove. The registry schema
// (zod, strict) refuses a `permissions` key and a topic that is not a run pattern.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConformanceRule, EditorConformanceSummary, EditorGrantsResponse, EditorView, InstallEditorResponse, ListEditorsResponse } from '../src/core/types.js';
import { conformanceCapMs, DEFAULT_CONFORMANCE_LOAD_S, gardenConformance, installPack, PackInstallError, type ConformanceRunner, type PackCheckRunner } from '../src/editors/pack-install.js';
import { EditorRegistry, EDITORS_STATE_FILENAME, PluginManifestSchema, RUN_PLUGIN_CASES, sha256Of, validRunTopic } from '../src/editors/registry.js';
import { registerEditorRoutes } from '../src/editors/routes.js';

const scratches: string[] = [];
afterEach(() => {
  for (const s of scratches.splice(0)) rmSync(s, { recursive: true, force: true });
});

const PLUGIN_HTML = '<!doctype html><html><body><section>times</section><script>parent.postMessage({ type: "plugin.ready" }, "*")</script></body></html>';

/** A pack directory that declares one run plugin (CS7), its entry on disk and its true hash pinned. */
function makePluginPack(opts: { name?: string; id?: string; html?: string; version?: string; topics?: Array<{ topic: string; why: string }>; also?: Record<string, unknown>; blocks?: boolean; editorToo?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'run-plugin-pack-'));
  scratches.push(root);
  const id = opts.id ?? 'acme-times';
  const html = opts.html ?? PLUGIN_HTML;
  const version = opts.version ?? '0.1.0';
  mkdirSync(join(root, 'plugins', id), { recursive: true });
  writeFileSync(join(root, 'plugins', id, 'index.html'), html);
  const topics = opts.topics ?? [
    { topic: 'wicked.run.unit.*', why: 'to show each phase' },
    { topic: 'wicked.run.usage.reported', why: 'to show the spend' },
  ];
  const manifest: Record<string, unknown> = {
    spec: 2,
    name: opts.name ?? id,
    vendor: 'acme',
    version,
    plugins: [
      {
        id,
        title: 'Phase times',
        version,
        protocol: [3],
        inline: 'run-thread',
        entry: `plugins/${id}/index.html`,
        sha256: sha256Of(Buffer.from(html)),
        observe: topics,
        panels: [{ slot: 'run.details', id: 'main', title: 'Phase times', order: 1 }],
        ...opts.also,
      },
    ],
  };
  if (opts.editorToo === true) {
    const ehtml = '<!doctype html><html><body>doc</body></html>';
    mkdirSync(join(root, 'editors', 'acme-notes'), { recursive: true });
    writeFileSync(join(root, 'editors', 'acme-notes', 'index.html'), ehtml);
    manifest['editors'] = [{ id: 'acme-notes', title: 'Notes', version, protocol: [1], kinds: ['document'], entry: 'editors/acme-notes/index.html', sha256: sha256Of(Buffer.from(ehtml)), sizes: ['inline', 'pane'], permissions: [{ id: 'artifact.read', why: 'r' }] }];
  }
  if (opts.blocks === true) {
    manifest['blocks'] = [{ id: 'acme-b', label: 'B', preset: 'presets/b.json', produces_kind: 'document', skills: ['acme-s'] }];
    mkdirSync(join(root, 'skills', 'acme-s'), { recursive: true });
  }
  writeFileSync(join(root, 'wicked-pack.json'), JSON.stringify(manifest));
  return root;
}

const passCheck: PackCheckRunner = async () => ({ ok: true, errors: [], warnings: [] });

/** The editor-side conformance for whatever `editors[]` the pack holds (cases 0-12 + 18), per garden's report. */
function editorRows(packRoot: string): EditorConformanceSummary['editors'] {
  const m = JSON.parse(readFileSync(join(packRoot, 'wicked-pack.json'), 'utf8')) as { editors?: Array<{ id: string; version: string; entry: string }> };
  const EDITOR_CASES = ['0-manifest', '1-handshake', '2-sizes', '3-no-network', '4-permissions', '5-typing', '6-forwarding', '7-edit', '8-strict-input', '9-liveness', '10-keyboard', '11-theme', '12-hash-pinned', '18-shows'];
  return (m.editors ?? []).map((e) => ({ id: e.id, version: e.version, sha256: sha256Of(readFileSync(join(packRoot, e.entry))), ok: true, cases: Object.fromEntries(EDITOR_CASES.map((c) => [c, { ok: true }])), gaps: [] }));
}

/** A passing run over the pack's plugins (its ids, versions, entry hashes), every run case ok, plus any editors. */
function conformantPlugins(caseOverride?: (p: { id: string }) => Record<string, { ok: boolean }>): ConformanceRunner {
  return vi.fn(async (packRoot: string): Promise<EditorConformanceSummary> => {
    const m = JSON.parse(readFileSync(join(packRoot, 'wicked-pack.json'), 'utf8')) as { plugins?: Array<{ id: string; version: string; entry: string }> };
    const plugins = (m.plugins ?? []).map((p) => ({
      id: p.id,
      version: p.version,
      sha256: sha256Of(readFileSync(join(packRoot, p.entry))),
      ok: true,
      cases: caseOverride ? caseOverride(p) : Object.fromEntries(RUN_PLUGIN_CASES.map((c) => [c, { ok: true }])),
      gaps: [],
    }));
    return { ok: true, at: '2026-10-20T00:00:00.000Z', editors: editorRows(packRoot), ...(plugins.length > 0 ? { plugins } : {}) };
  });
}

function registry(): { reg: EditorRegistry; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'run-plugin-home-'));
  scratches.push(home);
  return { reg: new EditorRegistry({ stateHome: home }), home };
}

describe('the plugin manifest schema (CS7 C1/C2, zod strict)', () => {
  const base = {
    id: 'acme-times',
    title: 'Phase times',
    version: '0.1.0',
    protocol: [3],
    inline: 'run-thread',
    entry: 'plugins/acme-times/index.html',
    sha256: 'a'.repeat(64),
    observe: [{ topic: 'wicked.run.unit.*', why: 'to show phases' }],
    panels: [{ slot: 'run.details', id: 'main', title: 'Phase times', order: 1 }],
  };

  it('admits a well-formed entry and fills the panel defaults', () => {
    const r = PluginManifestSchema.safeParse(base);
    expect(r.success, JSON.stringify(r)).toBe(true);
    if (r.success) {
      expect(r.data.panels[0]).toMatchObject({ slot: 'run.details', id: 'main', instances: 'single', defaultOpen: 'while-live', summary: 'none' });
      expect(r.data.inline).toBe('run-thread');
    }
  });

  it('refuses a `permissions` key (strict: the observe tier asks for nothing else)', () => {
    const r = PluginManifestSchema.safeParse({ ...base, permissions: [{ id: 'artifact.read', why: 'x' }] });
    expect(r.success).toBe(false);
  });

  it('refuses a topic that is not a run pattern (`wicked.**`, `wicked.bus.x`, `wicked.run`)', () => {
    for (const bad of ['wicked.**', 'wicked.bus.x', 'wicked.run', 'Wicked.run.x', 'wicked.run.**.x']) {
      expect(PluginManifestSchema.safeParse({ ...base, observe: [{ topic: bad, why: 'x' }] }).success, bad).toBe(false);
      expect(validRunTopic(bad), bad).toBe(false);
    }
    for (const ok of ['wicked.run.unit.*', 'wicked.run.usage.reported', 'wicked.run.**']) {
      expect(validRunTopic(ok), ok).toBe(true);
    }
  });

  it('refuses a protocol that does not list 3, duplicate topics, and too many topics', () => {
    expect(PluginManifestSchema.safeParse({ ...base, protocol: [1, 2] }).success).toBe(false);
    expect(PluginManifestSchema.safeParse({ ...base, observe: [{ topic: 'wicked.run.unit.*', why: 'a' }, { topic: 'wicked.run.unit.*', why: 'b' }] }).success).toBe(false);
    const seventeen = Array.from({ length: 17 }, (_, i) => ({ topic: `wicked.run.t${i}`, why: 'x' }));
    expect(PluginManifestSchema.safeParse({ ...base, observe: seventeen }).success).toBe(false);
  });
});

describe('pack install admits run plugins (CS7 C4/C5)', () => {
  it('a plugin-only pack whose report has every run case installs and reads back', async () => {
    const { reg, home } = registry();
    const root = makePluginPack();
    const conformance = conformantPlugins();
    const res: InstallEditorResponse = await installPack(root, undefined, { check: passCheck, conformance, registry: reg });
    expect(res.installed).toBe(true);
    expect(res.editors).toHaveLength(1);
    expect(res.editors[0]).toMatchObject({ id: 'acme-times', inline: 'run-thread', first_party: false, source: 'pack', kinds: [], sizes: [], permissions: [] });
    expect(res.editors[0]!.observe).toEqual([
      { topic: 'wicked.run.unit.*', why: 'to show each phase' },
      { topic: 'wicked.run.usage.reported', why: 'to show the spend' },
    ]);
    expect(res.editors[0]!.run_panels![0]).toMatchObject({ slot: 'run.details', id: 'main', order: 1, instances: 'single' });
    // The plugin rode the conformance run as a plugin entry.
    expect(conformance).toHaveBeenCalledWith(root, [], [expect.objectContaining({ id: 'acme-times' })]);
    const state = JSON.parse(readFileSync(join(home, EDITORS_STATE_FILENAME), 'utf8')) as { installed: Record<string, { kind: string; conformance: { cases: string[] } }> };
    expect(state.installed['acme-times']).toMatchObject({ kind: 'plugin' });
    expect(state.installed['acme-times']!.conformance.cases).toEqual([...RUN_PLUGIN_CASES]);
    // Read back after a restart.
    expect(new EditorRegistry({ stateHome: home }).get('acme-times')).toMatchObject({ kind: 'plugin', firstParty: false });
  });

  it('a plugin row missing r3-topics is a 422 and nothing is installed', async () => {
    const { reg, home } = registry();
    const missingR3 = conformantPlugins(() => Object.fromEntries(RUN_PLUGIN_CASES.filter((c) => c !== 'r3-topics').map((c) => [c, { ok: true }])));
    const err = await installPack(makePluginPack(), undefined, { check: passCheck, conformance: missingR3, registry: reg }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PackInstallError);
    expect((err as PackInstallError).status).toBe(422);
    expect((err as PackInstallError).message).toMatch(/r3-topics/);
    expect(reg.get('acme-times')).toBeNull();
    expect(() => readFileSync(join(home, EDITORS_STATE_FILENAME), 'utf8')).toThrow();
  });

  // codex r1: the fixtures above are built from production's list, so these pin the contract independently.
  const CONTRACT_RUN_CASES = ['r0-manifest', 'r1-handshake', 'r2-no-network', 'r3-topics', 'r4-replay', 'r5-hash-pinned'];

  it('RUN_PLUGIN_CASES is exactly the contract list, in order', () => {
    expect([...RUN_PLUGIN_CASES]).toEqual(CONTRACT_RUN_CASES);
  });

  it.each(CONTRACT_RUN_CASES.flatMap((c) => [[c, 'missing'], [c, 'failed']] as const))('a plugin row with %s %s is a 422 and nothing is installed', async (c, how) => {
    const { reg } = registry();
    const cases = Object.fromEntries(CONTRACT_RUN_CASES.filter((x) => how === 'failed' || x !== c).map((x) => [x, { ok: !(how === 'failed' && x === c) }]));
    const err = await installPack(makePluginPack(), undefined, { check: passCheck, conformance: conformantPlugins(() => cases), registry: reg }).catch((e: unknown) => e);
    expect((err as PackInstallError).status).toBe(422);
    expect((err as PackInstallError).message).toContain(c);
    expect(reg.get('acme-times')).toBeNull();
  });

  it('a plugin row survives garden\'s report as crew parses it (gardenConformance), with the plugin-inclusive cap', async () => {
    const { reg } = registry();
    const root = makePluginPack();
    const garden = mkdtempSync(join(tmpdir(), 'run-plugin-garden-'));
    scratches.push(garden);
    mkdirSync(join(garden, 'scripts', 'editor'), { recursive: true });
    writeFileSync(join(garden, 'scripts', 'editor', 'conformance.py'), '# stub\n');
    const m = JSON.parse(readFileSync(join(root, 'wicked-pack.json'), 'utf8')) as { plugins: Array<{ id: string; version: string; entry: string }> };
    const p = m.plugins[0]!;
    const report = { ok: true, editors: [], plugins: [{ id: p.id, version: p.version, protocol: [3], sha256: sha256Of(readFileSync(join(root, p.entry))), ok: true, cases: Object.fromEntries(CONTRACT_RUN_CASES.map((c) => [c, { ok: true }])), gaps: [] }] };
    const seen: Array<{ timeout?: number }> = [];
    const run = gardenConformance(garden, () => 'http://127.0.0.1:1', {
      env: {},
      exec: (async (_b: string, _a: string[], opts: { timeout?: number } = {}) => { seen.push(opts); return { stdout: JSON.stringify(report), stderr: '' }; }) as never,
    });
    const res = await installPack(root, undefined, { check: passCheck, conformance: run, registry: reg });
    expect(res.conformance.plugins?.[0]).toMatchObject({ id: p.id, ok: true });
    expect(reg.get('acme-times')).toMatchObject({ kind: 'plugin' });
    // The child's cap is the plugin-inclusive one.
    expect(seen[0]?.timeout).toBe(conformanceCapMs([], DEFAULT_CONFORMANCE_LOAD_S, m.plugins as never));
    expect(conformanceCapMs([], DEFAULT_CONFORMANCE_LOAD_S, m.plugins as never)).toBeGreaterThan(conformanceCapMs([], DEFAULT_CONFORMANCE_LOAD_S, []));
  });

  it('a report row for another sha (not the bytes being installed) is refused (422)', async () => {
    const { reg } = registry();
    const root = makePluginPack();
    const otherSha: ConformanceRunner = async (packRoot) => {
      const base = await conformantPlugins()(packRoot);
      return { ...base, plugins: (base.plugins ?? []).map((p) => ({ ...p, sha256: 'b'.repeat(64) })) };
    };
    await expect(installPack(root, undefined, { check: passCheck, conformance: otherSha, registry: reg })).rejects.toMatchObject({ status: 422, message: /not this entry/ });
    expect(reg.get('acme-times')).toBeNull();
  });

  it('a plugin-only pack whose report carries no plugins at all is unavailable (422), nothing installed', async () => {
    const { reg } = registry();
    const noRun: ConformanceRunner = async () => ({ ok: true, at: 'x', editors: [] });
    const err = await installPack(makePluginPack(), undefined, { check: passCheck, conformance: noRun, registry: reg }).catch((e: unknown) => e);
    expect((err as PackInstallError).status).toBe(422);
    expect((err as PackInstallError).body).toMatchObject({ code: 'conformance_unavailable' });
  });

  it('a pack with neither editors nor plugins is a 400; one that also ships blocks is a 501', async () => {
    const { reg } = registry();
    const empty = mkdtempSync(join(tmpdir(), 'run-plugin-empty-'));
    scratches.push(empty);
    writeFileSync(join(empty, 'wicked-pack.json'), JSON.stringify({ spec: 2, name: 'x', vendor: 'y', version: '0.1.0' }));
    await expect(installPack(empty, undefined, { check: passCheck, conformance: conformantPlugins(), registry: reg })).rejects.toMatchObject({ status: 400 });
    await expect(installPack(makePluginPack({ blocks: true }), undefined, { check: passCheck, conformance: conformantPlugins(), registry: reg })).rejects.toMatchObject({ status: 501 });
  });

  it('an editor-only pack needs no run cases (its report carries no plugins)', async () => {
    const { reg } = registry();
    const root = mkdtempSync(join(tmpdir(), 'run-plugin-editor-'));
    scratches.push(root);
    const html = '<!doctype html><html><body>doc</body></html>';
    mkdirSync(join(root, 'editors', 'acme-notes'), { recursive: true });
    writeFileSync(join(root, 'editors', 'acme-notes', 'index.html'), html);
    writeFileSync(join(root, 'wicked-pack.json'), JSON.stringify({ spec: 2, name: 'acme-notes', vendor: 'acme', version: '0.1.0', editors: [{ id: 'acme-notes', title: 'Notes', version: '0.1.0', protocol: [1], kinds: ['document'], entry: 'editors/acme-notes/index.html', sha256: sha256Of(Buffer.from(html)), sizes: ['inline', 'pane'], permissions: [{ id: 'artifact.read', why: 'r' }] }] }));
    const res = await installPack(root, undefined, { check: passCheck, conformance: conformantPlugins(), registry: reg });
    expect(res.editors[0]).toMatchObject({ id: 'acme-notes', source: 'pack' });
    expect(res.editors[0]!.inline).toBeUndefined();
  });
});

describe('the run-plugin routes (CS7 C3/C4)', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    for (const a of apps.splice(0)) await a.close();
  });

  /** allow / ask / deny by topic suffix, so a test can control the engine's decision per topic. */
  function decisionFor(topic: string): 'allow' | 'ask' | 'deny' {
    if (topic.endsWith('.denied')) return 'deny';
    if (topic.endsWith('.reported')) return 'ask';
    return 'allow';
  }

  async function harness(opts: { ledger?: { excludes: string[] } | null; throwsForPlugin?: boolean } = {}) {
    const home = mkdtempSync(join(tmpdir(), 'run-plugin-home-'));
    scratches.push(home);
    const reg = new EditorRegistry({ stateHome: home });
    const ledger = opts.ledger ?? null;
    const evaluateEditorGrants = vi.fn(async (req: { subject?: string; editorId: string; version: string; sha256: string; permissions: string[]; observe?: string[]; project?: string; firstParty: boolean }): Promise<EditorGrantsResponse> => {
      if (req.subject === 'plugin') {
        if (opts.throwsForPlugin === true) throw new Error('engine faulted');
        return {
          editorId: req.editorId, version: req.version, sha256: req.sha256, project: req.project ?? null, firstParty: false,
          grants: (req.observe ?? []).map((topic) => ({ permission: `observe:${topic}`, decision: decisionFor(topic), ruleIds: decisionFor(topic) === 'allow' ? ['EDITOR-GRANTS'] : [], token: `plugin:${req.editorId}@${req.version}#${req.sha256}/observe:${topic}` })),
        };
      }
      return { editorId: req.editorId, version: req.version, sha256: req.sha256, project: req.project ?? null, firstParty: req.firstParty, grants: req.permissions.map((p) => ({ permission: p, decision: 'allow' as const, ruleIds: ['EDITOR-BUILTIN'], token: `editor:${req.editorId}@${req.version}#${req.sha256}/${p}` })) };
    });
    const upsertConformanceRule = vi.fn(async (rule: ConformanceRule) => {
      if (ledger !== null) ledger.excludes = [...(rule.excludes ?? [])];
    });
    const adapter = {
      editorGrantsSupported: () => true,
      evaluateEditorGrants,
      listConformanceRules: async (): Promise<ConformanceRule[]> => (ledger === null ? [] : [{ id: 'EDITOR-GRANTS', excludes: [...ledger.excludes] } as unknown as ConformanceRule]),
      upsertConformanceRule,
    };
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
    registerEditorRoutes(app, { registry: reg, adapter, packCheck: passCheck, conformance: conformantPlugins(), log: (m) => logs.push(m) });
    await app.ready();
    apps.push(app);
    return { app, reg, home, adapter, evaluateEditorGrants, upsertConformanceRule, logs };
  }
  const HUMAN = { 'x-actor': 'human:operator' };

  it('install writes one observe token per declared topic and drops the earlier build\'s tokens; DELETE drops them', async () => {
    const ledger = { excludes: ['mcp:unrelated'] };
    const h = await harness({ ledger });
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/editors', headers: HUMAN, payload: { packRoot: makePluginPack() } });
    expect(res.statusCode, res.body).toBe(200);
    const sha = h.reg.get('acme-times')!.sha256;
    const t1 = `plugin:acme-times@0.1.0#${sha}/observe:wicked.run.unit.*`;
    const t2 = `plugin:acme-times@0.1.0#${sha}/observe:wicked.run.usage.reported`;
    expect((res.json() as InstallEditorResponse).granted).toEqual([t1, t2]);
    expect(ledger.excludes).toEqual(['mcp:unrelated', t1, t2]);
    // An update (new version/hash) drops the old build's tokens and writes the new build's.
    const v2 = makePluginPack({ version: '0.2.0', html: PLUGIN_HTML.replace('</body>', '<!-- v2 --></body>') });
    const updated = await h.app.inject({ method: 'POST', url: '/api/v1/editors', headers: HUMAN, payload: { packRoot: v2 } });
    expect(updated.statusCode, updated.body).toBe(200);
    const sha2 = h.reg.get('acme-times')!.sha256;
    expect(ledger.excludes.filter((t) => t.startsWith('plugin:acme-times@'))).toEqual([
      `plugin:acme-times@0.2.0#${sha2}/observe:wicked.run.unit.*`,
      `plugin:acme-times@0.2.0#${sha2}/observe:wicked.run.usage.reported`,
    ]);
    // Removing the plugin withdraws every plugin:<id>@ token; the unrelated entry stays.
    expect((await h.app.inject({ method: 'DELETE', url: '/api/v1/editors/acme-times', headers: HUMAN })).statusCode).toBe(200);
    expect(ledger.excludes).toEqual(['mcp:unrelated']);
    expect(h.reg.get('acme-times')).toBeNull();
  });

  it('GET /editors puts only the `allow` topics in granted_topics, and [] when the engine throws', async () => {
    const h = await harness({ ledger: { excludes: [] } });
    // One topic allowed, one ask, one deny.
    const topics = [
      { topic: 'wicked.run.unit.started', why: 'a' },
      { topic: 'wicked.run.usage.reported', why: 'b' }, // ask
      { topic: 'wicked.run.secret.denied', why: 'c' }, // deny
    ];
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/editors', headers: HUMAN, payload: { packRoot: makePluginPack({ topics }) } })).statusCode).toBe(200);
    const listed = (await h.app.inject({ method: 'GET', url: '/api/v1/editors', headers: HUMAN })).json() as ListEditorsResponse;
    const row = listed.editors.find((e) => e.id === 'acme-times')!;
    expect(row.inline).toBe('run-thread');
    expect(row.granted_topics).toEqual(['wicked.run.unit.started']);

    // When the engine throws for a plugin, the row hears nothing (fail closed) and a log line says why.
    const h2 = await harness({ ledger: { excludes: [] }, throwsForPlugin: true });
    expect((await h2.app.inject({ method: 'POST', url: '/api/v1/editors', headers: HUMAN, payload: { packRoot: makePluginPack({ topics }) } })).statusCode).toBe(200);
    const listed2 = (await h2.app.inject({ method: 'GET', url: '/api/v1/editors', headers: HUMAN })).json() as ListEditorsResponse;
    expect(listed2.editors.find((e) => e.id === 'acme-times')!.granted_topics).toEqual([]);
    expect(h2.logs.some((l) => /could not be decided/.test(l))).toBe(true);
  });

  it('GET /editors/:id/grants for a plugin answers the observe decisions; editor rows carry no granted_topics', async () => {
    const h = await harness({ ledger: { excludes: [] } });
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/editors', headers: HUMAN, payload: { packRoot: makePluginPack({ editorToo: true }) } })).statusCode).toBe(200);
    const grants = (await h.app.inject({ method: 'GET', url: '/api/v1/editors/acme-times/grants', headers: HUMAN })).json() as EditorGrantsResponse;
    expect(grants.grants.map((g) => g.permission)).toEqual(['observe:wicked.run.unit.*', 'observe:wicked.run.usage.reported']);
    expect(grants.grants.find((g) => g.permission === 'observe:wicked.run.usage.reported')!.decision).toBe('ask');
    // The editor in the same pack is an ordinary editor row with no granted_topics.
    const listed = (await h.app.inject({ method: 'GET', url: '/api/v1/editors', headers: HUMAN })).json() as ListEditorsResponse;
    const editorRow: EditorView = listed.editors.find((e) => e.id === 'acme-notes')!;
    expect(editorRow.inline).toBeUndefined();
    expect(editorRow.granted_topics).toBeUndefined();
  });

  it('POST /editors/:id/grants for a plugin is 409 install_only (its topics are the install consent\'s)', async () => {
    const ledger = { excludes: [] as string[] };
    const h = await harness({ ledger });
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/editors', headers: HUMAN, payload: { packRoot: makePluginPack() } })).statusCode).toBe(200);
    const after = [...ledger.excludes];
    const rec = h.reg.get('acme-times')!;
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/editors/acme-times/grants', headers: HUMAN, payload: { permission: 'observe:wicked.run.unit.*', allow: false, version: rec.manifest.version, sha256: rec.sha256 } });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ code: 'install_only' });
    expect(ledger.excludes).toEqual(after);
    // codex r2: the answer does not depend on the engine's grants support (it was a 501 before).
    (h.adapter as { editorGrantsSupported: () => boolean }).editorGrantsSupported = () => false;
    const unsupported = await h.app.inject({ method: 'POST', url: '/api/v1/editors/acme-times/grants', headers: HUMAN, payload: { permission: 'observe:wicked.run.unit.*', allow: true, version: rec.manifest.version, sha256: rec.sha256 } });
    expect(unsupported.statusCode, unsupported.body).toBe(409);
    expect(unsupported.json()).toMatchObject({ code: 'install_only' });
  });
});
