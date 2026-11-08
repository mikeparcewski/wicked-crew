// (CONTRACT-CS2 §P2) The publish check (A2): the manifest-digest guard, the public-app-with-an-action refusal,
// the fixture cards, the render-unavailable rule, and the apps-check --publish evidence paths. The render harness
// has mandatory browser-free driver probes and an end-to-end fake fixture run when conformance Python is present.

import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { actionHash, EMPTY_LOCK, type AppFiles, type CheckOutcome } from '../src/apps/check.js';
import { pinOf } from '../src/apps/exec/sources.js';
import { fixtureCardFor, publishCheck, consentCard, type PublishCheckDeps, type PublishRecord } from '../src/apps/publish/check.js';
import { buildManifest, type ManifestInput } from '../src/apps/publish/manifest.js';
import { renderFixture, type RenderInput, type RenderResult } from '../src/apps/publish/render.js';
import { evidenceTarget, materializeEvidence, PUBLISH_CHECK_TIMEOUT_MS, runAppsCheck, type AppsCheckIo } from '../src/cli/apps-check.js';
import type { AppAction, AppApiAction, AppRowWriteAction, AppActionGrant, AppPublishBody, AppPublishManifest, AppSpec } from '../src/core/types.js';
import type { ImageSources } from '../src/apps/publish/layout.js';
import type { McpToolRecord } from '../src/mcp/registry-store.js';
import type { McpUpstreamConfig } from '../src/mcp/probe.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, 'fixtures', 'apps-standalone');
const RENDER_SCRIPT = join(HERE, '..', 'scripts', 'apps-render.py');

const tmps: string[] = [];
const mkTmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'apps-pubcheck-'));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ASSIGN: AppRowWriteAction = { id: 'assign', kind: 'row-write', source: 'support', table: 'support.tickets', op: 'update', set: { owner: { kind: 'viewer', claim: 'email' } }, key: { id: { kind: 'param', name: 'id' } }, params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } };
const NOTIFY: AppApiAction = { id: 'notify', kind: 'api', source: 'mail', call: { kind: 'tool', tool: 'send' }, args: { to: { kind: 'param', name: 'to' }, when: { kind: 'crew', value: 'now' } }, params: { type: 'object', properties: { to: { type: 'string', format: 'email' } }, required: ['to'] } };

const imageSources: ImageSources = { schema: 'wicked.apps.image-sources/v1', sources: {
  mail: { config: { name: 'mail', kind: 'rest', url: 'https://mail.example.com', command: null, args: [], auth: null }, allowWrites: false, tools: [{ name: 'send', rest: null } as McpToolRecord] },
} };
const fixtureCard = (action: AppAction, manifest = manifestFor([action]), sources = imageSources) => fixtureCardFor(action, manifest, 'esc', sources);

const specOf = (actions: AppAction[], pages: AppSpec['pages'] = []): AppSpec =>
  ({ schema: 'wicked.apps/v1', name: 'Escalations', pages, queries: [{ id: 'open', source: 'support', kind: 'sql', output: [{ name: 'n', type: 'integer' }] }], actions, linkHosts: [] } as unknown as AppSpec);

const filesOf = (spec: AppSpec): AppFiles => {
  const lock = structuredClone(EMPTY_LOCK);
  for (const a of spec.actions) lock.actions[a.id] = { source: a.source, actionHash: actionHash(a), contractHash: `c-${a.id}` };
  return { spec, queryText: { open: 'SELECT 1 AS n' }, lock };
};

function manifestFor(actions: AppAction[]): AppPublishManifest {
  return {
    schema: 'wicked.apps.manifest/v1',
    app: { slug: 'esc', name: 'Escalations', version: 14, tree: 't'.repeat(40), commit: 'c'.repeat(40) },
    targets: ['studio', 'site'],
    site: { origin: 'https://escalations.example.com' },
    identity: { profile: 'oidc', issuer: 'https://dex.apps.test', clientId: 'esc', endpoints: { authorization: 'https://dex.apps.test/auth', token: 'https://dex.apps.test/token' } },
    audience: { kind: 'oidc-groups', groups: ['support-ops'] },
    embedOrigins: [],
    sources: [
      { name: 'support', kind: 'sql', descriptorHash: 'd'.repeat(64), reach: 'db.support.internal:5432', privateAddress: true, env: 'APPS_SRC_SUPPORT_PASSWORD', allowWrites: true },
      { name: 'mail', kind: 'rest', descriptorHash: 'e'.repeat(64), reach: 'https://mail.example.com', privateAddress: false, env: 'APPS_SRC_MAIL_TOKEN', allowWrites: false },
    ],
    queries: [{ id: 'open', source: 'support', public: false }],
    actions: actions.map((a) => ({ id: a.id, kind: a.kind === 'row-write' ? 'row-write' : 'api', source: a.source, grant: { app: 'esc', action: a.id, kind: a.kind === 'row-write' ? 'row-write' : 'api', source: a.source, actionHash: actionHash(a), contractHash: `c-${a.id}`, descriptorHash: 'd'.repeat(64), grantedBy: { id: 'priya', kind: 'human', trust: 'operator' }, grantedAt: 1 } as AppActionGrant, ...(a.kind === 'row-write' ? { table: a.table, columns: Object.keys(a.set ?? {}) } : {}) })),
    env: ['APPS_SRC_MAIL_TOKEN', 'APPS_SRC_SUPPORT_PASSWORD'],
    volume: actions.length > 0 ? '/data' : null,
  };
}

function recordFor(actions: AppAction[], digest: string): PublishRecord {
  const manifest = manifestFor(actions);
  return { runId: 'run-1', slug: 'esc', base: 14, tree: manifest.app.tree, commit: manifest.app.commit, manifest, digest, sources: structuredClone(imageSources) };
}

const okRecheck = async (): Promise<CheckOutcome> => ({ ok: true, lock: structuredClone(EMPTY_LOCK), summary: { level: 'data', checked: [] } });
const okRender = async (input: RenderInput): Promise<RenderResult> => ({ ok: true, report: { pages: [{ page: 'main', width: 1440, shot: 'main.png', errors: [] }], filters: [], actions: Object.keys(input.fixture.cards), errors: [] }, evidence: [{ path: 'out/report.json', base64: Buffer.from('{}').toString('base64') }] });

function depsFor(opts: { actions: AppAction[]; digest: string; rebuiltDigest?: string; rebuild?: PublishCheckDeps['rebuildManifest']; runtime?: PublishCheckDeps['runtime']; render?: PublishCheckDeps['render']; recheck?: PublishCheckDeps['recheck'] }): PublishCheckDeps {
  const spec = specOf(opts.actions);
  const rec = recordFor(opts.actions, opts.digest);
  return {
    publishOf: (runId) => (runId === rec.runId ? rec : null),
    filesOf: async () => filesOf(spec),
    recheck: opts.recheck ?? (async () => ({ ...await okRecheck(), lock: filesOf(spec).lock } as CheckOutcome)),
    rebuildManifest: opts.rebuild ?? (async (r) => ({ ok: true, manifest: r.manifest, sources: r.sources, digest: opts.rebuiltDigest ?? opts.digest })),
    runtime: opts.runtime ?? (() => ({ dir: FIXTURE_DIR, js: 'runtime.js', css: 'runtime.css' })),
    render: opts.render ?? okRender,
  };
}

// ── the manifest-digest guard ────────────────────────────────────────────────────────────────────

describe('the publish check guards the manifest', () => {
  it('fails check_failed manifest_changed when the rebuilt digest differs from the launch', async () => {
    const deps = depsFor({ actions: [ASSIGN], digest: 'a'.repeat(64), rebuiltDigest: 'b'.repeat(64) });
    const r = await publishCheck(deps, { slug: 'esc', runId: 'run-1' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('check_failed');
    expect(r.findings.map((f) => f.code)).toContain('manifest_changed');
  });

  it('passes when the rebuilt digest matches (every rule recorded in the report)', async () => {
    const deps = depsFor({ actions: [ASSIGN], digest: 'a'.repeat(64) });
    const r = await publishCheck(deps, { slug: 'esc', runId: 'run-1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.digest).toBe('a'.repeat(64));
    expect(r.report.rules.map((x) => x.rule)).toEqual(expect.arrayContaining(['turn_check', 'manifest_digest', 'action_cards', 'render']));
    expect(r.card).toContain('Publish Escalations v14');
  });

  it('surfaces the turn check code (source_check_unavailable is never swallowed)', async () => {
    const deps = depsFor({ actions: [ASSIGN], digest: 'a'.repeat(64), recheck: async () => ({ ok: false, code: 'source_check_unavailable', findings: [{ stage: 'source', code: 'source_check_unavailable', path: '$', message: 'no source stage' }] }) });
    const r = await publishCheck(deps, { slug: 'esc', runId: 'run-1' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('source_check_unavailable');
  });
});

// ── a public app with an action fails (the real buildManifest rule, surfaced by the check) ──────────

describe('a public app with an action fails', () => {
  const pg: McpUpstreamConfig = { name: 'support', kind: 'sql', command: null, args: [], url: null, auth: { ref: 'keychain:wicked-mcp/support' }, sql: { driver: 'postgres', host: 'db.support.internal', port: 5432, database: 'support', user: 'writer', tls: 'verify-full' }, address: { allow: ['10.0.0.0/8'], plaintext: false } };

  function publicManifestInput(): ManifestInput {
    const spec = specOf([ASSIGN]);
    const files = filesOf(spec);
    files.lock.sources['support'] = pinOf(pg);
    files.lock.actions['assign'] = { source: 'support', actionHash: actionHash(ASSIGN), contractHash: 'c-assign' };
    return {
      app: { slug: 'esc', name: 'Escalations', version: 14, tree: 't'.repeat(40), commit: 'c'.repeat(40) },
      files,
      body: { base: 14, targets: ['site'], site: { origin: 'https://escalations.example.com' }, identity: null, audience: { kind: 'public' } } as AppPublishBody,
      registry: {
        snapshot: async () => ({ config: pg, enabled: true }),
        source: async () => ({ config: pg, allowWrites: true, description: null, descriptorHash: pinOf(pg).descriptorHash, enabled: true }),
        appTool: async () => null,
        callSecret: async () => ({ secret: 'x', missing: false }),
      } as unknown as ManifestInput['registry'],
      grantOf: () => ({ app: 'esc', action: 'assign', kind: 'row-write', source: 'support', actionHash: actionHash(ASSIGN), contractHash: 'c-assign', descriptorHash: pinOf(pg).descriptorHash, fingerprint: 'fp', grantedBy: { id: 'priya', kind: 'human', trust: 'operator' }, grantedAt: 1 }),
      endpoints: null,
    };
  }

  it('refuses: buildManifest finds public_has_actions and the check answers check_failed', async () => {
    const built = await buildManifest(publicManifestInput());
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.findings.map((f) => f.code)).toContain('public_has_actions');
    const deps = depsFor({ actions: [ASSIGN], digest: 'a'.repeat(64), rebuild: async () => built });
    const r = await publishCheck(deps, { slug: 'esc', runId: 'run-1' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('check_failed');
    expect(r.findings.map((f) => f.code)).toContain('public_has_actions');
  });
});

// ── the fixture cards: one per action, fixture values, no record/rate/source call ──────────────────

describe('the fixture cards', () => {
  it('builds a card per action with fixture values and reads no source, record or rate limit', () => {
    const manifest = manifestFor([ASSIGN, NOTIFY]);
    const row = fixtureCardFor(ASSIGN, manifest, 'esc');
    expect(row.kind).toBe('row-write');
    if (row.kind !== 'row-write') return;
    expect(row.table).toBe('support.tickets');
    expect(row.verb).toBe('UPDATE');
    // The viewer-claim value is the deterministic fixture sample, not a live viewer lookup.
    expect(row.columns.find((c) => c.name === 'owner')).toMatchObject({ value: 'viewer@example.test', from: 'viewer' });
    expect(row.key.find((c) => c.name === 'id')).toMatchObject({ value: 1, from: 'param' });

    const api = fixtureCard(NOTIFY, manifest);
    expect(api.kind).toBe('api');
    if (api.kind !== 'api') return;
    expect(api.sourceKind).toBe('rest'); // taken from the manifest, not a source call
    expect(api.operation).toBe('tool send');
    expect(api.args.find((a) => a.name === 'to')).toMatchObject({ value: 'sample@example.test', from: 'param' });
  });

  it('through publishCheck, every action gets a card passed to the render (no source touched to build them)', async () => {
    let seen: Record<string, unknown> = {};
    const deps = depsFor({
      actions: [ASSIGN, NOTIFY],
      digest: 'a'.repeat(64),
      render: async (input) => {
        seen = input.fixture.cards;
        return okRender(input);
      },
    });
    const r = await publishCheck(deps, { slug: 'esc', runId: 'run-1' });
    expect(r.ok).toBe(true);
    expect(Object.keys(seen).sort()).toEqual(['assign', 'notify']);
  });
});

// ── render unavailable → render_unavailable, never ok ──────────────────────────────────────────────

describe('render unavailable', () => {
  it('no standalone runtime → render_unavailable', async () => {
    const deps = depsFor({ actions: [ASSIGN], digest: 'a'.repeat(64), runtime: () => null });
    const r = await publishCheck(deps, { slug: 'esc', runId: 'run-1' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('render_unavailable');
  });

  it('a render that could not run → render_unavailable, never ok', async () => {
    const deps = depsFor({ actions: [ASSIGN], digest: 'a'.repeat(64), render: async () => ({ ok: false, reason: 'no browser' }) });
    const r = await publishCheck(deps, { slug: 'esc', runId: 'run-1' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('render_unavailable');
    expect(r.findings[0]?.message).toContain('no browser');
  });
});

// ── apps-check --publish: crew-named evidence paths only, a `..` path refused ───────────────────────

describe('evidenceTarget (the CLI evidence-path boundary)', () => {
  it('accepts a crew-named path and refuses a .. hop, an absolute path and odd characters', () => {
    const dir = mkTmp();
    expect(evidenceTarget(dir, 'out/report.json')).toBe(join(dir, 'out', 'report.json'));
    expect(evidenceTarget(dir, 'out/main-page-1440.png')).toBe(join(dir, 'out', 'main-page-1440.png'));
    // The internal hop stays inside the root and requires the explicit segment guard.
    expect(() => evidenceTarget(dir, 'out/../report.json')).toThrow();
    // Also refuse outward traversal.
    expect(() => evidenceTarget(dir, '../escape.png')).toThrow();
    expect(() => evidenceTarget(dir, 'a/../../escape.png')).toThrow();
    expect(() => evidenceTarget(dir, '/etc/passwd')).toThrow();
    expect(() => evidenceTarget(dir, 'Out/Report.JSON')).toThrow(); // upper-case is not crew-named
  });
});

describe('apps-check --publish', () => {
  function io(cwd: string, answer: unknown, status = 200): { io: AppsCheckIo; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    const ioObj: AppsCheckIo = {
      env: { WICKED_MCP_TOKEN: 'tok', WICKED_CREW_URL: 'http://127.0.0.1:1', WICKED_TREE: 'a'.repeat(40) },
      cwd,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      fetch: (async () => ({ ok: status < 400, status, json: async () => answer })) as unknown as typeof fetch,
    };
    return { io: ioObj, out, err };
  }

  it('writes only crew-named evidence under .wicked/publish-check/<digest>/ and exits 0', async () => {
    const cwd = mkTmp();
    const answer = { ok: true, tree: 'a'.repeat(40), digest: 'b'.repeat(64), card: 'Publish X v1', report: { rules: [{ rule: 'render', ok: true }], render: { pages: [{}] } }, evidence: [{ path: 'out/report.json', base64: Buffer.from('{"ok":1}').toString('base64') }] };
    const { io: ioObj, out } = io(cwd, answer);
    const code = await runAppsCheck(['--publish'], ioObj);
    expect(code).toBe(0);
    const dir = join(cwd, '.wicked', 'publish-check', 'b'.repeat(12));
    expect(existsSync(join(dir, 'out', 'report.json'))).toBe(true);
    expect(readFileSync(join(dir, 'out', 'report.json'), 'utf8')).toBe('{"ok":1}');
    expect(out.join('\n')).toContain('evidence written to');
  });

  it('refuses a `..` evidence path (exit 1) and writes nothing outside the evidence dir', async () => {
    const cwd = mkTmp();
    const answer = { ok: true, tree: 'a'.repeat(40), digest: 'b'.repeat(64), report: { rules: [], render: { pages: [] } }, evidence: [{ path: '../escape.png', base64: Buffer.from('x').toString('base64') }] };
    const { io: ioObj, out } = io(cwd, answer);
    const code = await runAppsCheck(['--publish'], ioObj);
    expect(code).toBe(1);
    expect(out.join('\n')).toContain('evidence');
    expect(existsSync(join(cwd, 'escape.png'))).toBe(false);
    expect(existsSync(join(dirname(cwd), 'escape.png'))).toBe(false);
  });

  it('exits 1 with the findings when the publish check refused', async () => {
    const cwd = mkTmp();
    const answer = { ok: false, code: 'check_failed', findings: [{ code: 'manifest_changed', message: 'changed' }] };
    const { io: ioObj, out } = io(cwd, answer);
    const code = await runAppsCheck(['--publish'], ioObj);
    expect(code).toBe(1);
    expect(out.join('\n')).toContain('manifest_changed');
  });
});

// ── the render script + the fake fixture page ──────────────────────────────────────────────────────

/** The conformance venv's Python, if crew has provisioned one on this host (the test env points the var at a stub). */
function conformancePython(): string | null {
  const candidates = [
    process.env['WICKED_EDITOR_CONFORMANCE_PYTHON'] ?? '',
    join(homedir(), 'Library', 'Caches', 'wicked-crew', 'editor-conformance', 'venv-playwright-1.64.0', 'bin', 'python'),
    join(homedir(), '.cache', 'wicked-crew', 'editor-conformance', 'venv-playwright-1.64.0', 'bin', 'python'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

describe('apps-render.py', () => {
  it('refuses bad arguments (exit 2) and a directory missing the fixture files (exit 2)', () => {
    const run = (args: string[]): number => {
      try {
        execFileSync('python3', [RENDER_SCRIPT, ...args], { stdio: 'pipe' });
        return 0;
      } catch (e) {
        return (e as { status?: number }).status ?? -1;
      }
    };
    expect(run([])).toBe(2); // no --dir/--out
    const empty = mkTmp();
    expect(run(['--dir', empty, '--out', join(empty, 'out')])).toBe(2); // dir has none of the fixture assets
  });

  it('reports a missing playwright as exit 3 (the system python3 has none)', () => {
    const dir = mkTmp();
    for (const f of ['runtime.js', 'runtime.css', 'fixture.html', 'fixture.js']) writeFileSync(join(dir, f), readFileSync(join(FIXTURE_DIR, f)));
    writeFileSync(join(dir, 'fixture.json'), JSON.stringify({ spec: specOf([]), cards: {} }));
    let code = 0;
    try {
      execFileSync('python3', [RENDER_SCRIPT, '--dir', dir, '--out', join(dir, 'out')], { stdio: 'pipe' });
    } catch (e) {
      code = (e as { status?: number }).status ?? -1;
    }
    // 3 = no playwright in the system interpreter. If the system python happens to have playwright, it renders (0).
    expect([0, 3]).toContain(code);
  });

  const py = conformancePython();
  (py === null ? it.skip : it)('renders the fake fixture end-to-end with crew\'s conformance Python', async () => {
    const spec = specOf([ASSIGN, NOTIFY], [{ id: 'other', title: 'Other', components: [] }, { id: 'main', title: 'Main', components: [{ id: 'f1', type: 'filter', filter: 'select', box: { x: 0, y: 0, w: 3, h: 1 } }, { id: 'b1', type: 'button', box: { x: 0, y: 1, w: 3, h: 1 }, action: { label: 'Assign', action: 'assign' } }] }] as unknown as AppSpec['pages']);
    const cards = { assign: fixtureCardFor(ASSIGN, manifestFor([ASSIGN]), 'esc'), notify: fixtureCard(NOTIFY) };
    const result = await renderFixture({ runtime: { dir: FIXTURE_DIR, js: readFileSync(join(FIXTURE_DIR, 'runtime.js'), 'utf8'), css: readFileSync(join(FIXTURE_DIR, 'runtime.css'), 'utf8') }, fixture: { spec, cards }, python: py!, scriptPath: RENDER_SCRIPT });
    if (!result.ok) throw new Error(`render failed: ${result.reason}`);
    expect(result.report.pages.filter((p) => 'note' in p && p.note === 'page').map((p) => [p.page, p.width])).toEqual([['other', 1440], ['main', 1440], ['other', 390], ['main', 390]]);
    expect(result.report.filters).toHaveLength(4);
    expect(result.report.actions).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'assign', width: 1440 }), expect.objectContaining({ id: 'notify', width: 1440 }), expect.objectContaining({ id: 'assign', width: 390 }), expect.objectContaining({ id: 'notify', width: 390 })]));
    expect(result.report.pages.map((p) => p.width)).toEqual(expect.arrayContaining([1440, 390]));
    expect(result.evidence.some((e) => e.path === 'out/report.json')).toBe(true);
    expect(result.evidence.some((e) => e.path.endsWith('.png'))).toBe(true);
  }, 200_000);
});

// Keep an explicit touchpoint on the consent card helper so a signature drift is caught.
describe('the consent card', () => {
  it('names the targets, audience, issuer, sources, queries, actions and env', () => {
    const card = consentCard(manifestFor([ASSIGN]));
    expect(card).toContain('Where: studio, site');
    expect(card).toContain('People in group support-ops who sign in at https://dex.apps.test');
    expect(card).toContain('support: sql');
    expect(card).toContain('assign [row-write] on support.tickets');
    expect(card).toContain('APPS_SRC_MAIL_TOKEN');
  });
});


describe('publish review regressions', () => {
  it('runs mandatory driver and allowlisted-server probes without a browser', () => {
    expect(() => execFileSync('python3', [join(HERE, 'support', 'apps-render-probes.py'), RENDER_SCRIPT], { stdio: 'pipe', timeout: 20_000 })).not.toThrow();
  });

  it.each(['sources', 'queries', 'actions'] as const)('refuses a fresh %s contract that differs from the persisted tree', async (part) => {
    const deps = depsFor({ actions: [ASSIGN], digest: 'a'.repeat(64) });
    const files = await deps.filesOf('tree');
    const lock = structuredClone(files.lock);
    if (part === 'sources') lock.sources['support'] = { kind: 'sql', descriptorHash: 'changed' } as typeof lock.sources[string];
    if (part === 'queries') lock.queries['open'] = { contractHash: 'changed' } as typeof lock.queries[string];
    if (part === 'actions') lock.actions['assign']!.contractHash = 'changed';
    deps.recheck = async () => ({ ok: true, lock, summary: { level: 'data', checked: [] } });
    deps.render = vi.fn(okRender);
    const r = await publishCheck(deps, { slug: 'esc', runId: 'run-1' });
    expect(r).toMatchObject({ ok: false, findings: [expect.objectContaining({ code: 'manifest_changed' })] });
    expect(deps.render).not.toHaveBeenCalled();
  });

  it('passes the fresh lock into each manifest rebuild', async () => {
    const deps = depsFor({ actions: [ASSIGN], digest: 'a'.repeat(64) });
    const fresh = (await deps.filesOf('tree')).lock;
    deps.recheck = async () => ({ ok: true, lock: fresh, summary: { level: 'data', checked: [] } });
    const rebuild = vi.fn(deps.rebuildManifest);
    deps.rebuildManifest = rebuild;
    expect((await publishCheck(deps, { slug: 'esc', runId: 'run-1' })).ok).toBe(true);
    expect(rebuild).toHaveBeenCalledTimes(2);
    expect(rebuild.mock.calls.every((call) => call[1] === fresh)).toBe(true);
  });

  it.each(['source', 'grant', 'table'])('refuses a %s change during rendering', async (change) => {
    let rendered = false;
    const deps = depsFor({ actions: [ASSIGN], digest: 'a'.repeat(64), render: async (input) => { rendered = true; return okRender(input); } });
    const recheck = deps.recheck;
    deps.recheck = async (tree) => {
      const r = await recheck(tree);
      if (r.ok && rendered && change === 'table') r.lock.actions['assign']!.contractHash = 'changed';
      return r;
    };
    deps.rebuildManifest = async (rec) => rendered && change === 'grant' ? { ok: false, findings: [{ code: 'not_granted', message: 'revoked during render' }] } : { ok: true, manifest: rec.manifest, sources: rec.sources, digest: rendered && change === 'source' ? 'b'.repeat(64) : rec.digest };
    expect((await publishCheck(deps, { slug: 'esc', runId: 'run-1' })).ok).toBe(false);
  });

  it('binds viewer groups and samples bounded numbers, arrays and strings through live rules', () => {
    const action: AppAction = { ...NOTIFY, args: Object.fromEntries(['groups', 'id', 'tags', 'short', 'long'].map((name) => [name, { kind: 'param', name }])), params: { type: 'object', properties: { groups: { type: 'array', items: { type: 'string' }, from: 'viewer.groups' }, id: { type: 'integer', minimum: 100, maximum: 101 }, tags: { type: 'array', items: { type: 'integer' } }, short: { type: 'string', maxLength: 2 }, long: { type: 'string', minLength: 50 } }, required: ['id', 'tags', 'short', 'long'] } };
    const card = fixtureCard(action);
    expect(card.kind).toBe('api');
    if (card.kind !== 'api') return;
    expect(card.args).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'groups', value: ['support-ops'], from: 'viewer' }), expect.objectContaining({ name: 'id', value: 100 }), expect.objectContaining({ name: 'tags', value: [1] }), expect.objectContaining({ name: 'short', value: 'sa' })]));
    expect(String(card.args.find((a) => a.name === 'long')?.value)).toHaveLength(50);
  });

  it('refuses impossible fixture params before rendering', async () => {
    const action: AppAction = { ...NOTIFY, params: { type: 'object', properties: { to: { type: 'integer', minimum: 1.1, maximum: 1.9 } }, required: ['to'] } };
    const deps = depsFor({ actions: [action], digest: 'a'.repeat(64) });
    deps.render = vi.fn(okRender);
    expect(await publishCheck(deps, { slug: 'esc', runId: 'run-1' })).toMatchObject({ ok: false, findings: [expect.objectContaining({ code: 'fixture_invalid' })] });
    expect(deps.render).not.toHaveBeenCalled();
  });

  it('shows the REST request and automatic idempotency argument with the live presentation builder', () => {
    const sources = structuredClone(imageSources);
    sources.sources['mail']!.tools[0]!.rest = { method: 'POST', pathTemplate: '/send', pathMap: {}, queryMap: {}, headerMap: { idem: 'Idempotency-Key' }, bodyMap: { to: 'recipient', when: 'at' }, bodyArg: null, argAllowlist: ['to', 'when', 'idem'], timeoutMs: 1000 };
    const card = fixtureCard(NOTIFY, manifestFor([NOTIFY]), sources);
    expect(card).toMatchObject({ kind: 'api', operation: 'POST /send', request: expect.stringContaining('POST https://mail.example.com/send') });
    if (card.kind !== 'api') return;
    expect(card.request).toContain('"recipient":"sample@example.test"');
    expect(card.args).toContainEqual(expect.objectContaining({ name: 'idem', from: 'crew', value: '00000000-0000-4000-8000-000000000000' }));
  });

  it('shows the GraphQL request envelope and root field', () => {
    const sources = structuredClone(imageSources);
    sources.sources['mail']!.config.kind = 'graphql';
    const action: AppAction = { ...NOTIFY, call: { kind: 'mutation', mutation: 'mutation($to: String!) { send(to: $to) }' } };
    const card = fixtureCard(action, manifestFor([action]), sources);
    expect(card).toMatchObject({ operation: 'mutation send', request: expect.stringContaining('"variables":{"to":"sample@example.test"') });
    if (card.kind === 'api') expect(card.request).toContain('"query":"mutation');
  });

  it('includes operation, bindings, fixed values and the complete grant in consent text', () => {
    const card = consentCard(manifestFor([ASSIGN]), [ASSIGN], { assign: fixtureCard(ASSIGN) });
    for (const text of ['"op":"update"', '"claim":"email"', '"key"', '"actionHash"', '"contractHash"', '"descriptorHash"', '"grantedAt"']) expect(card).toContain(text);
  });

  it.each(['.wicked', 'publish-check', 'digest', 'out', 'file', 'hardlink'])('replaces %s entries without overwriting an external target', (where) => {
    const root = mkTmp();
    const outside = mkTmp();
    const external = join(outside, 'report.json');
    writeFileSync(external, 'keep');
    const digest = 'b'.repeat(64);
    const parents = ['.wicked', 'publish-check', digest.slice(0, 12), 'out'];
    const at = where === '.wicked' ? 0 : where === 'publish-check' ? 1 : where === 'digest' ? 2 : 3;
    if (where === 'file' || where === 'hardlink') {
      const dir = join(root, ...parents);
      mkdirSync(dir, { recursive: true });
      if (where === 'file') symlinkSync(external, join(dir, 'report.json'));
      else linkSync(external, join(dir, 'report.json'));
    } else {
      mkdirSync(join(root, ...parents.slice(0, at)), { recursive: true });
      symlinkSync(outside, join(root, ...parents.slice(0, at + 1)));
    }
    materializeEvidence(root, digest, [{ path: 'out/report.json', base64: Buffer.from('new').toString('base64') }]);
    expect(readFileSync(external, 'utf8')).toBe('keep');
    expect(readFileSync(join(root, ...parents, 'report.json'), 'utf8')).toBe('new');
  });

  it('preserves unrelated .wicked data and earlier evidence on safe entry replacement', () => {
    const root = mkTmp();
    mkdirSync(join(root, '.wicked', 'publish-check', 'earlier'), { recursive: true });
    writeFileSync(join(root, '.wicked', 'state.json'), 'state');
    writeFileSync(join(root, '.wicked', 'publish-check', 'earlier', 'report.json'), 'earlier');
    materializeEvidence(root, 'b'.repeat(64), [{ path: 'report.json', base64: '' }]);
    expect(readFileSync(join(root, '.wicked', 'state.json'), 'utf8')).toBe('state');
    expect(readFileSync(join(root, '.wicked', 'publish-check', 'earlier', 'report.json'), 'utf8')).toBe('earlier');
  });

  it('rejects invalid and duplicate evidence before replacing any entries', () => {
    const root = mkTmp();
    mkdirSync(join(root, '.wicked'));
    writeFileSync(join(root, '.wicked', 'state'), 'keep');
    for (const evidence of [[{ path: 'out/../x', base64: '' }], [{ path: 'out/x', base64: '' }, { path: 'out/x', base64: '' }]]) {
      expect(() => materializeEvidence(root, 'b'.repeat(64), evidence)).toThrow();
      expect(readFileSync(join(root, '.wicked', 'state'), 'utf8')).toBe('keep');
    }
  });

  it('requires API source and tool metadata instead of inventing a request', () => {
    expect(() => fixtureCardFor(NOTIFY, manifestFor([NOTIFY]), 'esc')).toThrow('no source metadata');
    const sources = structuredClone(imageSources);
    sources.sources['mail']!.tools = [];
    expect(() => fixtureCard(NOTIFY, manifestFor([NOTIFY]), sources)).toThrow('no tool metadata');
  });

  it('bounds formatted email samples and refuses incompatible viewer-bound declarations', () => {
    const action: AppAction = { ...NOTIFY, params: { type: 'object', properties: { to: { type: 'string', format: 'email', maxLength: 8 } }, required: ['to'] } };
    expect(fixtureCard(action)).toMatchObject({ args: expect.arrayContaining([expect.objectContaining({ name: 'to', value: 'aaa@b.co' })]) });
    const invalid: AppAction = { ...NOTIFY, params: { type: 'object', properties: { to: { type: 'integer', from: 'viewer.email' } }, required: ['to'] } };
    expect(() => fixtureCard(invalid)).toThrow('is not a number');
  });

  it.each(['missing-viewport', 'missing-action', 'bad-shot', 'page-error', 'report-error', 'missing-errors', 'extra-entry'] as const)('fails closed on a %s render report', async (failure) => {
    const script = join(mkTmp(), 'render.py');
    const report = { pages: [1440, 390].map((width) => ({ page: 'main', width, shot: `shot-${width}.png`, errors: [] as string[] })), filters: [], actions: [1440, 390].map((width) => ({ id: 'assign', width })), errors: [] as string[] };
    if (failure === 'missing-viewport') report.pages.pop();
    if (failure === 'missing-action') report.actions.pop();
    if (failure === 'bad-shot') report.pages[0]!.shot = '../runtime.js';
    if (failure === 'page-error') report.pages[0]!.errors.push('page failed');
    if (failure === 'report-error') report.errors.push('runtime failed');
    const wire: Record<string, unknown> = { ...report };
    if (failure === 'missing-errors') delete wire['errors'];
    writeFileSync(script, `import json, pathlib, sys
root=pathlib.Path(sys.argv[sys.argv.index('--out')+1])
(root/'report.json').write_text(${JSON.stringify(JSON.stringify(wire))})
(root/'shot-1440.png').write_bytes(b'PNG')
(root/'shot-390.png').write_bytes(b'PNG')
${failure === 'extra-entry' ? "(root/'private.txt').write_text('unexpected')" : ''}
`);
    const result = await renderFixture({ runtime: { dir: FIXTURE_DIR, js: 'real source contents', css: 'real CSS contents' }, fixture: { spec: specOf([ASSIGN], [{ id: 'main', title: 'Main', components: [] }]), cards: { assign: fixtureCard(ASSIGN) } }, python: 'python3', scriptPath: script });
    expect(result.ok).toBe(false);
  });

  it('refuses a missing fixture bootstrap even when the runtime files exist', async () => {
    const dir = mkTmp();
    for (const name of ['runtime.js', 'runtime.css', 'fixture.html']) writeFileSync(join(dir, name), readFileSync(join(FIXTURE_DIR, name)));
    expect(await renderFixture({ runtime: { dir, js: 'contents', css: 'contents' }, fixture: { spec: specOf([]), cards: {} }, python: 'python3', scriptPath: RENDER_SCRIPT })).toMatchObject({ ok: false, reason: 'the standalone runtime has no fixture.js' });
  });

  it('gives publish requests time for both source checks and the whole render', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      await runAppsCheck(['--publish'], { cwd: mkTmp(), env: { WICKED_MCP_TOKEN: 'tok', WICKED_CREW_URL: 'http://127.0.0.1:1', WICKED_TREE: 'a'.repeat(40) }, out: () => {}, err: () => {}, fetch: (async () => ({ ok: true, json: async () => ({ ok: false }) })) as unknown as typeof fetch });
      expect(timeout).toHaveBeenCalledWith(PUBLISH_CHECK_TIMEOUT_MS);
      expect(PUBLISH_CHECK_TIMEOUT_MS).toBeGreaterThan(2 * 120_000 + 180_000);
    } finally { timeout.mockRestore(); }
  });
});
