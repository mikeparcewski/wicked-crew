// (DES-APPS-001 §8.2, §9.3, slice K6) The publish manifest (the deterministic part of the publish check) and the
// site packer, on a stand-in registry: no database, no engine.

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { actionHash, type AppFiles } from '../src/apps/check.js';
import { pinOf } from '../src/apps/exec/sources.js';
import { secretEnvName } from '../src/apps/publish/layout.js';
import { buildManifest, manifestDigest, type ManifestInput, siteOriginProblem } from '../src/apps/publish/manifest.js';
import { PackError, writeImageContext, writeSite } from '../src/apps/publish/pack.js';
import type { AppAction, AppActionGrant, AppPublishBody, AppSpec } from '../src/core/types.js';
import type { McpUpstreamConfig } from '../src/mcp/probe.js';

const pg = (name: string, extra: Partial<McpUpstreamConfig> = {}): McpUpstreamConfig => ({
  name,
  kind: 'sql',
  command: null,
  args: [],
  url: null,
  auth: { ref: `keychain:wicked-mcp/${name}` },
  sql: { driver: 'postgres', host: 'db.support.internal', port: 5432, database: 'support', user: 'writer', tls: 'verify-full' },
  address: { allow: ['10.0.0.0/8'], plaintext: false },
  ...extra,
});

const ASSIGN: AppAction = { id: 'assign', kind: 'row-write', source: 'support', table: 'support.tickets', op: 'update', set: { owner: { kind: 'viewer', claim: 'email' } }, key: { id: { kind: 'param', name: 'id' } }, params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } } as AppAction;

function fixture(opts: { configs?: McpUpstreamConfig[]; actions?: AppAction[]; queries?: AppSpec['queries']; allowWrites?: boolean; grant?: Partial<AppActionGrant> | null } = {}) {
  const configs = opts.configs ?? [pg('support')];
  const queries = opts.queries ?? [{ id: 'open', source: 'support', kind: 'sql', output: [{ name: 'n', type: 'integer' }] }];
  const actions = opts.actions ?? [ASSIGN];
  const spec = { schema: 'wicked.apps/v1', name: 'Escalations', pages: [], queries, actions, linkHosts: [] } as unknown as AppSpec;
  const lock: AppFiles['lock'] = { schema: 'wicked.apps.lock/v1', sources: {}, queries: {}, actions: {}, uploads: {} };
  for (const c of configs) lock.sources[c.name] = pinOf(c);
  for (const q of queries) lock.queries[q.id] = { contractHash: `c-${q.id}` } as never;
  for (const a of actions) lock.actions[a.id] = { actionHash: actionHash(a), contractHash: `c-${a.id}` } as never;
  const registry = {
    snapshot: async (name: string) => {
      const c = configs.find((x) => x.name === name);
      return c === undefined ? null : { config: c, enabled: true };
    },
    source: async (name: string) => {
      const c = configs.find((x) => x.name === name)!;
      return { config: c, allowWrites: opts.allowWrites ?? true, description: null, descriptorHash: pinOf(c).descriptorHash, enabled: true };
    },
    appTool: async () => null,
    callSecret: async () => ({ secret: 'never-read-here', missing: false }),
  };
  const grantOf = (id: string): AppActionGrant | null => {
    if (opts.grant === null) return null;
    const a = actions.find((x) => x.id === id)!;
    return { app: 'esc', action: id, kind: 'row-write', source: a.source, actionHash: actionHash(a), contractHash: `c-${id}`, descriptorHash: lock.sources[a.source]!.descriptorHash, fingerprint: 'fp', grantedBy: { id: 'priya', kind: 'human', trust: 'operator' }, grantedAt: 1, ...(opts.grant ?? {}) };
  };
  const input = (body: Partial<AppPublishBody> = {}): ManifestInput => ({
    app: { slug: 'esc', name: 'Escalations', version: 14, tree: 't'.repeat(40), commit: 'c'.repeat(40) },
    files: { spec, queryText: Object.fromEntries(queries.map((q) => [q.id, 'SELECT 1 AS n'])), lock },
    body: {
      base: 14,
      targets: ['site'],
      site: { origin: 'https://escalations.example.com' },
      identity: { profile: 'oidc', issuer: 'https://dex.apps.test', clientId: 'esc' },
      audience: { kind: 'oidc-groups', groups: ['support-ops'] },
      ...body,
    },
    registry,
    grantOf,
    endpoints: { authorization: 'https://dex.apps.test/auth', token: 'https://dex.apps.test/token' },
  });
  return { input, spec, lock };
}

const codes = async (i: ManifestInput): Promise<string[]> => {
  const r = await buildManifest(i);
  return r.ok ? [] : r.findings.map((f) => f.code);
};

describe('the publish manifest', () => {
  it('binds the app, the site origin (the share link), the issuer with its endpoints, the sources, the grants and the environment names', async () => {
    const { input } = fixture();
    const r = await buildManifest(input());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest).toMatchObject({
      schema: 'wicked.apps.manifest/v1',
      app: { slug: 'esc', version: 14 },
      targets: ['studio', 'site'],
      site: { origin: 'https://escalations.example.com' },
      identity: { issuer: 'https://dex.apps.test', endpoints: { token: 'https://dex.apps.test/token' } },
      env: ['APPS_SRC_SUPPORT_PASSWORD'],
      volume: '/data',
      sources: [{ name: 'support', reach: 'db.support.internal:5432', privateAddress: true, env: 'APPS_SRC_SUPPORT_PASSWORD', allowWrites: true }],
      actions: [{ id: 'assign', kind: 'row-write', table: 'support.tickets', columns: ['owner'] }],
    });
    // The config ships as crew holds it: the secret REFERENCE (part of the descriptor hash), never a secret.
    expect(r.sources.sources['support']!.config.auth).toEqual({ ref: 'keychain:wicked-mcp/support' });
    expect(JSON.stringify([r.manifest, r.sources])).not.toContain('never-read-here');
    expect(r.digest).toBe(manifestDigest(r.manifest));
  });

  it('refuses a site address that is not a bare https origin (http only for localhost)', () => {
    expect(siteOriginProblem('https://a.example.com')).toBeNull();
    expect(siteOriginProblem('http://localhost:8080')).toBeNull();
    expect(siteOriginProblem('http://127.0.0.1:8443')).toBeNull();
    for (const bad of ['http://a.example.com', 'https://a.example.com/app', 'https://a.example.com?x=1', 'https://u:p@a.example.com', 'ftp://a', 'nope']) expect(siteOriginProblem(bad), bad).not.toBeNull();
  });

  it('names what an image cannot carry: the crew source and a local MCP server, with what uses them', async () => {
    const crewQ = { id: 'runs', source: 'crew', kind: 'crew', output: [{ name: 'id', type: 'string' }] } as AppSpec['queries'][number];
    const stdio: McpUpstreamConfig = { name: 'local', kind: 'mcp-stdio', command: 'node', args: ['x.js'], url: null, auth: null };
    const toolQ = { id: 'local_q', source: 'local', kind: 'mcp', output: [{ name: 'a', type: 'string' }] } as AppSpec['queries'][number];
    const { input } = fixture({ configs: [pg('support'), stdio], queries: [crewQ, toolQ], actions: [] });
    const r = await buildManifest(input());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.findings.filter((f) => f.code === 'blocked_source').map((f) => f.message).join(' ')).toMatch(/crew source.*query runs[\s\S]*local MCP server: remove query local_q/);
  });

  it('(DES-KNOWLEDGE-DATA-001 §9.1) refuses a knowledge query: recall is studio-hosted only in v1', async () => {
    const recallQ = { id: 'rules', source: 'estate', kind: 'recall', output: [{ name: 'title', type: 'string' }] } as AppSpec['queries'][number];
    const { input } = fixture({ queries: [recallQ], actions: [] });
    const r = await buildManifest(input());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const blocked = r.findings.filter((f) => f.code === 'blocked_source').map((f) => f.message).join(' ');
    expect(blocked).toMatch(/system's knowledge.*remove query rules/);
    expect(r.findings.map((f) => f.code)).not.toContain('unknown_source');
  });

  it('targets and audience fit: embed is public only, Teams needs Entra, a public app holds no action and only public queries', async () => {
    const { input } = fixture();
    expect(await codes(input({ targets: ['embed'], embedOrigins: ['https://intranet.example.com'] }))).toContain('embed_needs_public');
    expect(await codes(input({ targets: ['teams'] }))).toContain('teams_needs_entra');
    const pub = await codes(input({ targets: ['embed'], embedOrigins: ['https://intranet.example.com'], identity: null, audience: { kind: 'public' } }));
    expect(pub).toEqual(expect.arrayContaining(['public_has_actions', 'public_queries']));
    expect(await codes(input({ targets: ['embed'], embedOrigins: ['http://intranet.example.com'], identity: null, audience: { kind: 'public' } }))).toContain('embed_origins');
    expect(await codes(input({ identity: null }))).toContain('identity');
    expect(await codes(input({ audience: { kind: 'oidc-groups', groups: [] } }))).toContain('audience');
    expect(await codes(input({ identity: { profile: 'entra', issuer: 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0', clientId: 'c', tenantId: '99999999-2222-3333-4444-555555555555' }, audience: { kind: 'entra-roles', roles: ['Apps.Viewer'] } }))).toContain('identity');
  });

  it('every action needs a grant bound to its current hashes, and a row write needs Allow writes on', async () => {
    expect(await codes(fixture({ grant: null }).input())).toContain('not_granted');
    expect(await codes(fixture({ grant: { contractHash: 'old' } }).input())).toContain('not_granted');
    expect(await codes(fixture({ grant: { descriptorHash: 'old' } }).input())).toContain('not_granted');
    expect(await codes(fixture({ allowWrites: false }).input())).toContain('writes_off');
  });

  it('a source switched off is refused (publishing never turns it back on), and a sign-in scope without openid is refused', async () => {
    const { input } = fixture();
    const off = input();
    const reg = off.registry!;
    off.registry = { ...reg, source: async (n: string) => ({ ...(await reg.source(n)), enabled: false }) };
    expect(await codes(off)).toContain('source_off');
    expect(await codes(input({ identity: { profile: 'oidc', issuer: 'https://dex.apps.test', clientId: 'esc', scope: 'email profile' } }))).toContain('identity');
    expect(await codes(input({ identity: { profile: 'oidc', issuer: 'https://dex.apps.test', clientId: 'esc', scope: 'openid email' } }))).toEqual([]);
  });

  it('two sources whose secrets would share one environment name are refused', async () => {
    const a = pg('support-pg');
    const b = pg('support_pg');
    expect(secretEnvName(a)).toBe(secretEnvName(b));
    const q = (id: string, source: string) => ({ id, source, kind: 'sql', output: [{ name: 'n', type: 'integer' }] }) as AppSpec['queries'][number];
    expect(await codes(fixture({ configs: [a, b], queries: [q('one', 'support-pg'), q('two', 'support_pg')], actions: [] }).input())).toContain('env_collision');
  });
});

describe('the site packer', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('writes the layout the server reads, verifies each snapshot against its digest, and names files only from checked ids', async () => {
    const { input, spec, lock } = fixture({ actions: [] });
    const r = await buildManifest(input());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const site = mkdtempSync(join(tmpdir(), 'k6-site-'));
    const snaps = mkdtempSync(join(tmpdir(), 'k6-snap-'));
    dirs.push(site, snaps);
    const base = { spec, specText: JSON.stringify(spec), lockText: JSON.stringify(lock), queryText: { open: 'SELECT 1 AS n' }, manifest: r.manifest, sources: r.sources, runtime: { js: 'var wickedAppsStandalone={};', css: ':root{}' }, snapshotDir: snaps };
    const digests = writeSite(site, base);
    for (const f of ['apps.json', 'apps.lock.json', 'queries/open.sql', 'manifest.json', 'sources.json', 'runtime/runtime.js', 'runtime/runtime.css']) expect(existsSync(join(site, f)), f).toBe(true);
    expect(digests['queries/open.sql']).toBe(createHash('sha256').update('SELECT 1 AS n').digest('hex'));
    // A snapshot whose bytes no longer match its digest is refused.
    const bytes = Buffer.from('SQLite format 3\u0000 rows');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const withSnap = { ...r.manifest, sources: [...r.manifest.sources, { name: 'refunds', kind: 'sql' as const, descriptorHash: 'd', reach: null, privateAddress: false, env: null, allowWrites: false, snapshot: digest }] };
    expect(() => writeSite(mkdtempSync(join(tmpdir(), 'k6-site-')), { ...base, manifest: withSnap })).toThrow(PackError);
    writeFileSync(join(snaps, `${digest}.sqlite`), Buffer.from('tampered'));
    expect(() => writeSite(mkdtempSync(join(tmpdir(), 'k6-site-')), { ...base, manifest: withSnap })).toThrow(/does not match its digest/);
    writeFileSync(join(snaps, `${digest}.sqlite`), bytes);
    const ok = mkdtempSync(join(tmpdir(), 'k6-site-'));
    dirs.push(ok);
    writeSite(ok, { ...base, manifest: withSnap });
    expect(readFileSync(join(ok, 'snapshots', `${digest}.sqlite`))).toEqual(bytes);
    // The whole context: the product Dockerfile, the server and runners, and never the host's TEST build.
    const art = mkdtempSync(join(tmpdir(), 'k6-art-'));
    const ctx = mkdtempSync(join(tmpdir(), 'k6-ctx-'));
    dirs.push(art, ctx);
    for (const [f, t] of [['Dockerfile', 'FROM scratch\n'], ['server/shim/host.js', 'h'], ['server/shim/host.test.js', 'seam'], ['runners/sqlite-runner.mjs', 'r']] as const) {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(art, f, '..'), { recursive: true });
      writeFileSync(join(art, f), t);
    }
    writeImageContext(ctx, { ...base, serverArtifact: art });
    expect(existsSync(join(ctx, 'Dockerfile'))).toBe(true);
    expect(existsSync(join(ctx, 'server', 'shim', 'host.js'))).toBe(true);
    expect(existsSync(join(ctx, 'server', 'shim', 'host.test.js'))).toBe(false);
    expect(existsSync(join(ctx, 'site', 'manifest.json'))).toBe(true);
    // A query id that could name a path outside queries/ never reaches the file system.
    const evil = { ...spec, queries: [{ ...spec.queries[0]!, id: '../../escape' }] };
    expect(() => writeSite(mkdtempSync(join(tmpdir(), 'k6-site-')), { ...base, spec: evil, queryText: { '../../escape': 'x' } })).toThrow(/cannot name a file/);
  });
});
