// CS2-P1: real app objects and persistence, a scripted engine and a mocked image builder (never Docker).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppGit } from '../src/apps/git.js';
import { EMPTY_LOCK, lockBytes, specBytes, type AppSourceStage } from '../src/apps/check.js';
import { AppStore } from '../src/apps/store.js';
import { publishCheck } from '../src/apps/publish/check.js';
import { appsRuntime, appsServerArtifact } from '../src/apps/publish/artifacts.js';
import { buildImage } from '../src/apps/publish/image.js';
import { writeImageContext } from '../src/apps/publish/pack.js';
import { publishEndpoints } from '../src/apps/publish/run.js';
import { runAppsProduce } from '../src/cli/apps-produce.js';
import { dialFetch } from '../src/sources/dialer.js';
import type { AppPublishBody, LaunchRunInput, SessionView } from '../src/core/types.js';
import { appsHarness, PRIYA, specWith, type Harness } from './support/apps-harness.js';
import { updateAction } from './support/apps-writes.js';

vi.mock('../src/apps/publish/check.js', () => ({ publishCheck: vi.fn() }));
vi.mock('../src/apps/publish/artifacts.js', () => ({ appsRuntime: vi.fn(), appsServerArtifact: vi.fn() }));
vi.mock('../src/apps/publish/image.js', () => ({ buildImage: vi.fn(), ImageBuildError: class extends Error {} }));
vi.mock('../src/apps/publish/pack.js', () => ({ writeImageContext: vi.fn(), PackError: class extends Error {} }));
vi.mock('../src/sources/dialer.js', async (original) => ({ ...await original<object>(), dialFetch: vi.fn() }));

const rigs: Harness[] = [];
afterEach(async () => {
  for (const h of rigs.splice(0)) await h.close();
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(buildImage).mockResolvedValue({ id: `sha256:${'a'.repeat(64)}`, log: '' });
  vi.mocked(appsServerArtifact).mockReturnValue('/product/apps-server');
  vi.mocked(appsRuntime).mockReturnValue({ dir: '/product/runtime', js: 'runtime-js', css: 'runtime-css' });
  vi.mocked(writeImageContext).mockReturnValue({});
  vi.mocked(publishCheck).mockResolvedValue({ ok: false, code: 'render_unavailable', findings: [] });
  vi.mocked(dialFetch).mockImplementation(async () => new Response(JSON.stringify({ issuer: 'https://issuer.example.com', authorization_endpoint: 'https://issuer.example.com/auth', token_endpoint: 'https://issuer.example.com/token' })));
});

const body = (base = 1, extra: Partial<AppPublishBody> = {}): AppPublishBody => ({ base, targets: ['site'], site: { origin: 'http://localhost:8080' }, identity: null, audience: { kind: 'public' }, ...extra });

async function rig() {
  const launched: LaunchRunInput[] = [];
  const states = new Map<string, string>();
  const tokens: Record<string, { runId: string; phase: string }> = {};
  let refusal: string | null = null;
  const h = await appsHarness({ routes: {
    verifyUnitToken: async (token) => tokens[token] ?? null,
    publish: {
      registry: null, grantOf: () => null, roster: async () => '[{"key":"judge"}]',
      engine: {
        launchRun: async (input) => {
          expect(h.store.publishOf(input.sessionId)).not.toBeNull();
          launched.push(input);
          if (refusal !== null) throw new Error(refusal);
          states.set(input.sessionId, 'executing');
          return input.sessionId;
        },
        sessionsDetail: async () => [...states].map(([id, status]) => ({ session: { id, status }, units: [] }) as unknown as SessionView),
      },
    },
  } });
  rigs.push(h);
  h.store.turns = { launch: async () => undefined, isActive: async () => true };
  await h.newApp('desk');
  const publish = async (b?: AppPublishBody) => {
    const r = await h.call('POST', '/apps/desk/publish', b ?? body((await h.store.detail('desk')).head.version));
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    return r.body as unknown as { runId: string; manifestDigest: string };
  };
  const produce = async (runId: string) => {
    const token = `produce-${runId}`;
    tokens[token] = { runId, phase: 'produce' };
    return h.app.inject({ method: 'POST', url: '/api/v1/apps/produce', payload: { token } });
  };
  return { h, launched, tokens, states, publish, produce, refuse: (message: string) => { refusal = message; } };
}

/** Land a real checked/reviewed turn, with a distinct tree each time. */
async function reviewed(h: Harness, builder: string) {
  const head = (await h.store.detail('desk')).head.version;
  const t = await h.store.beginTurn('desk', { base: head, actor: PRIYA, message: 'Change the page', about: [] });
  const git = new AppGit(join(h.dir, 'apps', 'desk'));
  const tree = await git.mktree([
    { name: 'apps.json', mode: '100644', type: 'blob', sha: await git.writeBlob(specBytes(specWith([], [], { name: `Version ${head + 1}` }))) },
    { name: 'apps.lock.json', mode: '100644', type: 'blob', sha: await git.writeBlob(lockBytes(EMPTY_LOCK)) },
  ]);
  const check = await h.store.checkTurn('desk', t.runId, { tree });
  expect(check.ok).toBe(true);
  if (!check.ok) throw new Error('turn check failed');
  await h.store.landTurn('desk', { runId: t.runId, commit: check.commit, builder, reviewer: 'judge', summary: 'Changed the page' });
}

describe('publish runs', () => {
  it('answers 202, persists the exact manifest before launch and excludes every builder since the last publish', async () => {
    const r = await rig();
    await reviewed(r.h, 'alpha');
    await reviewed(r.h, 'beta');
    const p = await r.publish();
    const saved = JSON.parse(readFileSync(r.h.store.stateFile, 'utf8')).apps.desk.publishes[p.runId];
    expect(saved).toMatchObject({ runId: p.runId, base: 3, state: 'running', digest: p.manifestDigest, launchedBy: PRIYA, body: body(3) });
    expect(r.h.store.publishOf(p.runId)).toEqual(saved);
    expect(r.h.store.publishRunApp(p.runId)).toBe('desk');
    expect(r.launched[0]).toMatchObject({ sessionId: p.runId, workflow: 'apps-publish', repoRef: 'desk', projectId: 'p1', humanConfirm: 'none', excludeSeats: ['alpha', 'beta'] });
    for (const text of ['desk', 'v3', saved.tree, saved.digest, 'Anyone (public)']) expect(r.launched[0]!.problem).toContain(text);
    expect((await r.produce(p.runId)).statusCode).toBe(200);
    await reviewed(r.h, 'gamma');
    await r.publish();
    expect(r.launched[1]!.excludeSeats).toEqual(['gamma']);
  });

  it('refuses a stale base and an unaccepted head before launching', async () => {
    const r = await rig();
    await reviewed(r.h, 'alpha');
    expect(await r.h.call('POST', '/apps/desk/publish', body(1))).toMatchObject({ status: 409, body: { code: 'stale_base' } });
    await r.h.store.create({ slug: 'unaccepted', name: 'Unaccepted', projectId: 'p1', actor: { id: 'seat', kind: 'agent', trust: 'operator' } });
    expect(await r.h.call('POST', '/apps/unaccepted/publish', body())).toMatchObject({ status: 409, body: { code: 'not_accepted' } });
    expect(r.launched).toHaveLength(0);
  });

  it('refuses public apps with an action with 422 findings', async () => {
    const r = await rig();
    const action = updateAction('assign', 'support', 'support.tickets', { owner: { kind: 'literal', value: 'a' } });
    const stage: AppSourceStage = { check: async () => ({ findings: [], sources: { support: { kind: 'sql', descriptor: {}, descriptorHash: 'd' } }, queries: {}, actions: { assign: 'contract' }, uploads: {} }) };
    r.h.store.sourceStage = stage;
    const landed = await r.h.land('desk', specWith([], [action]));
    expect(landed.status, JSON.stringify(landed.body)).toBe(200);
    const response = await r.h.call('POST', '/apps/desk/publish', body(2));
    expect(response).toMatchObject({ status: 422, body: { code: 'publish_refused', findings: expect.arrayContaining([expect.objectContaining({ code: 'public_has_actions' })]) } });
    expect(r.launched).toHaveLength(0);
  });

  it('refuses teams and an agent-kind operator', async () => {
    const r = await rig();
    expect(await r.h.call('POST', '/apps/desk/publish', body(1, { targets: ['teams'] }))).toMatchObject({ status: 400, body: { code: 'teams_not_offered' } });
    expect(await r.h.call('POST', '/apps/desk/publish', body(), 'seat')).toMatchObject({ status: 403, body: { code: 'human_only' } });
    expect(r.launched).toHaveLength(0);
  });

  it('refuses an archived app or an unavailable publisher, and reserves the worker route slug', async () => {
    const r = await rig();
    const publisher = r.h.store.publisher;
    r.h.store.publisher = null;
    expect(await r.h.call('POST', '/apps/desk/publish', body())).toMatchObject({ status: 503, body: { code: 'apps_unavailable' } });
    r.h.store.publisher = publisher;
    await r.h.store.archive('desk', { actor: PRIYA });
    expect(await r.h.call('POST', '/apps/desk/publish', body())).toMatchObject({ status: 409, body: { code: 'app_archived' } });
    expect(await r.h.call('POST', '/apps', { slug: 'produce', projectId: 'p1' })).toMatchObject({ status: 422, body: { code: 'reserved_slug' } });
    expect(r.launched).toHaveLength(0);
  });

  it('holds the app while a publish runs, and refuses publishing while a turn runs', async () => {
    const r = await rig();
    const p = await r.publish();
    expect(await r.h.call('POST', '/apps/desk/publish', body())).toMatchObject({ status: 409, body: { code: 'busy' } });
    expect(await r.h.call('POST', '/apps/desk/turns', { base: 1, message: 'Change it' })).toMatchObject({ status: 409, body: { code: 'busy' } });
    expect(await r.h.land('desk', specWith([]))).toMatchObject({ status: 409, body: { code: 'busy' } });
    r.states.set(p.runId, 'cancelled');
    const t = await r.h.store.beginTurn('desk', { base: 1, message: 'Change it', actor: PRIYA, about: [] });
    expect(r.h.store.publishOf(p.runId)?.state).toBe('cancelled');
    expect(await r.h.call('POST', '/apps/desk/publish', body())).toMatchObject({ status: 409, body: { code: 'busy' } });
    await r.h.store.endTurn('desk', t.runId);
  });

  it.each(['every seat is a builder', 'QE skip is refused'])('passes through an engine refusal: %s', async (reason) => {
    const r = await rig();
    r.refuse(reason);
    expect(await r.h.call('POST', '/apps/desk/publish', body())).toMatchObject({ status: 409, body: { code: 'launch_refused', error: reason } });
    expect(r.h.store.publishOf(r.launched[0]!.sessionId)?.state).toBe('failed');
  });

  it('a second audience on the same tree gets its own new run and persisted manifest', async () => {
    const r = await rig();
    const first = await r.publish();
    expect((await r.produce(first.runId)).statusCode).toBe(200);
    const second = await r.publish(body(1, { identity: { profile: 'oidc', issuer: 'https://issuer.example.com', clientId: 'desk' }, audience: { kind: 'oidc-groups', groups: ['operators'] } }));
    expect(second.runId).not.toBe(first.runId);
    expect(second.manifestDigest).not.toBe(first.manifestDigest);
    const a = r.h.store.publishOf(first.runId)!;
    const b = r.h.store.publishOf(second.runId)!;
    expect(b.tree).toBe(a.tree);
    expect(a.state).toBe('published');
    expect(b.state).toBe('running');
    expect(b.published).toBeUndefined();
    expect(r.launched).toHaveLength(2);
    expect((await r.produce(second.runId)).statusCode).toBe(200);
    expect(buildImage).toHaveBeenCalledTimes(2);
  });

  it('the store hands the real publish check its persisted publish, a no-land recheck and a same-digest rebuild (lane glue)', async () => {
    const r = await rig();
    const p = await r.publish();
    const deps = r.h.store.publishCheckDeps('desk');
    const rec = deps.publishOf(p.runId)!;
    expect(rec).toMatchObject({ runId: p.runId, slug: 'desk', digest: p.manifestDigest });
    expect(r.h.store.publishCheckDeps('other').publishOf(p.runId)).toBeNull();
    const head = (await r.h.store.detail('desk')).head;
    const rebuilt = await deps.rebuildManifest(rec, (await deps.filesOf(rec.tree)).lock);
    expect(rebuilt.ok && rebuilt.digest).toBe(p.manifestDigest);
    const outcome = await deps.recheck(rec.tree);
    expect(outcome.ok).toBe(true);
    // The recheck lands nothing: the head is unchanged.
    expect((await r.h.store.detail('desk')).head).toEqual(head);
  });

  it('routes a publish check to publishCheck and a turn check to checkTurn', async () => {
    const r = await rig();
    const p = await r.publish();
    r.tokens.check = { runId: p.runId, phase: 'check' };
    const tree = r.h.store.publishOf(p.runId)!.tree;
    const check = await r.h.app.inject({ method: 'POST', url: '/api/v1/apps/check', payload: { token: 'check', tree } });
    expect(check.statusCode).toBe(200);
    expect(publishCheck).toHaveBeenCalledWith(expect.objectContaining({ publishOf: expect.any(Function), recheck: expect.any(Function), rebuildManifest: expect.any(Function) }), { slug: 'desk', runId: p.runId });
    r.states.set(p.runId, 'failed');
    const t = await r.h.store.beginTurn('desk', { base: 1, message: 'Change it', actor: PRIYA, about: [] });
    r.tokens.turncheck = { runId: t.runId, phase: 'check' };
    const spy = vi.spyOn(r.h.store, 'checkTurn');
    const turn = await r.h.app.inject({ method: 'POST', url: '/api/v1/apps/check', payload: { token: 'turncheck', tree } });
    expect(turn.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith('desk', t.runId, { tree });
    expect(publishCheck).toHaveBeenCalledTimes(1);
  });

  it('refuses a publish check unit at produce (phase guard regression)', async () => {
    const r = await rig();
    const p = await r.publish();
    r.tokens.check = { runId: p.runId, phase: 'check' };
    const res = await r.h.app.inject({ method: 'POST', url: '/api/v1/apps/produce', payload: { token: 'check' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'not_the_produce' });
    expect(buildImage).not.toHaveBeenCalled();
  });

  it('refuses another run\'s produce unit and a turn\'s unit', async () => {
    const r = await rig();
    await r.publish();
    r.tokens.other = { runId: 'other-run', phase: 'produce' };
    await r.h.newApp('other');
    const t = await r.h.store.beginTurn('other', { base: 1, actor: PRIYA, message: 'Change it', about: [] });
    r.tokens.turn = { runId: t.runId, phase: 'produce' };
    for (const token of ['other', 'turn']) {
      const res = await r.h.app.inject({ method: 'POST', url: '/api/v1/apps/produce', payload: { token } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'not_the_produce' });
    }
    expect(buildImage).not.toHaveBeenCalled();
  });

  it('builds from persisted git objects and manifest once per run/digest, including concurrent calls and a restart', async () => {
    const r = await rig();
    const p = await r.publish(body(1, { targets: ['site', 'embed'], embedOrigins: ['https://embed.example.com'] }));
    const saved = r.h.store.publishOf(p.runId)!;
    // Worktree text never supplies the build context.
    writeFileSync(join(r.h.dir, 'apps', 'desk', 'apps.json'), 'untrusted worktree text');
    const responses = await Promise.all([r.produce(p.runId), r.produce(p.runId)]);
    expect(responses.map((res) => res.statusCode)).toEqual([200, 200]);
    const published = responses[0]!.json().published;
    expect(responses[1]!.json().published).toEqual(published);
    expect(buildImage).toHaveBeenCalledTimes(1);
    expect(buildImage).toHaveBeenCalledWith(expect.any(String), `wicked-apps/desk:v1-${p.manifestDigest.slice(0, 12)}`, { 'org.wicked.apps.manifest': p.manifestDigest, 'org.wicked.apps.run': p.runId });
    expect(writeImageContext).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ manifest: saved.manifest, sources: saved.sources, specText: expect.stringContaining('wicked.apps/v1'), runtime: { dir: '/product/runtime', js: 'runtime-js', css: 'runtime-css' } }));
    expect(published).toMatchObject({ shareUrl: 'http://localhost:8080/', snippet: '<iframe src="http://localhost:8080/" title="desk"></iframe>', teamsPackage: null, manifestDigest: p.manifestDigest, run: { env: [], volume: null, port: 8080 } });
    expect(r.h.store.list()[0]!.published).toEqual(published);
    const state = JSON.parse(readFileSync(r.h.store.stateFile, 'utf8'));
    expect(state.apps.desk.receipts[saved.tree].filter((receipt: { kind: string }) => receipt.kind === 'published')).toEqual([expect.objectContaining({ publish: { runId: p.runId, manifestDigest: p.manifestDigest, artifacts: { image: published.image.id } } })]);
    const reloaded = new AppStore({ stateFile: r.h.store.stateFile, appsRoot: r.h.store.appsRoot, registry: { register: async () => { throw new Error('unused'); }, idTaken: async () => false } });
    expect(await reloaded.producePublish(p.runId, async () => { throw new Error('must not build again'); })).toEqual(published);
  });

  it('admits produce by unit token with operator auth on, while every operator route still requires a bearer', async () => {
    const r = await rig();
    const p = await r.publish();
    expect((await r.produce(p.runId)).statusCode).toBe(200);
    for (const [method, url, payload] of [['GET', '/apps/desk', undefined], ['GET', '/apps', undefined], ['POST', '/apps/desk/publish', body()], ['POST', '/apps/desk/turns', { base: 1, message: 'change it' }]] as const) {
      expect((await r.h.app.inject({ method, url: `/api/v1${url}`, ...(payload === undefined ? {} : { payload }) })).statusCode).toBe(401);
    }
    const invalid = await r.h.app.inject({ method: 'POST', url: '/api/v1/apps/produce', payload: { token: 'invalid' } });
    expect(invalid.statusCode).toBe(401);
  });

  it('refuses malformed worker bodies or an unavailable verifier', async () => {
    const r = await rig();
    for (const payload of [{}, { token: 'unit', manifest: {} }]) {
      const res = await r.h.app.inject({ method: 'POST', url: '/api/v1/apps/produce', payload });
      expect(res.statusCode).toBe(400);
    }
    expect(await r.h.call('POST', '/apps/desk/publish', {})).toMatchObject({ status: 400, body: { code: 'bad_request' } });
    const h = await appsHarness();
    rigs.push(h);
    const unavailable = await h.app.inject({ method: 'POST', url: '/api/v1/apps/produce', payload: { token: 'unit' } });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ code: 'apps_unavailable' });
  });

  it('fails closed without artifacts or on a failed run, without building', async () => {
    const r = await rig();
    const p = await r.publish();
    vi.mocked(appsRuntime).mockReturnValue(null);
    expect((await r.produce(p.runId)).statusCode).toBe(503);
    vi.mocked(appsRuntime).mockReturnValue({ dir: '/product/runtime', js: 'js', css: 'css' });
    vi.mocked(appsServerArtifact).mockReturnValue(null);
    expect((await r.produce(p.runId)).statusCode).toBe(503);
    r.states.set(p.runId, 'failed');
    await r.h.store.beginTurn('desk', { base: 1, message: 'change', about: [], actor: PRIYA });
    expect((await r.produce(p.runId)).statusCode).toBe(403);
    expect(buildImage).not.toHaveBeenCalled();
  });
});

describe('publish discovery and produce CLI', () => {
  it('uses bounded dialer discovery, refuses mismatched or insecure endpoints, and handles failure', async () => {
    const identity = { profile: 'oidc' as const, issuer: 'https://issuer.example.com', clientId: 'desk' };
    expect(await publishEndpoints(identity)).toMatchObject({ token: 'https://issuer.example.com/token' });
    expect(dialFetch).toHaveBeenCalledWith('https://issuer.example.com/.well-known/openid-configuration', expect.objectContaining({ signal: expect.any(AbortSignal) }), { allow: [], plaintext: false });
    for (const doc of [
      { issuer: 'https://other.example.com', authorization_endpoint: 'https://issuer.example.com/auth', token_endpoint: 'https://issuer.example.com/token' },
      { issuer: identity.issuer, authorization_endpoint: 'http://issuer.example.com/auth', token_endpoint: 'https://issuer.example.com/token' },
      { issuer: identity.issuer },
    ]) {
      vi.mocked(dialFetch).mockResolvedValueOnce(new Response(JSON.stringify(doc)));
      expect(await publishEndpoints(identity)).toBeNull();
    }
    vi.mocked(dialFetch).mockRejectedValueOnce(new Error('offline'));
    expect(await publishEndpoints(identity)).toBeNull();
    vi.mocked(dialFetch).mockResolvedValueOnce(new Response('x'.repeat(1024 * 1024 + 1)));
    expect(await publishEndpoints(identity)).toBeNull();
    expect(await publishEndpoints(null)).toBeNull();
  });

  it('posts only the unit token and prints the produced image and share link', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true, published: { image: { tag: 'tag', id: 'id' }, shareUrl: 'https://site.example.com/' } })));
    const out = vi.fn();
    const io = { env: { WICKED_MCP_TOKEN: 'unit', WICKED_CREW_URL: 'http://crew/' }, fetch: request, out, err: vi.fn() };
    expect(await runAppsProduce(io)).toBe(0);
    expect(request).toHaveBeenCalledWith('http://crew/api/v1/apps/produce', expect.objectContaining({ method: 'POST', body: '{"token":"unit"}' }));
    expect(out.mock.calls.flat().join('\n')).toContain('tag (id)');
    expect(out.mock.calls.flat().join('\n')).toContain('https://site.example.com/');
    request.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'not_the_produce', error: 'wrong step' }), { status: 403 }));
    expect(await runAppsProduce(io)).toBe(1);
    expect(io.err).toHaveBeenCalledWith(expect.stringContaining('wrong step'));
    expect(await runAppsProduce({ ...io, env: {} })).toBe(1);
  });
});
