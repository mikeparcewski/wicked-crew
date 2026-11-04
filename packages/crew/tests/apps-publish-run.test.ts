// (DES-APPS-001 §9.3, slice K6) The publish run's crew side: start (bind the head tree and the manifest, launch with
// the QE exclusion), check (only the run's `check` Tool unit; the manifest must still be the bound one), produce
// (only the `produce` Tool unit; the published receipt and the share link), the routes, and the Teams package. The
// engine is a stand-in launcher; the image build is a stand-in; the app is crew's own store.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { registerAppRoutes } from '../src/apps/routes.js';
import { AppPublishService, consentCard } from '../src/apps/publish/service.js';
import { solidPng, teamsManifest, zip } from '../src/apps/publish/teams.js';
import type { AppPublishBody } from '../src/core/types.js';
import { appsHarness, type Harness, specWith } from './support/apps-harness.js';

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = '99999999-8888-7777-6666-555555555555';

/** The names in a stored zip, read from its central directory. */
function zipNames(buf: Buffer): string[] {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(at)).toBe(0x02014b50);
    const n = buf.readUInt16LE(at + 28);
    names.push(buf.subarray(at + 46, at + 46 + n).toString('utf8'));
    at += 46 + n + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return names;
}

describe('the publish run (crew side)', () => {
  let h: Harness;
  let dir: string;
  const launched: Array<Record<string, unknown>> = [];
  let active = true;
  const units = new Map<string, { runId: string; step: string | null; tool: boolean }>();
  let endpoints = { authorization: 'https://dex.apps.test/auth', token: 'https://dex.apps.test/token' };
  let svc: AppPublishService;
  const built: string[] = [];
  /** The base the engine recorded per run (default: the commit the launcher was handed, as a real launch mints it). */
  const bases = new Map<string, string | null>();
  /** TESTS: hold the image build until released. */
  let holdBuild: Promise<void> | null = null;

  beforeAll(async () => {
    h = await appsHarness();
    dir = mkdtempSync(join(tmpdir(), 'k6-pub-'));
    // A server artifact and a runtime, as crew's dist carries them.
    for (const p of ['art/server/lib/bundle', 'art/runners', 'rt']) mkdirSync(join(dir, p), { recursive: true });
    writeFileSync(join(dir, 'art', 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(join(dir, 'art', 'server', 'lib', 'bundle', 'server.mjs'), '');
    writeFileSync(join(dir, 'art', 'runners', 'sqlite-runner.mjs'), '');
    writeFileSync(join(dir, 'rt', 'runtime.js'), 'var wickedAppsStandalone={};');
    writeFileSync(join(dir, 'rt', 'runtime.css'), ':root{}');
    h.store.publish = {
      launch: async (input) => {
        launched.push(input);
      },
      isActive: async () => active,
    };
    svc = new AppPublishService({
      store: h.store,
      registry: h.registry,
      executor: h.executor,
      writePath: h.writePath,
      unitOf: async (token) => units.get(token) ?? null,
      runBase: async (runId) => (bases.has(runId) ? bases.get(runId)! : ((launched.find((l) => l['runId'] === runId)?.['commit'] as string | undefined) ?? null)),
      discover: async () => endpoints,
      runtimeDir: () => join(dir, 'rt'),
      serverArtifact: () => join(dir, 'art'),
      artifactsDir: join(dir, 'published'),
      build: async (ctx, tag) => {
        // The context crew packed: the product Dockerfile, the site from the tree, no test host build.
        expect(existsSync(join(ctx, 'Dockerfile'))).toBe(true);
        expect(JSON.parse(readFileSync(join(ctx, 'site', 'manifest.json'), 'utf8')).app.slug).toBe('esc');
        if (holdBuild !== null) await holdBuild;
        built.push(tag);
        return { id: `sha256:${'a'.repeat(64)}`, log: 'built' };
      },
    });
    await h.newApp('esc');
    const landed = await h.land('esc', specWith([], [], { name: 'Escalations' }));
    expect(landed.status, JSON.stringify(landed.body)).toBe(200);
  });
  afterAll(async () => {
    await h?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    active = true;
    endpoints = { authorization: 'https://dex.apps.test/auth', token: 'https://dex.apps.test/token' };
  });

  const head = async (): Promise<number> => (await h.store.detail('esc')).head.version;
  const oidcBody = async (extra: Partial<AppPublishBody> = {}): Promise<AppPublishBody> => ({
    base: await head(),
    targets: ['site'],
    site: { origin: 'https://esc.example.com' },
    identity: { profile: 'oidc', issuer: 'https://dex.apps.test', clientId: 'esc-site' },
    audience: { kind: 'oidc-groups', groups: ['support-ops'] },
    ...extra,
  });

  it('start binds the head tree and the manifest, launches apps-publish, and refuses a second while it runs, a stale base and a failing check', async () => {
    const a = await svc.start('esc', await oidcBody(), { id: 'priya', kind: 'human', trust: 'operator' });
    expect(a.runId).toMatch(/^apps-publish-esc-[0-9a-f]{12}$/);
    expect(launched.at(-1)).toMatchObject({ runId: a.runId, app: 'esc', name: 'esc', version: await head(), excludeSeats: [], commit: (await h.store.detail('esc')).versions.at(-1)!.commit });
    expect(h.store.publishingOf(a.runId)?.publishing.digest).toBe(a.manifestDigest);
    await expect(svc.start('esc', await oidcBody(), { id: 'priya', kind: 'human', trust: 'operator' })).rejects.toMatchObject({ status: 409, code: 'publish_in_flight' });
    active = false; // the run ended without producing
    await expect(svc.start('esc', await oidcBody({ base: 1 }), { id: 'priya', kind: 'human', trust: 'operator' })).rejects.toMatchObject({ status: 409, code: 'stale_base' });
    const bad = svc.start('esc', await oidcBody({ targets: ['embed'], embedOrigins: ['https://intranet.example.com'] }), { id: 'priya', kind: 'human', trust: 'operator' });
    await expect(bad).rejects.toMatchObject({ status: 422, code: 'check_failed', findings: [expect.objectContaining({ code: 'embed_needs_public' })] });
  });

  it('check takes only the run`s check Tool unit, answers the consent card, and refuses a manifest that changed since the start', async () => {
    active = false;
    const { runId } = await svc.start('esc', await oidcBody(), { id: 'priya', kind: 'human', trust: 'operator' });
    units.set('tok-check', { runId, step: 'check', tool: true });
    units.set('tok-qe', { runId, step: 'qe', tool: false });
    units.set('tok-other', { runId: 'some-other-run', step: 'check', tool: true });
    await expect(svc.check('nope')).rejects.toMatchObject({ status: 401, code: 'invalid_token' });
    await expect(svc.check('tok-qe')).rejects.toMatchObject({ status: 403, code: 'not_this_step' });
    await expect(svc.check('tok-other')).rejects.toMatchObject({ status: 404, code: 'not_publishing' });
    const ok = await svc.check('tok-check');
    expect(ok.ok).toBe(true);
    expect(ok.card).toContain('Share link: https://esc.example.com/');
    expect(ok.card).toContain('Who can open it: People in group support-ops who sign in at dex.apps.test');
    // The issuer now names other endpoints: what would ship is not what was bound.
    endpoints = { authorization: 'https://dex.apps.test/v2/auth', token: 'https://dex.apps.test/v2/token' };
    const changed = await svc.check('tok-check');
    expect(changed.ok).toBe(false);
    expect(changed.findings.map((f) => f.code)).toContain('manifest_changed');
  });

  it('produce takes only the produce unit, builds, records the published receipt and the share link, and writes the Teams package', async () => {
    active = false;
    const body = await oidcBody({ targets: ['site', 'teams'], identity: { profile: 'entra', issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`, clientId: CLIENT, tenantId: TENANT }, audience: { kind: 'entra-roles', roles: ['Apps.Viewer'] } });
    const { runId, manifestDigest } = await svc.start('esc', body, { id: 'priya', kind: 'human', trust: 'operator' });
    units.set('tok-produce', { runId, step: 'produce', tool: true });
    units.set('tok-check2', { runId, step: 'check', tool: true });
    await expect(svc.produce('tok-check2')).rejects.toMatchObject({ status: 403, code: 'not_this_step' });
    const out = await svc.produce('tok-produce');
    expect(out.published).toMatchObject({ runId, shareUrl: 'https://esc.example.com/', manifestDigest, image: { tag: `wicked-apps/esc:v${await head()}-${runId.slice(-12)}`, id: `sha256:${'a'.repeat(64)}` }, snippet: null, teamsPackage: { url: '/api/v1/apps/esc/published/teams.zip' }, run: { volume: null, port: 8080 } });
    expect(built.at(-1)).toBe(`wicked-apps/esc:v${await head()}-${runId.slice(-12)}`);
    const detail = await h.store.detail('esc');
    expect(detail.published?.shareUrl).toBe('https://esc.example.com/');
    expect(h.store.list()[0]!.published?.version).toBe(detail.head.version);
    expect(detail.versions.at(-1)!.receipt?.kind).not.toBe('published'); // the version keeps its own receipt; the tree gains one
    expect(h.store.publishingOf(runId)).toBeNull();
    // Each produce writes its own run's package (a stale produce never overwrites the record's).
    const pkg = readFileSync(join(dir, 'published', 'esc', runId.slice(-12), 'teams.zip'));
    expect(zipNames(pkg)).toEqual(['manifest.json', 'color.png', 'outline.png']);
    // The same publish cannot produce twice.
    await expect(svc.produce('tok-produce')).rejects.toMatchObject({ code: 'not_publishing' });
  });

  it('check and produce refuse a run the engine did not start on the bound commit (its recorded base), or recorded no base for', async () => {
    active = false;
    const { runId } = await svc.start('esc', await oidcBody(), { id: 'priya', kind: 'human', trust: 'operator' });
    units.set('tok-check-base', { runId, step: 'check', tool: true });
    units.set('tok-produce-base', { runId, step: 'produce', tool: true });
    bases.set(runId, 'f'.repeat(40));
    const moved = await svc.check('tok-check-base');
    expect(moved.ok).toBe(false);
    expect(moved.findings).toContainEqual(expect.objectContaining({ code: 'base_mismatch', message: expect.stringContaining('ffffffffffff') }));
    await expect(svc.produce('tok-produce-base')).rejects.toMatchObject({ status: 409, code: 'base_mismatch' });
    bases.set(runId, null);
    expect((await svc.check('tok-check-base')).findings.map((f) => f.code)).toContain('base_mismatch');
    const before = built.length;
    await expect(svc.produce('tok-produce-base')).rejects.toMatchObject({ code: 'base_mismatch' });
    expect(built.length).toBe(before); // nothing was built
    bases.delete(runId);
    expect((await svc.check('tok-check-base')).ok).toBe(true);
    await h.store.endPublish(runId);
  });

  it('a second produce of the same run while the first builds is refused before it writes anything, and the package served is the recorded one', async () => {
    active = false;
    const body = await oidcBody({ targets: ['site', 'teams'], identity: { profile: 'entra', issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`, clientId: CLIENT, tenantId: TENANT }, audience: { kind: 'entra-roles', roles: ['Apps.Viewer'] } });
    const { runId } = await svc.start('esc', body, { id: 'priya', kind: 'human', trust: 'operator' });
    units.set('tok-produce-twice', { runId, step: 'produce', tool: true });
    let release!: () => void;
    holdBuild = new Promise((r) => (release = r));
    const first = svc.produce('tok-produce-twice');
    await new Promise((r) => setTimeout(r, 20));
    await expect(svc.produce('tok-produce-twice')).rejects.toMatchObject({ status: 409, code: 'produce_in_flight' });
    release();
    holdBuild = null;
    const out = await first;
    const pkg = readFileSync(join(dir, 'published', 'esc', runId.slice(-12), 'teams.zip'));
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(pkg).digest('hex')).toBe(out.published.teamsPackage!.sha256);
    // After it finished, a retry finds the publish ended (and writes nothing either).
    await expect(svc.produce('tok-produce-twice')).rejects.toMatchObject({ code: 'not_publishing' });
    expect(createHash('sha256').update(readFileSync(join(dir, 'published', 'esc', runId.slice(-12), 'teams.zip'))).digest('hex')).toBe(out.published.teamsPackage!.sha256);
  });

  it('a publish starts only with HEAD following main: a HEAD moved elsewhere is re-pointed, one that cannot be is refused with nothing launched', async () => {
    active = false;
    const root = (h.store as unknown as { state: { apps: Record<string, { root: string }> } }).state.apps['esc']!.root;
    const headFile = join(root, '.git', 'HEAD');
    writeFileSync(headFile, 'ref: refs/heads/elsewhere\n');
    const ok = await svc.start('esc', await oidcBody(), { id: 'priya', kind: 'human', trust: 'operator' });
    expect(readFileSync(headFile, 'utf8')).toBe('ref: refs/heads/main\n');
    await h.store.endPublish(ok.runId);
    // HEAD replaced by a directory (it cannot be rewritten): refused, and the launcher was not called.
    rmSync(headFile);
    mkdirSync(join(headFile, 'x'), { recursive: true });
    const count = launched.length;
    try {
      await expect(svc.start('esc', await oidcBody(), { id: 'priya', kind: 'human', trust: 'operator' })).rejects.toMatchObject({ status: 409, code: 'repo_unrepaired' });
      expect(launched.length).toBe(count);
    } finally {
      rmSync(headFile, { recursive: true, force: true });
      writeFileSync(headFile, 'ref: refs/heads/main\n');
    }
  });

  it('a failed image build answers a code (502 image_build_failed), and nothing is published', async () => {
    active = false;
    const { runId } = await svc.start('esc', await oidcBody(), { id: 'priya', kind: 'human', trust: 'operator' });
    units.set('tok-produce-fail', { runId, step: 'produce', tool: true });
    const { ImageBuildError } = await import('../src/apps/publish/image.js');
    const failing = new AppPublishService({ ...(svc as unknown as { deps: ConstructorParameters<typeof AppPublishService>[0] }).deps, build: async () => Promise.reject(new ImageBuildError('build_failed', 'the image build failed (exit 1)', 'step 3/5 failed')) });
    await expect(failing.produce('tok-produce-fail')).rejects.toMatchObject({ status: 502, code: 'image_build_failed' });
    expect(h.store.publishingOf(runId)).not.toBeNull(); // still the run's to retry or end
  });

  it('the routes: publish answers 202 with the run, the Tool routes take a token body only, the Teams package downloads', async () => {
    active = false;
    const app = Fastify({ logger: false });
    registerAppRoutes(app, { store: h.store, audit: new AuditLog(join(dir, 'audit.log'), () => undefined), publish: svc, publishedDir: join(dir, 'published') });
    await app.ready();
    const started = await app.inject({ method: 'POST', url: '/api/v1/apps/esc/publish', payload: await oidcBody() });
    expect(started.statusCode, started.body).toBe(202);
    expect(Object.keys(started.json() as object).sort()).toEqual(['manifestDigest', 'runId']);
    expect((await app.inject({ method: 'POST', url: '/api/v1/apps/esc/publish', payload: { ...(await oidcBody()), extra: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/apps/publish/check', payload: { token: 'x', more: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/apps/publish/check', payload: { token: 'unknown' } })).statusCode).toBe(401);
    const zipAnswer = await app.inject({ method: 'GET', url: '/api/v1/apps/esc/published/teams.zip' });
    expect(zipAnswer.statusCode).toBe(200);
    expect(zipAnswer.headers['content-type']).toBe('application/zip');
    await app.close();
  });
});

describe('the Teams package', () => {
  it('is a zip crew can read back, with a 192 px colour icon and a 32 px outline, and a manifest for the site', () => {
    const png = solidPng(32, [255, 255, 255, 255]);
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(32);
    const z = zip([{ name: 'a.txt', data: Buffer.from('hello') }]);
    expect(z.subarray(0, 2).toString('ascii')).toBe('PK');
    const m = { schema: 'wicked.apps.manifest/v1', app: { slug: 'esc', name: 'Escalations', version: 14, tree: 't', commit: 'c' }, targets: ['studio', 'site', 'teams'], site: { origin: 'https://esc.example.com' }, identity: { profile: 'entra', issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`, clientId: CLIENT, tenantId: TENANT, endpoints: { authorization: 'https://x/a', token: 'https://x/t' } }, audience: { kind: 'entra-roles', roles: ['Apps.Viewer'] }, embedOrigins: [], sources: [], queries: [], actions: [], env: [], volume: null } as never;
    const tm = teamsManifest(m) as { staticTabs: Array<{ contentUrl: string }>; validDomains: string[]; webApplicationInfo: { id: string; resource: string }; id: string; version: string };
    expect(tm.staticTabs[0]!.contentUrl).toBe('https://esc.example.com/');
    expect(tm.validDomains).toEqual(['esc.example.com']);
    expect(tm.webApplicationInfo).toEqual({ id: CLIENT, resource: `api://esc.example.com/${CLIENT}` });
    expect(tm.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(tm.version).toBe('1.1.14');
    expect(teamsManifest(m)).toEqual(tm); // stable: the same app republished keeps its tab
    expect(consentCard(m)).toContain('Framed by: https://teams.microsoft.com');
  });
});
