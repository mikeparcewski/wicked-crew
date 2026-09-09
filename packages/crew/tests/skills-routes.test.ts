// The `/api/v1/skills*` file manager (design v3 §API) over a fixture store: every guard answers
// 2xx `{verdict, findings[], revision}` — a publish already in flight or a root that changed under
// one included (`publish-in-flight` / `root-changed`, both wrote nothing). 409 is EXCLUSIVELY a
// stale expectedRevision (a CAS conflict); containment and strict bodies are 400; unknown skill/file
// 404; no runtime 503. Publish exports the snapshot path for the engine (`WICKED_SKILLS_SNAPSHOT`)
// with the copilot view inside the snapshot — nothing is written into any home directory (v3.2 §1).

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes } from '../src/api/routes.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type {
  SkillMutationResult,
  SkillPublishResult,
  SkillReadResult,
  SkillRevisionConflict,
  SkillsManifestResponse,
  SystemSettings,
} from '../src/core/types.js';
import { canonicalCrewStateHome, CREW_STATE_HOME_ENGINE_ENV, SKILLS_SNAPSHOT_ENGINE_ENV } from '../src/skills/engine-env.js';
import { SkillsRuntime } from '../src/skills/runtime.js';
import { COPILOT_VIEW_SKILLS_REL } from '../src/skills/store.js';
import type { VenvProvisioner } from '../src/skills/venv.js';
import { removeScratch } from './setup/scratch.js';
import { scaffold, type Scaffold } from './support/skills-fixture.js';

let s: Scaffold;
let app: FastifyInstance;
let logs: string[];
const savedEnv = process.env[SKILLS_SNAPSHOT_ENGINE_ENV];

function settingsAdapter(initial: Partial<SystemSettings> = {}): CoreAdapter {
  let store: SystemSettings = { graphNodeLimit: 150, ...initial };
  return {
    getSettings: async () => ({ ...store }),
    updateSettings: async (patch: Partial<SystemSettings>) => {
      store = { ...store, ...patch };
      return { ...store };
    },
    listWorkflows: () => [],
  } as unknown as CoreAdapter;
}

function buildApp(runtime?: SkillsRuntime): FastifyInstance {
  const fastify = Fastify({ logger: false });
  registerRoutes(fastify, settingsAdapter(), new GateCache(), new ElicitationCache(), undefined, undefined, undefined, {
    ...(runtime !== undefined ? { skills: runtime } : {}),
  });
  return fastify;
}

beforeEach(async () => {
  s = scaffold();
  s.store.seed();
  logs = [];
  app = buildApp(new SkillsRuntime({ store: s.store, log: (m) => logs.push(m) }));
  await app.ready();
});

afterEach(async () => {
  await app.close();
  removeScratch(s.base);
  if (savedEnv === undefined) delete process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
  else process.env[SKILLS_SNAPSHOT_ENGINE_ENV] = savedEnv;
});

const manifest = async (): Promise<SkillsManifestResponse> =>
  (await app.inject({ method: 'GET', url: '/api/v1/skills' })).json() as SkillsManifestResponse;

describe('GET /skills, files, reads', () => {
  it('serves the manifest with its revision, the root, and no current snapshot before a publish', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/skills' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SkillsManifestResponse;
    expect(body.revision).toBe(1);
    expect(body.manifest.revision).toBe(1);
    expect(body.root).toBe(s.root);
    expect(body.current).toBeNull();
    expect(Object.keys(body.manifest.skills)).toContain('wicked-garden-alpha-nested');
  });

  it('lists a skill\'s OWN files and serves typed reads (effective and baseline sides)', async () => {
    const tree = await app.inject({ method: 'GET', url: '/api/v1/skills/wicked-garden-alpha/files' });
    expect(tree.statusCode).toBe(200);
    const paths = (tree.json() as { files: Array<{ path: string }> }).files.map((f) => f.path);
    expect(paths).toEqual(['SKILL.md', 'refs/notes.md']); // nested/SKILL.md belongs to alpha-nested
    const file = await app.inject({ method: 'GET', url: '/api/v1/skills/wicked-garden-alpha/files/refs/notes.md' });
    expect(file.statusCode).toBe(200);
    expect(file.json() as SkillReadResult).toMatchObject({ path: 'skills/alpha/refs/notes.md', truncated: false, binary: false });
    const baseline = await app.inject({ method: 'GET', url: '/api/v1/skills/wicked-garden-alpha/files/SKILL.md?side=baseline' });
    expect(baseline.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/skills/wicked-garden-alpha/files/SKILL.md?side=nope' })).statusCode).toBe(400);
    const support = await app.inject({ method: 'GET', url: '/api/v1/skills/support/scripts/_python.sh' });
    expect(support.statusCode).toBe(200);
    expect((support.json() as SkillReadResult).content).toContain('python3');
  });

  it('404s an unknown skill or file; 400s an escaping path (encoded dot-dot included) or a nested skill\'s path', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/skills/wicked-garden-nope/files' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/skills/wicked-garden-alpha/files/refs/missing.md' })).statusCode).toBe(404);
    // `%2e%2e` as a whole segment is a dot-segment to the WHATWG URL parser: it is folded into `..`
    // and resolved BEFORE routing, so the request lands on a path no route serves (404) — the
    // store never sees it. An encoded separator keeps the segment intact through the URL layer,
    // so the route's decode-then-refuse rule is what answers: 400.
    expect((await app.inject({ method: 'GET', url: '/api/v1/skills/wicked-garden-alpha/files/%2e%2e/gamma/SKILL.md' })).statusCode).toBe(404);
    const encoded = await app.inject({ method: 'GET', url: '/api/v1/skills/wicked-garden-alpha/files/%2e%2e%2Fgamma/SKILL.md' });
    expect(encoded.statusCode).toBe(400);
    expect((encoded.json() as { error: string }).error).toContain('".."');
    expect((await app.inject({ method: 'GET', url: '/api/v1/skills/wicked-garden-alpha/files/nested/SKILL.md' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/skills/support/skills/beta/SKILL.md' })).statusCode).toBe(400);
  });
});

describe('mutations — 2xx verdicts, CAS 409, strict bodies', () => {
  it('PUT a file with the current revision → 200 clear; stale revision → 409 naming the current one', async () => {
    const ok = await app.inject({
      method: 'PUT',
      url: '/api/v1/skills/wicked-garden-gamma/files/SKILL.md',
      payload: { content: '---\nname: wicked-garden-gamma\n---\n\nedited\n', expectedRevision: 1 },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as SkillMutationResult;
    expect(body).toMatchObject({ verdict: 'clear', revision: 2 });
    expect(body.skill).toMatchObject({ name: 'wicked-garden-gamma', provenance: 'override' });

    const stale = await app.inject({
      method: 'PUT',
      url: '/api/v1/skills/wicked-garden-gamma/files/SKILL.md',
      payload: { content: 'x', expectedRevision: 1 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json() as SkillRevisionConflict).toMatchObject({ revision: 2 });
  });

  it('a blocked guard is a NORMAL 200 with the findings and an unchanged revision', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/skills/wicked-garden-beta/disable', payload: { expectedRevision: 1 } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SkillMutationResult;
    expect(body.verdict).toBe('blocked');
    expect(body.findings[0]?.kind).toBe('core-disable');
    expect(body.revision).toBe(1);
    expect((await manifest()).manifest.skills['wicked-garden-beta']?.enabled).toBe(true);
  });

  it('a containment refusal on a WRITE is a normal 200 blocked envelope (path-invalid), never a 400', async () => {
    const nested = await app.inject({
      method: 'PUT',
      url: '/api/v1/skills/wicked-garden-alpha/files/nested/SKILL.md',
      payload: { content: 'x', expectedRevision: 1 },
    });
    expect(nested.statusCode).toBe(200);
    expect(nested.json() as SkillMutationResult).toMatchObject({ verdict: 'blocked', revision: 1 });
    expect((nested.json() as SkillMutationResult).findings[0]?.kind).toBe('path-invalid');
    const escaped = await app.inject({
      method: 'PUT',
      url: '/api/v1/skills/wicked-garden-alpha/files/%2e%2e%2Fgamma/SKILL.md',
      payload: { content: 'x', expectedRevision: 1 },
    });
    expect(escaped.statusCode).toBe(200);
    expect((escaped.json() as SkillMutationResult).verdict).toBe('blocked');
    const support = await app.inject({
      method: 'PUT',
      url: '/api/v1/skills/support/skills/beta/SKILL.md',
      payload: { content: 'x', expectedRevision: 1 },
    });
    expect(support.statusCode).toBe(200);
    expect((support.json() as SkillMutationResult).findings[0]?.kind).toBe('path-invalid');
    expect((await manifest()).revision).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/api/v1/skills/wicked-garden-gamma/files/SKILL.md' })).json()).not.toMatchObject({ content: 'x' });
  });

  it('the support endpoint refuses the names the store owns (snapshot.json, manifest.json, current, views/, .venv): PUT → blocked path-invalid, GET → 400', async () => {
    for (const rel of ['snapshot.json', 'manifest.json', 'current', 'views/copilot/.github/skills/x/SKILL.md', '.venv/bin/python']) {
      const put = await app.inject({ method: 'PUT', url: `/api/v1/skills/support/${rel}`, payload: { content: 'x', expectedRevision: 1 } });
      expect(put.statusCode, rel).toBe(200);
      const body = put.json() as SkillMutationResult;
      expect(body.verdict, rel).toBe('blocked');
      expect(body.findings[0]?.kind, rel).toBe('path-invalid');
      expect(body.findings[0]?.evidence, rel).toContain('reserved');
      const get = await app.inject({ method: 'GET', url: `/api/v1/skills/support/${rel}` });
      expect(get.statusCode, rel).toBe(400);
    }
    expect((await manifest()).revision).toBe(1);
    // …and the publish that follows verifies: none of those names leaked into the snapshot.
    const published = await app.inject({ method: 'POST', url: '/api/v1/skills/publish', payload: { expectedRevision: 1 } });
    expect((published.json() as SkillPublishResult).verdict).toBe('clear');
    expect((await manifest()).current?.gen).toBe(1);
  });

  it('refuses unknown body keys and malformed bodies with 400', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/v1/skills/wicked-garden-delta/disable', payload: { expectedRevision: 1, extra: true } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/skills/wicked-garden-delta/disable', payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/skills/wicked-garden-delta/files/SKILL.md', payload: { content: 5, expectedRevision: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/skills', payload: { name: 'wicked-garden-x', expectedRevision: 1 } })).statusCode).toBe(400);
  });

  it('add / replace / reset / enable round-trip through the routes with the CAS chain', async () => {
    const add = await app.inject({
      method: 'POST',
      url: '/api/v1/skills',
      payload: { name: 'wicked-garden-zeta', files: { 'SKILL.md': '---\nname: wicked-garden-zeta\n---\n\nz\n' }, expectedRevision: 1 },
    });
    expect(add.statusCode).toBe(200);
    let rev = (add.json() as SkillMutationResult).revision;
    const off = await app.inject({ method: 'POST', url: '/api/v1/skills/wicked-garden-zeta/disable', payload: { expectedRevision: rev } });
    rev = (off.json() as SkillMutationResult).revision;
    const replace = await app.inject({
      method: 'POST',
      url: '/api/v1/skills/wicked-garden-delta/replace',
      payload: { files: { 'SKILL.md': '---\nname: wicked-garden-delta\n---\n\nreplaced\n' }, expectedRevision: rev },
    });
    expect((replace.json() as SkillMutationResult).skill).toMatchObject({ provenance: 'override', portable: true });
    rev = (replace.json() as SkillMutationResult).revision;
    const reset = await app.inject({ method: 'POST', url: '/api/v1/skills/wicked-garden-delta/reset', payload: { expectedRevision: rev } });
    expect((reset.json() as SkillMutationResult).skill).toMatchObject({ provenance: 'shipped', enabled: true });
    rev = (reset.json() as SkillMutationResult).revision;
    const on = await app.inject({ method: 'POST', url: '/api/v1/skills/wicked-garden-zeta/enable', payload: { expectedRevision: rev } });
    expect((on.json() as SkillMutationResult).skill).toMatchObject({ enabled: true });
    expect((await app.inject({ method: 'POST', url: '/api/v1/skills/wicked-garden-nope/enable', payload: { expectedRevision: 1 } })).statusCode).toBe(404);
  });
});

describe('publish / analyze — the engine handoff and the copilot view', () => {
  it('publishes, exports WICKED_SKILLS_SNAPSHOT as the resolved snapshot path, lays the portable skills out in the snapshot\'s copilot view — and writes nothing into the home', async () => {
    delete process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
    const res = await app.inject({ method: 'POST', url: '/api/v1/skills/publish', payload: { expectedRevision: 1 } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SkillPublishResult;
    expect(body.verdict).toBe('clear');
    // The snapshot path is the absolute REAL path (v3.1 §2) — the one value the engine is handed.
    const real = realpathSync(join(s.root, 'snapshots', '000001'));
    expect(body.snapshot).toMatchObject({ gen: 1, path: real, skills: 6 });
    expect(process.env[SKILLS_SNAPSHOT_ENGINE_ENV]).toBe(real);
    expect(process.env['WICKED_SKILLS_CURRENT']).toBeUndefined(); // withdrawn: crew hands the engine ONE skills input
    expect(process.env[CREW_STATE_HOME_ENGINE_ENV]).toBe(canonicalCrewStateHome()); // …and the fenced state home beside it
    // The copilot view (v3.2 §4) is INSIDE the snapshot: portable skills only, under their frontmatter names.
    const view = join(real, ...COPILOT_VIEW_SKILLS_REL.split('/'));
    expect(existsSync(join(view, 'wicked-garden-gamma', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(view, 'wicked-garden-beta', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(view, 'wicked-garden-alpha'))).toBe(false);
    // The user's CLI directories are never touched (v3.2 §1): the fixture home stays non-existent.
    expect(existsSync(s.home)).toBe(false);
    // The answered revision is the final one — a publish moves it exactly once.
    expect(body.revision).toBe((await manifest()).revision);
    expect(body.revision).toBe(2);
    expect((await manifest()).current).toEqual({ gen: 1, path: real });
  });

  it('one publish at a time: a concurrent publish is a 2xx blocked publish-in-flight envelope, the first one lands, the provisioner ran once (deterministic, codex round 3)', async () => {
    // Deterministic synchronization — no sleeps, no wall-clock deadlines (codex round 3): the
    // provisioner resolves `entered` the instant it is called (the first publish is parked at its
    // await) and blocks on `release` (a gate the test opens); both are released in `finally`.
    let calls = 0;
    let entered!: () => void;
    const enteredP = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provisioner: VenvProvisioner = async () => {
      calls += 1;
      entered();
      await gate;
      return 'skipped';
    };
    const slow = scaffold({ provisionVenv: provisioner });
    const slowApp = buildApp(new SkillsRuntime({ store: slow.store, log: () => undefined }));
    try {
      slow.store.seed();
      await slowApp.ready();
      const first = slowApp.inject({ method: 'POST', url: '/api/v1/skills/publish', payload: { expectedRevision: 1 } });
      await enteredP; // the first publish has reached (and parked at) the provisioner — no polling
      expect(slow.store.isPublishing()).toBe(true);
      // A publish already in flight wrote nothing → a 2xx `blocked` findings envelope, NOT a 409.
      const second = await slowApp.inject({ method: 'POST', url: '/api/v1/skills/publish', payload: { expectedRevision: 1 } });
      expect(second.statusCode).toBe(200);
      const body = second.json() as SkillPublishResult;
      expect(body.verdict).toBe('blocked');
      expect(body.snapshot).toBeNull();
      expect(body.revision).toBe(1);
      expect(body.findings[0]?.kind).toBe('publish-in-flight');
      expect(body.findings[0]?.evidence).toContain('in flight');
      release();
      const done = await first;
      expect(done.statusCode).toBe(200);
      expect((done.json() as SkillPublishResult).snapshot?.gen).toBe(1);
      expect(calls).toBe(1);
      expect(slow.store.isPublishing()).toBe(false);
      expect(slow.store.generationsOnDisk()).toEqual([1]);
    } finally {
      release(); // always open the gate, even on an assertion failure, so teardown never hangs
      await slowApp.close();
      removeScratch(slow.base);
    }
  });

  it('a blocked publish is a 200 with file:line findings, no snapshot, no env export', async () => {
    delete process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
    const off = await app.inject({ method: 'POST', url: '/api/v1/skills/wicked-garden-alpha/disable', payload: { expectedRevision: 1 } });
    const rev = (off.json() as SkillMutationResult).revision;
    const res = await app.inject({ method: 'POST', url: '/api/v1/skills/publish', payload: { expectedRevision: rev } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SkillPublishResult;
    expect(body.verdict).toBe('blocked');
    expect(body.snapshot).toBeNull();
    expect(body.findings.find((f) => f.kind === 'unresolved-ref')).toMatchObject({ file: 'skills/alpha/nested/SKILL.md', line: 10 });
    expect(process.env[SKILLS_SNAPSHOT_ENGINE_ENV]).toBeUndefined();
    // analyze is the same validation, PURE: same findings, nothing published, nothing persisted, CAS untouched.
    const analyze = await app.inject({ method: 'POST', url: '/api/v1/skills/analyze' });
    expect(analyze.statusCode).toBe(200);
    expect((analyze.json() as SkillPublishResult).verdict).toBe('blocked');
    expect((analyze.json() as SkillPublishResult).revision).toBe(rev);
    expect((await manifest()).revision).toBe(rev);
    expect((await manifest()).current).toBeNull();
  });

  it('refresh-baseline over an unchanged upstream is a clear no-op through the route', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/skills/refresh-baseline', payload: { expectedRevision: 1 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ verdict: 'clear', taken: [], added: [], removed: [], revision: 1 });
  });
});

describe('without a skills runtime', () => {
  it('every /skills route answers 503, never a 500 or a silent empty catalog', async () => {
    const bare = buildApp();
    await bare.ready();
    try {
      expect((await bare.inject({ method: 'GET', url: '/api/v1/skills' })).statusCode).toBe(503);
      expect((await bare.inject({ method: 'POST', url: '/api/v1/skills/publish', payload: { expectedRevision: 0 } })).statusCode).toBe(503);
      expect((await bare.inject({ method: 'POST', url: '/api/v1/skills/analyze' })).statusCode).toBe(503);
    } finally {
      await bare.close();
    }
  });
});
