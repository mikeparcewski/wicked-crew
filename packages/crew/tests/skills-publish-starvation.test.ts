// crew#852 — `POST /skills/publish` must not starve the daemon's read path. One publish of a 15k-file
// catalogue used to hold the event loop for minutes (validate, hash, copy, staged hash, lock, reap
// and the post-publish verification were all synchronous): `/health` did not answer, the stall
// watchdog's `listExecuting()` timed out, the few reads that completed took tens of seconds. The
// publish path now runs its tree steps PACED (src/skills/tree.ts `paced` / `budgetPacer`), so a
// trivial route in the same process keeps answering within one slice while a publish over a
// 150-skill fixture runs; the published-generation semantics are unchanged (one publish at a time,
// `gen` increments once, a reader sees the old generation or the new one), a mutation that arrives
// while a publish runs is refused before it touches anything, and a manifest moved on disk under a
// running publish fails the publish's own CAS rather than landing a generation the manifest no
// longer describes.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes } from '../src/api/routes.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { SkillPublishResult, SkillsManifestResponse, SystemSettings } from '../src/core/types.js';
import { SKILLS_SNAPSHOT_ENGINE_ENV } from '../src/skills/engine-env.js';
import { pluginSourceAt } from '../src/skills/plugin-source.js';
import { SkillsRuntime } from '../src/skills/runtime.js';
import { RevisionMismatchError, SkillsPublishInFlightError, SkillsStore } from '../src/skills/store.js';
import { budgetPacer, PACE_SLICE_MS, type Pacer } from '../src/skills/tree.js';
import { noVenv } from '../src/skills/venv.js';
import { removeScratch } from './setup/scratch.js';
import { CLOCK, REGISTERED_REFS, scaffold, type Scaffold } from './support/skills-fixture.js';

const SKILLS = 60;
const FILES_PER_SKILL = 20;
/** The route must answer within this while a publish runs — the issue's capture gate asked for 5 s and got nothing for seven minutes. */
const PROBE_DEADLINE_MS = 250;
/** Whatever the host does to one syscall, the loop is never held past this: a hold beyond it is unpaced work, not I/O. */
const HARD_CEILING_MS = 2000;
/** The fixture publish is sub-second on a quiet runner and tens of seconds on a loaded host behind a file scanner (where this was diagnosed); the budget is for the latter. */
const SLOW_HOST_MS = 180_000;

const scratch: Scaffold[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const sc of scratch.splice(0)) removeScratch(sc.base);
}, SLOW_HOST_MS);

function settingsAdapter(): CoreAdapter {
  let store: SystemSettings = { graphNodeLimit: 150 } as SystemSettings;
  return {
    getSettings: async () => ({ ...store }),
    updateSettings: async (patch: Partial<SystemSettings>) => {
      store = { ...store, ...patch };
      return { ...store };
    },
    listWorkflows: () => [],
  } as unknown as CoreAdapter;
}

function buildApp(runtime: SkillsRuntime): FastifyInstance {
  const app = Fastify({ logger: false });
  registerRoutes(app, settingsAdapter(), new GateCache(), new ElicitationCache(), undefined, undefined, { skills: runtime });
  // The daemon's `/health` is a trivial route of this kind for the purpose of this test: the
  // starvation was loop-level, so any route that needs the loop to turn measures it.
  app.get('/probe', async () => ({ ok: true }));
  apps.push(app);
  return app;
}

/** Add `SKILLS` portable module skills of `FILES_PER_SKILL` files each to the fixture upstream — the catalogue the issue's publish walked, scaled to the suite. */
function grow(upstream: string): void {
  const filler = 'lorem ipsum dolor sit amet, consectetur adipiscing elit — '.repeat(40);
  for (let i = 1; i <= SKILLS; i += 1) {
    const id = `s${String(i).padStart(3, '0')}`;
    const dir = join(upstream, 'skills', id);
    mkdirSync(join(dir, 'refs'), { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: wicked-garden-${id}\ndescription: generated fixture skill ${id} (portable module)\n---\n\n# ${id}\n\nNothing here leaves the file.\n`);
    for (let f = 1; f < FILES_PER_SKILL; f += 1) writeFileSync(join(dir, 'refs', `note-${String(f).padStart(3, '0')}.md`), `# ${id} note ${f}\n\n${filler}\n`);
  }
}

/** Poll `GET /probe` over a real socket until stopped; every answer's latency and arrival time is recorded. */
function probe(port: number): { stop: () => Promise<Array<{ at: number; ms: number }>> } {
  const answers: Array<{ at: number; ms: number }> = [];
  let running = true;
  const once = (): Promise<void> =>
    new Promise((resolve) => {
      const t0 = performance.now();
      get({ host: '127.0.0.1', port, path: '/probe', agent: false }, (res) => {
        res.resume();
        res.on('end', () => {
          const now = performance.now();
          answers.push({ at: now, ms: now - t0 });
          resolve();
        });
      }).on('error', () => resolve());
    });
  const loop = (async () => {
    while (running) {
      await once();
      await new Promise((r) => setTimeout(r, 10));
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
      return answers;
    },
  };
}

describe('POST /skills/publish does not hold the event loop (crew#852)', () => {
  it(`a publish over ${SKILLS} skills / ~${SKILLS * FILES_PER_SKILL} files keeps a trivial route answering within ${PROBE_DEADLINE_MS} ms throughout; the generation lands whole`, async () => {
    // The pacer is observed, not replaced: the longest stretch between two ticks (an unpaced step)
    // and the time of the last tick localize a slow probe when the assertion fails.
    let lastTick = 0;
    let longestGap = { ms: 0, at: 0 };
    const observed = (): Pacer => {
      const inner = budgetPacer();
      lastTick = performance.now();
      return {
        tick: () => {
          const now = performance.now();
          if (now - lastTick > longestGap.ms) longestGap = { ms: now - lastTick, at: now };
          lastTick = now;
          return inner.tick();
        },
      };
    };
    const sc = scaffold({ pacer: observed });
    scratch.push(sc);
    grow(sc.upstream);
    sc.store.seed();
    const app = buildApp(new SkillsRuntime({ store: sc.store, log: () => undefined }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const probes = probe(port);
    await new Promise((r) => setTimeout(r, 60)); // a few answers before the publish, as a baseline
    const t0 = performance.now();
    const res = await app.inject({ method: 'POST', url: '/api/v1/skills/publish', payload: { expectedRevision: 1 } });
    const t1 = performance.now();
    const answers = await probes.stop();
    expect(res.statusCode).toBe(200);
    const body = res.json() as SkillPublishResult;
    expect(body.verdict).toBe('clear');
    expect(body.snapshot).toMatchObject({ gen: 1 });
    expect(body.snapshot?.skills).toBeGreaterThanOrEqual(SKILLS);
    const during = answers.filter((a) => a.at >= t0 && a.at <= t1);
    const worstAnswer = answers.reduce((w, a) => (a.ms > w.ms ? a : w), answers[0] ?? { at: 0, ms: 0 });
    const worst = worstAnswer.ms;
    const where = `worst answer at +${Math.round(worstAnswer.at - t0)} ms (publish ${Math.round(t1 - t0)} ms; last pacer tick at +${Math.round(lastTick - t0)} ms; longest gap between ticks ${Math.round(longestGap.ms)} ms at +${Math.round(longestGap.at - t0)} ms; ${sc.warnings.filter((w) => w.includes('publish:')).join(' | ')})`;
    // The publish took long enough for the probe to run DURING it, and every answer — before,
    // during and after — came within the deadline. Before the pacing the probe's first answer
    // inside the publish window arrived after the publish itself (latency ≈ publish duration).
    expect(during.length, `probe answers during the ${Math.round(t1 - t0)} ms publish`).toBeGreaterThanOrEqual(5);
    // The guarantee the pacing gives is "one step plus one slice": a step is ONE synchronous
    // syscall (an open, a read, a chmod), and on a host whose on-access scanner stalls a single
    // open for hundreds of milliseconds (where crew#852 was diagnosed) that one step is the floor
    // no pacing can split. So the deadline widens only by the excess of the longest single step the
    // observed pacer saw, never by unpaced code — which the hard ceiling catches regardless.
    const stepExcess = Math.max(0, longestGap.ms - PACE_SLICE_MS);
    expect(worst, `worst probe latency (ms) over ${answers.length} answers — ${where}`).toBeLessThan(PROBE_DEADLINE_MS + stepExcess);
    expect(worst, `worst probe latency (ms) — ${where}`).toBeLessThan(HARD_CEILING_MS);
    // The route's export verified the new generation (paced too): `current` names it, nothing is in flight.
    const after = (await app.inject({ method: 'GET', url: '/api/v1/skills' })).json() as SkillsManifestResponse;
    expect(after.publishing).toBe(false);
    expect(after.current).toMatchObject({ gen: 1 });
    expect(after.revision).toBe(2);
  }, SLOW_HOST_MS);

  it('while a publish runs: GET /skills answers `publishing: true` with the PREVIOUS generation as `current`; a write is the 2xx publish-in-flight envelope and touches nothing; released, the publish lands and the write goes through', async () => {
    // Deterministic: the second publish's pacer parks at its first yield until the test releases it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parked!: () => void;
    const parkedP = new Promise<void>((resolve) => {
      parked = resolve;
    });
    let publishes = 0;
    const pacer = (): Pacer => {
      publishes += 1;
      if (publishes === 1) return budgetPacer();
      let once = false;
      return {
        tick: () => {
          if (once) return null;
          once = true;
          parked();
          return gate;
        },
      };
    };
    const sc = scaffold({ pacer });
    scratch.push(sc);
    sc.store.seed();
    const app = buildApp(new SkillsRuntime({ store: sc.store, log: () => undefined }));
    await app.ready();
    try {
      const first = (await app.inject({ method: 'POST', url: '/api/v1/skills/publish', payload: { expectedRevision: 1 } })).json() as SkillPublishResult;
      expect(first.snapshot?.gen).toBe(1);
      // Something to publish, so the second publish takes the slow path (and its pacer).
      const edit = sc.store.writeFile('wicked-garden-gamma', 'SKILL.md', '---\nname: wicked-garden-gamma\ndescription: edited\n---\n\n# gamma\n\nRank things, edited.\n', first.revision);
      expect(edit.verdict).toBe('clear');
      const second = app.inject({ method: 'POST', url: '/api/v1/skills/publish', payload: { expectedRevision: edit.revision } });
      await parkedP;
      expect(sc.store.isPublishing()).toBe(true);
      const mid = (await app.inject({ method: 'GET', url: '/api/v1/skills' })).json() as SkillsManifestResponse;
      expect(mid.publishing).toBe(true);
      expect(mid.current).toMatchObject({ gen: 1 }); // the old generation, until the flip
      expect(mid.revision).toBe(edit.revision); // nothing committed yet
      // A mutation in the window is refused BEFORE it touches anything — the same envelope a second publish gets.
      expect(() => sc.store.writeFile('wicked-garden-gamma', 'SKILL.md', 'later', edit.revision)).toThrow(SkillsPublishInFlightError);
      expect(() => sc.store.disable('wicked-garden-epsilon', edit.revision)).toThrow(SkillsPublishInFlightError);
      const refused = await app.inject({ method: 'POST', url: '/api/v1/skills/wicked-garden-epsilon/disable', payload: { expectedRevision: edit.revision } });
      expect(refused.statusCode).toBe(200);
      expect(refused.json()).toMatchObject({ verdict: 'blocked', snapshot: null, revision: edit.revision });
      expect((refused.json() as SkillPublishResult).findings[0]?.kind).toBe('publish-in-flight');
      release();
      const done = (await second).json() as SkillPublishResult;
      expect(done.snapshot?.gen).toBe(2);
      expect(done.revision).toBe(edit.revision + 1);
      const after = (await app.inject({ method: 'GET', url: '/api/v1/skills' })).json() as SkillsManifestResponse;
      expect(after.publishing).toBe(false);
      expect(after.current).toMatchObject({ gen: 2 });
      // The refused write touched nothing: the same write now lands at the new revision.
      expect(sc.store.disable('wicked-garden-epsilon', done.revision).verdict).toBe('clear');
    } finally {
      release();
    }
  });

  it('the export is INSIDE the publish window (codex r1 on #853): parked while the route verifies the new generation, GET /skills says publishing: true, a second publish is publish-in-flight; released, the engine input names the generation this publish minted', async () => {
    // The route exports through the publish's own pacer, so a pacer that parks at the first tick
    // AFTER `current` flipped is parked inside `afterPublishPaced` — the window codex named.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parked!: () => void;
    const parkedP = new Promise<void>((resolve) => {
      parked = resolve;
    });
    let armed = false;
    let once = false;
    const pacer = (): Pacer => ({
      tick: () => {
        if (!armed || once) return null;
        let target: string;
        try {
          target = readlinkSync(join(sc.root, 'current'));
        } catch {
          return null;
        }
        if (!target.endsWith('000002')) return null;
        once = true;
        parked();
        return gate;
      },
    });
    const sc = scaffold({ pacer });
    scratch.push(sc);
    sc.store.seed();
    const app = buildApp(new SkillsRuntime({ store: sc.store, log: () => undefined, bootSnapshot: undefined }));
    await app.ready();
    try {
      const first = (await app.inject({ method: 'POST', url: '/api/v1/skills/publish', payload: { expectedRevision: 1 } })).json() as SkillPublishResult;
      expect(first.snapshot?.gen).toBe(1);
      const edit = sc.store.writeFile('wicked-garden-gamma', 'SKILL.md', '---\nname: wicked-garden-gamma\ndescription: edited again\n---\n\n# gamma\n\nRank things, edited again.\n', first.revision);
      armed = true;
      const second = app.inject({ method: 'POST', url: '/api/v1/skills/publish', payload: { expectedRevision: edit.revision } });
      await parkedP; // `current` -> gen 2 already; the route is verifying/exporting it
      expect(sc.store.isPublishing()).toBe(true);
      expect(process.env[SKILLS_SNAPSHOT_ENGINE_ENV]?.endsWith('000001')).toBe(true); // the export has not happened yet
      const mid = (await app.inject({ method: 'GET', url: '/api/v1/skills' })).json() as SkillsManifestResponse;
      expect(mid.publishing).toBe(true);
      const third = await app.inject({ method: 'POST', url: '/api/v1/skills/publish', payload: { expectedRevision: edit.revision + 1 } });
      expect(third.statusCode).toBe(200);
      expect((third.json() as SkillPublishResult).findings[0]?.kind).toBe('publish-in-flight');
      release();
      const done = (await second).json() as SkillPublishResult;
      expect(done.snapshot?.gen).toBe(2);
      expect(process.env[SKILLS_SNAPSHOT_ENGINE_ENV]).toBe(done.snapshot?.path);
      expect(sc.store.isPublishing()).toBe(false);
      expect(((await app.inject({ method: 'GET', url: '/api/v1/skills' })).json() as SkillsManifestResponse).publishing).toBe(false);
    } finally {
      release();
    }
  });

  it('a manifest moved on disk UNDER a running publish (an out-of-process writer) fails the publish CAS at the commit: no generation, `current` unchanged, the retry at the new revision lands', async () => {
    // The out-of-process writer is a second store over the same root — its own in-flight state is
    // empty, so the gate above does not apply to it; only the commit-time re-check can catch it.
    // (`other` is declared below `sc`; the pacer runs only inside `publish()`, after both exist.)
    let moved = false;
    const pacer = (): Pacer => ({
      tick: () => {
        // The copy phase has begun (snapshots/ exists) — the manifest the publish bound is about to be committed.
        if (moved || !existsSync(join(sc.root, 'snapshots'))) return null;
        moved = true;
        expect(other.disable('wicked-garden-epsilon', 1).verdict).toBe('clear');
        return new Promise<void>((resolve) => setImmediate(resolve));
      },
    });
    const sc = scaffold({ pacer });
    scratch.push(sc);
    sc.store.seed();
    const other = new SkillsStore({
      root: sc.root,
      registeredSkillRefs: () => REGISTERED_REFS,
      provisionVenv: noVenv,
      source: () => pluginSourceAt(sc.upstream),
      now: () => CLOCK,
      warn: () => undefined,
    });
    await expect(sc.store.publish(1)).rejects.toBeInstanceOf(RevisionMismatchError);
    expect(moved).toBe(true);
    expect(sc.store.generationsOnDisk()).toEqual([]); // the staged generation was removed: no manifest, no generation
    expect(sc.store.currentSnapshot()).toBeNull();
    expect(sc.store.revision()).toBe(2); // the writer's commit stands
    expect(sc.store.isPublishing()).toBe(false);
    const retry = await sc.store.publish(2);
    expect(retry.snapshot?.gen).toBe(1);
    expect(sc.store.manifest().skills['wicked-garden-epsilon']?.enabled).toBe(false);
  });
});
