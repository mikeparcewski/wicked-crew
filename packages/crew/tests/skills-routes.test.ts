// The `/api/v1/skills*` file manager (design v3 §API) over a fixture store: every guard answers
// 2xx `{verdict, findings[], revision}` — a publish already in flight or a root that changed under
// one included (`publish-in-flight` / `root-changed`, both wrote nothing). 409 is EXCLUSIVELY a
// stale expectedRevision (a CAS conflict); containment and strict bodies are 400; unknown skill/file
// 404; no runtime 503. Publish exports the snapshot path for the engine (`WICKED_SKILLS_SNAPSHOT`)
// with the copilot view inside the snapshot — nothing is written into any home directory (v3.2 §1).

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import Fastify, { type FastifyInstance } from 'fastify';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
import { SKILLS_SNAPSHOT_ENGINE_ENV } from '../src/skills/engine-env.js';
import { PORTABILITY_RULES_IDENTITY } from '../src/skills/refs.js';
import { SkillsRuntime } from '../src/skills/runtime.js';
import { COPILOT_VIEW_SKILLS_REL, type CurrentSnapshot } from '../src/skills/store.js';
import { hashTree, removeTreeForce, sha256Hex, walkTree } from '../src/skills/tree.js';
import type { VenvProvisioner } from '../src/skills/venv.js';
import { removeScratch } from './setup/scratch.js';
import { scaffold, type Scaffold } from './support/skills-fixture.js';

let s: Scaffold;
let app: FastifyInstance;
let logs: string[];
const savedEnv = process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
/** Whatever the process carried under the RETIRED engine-input name — crew must leave it untouched (v3.4 §2). */
const stateHomeEnvBefore = process.env['WICKED_CREW_STATE_HOME'];

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

describe('route paths are decoded EXACTLY ONCE — by Fastify (codex round 5)', () => {
  it('`100%25.txt` round-trips as the filename `100%.txt`; the literal `a%252Fb.txt` stays `a%2Fb.txt` (never becomes the path a/b.txt)', async () => {
    for (const [encoded, name] of [
      ['100%25.txt', '100%.txt'],
      ['a%252Fb.txt', 'a%2Fb.txt'],
      ['sp%20ace%20%2B%20plus.md', 'sp ace + plus.md'],
    ] as const) {
      const put = await app.inject({
        method: 'PUT',
        url: `/api/v1/skills/wicked-garden-gamma/files/refs/${encoded}`,
        payload: { content: `content of ${name}\n`, expectedRevision: (await manifest()).revision },
      });
      expect(put.statusCode, encoded).toBe(200);
      expect((put.json() as SkillMutationResult).verdict, encoded).toBe('clear');
      const get = await app.inject({ method: 'GET', url: `/api/v1/skills/wicked-garden-gamma/files/refs/${encoded}` });
      expect(get.statusCode, encoded).toBe(200);
      expect(get.json() as SkillReadResult).toMatchObject({ path: `skills/gamma/refs/${name}`, content: `content of ${name}\n` });
      expect(existsSync(join(s.root, 'effective', 'skills', 'gamma', 'refs', name)), encoded).toBe(true);
    }
    // The literal-percent name is ONE file, not a nested path: no `refs/a/b.txt` ever appeared.
    expect(existsSync(join(s.root, 'effective', 'skills', 'gamma', 'refs', 'a', 'b.txt'))).toBe(false);
    const tree = await app.inject({ method: 'GET', url: '/api/v1/skills/wicked-garden-gamma/files' });
    expect((tree.json() as { files: Array<{ path: string }> }).files.map((f) => f.path)).toEqual(
      expect.arrayContaining(['refs/100%.txt', 'refs/a%2Fb.txt', 'refs/sp ace + plus.md']),
    );
  });

  it('a raw `%2F` IS a separator (Fastify decodes it before routing): `a%2Fb.txt` addresses refs/a/b.txt; an encoded dot-dot is still refused; a malformed escape is Fastify\'s own 400', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/skills/wicked-garden-gamma/files/refs/a%2Fb.txt',
      payload: { content: 'nested\n', expectedRevision: 1 },
    });
    expect(put.statusCode).toBe(200);
    expect(existsSync(join(s.root, 'effective', 'skills', 'gamma', 'refs', 'a', 'b.txt'))).toBe(true);
    const escaped = await app.inject({ method: 'GET', url: '/api/v1/skills/wicked-garden-gamma/files/%2e%2e%2Fbeta/SKILL.md' });
    expect(escaped.statusCode).toBe(400);
    expect((escaped.json() as { error: string }).error).toContain('".."');
    const malformed = await app.inject({ method: 'GET', url: '/api/v1/skills/wicked-garden-gamma/files/%E0%A4%A' });
    expect(malformed.statusCode).toBe(400);
    const support = await app.inject({ method: 'PUT', url: '/api/v1/skills/support/scripts/100%25.sh', payload: { content: '#!/bin/sh\n', expectedRevision: 2 } });
    expect(support.statusCode).toBe(200);
    expect(existsSync(join(s.root, 'effective', 'scripts', '100%.sh'))).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/v1/skills/support/scripts/100%25.sh' })).statusCode).toBe(200);
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
    expect(process.env['WICKED_CREW_STATE_HOME']).toBe(stateHomeEnvBefore); // …and NOTHING beside it: retired as an engine input (v3.4 §2)
    // The one input is a real generation directory, every component resolved — never the `current` link.
    expect(realpathSync(real)).toBe(real);
    expect(lstatSync(real).isDirectory()).toBe(true);
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
    expect((await manifest()).current).toMatchObject({ gen: 1, path: real }); // `rules` / `drift` ride beside (F-083)
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

  it('a publish with a MISSING-target ref is a 200 `warnings` WITH a snapshot and the env export (design v3.4 §1); an ESCAPING ref is a 200 `blocked` with file:line findings, no snapshot, the env untouched', async () => {
    delete process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
    // Disabling alpha leaves alpha/nested's `../SKILL.md` pointing at a file the snapshot OMITS: inside the root, missing → a warning.
    const off = await app.inject({ method: 'POST', url: '/api/v1/skills/wicked-garden-alpha/disable', payload: { expectedRevision: 1 } });
    const rev = (off.json() as SkillMutationResult).revision;
    const res = await app.inject({ method: 'POST', url: '/api/v1/skills/publish', payload: { expectedRevision: rev } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SkillPublishResult;
    expect(body.verdict).toBe('warnings');
    expect(body.snapshot).toMatchObject({ gen: 1 });
    expect(body.findings.find((f) => f.kind === 'unresolved-ref')).toMatchObject({ severity: 'warning', file: 'skills/alpha/nested/SKILL.md', line: 10 });
    const real = realpathSync(join(s.root, 'snapshots', '000001'));
    expect(process.env[SKILLS_SNAPSHOT_ENGINE_ENV]).toBe(real); // the snapshot is written AND handed over
    expect((await manifest()).current).toMatchObject({ gen: 1, path: real }); // `rules` / `drift` ride beside (F-083)
    // analyze mirrors it, PURE: the same warning, nothing persisted, the CAS untouched.
    const analyze = await app.inject({ method: 'POST', url: '/api/v1/skills/analyze' });
    expect(analyze.statusCode).toBe(200);
    expect((analyze.json() as SkillPublishResult).verdict).toBe('warnings');
    expect((analyze.json() as SkillPublishResult).revision).toBe(body.revision);
    expect((await manifest()).revision).toBe(body.revision);

    // An ESCAPE — `${CLAUDE_PLUGIN_ROOT}/../x` climbs out of the plugin root — is a boundary claim: blocked, nothing written, the env unchanged.
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/skills/wicked-garden-beta/files/refs/escape.md',
      payload: { content: 'see `${CLAUDE_PLUGIN_ROOT}/../x`\n', expectedRevision: body.revision },
    });
    expect(put.statusCode).toBe(200);
    const rev2 = (put.json() as SkillMutationResult).revision;
    const blocked = await app.inject({ method: 'POST', url: '/api/v1/skills/publish', payload: { expectedRevision: rev2 } });
    expect(blocked.statusCode).toBe(200);
    const blockedBody = blocked.json() as SkillPublishResult;
    expect(blockedBody.verdict).toBe('blocked');
    expect(blockedBody.snapshot).toBeNull();
    expect(blockedBody.findings.find((f) => f.kind === 'unresolved-ref' && f.severity === 'blocking')).toMatchObject({ file: 'skills/beta/refs/escape.md', line: 1 });
    expect(blockedBody.revision).toBe(rev2);
    expect(process.env[SKILLS_SNAPSHOT_ENGINE_ENV]).toBe(real); // the last VERIFIED snapshot stays exported
    expect((await manifest()).current).toMatchObject({ gen: 1, path: real }); // `rules` / `drift` ride beside (F-083)
    expect(((await app.inject({ method: 'POST', url: '/api/v1/skills/analyze' })).json() as SkillPublishResult).verdict).toBe('blocked');
    expect((await manifest()).revision).toBe(rev2);
  });

  it('a refresh-time NAME COLLISION keeps the operator\'s skill and records the held-back upstream directory (codex round 9): `?side=baseline` reads the UPSTREAM bytes at that directory, the default read the local bytes', async () => {
    // Local skill `wicked-garden-a-b` lands at skills/a-b; upstream ships the SAME name at skills/a/b.
    const added = await app.inject({
      method: 'POST',
      url: '/api/v1/skills',
      payload: { name: 'wicked-garden-a-b', files: { 'SKILL.md': '---\nname: wicked-garden-a-b\n---\n\nLOCAL bytes\n' }, expectedRevision: 1 },
    });
    expect(added.statusCode).toBe(200);
    const rev = (added.json() as SkillMutationResult).revision;
    expect((added.json() as SkillMutationResult).skill).toMatchObject({ dir: 'skills/a-b', upstreamDir: null });
    mkdirSync(join(s.upstream, 'skills', 'a', 'b'), { recursive: true });
    writeFileSync(join(s.upstream, 'skills', 'a', 'b', 'SKILL.md'), '---\nname: wicked-garden-a-b\n---\n\nUPSTREAM bytes\n');
    const refreshed = await app.inject({ method: 'POST', url: '/api/v1/skills/refresh-baseline', payload: { expectedRevision: rev } });
    expect(refreshed.statusCode).toBe(200);
    const body = refreshed.json() as SkillMutationResult & { conflicts: string[] };
    expect(body.verdict).toBe('warnings');
    expect(body.conflicts).toEqual(['wicked-garden-a-b']);
    expect(body.findings.find((f) => f.kind === 'refresh-conflict')?.evidence).toContain('upstream at skills/a/b');
    const entry = (await manifest()).manifest.skills['wicked-garden-a-b'];
    expect(entry).toMatchObject({ dir: 'skills/a-b', conflict: true, upstreamDir: 'skills/a/b', provenance: 'user-added' });
    // The two sides of the collision are readable: default = the operator's, ?side=baseline = upstream's held-back directory.
    const local = await app.inject({ method: 'GET', url: '/api/v1/skills/wicked-garden-a-b/files/SKILL.md' });
    expect(local.statusCode).toBe(200);
    expect(local.json() as SkillReadResult).toMatchObject({ path: 'skills/a-b/SKILL.md' });
    expect((local.json() as SkillReadResult).content).toContain('LOCAL bytes');
    const upstream = await app.inject({ method: 'GET', url: '/api/v1/skills/wicked-garden-a-b/files/SKILL.md?side=baseline' });
    expect(upstream.statusCode).toBe(200);
    expect(upstream.json() as SkillReadResult).toMatchObject({ path: 'skills/a/b/SKILL.md' });
    expect((upstream.json() as SkillReadResult).content).toContain('UPSTREAM bytes');
    // The held-back skill never entered effective/ — the operator's tree is untouched.
    expect(existsSync(join(s.root, 'effective', 'skills', 'a'))).toBe(false);
  });

  it('a support PUT outside the bundle closure (hooks/x, tests/x) is a 200 blocked `outside-closure` envelope — nothing written, the revision unchanged; a GET there is a 400 (codex round 6)', async () => {
    const put = await app.inject({ method: 'PUT', url: '/api/v1/skills/support/hooks/hooks.json', payload: { content: '{}\n', expectedRevision: 1 } });
    expect(put.statusCode).toBe(200);
    const body = put.json() as SkillMutationResult;
    expect(body).toMatchObject({ verdict: 'blocked', revision: 1 });
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0]).toMatchObject({ kind: 'outside-closure', severity: 'blocking', file: 'hooks/hooks.json' });
    expect(body.findings[0]?.evidence).toContain('outside the bundle closure');
    expect(existsSync(join(s.root, 'effective', 'hooks'))).toBe(false);
    expect((await manifest()).revision).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/api/v1/skills/support/hooks/hooks.json' })).statusCode).toBe(400);
    const tests = await app.inject({ method: 'PUT', url: '/api/v1/skills/support/tests/x.py', payload: { content: 'x\n', expectedRevision: 1 } });
    expect(tests.json()).toMatchObject({ verdict: 'blocked', revision: 1 });
    expect((tests.json() as SkillMutationResult).findings[0]?.kind).toBe('outside-closure');
    // Inside the closure the same PUT lands (with the usual support-file-edit warning).
    const inside = await app.inject({ method: 'PUT', url: '/api/v1/skills/support/docs/examples/new.yml', payload: { content: 'a: 1\n', expectedRevision: 1 } });
    expect(inside.json()).toMatchObject({ verdict: 'warnings', revision: 2 });
  });

  it('refresh-baseline over an unchanged upstream is a clear no-op through the route', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/skills/refresh-baseline', payload: { expectedRevision: 1 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ verdict: 'clear', taken: [], added: [], removed: [], revision: 1 });
  });

  it('a refresh whose destination is refused (a symlinked effective parent) is a 200 blocked path-invalid envelope — never a 500 — with nothing changed (codex round 4)', async () => {
    mkdirSync(join(s.upstream, 'skills', 'gamma', 'refs'), { recursive: true });
    writeFileSync(join(s.upstream, 'skills', 'gamma', 'refs', 'new.md'), 'upstream added\n');
    const outside = join(s.base, 'outside-refs');
    mkdirSync(outside);
    symlinkSync(outside, join(s.root, 'effective', 'skills', 'gamma', 'refs'));
    const res = await app.inject({ method: 'POST', url: '/api/v1/skills/refresh-baseline', payload: { expectedRevision: 1 } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SkillMutationResult;
    expect(body).toMatchObject({ verdict: 'blocked', revision: 1 });
    expect(body.findings[0]).toMatchObject({ kind: 'path-invalid', skill: 'wicked-garden-gamma', file: 'skills/gamma/refs/new.md' });
    expect(readdirSync(outside)).toEqual([]);
    expect((await manifest()).revision).toBe(1);
  });

  it('a skills root replaced by a symlink after boot answers 503 on every route — nothing is read or written through it (codex round 4)', async () => {
    const copy = join(s.base, 'copy');
    cpSync(s.root, copy, { recursive: true });
    rmSync(s.root, { recursive: true });
    symlinkSync(copy, s.root);
    for (const [method, url, payload] of [
      ['GET', '/api/v1/skills', undefined],
      ['GET', '/api/v1/skills/wicked-garden-gamma/files/SKILL.md', undefined],
      ['PUT', '/api/v1/skills/wicked-garden-gamma/files/SKILL.md', { content: 'x', expectedRevision: 1 }],
      ['POST', '/api/v1/skills/wicked-garden-delta/disable', { expectedRevision: 1 }],
      ['POST', '/api/v1/skills/refresh-baseline', { expectedRevision: 1 }],
      ['POST', '/api/v1/skills/publish', { expectedRevision: 1 }],
      ['POST', '/api/v1/skills/analyze', undefined],
    ] as const) {
      const res = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
      expect(res.statusCode, `${method} ${url}`).toBe(503);
      expect((res.json() as { error: string }).error, `${method} ${url}`).toContain('symlink stands in for the skills root');
    }
    expect(existsSync(join(copy, 'snapshots'))).toBe(false);
    expect(readFileSync(join(copy, 'effective', 'skills', 'gamma', 'SKILL.md'), 'utf8')).not.toBe('x');
    rmSync(s.root);
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

describe('portability per reason on the wire (F-079; api-types 0.34.0)', () => {
  it('GET /skills carries `portability` on every entry beside `portable`; a PUT that adds two reasons answers two `non-portable` findings with file:line and the reason token', async () => {
    const before = await manifest();
    expect(before.manifest.skills['wicked-garden-alpha']).toMatchObject({ portable: false, portability: { portable: false, reasons: ['plugin-root'], evidence: ['skills/alpha/SKILL.md:10'] } });
    expect(before.manifest.skills['wicked-garden-gamma']).toMatchObject({ portable: true, portability: { portable: true, reasons: [], evidence: [] } });
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/skills/wicked-garden-gamma/files/refs/extra.md',
      payload: { content: 'ls ${CLAUDE_SKILL_DIR}\nrun `python3 scripts/alpha/run.py`\n', expectedRevision: before.revision },
    });
    expect(put.statusCode).toBe(200);
    const body = put.json() as SkillMutationResult;
    expect(body.verdict).toBe('warnings');
    expect(body.findings.filter((f) => f.kind === 'non-portable').map((f) => [f.portabilityReason, f.file, f.line])).toEqual([
      ['cwd-script', 'refs/extra.md', 2],
      ['skill-dir-var', 'refs/extra.md', 1],
    ]);
    expect(body.skill).toMatchObject({ portable: false, portability: { portable: false, reasons: ['cwd-script', 'skill-dir-var'], evidence: ['skills/gamma/refs/extra.md:1', 'skills/gamma/refs/extra.md:2'] } });
    const after = await manifest();
    expect(after.manifest.skills['wicked-garden-gamma']?.portability?.reasons).toEqual(['cwd-script', 'skill-dir-var']);
    // The GET shape itself is unchanged: {manifest, revision, root, current}.
    expect(Object.keys(after).sort()).toEqual(['current', 'manifest', 'revision', 'root']);
    // Published: the snapshot row carries the same claim and the view excludes gamma now.
    const pub = await app.inject({ method: 'POST', url: '/api/v1/skills/publish', payload: { expectedRevision: body.revision } });
    expect(pub.statusCode).toBe(200);
    const snapshot = JSON.parse(readFileSync(join((pub.json() as SkillPublishResult).snapshot?.path ?? '', 'snapshot.json'), 'utf8')) as { skills: Array<{ name: string; portability?: unknown }>; views: { copilot: { skills: string[] } } };
    expect(snapshot.skills.find((x) => x.name === 'wicked-garden-gamma')?.portability).toEqual({ portable: false, reasons: ['cwd-script', 'skill-dir-var'], evidence: ['skills/gamma/refs/extra.md:1', 'skills/gamma/refs/extra.md:2'] });
    expect(snapshot.views.copilot.skills).toEqual(['wicked-garden-beta']);
    // F-083: `current` additively names the portability rules the generation was published under
    // beside the running ones, and the rows that derive differently — none: this daemon published it.
    const current = (await manifest()).current as unknown as CurrentSnapshot | null;
    expect(current).toMatchObject({
      gen: (pub.json() as SkillPublishResult).snapshot?.gen,
      rules: { recorded: { ...PORTABILITY_RULES_IDENTITY }, running: { ...PORTABILITY_RULES_IDENTITY }, stale: false },
      drift: [],
    });
  });
});

describe('a STALE generation on the wire (F-083, review M2/L2)', () => {
  /**
   * Age the current generation + manifest.json the way a 0.7.29 publisher left them: no rules
   * identity, no per-reason blocks, `name` recorded non-portable with its copilot view absent, the
   * tree re-hashed, the manifest re-stamped and its row aged too.
   */
  const ageAsOlderPublisher = (snapPath: string, name: string): void => {
    const metadata = join(snapPath, 'snapshot.json');
    chmodSync(dirname(metadata), 0o755);
    chmodSync(metadata, 0o644);
    const view = join(snapPath, ...COPILOT_VIEW_SKILLS_REL.split('/'), name);
    chmodSync(dirname(view), 0o755);
    removeTreeForce(view);
    const pristine = JSON.parse(readFileSync(metadata, 'utf8')) as Record<string, unknown> & { skills: Array<Record<string, unknown>>; views: { copilot: { dir: string; skills: string[] } } };
    delete pristine['rulesVersion'];
    delete pristine['rulesSha256'];
    const tree = walkTree(snapPath);
    const aged = {
      ...pristine,
      contentHash: hashTree(tree.files.filter((f) => f.rel !== 'snapshot.json'), tree.links, tree.dirs),
      skills: pristine.skills.map((row) => {
        const older = { ...row };
        delete older['portability'];
        if (older['name'] === name) older['portable'] = false;
        return older;
      }),
      views: { copilot: { dir: pristine.views.copilot.dir, skills: pristine.views.copilot.skills.filter((n) => n !== name) } },
    };
    const raw = `${JSON.stringify(aged, null, 2)}\n`;
    writeFileSync(metadata, raw);
    const manifestPath = join(s.root, 'manifest.json');
    const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as { published: { contentHash: string; snapshotHash: string }; skills: Record<string, Record<string, unknown>> };
    m.published.contentHash = aged.contentHash;
    m.published.snapshotHash = sha256Hex(raw);
    const entry = m.skills[name] as Record<string, unknown>;
    entry['portable'] = false;
    delete entry['portability'];
    writeFileSync(manifestPath, `${JSON.stringify(m, null, 2)}\n`);
  };

  it('a daemon booted over a 0.7.29-shaped root answers GET /skills 200 with the EDITOR rows re-derived under the running rules beside current.rules / current.drift, GET /diagnostics carries the ONE skills.stale-rules warning with the seat clause and the snapshot as engineInput, and POST /skills/publish clears it', async () => {
    const before = await manifest();
    const pub = await app.inject({ method: 'POST', url: '/api/v1/skills/publish', payload: { expectedRevision: before.revision } });
    expect(pub.statusCode).toBe(200);
    const snapPath = (pub.json() as SkillPublishResult).snapshot?.path ?? '';
    expect(snapPath).not.toBe('');
    ageAsOlderPublisher(snapPath, 'wicked-garden-gamma');
    expect((await manifest()).manifest.skills['wicked-garden-gamma']).toMatchObject({ portable: false }); // the aged verdict, as 0.7.29 left it
    // A daemon boot over the aged root: the seam's ladder, then the routes.
    const booted = new SkillsRuntime({ store: s.store, log: (m) => logs.push(m) });
    const health = await booted.apply();
    expect(health.state).toBe('published');
    const app2 = buildApp(booted);
    await app2.ready();
    try {
      const res = await app2.inject({ method: 'GET', url: '/api/v1/skills' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as SkillsManifestResponse;
      expect(body.manifest.skills['wicked-garden-gamma']).toMatchObject({ portable: true, portability: { portable: true, reasons: [], evidence: [] } });
      const current = body.current as unknown as CurrentSnapshot | null;
      expect(current?.gen).toBe(1);
      expect(current?.rules).toEqual({ recorded: null, running: { ...PORTABILITY_RULES_IDENTITY }, stale: true });
      expect(current?.drift.map((d) => [d.name, d.recorded.portable, d.recorded.reasons, d.derived.portable])).toEqual([['wicked-garden-gamma', false, null, true]]);
      const diag = await app2.inject({ method: 'GET', url: '/api/v1/diagnostics' });
      expect(diag.statusCode).toBe(200);
      const skills = (diag.json() as { skills: { state: string; engineInput: string | null; findings: Array<{ kind: string; severity: string; message: string }> } }).skills;
      expect(skills.state).toBe('published');
      expect(skills.engineInput).toBe(snapPath);
      expect(process.env[SKILLS_SNAPSHOT_ENGINE_ENV]).toBe(snapPath);
      expect(skills.findings.map((f) => [f.kind, f.severity])).toEqual([['skills.stale-rules', 'warning']]);
      expect(skills.findings[0]?.message).toContain('wicked-garden-gamma (portable false → true)');
      expect(skills.findings[0]?.message).toContain('every seat is still admitted and served by the RECORDED rows until a re-publish');
      expect(skills.findings[0]?.message).toContain('(1 row(s) moved)');
      // The remedy through the route: publish → the new generation records the identity, the warning is gone.
      const pub2 = await app2.inject({ method: 'POST', url: '/api/v1/skills/publish', payload: { expectedRevision: body.revision } });
      expect(pub2.statusCode).toBe(200);
      expect((pub2.json() as SkillPublishResult).snapshot?.gen).toBe(2);
      const after = (await app2.inject({ method: 'GET', url: '/api/v1/skills' })).json() as SkillsManifestResponse;
      const cur2 = after.current as unknown as CurrentSnapshot | null;
      expect(cur2).toMatchObject({ gen: 2, rules: { recorded: { ...PORTABILITY_RULES_IDENTITY }, stale: false }, drift: [] });
      const diag2 = (await app2.inject({ method: 'GET', url: '/api/v1/diagnostics' })).json() as { skills: { findings: unknown[] } };
      expect(diag2.skills.findings).toEqual([]);
    } finally {
      await app2.close();
    }
  });
});
