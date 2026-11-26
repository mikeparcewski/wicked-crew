// crew#1890: every write to the daemon skills root is a human operator's only, and under auth off (every caller is the
// local human) a request that carries a governed unit's token is refused, as the editor grant write is (F37 §6.4).
// Reads, and the dry-run analyze, stay open.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerAuthHooks, type ResolvedAuth } from '../src/api/auth.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes } from '../src/api/routes.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { SkillsManifestResponse } from '../src/core/types.js';
import { SKILLS_SNAPSHOT_ENGINE_ENV } from '../src/skills/engine-env.js';
import { SkillsRuntime } from '../src/skills/runtime.js';
import { removeScratch } from './setup/scratch.js';
import { scaffold, type Scaffold } from './support/skills-fixture.js';

const savedEnv = process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
let s: Scaffold;
let app: FastifyInstance;
let seen: string[];

const adapter = { getSettings: async () => ({ graphNodeLimit: 150 }), listWorkflows: () => [] } as unknown as CoreAdapter;

/** The engine's word on a bearer, as `unitTokenProbe` gives it: one unit token, one fault, the rest no unit's. */
const probe = async (token: string): Promise<'unit' | 'not_unit' | 'unknown'> => {
  seen.push(token);
  return token === 'unit-tok-1' ? 'unit' : token === 'flaky' ? 'unknown' : 'not_unit';
};

async function build(auth?: ResolvedAuth): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });
  if (auth !== undefined) registerAuthHooks(fastify, auth);
  registerRoutes(fastify, adapter, new GateCache(), new ElicitationCache(), undefined, undefined, {
    skills: new SkillsRuntime({ store: s.store, log: () => undefined }),
    editorUnitTokenProbe: probe,
  });
  await fastify.ready();
  return fastify;
}

beforeEach(() => {
  s = scaffold();
  s.store.seed();
  seen = [];
});

afterEach(async () => {
  await app.close();
  removeScratch(s.base);
  if (savedEnv === undefined) delete process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
  else process.env[SKILLS_SNAPSHOT_ENGINE_ENV] = savedEnv;
});

const manifest = async (headers: Record<string, string> = {}): Promise<SkillsManifestResponse> =>
  (await app.inject({ method: 'GET', url: '/api/v1/skills', headers })).json() as SkillsManifestResponse;

const SKILL = '---\nname: wicked-garden-seat\ndescription: a skill a worker tried to add\n---\n\nbody\n';

/** One request per skills write route, at revision `rev`. */
function writes(rev: number): Array<{ method: 'POST' | 'PUT'; url: string; payload: Record<string, unknown> }> {
  return [
    { method: 'POST', url: '/api/v1/skills', payload: { name: 'wicked-garden-seat', files: { 'SKILL.md': SKILL }, expectedRevision: rev } },
    { method: 'PUT', url: '/api/v1/skills/wicked-garden-gamma/files/refs/seat.md', payload: { content: 'seat\n', expectedRevision: rev } },
    { method: 'PUT', url: '/api/v1/skills/support/scripts/seat.sh', payload: { content: 'echo seat\n', expectedRevision: rev } },
    { method: 'POST', url: '/api/v1/skills/wicked-garden-gamma/disable', payload: { expectedRevision: rev } },
    { method: 'POST', url: '/api/v1/skills/wicked-garden-gamma/enable', payload: { expectedRevision: rev } },
    { method: 'POST', url: '/api/v1/skills/wicked-garden-gamma/reset', payload: { expectedRevision: rev } },
    { method: 'POST', url: '/api/v1/skills/wicked-garden-gamma/replace', payload: { files: { 'SKILL.md': SKILL }, expectedRevision: rev } },
    { method: 'POST', url: '/api/v1/skills/refresh-baseline', payload: { expectedRevision: rev } },
    { method: 'POST', url: '/api/v1/skills/publish', payload: { expectedRevision: rev } },
  ];
}

describe('skills writes: a person only (crew#1890)', () => {
  it('under auth off, every write carrying a governed unit\'s token is 403 seat_token and the root is unchanged; an unknown verdict is 503', async () => {
    app = await build();
    const before = await manifest();
    for (const w of writes(before.revision)) {
      const res = await app.inject({ ...w, headers: { authorization: 'Bearer unit-tok-1' } });
      expect(res.statusCode, `${w.method} ${w.url}: ${res.body}`).toBe(403);
      expect(res.json(), w.url).toMatchObject({ code: 'seat_token' });
      const unsure = await app.inject({ ...w, headers: { authorization: 'Bearer flaky' } });
      expect(unsure.statusCode, `${w.method} ${w.url}: ${unsure.body}`).toBe(503);
    }
    const after = await manifest();
    expect(after.revision).toBe(before.revision);
    expect(after.manifest).toEqual(before.manifest);
    expect(after.current).toBeNull();
    expect(seen).toEqual(writes(0).flatMap(() => ['unit-tok-1', 'flaky']));
  });

  it('under auth off, a bearer that is no unit\'s token and a request with no bearer still write; reads and analyze are never probed', async () => {
    app = await build();
    const rev = (await manifest({ authorization: 'Bearer unit-tok-1' })).revision;
    expect((await app.inject({ method: 'POST', url: '/api/v1/skills/analyze', headers: { authorization: 'Bearer unit-tok-1' } })).statusCode).toBe(200);
    expect(seen).toEqual([]);
    const added = await app.inject({ method: 'POST', url: '/api/v1/skills', headers: { authorization: 'Bearer person-tok' }, payload: { name: 'wicked-garden-seat', files: { 'SKILL.md': SKILL }, expectedRevision: rev } });
    expect(added.statusCode, added.body).toBe(200);
    const disabled = await app.inject({ method: 'POST', url: '/api/v1/skills/wicked-garden-gamma/disable', payload: { expectedRevision: (await manifest()).revision } });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(seen).toEqual(['person-tok']);
  });

  it('under auth required, an agent, plugin or system actor is 403 human_only on every write and the root is unchanged; a human operator writes', async () => {
    const actors = {
      'agent-tok': { id: 'a', kind: 'agent', trust: 'admin' },
      'plugin-tok': { id: 'p', kind: 'plugin', trust: 'admin' },
      'system-tok': { id: 's', kind: 'system', trust: 'admin' },
      'person-tok': { id: 'h', kind: 'human', trust: 'admin' },
    } as const;
    app = await build({
      mode: 'required',
      verifiers: [{ name: 'test', verify: async (t) => actors[t as keyof typeof actors] ?? null }],
      allowedOrigins: null,
    });
    const PERSON = { authorization: 'Bearer person-tok' };
    const before = await manifest(PERSON);
    for (const token of ['agent-tok', 'plugin-tok', 'system-tok']) {
      for (const w of writes(before.revision)) {
        const res = await app.inject({ ...w, headers: { authorization: `Bearer ${token}` } });
        expect(res.statusCode, `${token} ${w.method} ${w.url}: ${res.body}`).toBe(403);
        expect(res.json(), w.url).toMatchObject({ code: 'human_only' });
      }
      // Reads stay open to every operator-trusted actor.
      expect((await app.inject({ method: 'GET', url: '/api/v1/skills', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    }
    const after = await manifest(PERSON);
    expect(after.revision).toBe(before.revision);
    expect(after.manifest).toEqual(before.manifest);
    // A verified human operator is not probed (a unit token is no identity under required auth: 401).
    const added = await app.inject({ method: 'POST', url: '/api/v1/skills', headers: PERSON, payload: { name: 'wicked-garden-seat', files: { 'SKILL.md': SKILL }, expectedRevision: after.revision } });
    expect(added.statusCode, added.body).toBe(200);
    expect(seen).toEqual([]);
    expect((await app.inject({ method: 'POST', url: '/api/v1/skills/publish', headers: { authorization: 'Bearer unit-tok-1' }, payload: { expectedRevision: after.revision } })).statusCode).toBe(401);
  });
});
