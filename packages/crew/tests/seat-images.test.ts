// The Nerve Center's seat images row (`seat_images`) and its fix, over the engine's
// `seat-image status --json` answer (wicked-core#1225): missing images, an unbuildable base, the
// runtime VM disk warning before a kubelet's image cleanup, and the one-at-a-time rebuild (its
// route: a person only, one run, refused while one runs).

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { seatImagesRebuildFixes } from '../src/api/needs.js';
import { registerRoutes, type RuntimeDeps } from '../src/api/routes.js';
import {
  parseSeatImageStatus,
  probeSeatImages,
  SeatImageRebuilder,
  spawnLines,
  type SeatImageStatus,
  type SpawnLines,
} from '../src/api/seat-images.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import { MembershipIndex } from '../src/projects/membership-index.js';

function status(over: Partial<SeatImageStatus> = {}, seats: Partial<Record<string, Partial<SeatImageStatus['seats'][number]>>> = {}): SeatImageStatus {
  return {
    runtime: 'docker',
    base: { image: 'wicked-seat-base:rust', present: true, held: true },
    baseRecipe: false,
    holdSupported: true,
    floor: { image: 'wicked-floor:1', present: true, held: true },
    seats: ['claude', 'codex', 'agy'].map((cli) => ({ cli, image: `wicked-seat-${cli}:1`, present: true, held: true, operatorImage: false, ...(seats[cli] ?? {}) })),
    disk: { totalBytes: 100 * 2 ** 30, availBytes: 60 * 2 ** 30, usedPct: 40 },
    imageGcHighPct: 85,
    ...over,
  };
}

const diskAt = (usedPct: number) => ({ totalBytes: 100 * 2 ** 30, availBytes: (100 - usedPct) * 2 ** 30, usedPct });

const probe = (st: SeatImageStatus | null, extra: Partial<Parameters<typeof probeSeatImages>[0]> = {}) =>
  probeSeatImages({ containerFloor: true, clis: ['claude', 'codex', 'agy'], status: async () => st, rebuild: () => null, ...extra });

describe('parseSeatImageStatus', () => {
  it('reads the engine answer, field by field, and refuses anything else', () => {
    const st = status();
    expect(parseSeatImageStatus(JSON.stringify(st))).toEqual(st);
    // Extra fields the engine might print never ride into the row's details.
    const extra = parseSeatImageStatus(JSON.stringify({ ...st, floor: { ...st.floor, dockerfile: '/secret/path' } }))!;
    expect(extra.floor).toEqual(st.floor);
    expect(parseSeatImageStatus('runtime: docker\nfloor: x present')).toBeNull();
    expect(parseSeatImageStatus('{"floor": 1, "seats": []}')).toBeNull();
    expect(parseSeatImageStatus(JSON.stringify({ ...st, disk: null }))!.disk).toBeNull();
  });
});

describe('the seat_images row', () => {
  it('is off on the host floor', async () => {
    expect((await probe(status(), { containerFloor: false })).state).toBe('off');
  });

  it('is ok when every roster image is present and held, with the disk read', async () => {
    const row = await probe(status());
    expect(row.state).toBe('ok');
    expect(row.remedy).toBeNull();
  });

  it('a missing image of a CLI not on the roster is not a problem; agy on the roster is read', async () => {
    expect((await probe(status({}, { agy: { present: false, held: false } }), { clis: ['claude'] })).state).toBe('ok');
    const row = await probe(status({}, { agy: { present: false, held: false } }));
    expect(row.details['missing']).toEqual(['agy']);
  });

  it('a missing roster image is degraded and fixable by a rebuild', async () => {
    const row = await probe(status({}, { codex: { present: false, held: false } }));
    expect(row.state).toBe('degraded');
    expect(row.details['missing']).toEqual(['codex']);
    expect(seatImagesRebuildFixes(row)).toBe(true);
  });

  it('a missing operator base with no recipe is down only when a seat image must be built from it', async () => {
    const gone = { base: { image: 'wicked-seat-base:rust', present: false, held: false } };
    const needed = await probe(status(gone, { claude: { present: false, held: false } }));
    expect(needed.state).toBe('down');
    expect(needed.reason).toMatch(/nothing can rebuild it/);
    expect(needed.remedy).toMatch(/WICKED_SEAT_BASE_DOCKERFILE/);
    expect(seatImagesRebuildFixes(needed)).toBe(false);
    // Every seat image is there: the seats run; it is a warning, not a stop.
    const runnable = await probe(status(gone));
    expect(runnable.state).toBe('degraded');
    expect(runnable.reason).toMatch(/seats run on the images they have/);
  });

  it('a missing base WITH a recipe is degraded and a rebuild fixes it', async () => {
    const row = await probe(status({ base: { image: 'wicked-seat-base:rust', present: false, held: false }, baseRecipe: true }));
    expect(row.state).toBe('degraded');
    expect(row.reason).toMatch(/rebuilt from its Dockerfile/);
    expect(seatImagesRebuildFixes(row)).toBe(true);
  });

  it('a missing operator image is down and not a rebuild; an unheld one is (the engine holds it)', async () => {
    const missing = await probe(status({}, { claude: { present: false, held: false, operatorImage: true } }));
    expect(missing.state).toBe('down');
    expect(seatImagesRebuildFixes(missing)).toBe(false);
    const unheld = await probe(status({}, { claude: { held: false, operatorImage: true } }));
    expect(seatImagesRebuildFixes(unheld)).toBe(true);
  });

  it('warns from 75 % VM disk (before the 85 % cleanup), is down from 92 %, and offers no rebuild onto a full disk', async () => {
    expect((await probe(status({ disk: diskAt(74) }))).state).toBe('ok');
    const warn = await probe(status({ disk: diskAt(75) }));
    expect(warn.state).toBe('degraded');
    expect(warn.reason).toMatch(/from 85%/);
    expect(warn.remedy).toMatch(/held and survive the cleanup/);
    expect(seatImagesRebuildFixes(warn)).toBe(false);
    const full = await probe(status({ disk: diskAt(95) }, { codex: { present: false, held: false } }));
    expect(full.state).toBe('down');
    expect(full.remedy).toMatch(/^Free space/);
    expect(seatImagesRebuildFixes(full)).toBe(false);
  });

  it('a missing base nothing can rebuild never offers a rebuild, even for unheld images', async () => {
    const row = await probe(status({ base: { image: 'wicked-seat-base:rust', present: false, held: false } }, { claude: { held: false } }));
    expect(row.details['unheld']).toEqual(['claude']);
    expect(seatImagesRebuildFixes(row)).toBe(false);
  });

  it('when every roster seat runs an operator image, the seat base does not count', async () => {
    const op = { operatorImage: true };
    const row = await probe(status({ base: { image: 'wicked-seat-base:rust', present: false, held: false } }, { claude: op, codex: op, agy: op }));
    expect(row.state).toBe('ok');
  });

  it('a pressed disk comes first in the remedy, before any image fix, for the runtime read', async () => {
    const row = await probe(status({ disk: diskAt(95), runtime: '/opt/podman' }, { claude: { present: false, held: false, operatorImage: true } }));
    expect(row.state).toBe('down');
    // podman's `volume prune` would take named volumes too: never suggested there.
    expect(row.remedy).toMatch(/^Free space in the container runtime VM first: the dangling volumes you no longer need \(`podman volume ls --filter dangling=true`/);
    expect(row.remedy).not.toMatch(/volume prune/);
    expect(row.remedy).toMatch(/Then: Rebuild or re-pull your own seat image/);
    expect(row.remedy).not.toMatch(/docker/);
    // A missing image under a pressed disk: never "held and survive".
    const missing = await probe(status({ disk: diskAt(80) }, { codex: { present: false, held: false } }));
    expect(missing.remedy).not.toMatch(/held and survive/);
  });

  it('with the disk pressed AND an image unheld, says both and never claims the images are held', async () => {
    const row = await probe(status({ disk: diskAt(80) }, { claude: { held: false } }));
    expect(row.reason).toMatch(/not held against image cleanup: claude/);
    expect(row.reason).toMatch(/80% used/);
    expect(row.remedy).not.toMatch(/held and survive/);
  });

  it('a runtime that cannot hold images is not nagged about holders', async () => {
    const row = await probe(status({ holdSupported: false }, { claude: { held: false }, codex: { held: false } }));
    expect(row.state).toBe('ok');
    expect(row.reason).toMatch(/cannot hold them/);
  });

  it('never reads ok without every reading: engine silent, older engine, roster unreadable, disk unread', async () => {
    const silent = await probeSeatImages({ containerFloor: true, clis: ['claude'], status: () => new Promise(() => {}), rebuild: () => null, timeoutMs: 20 });
    expect(silent.state).toBe('unknown');
    const old = await probe(null);
    expect(old.state).toBe('unknown');
    expect(old.reason).toMatch(/older than wicked-core#1225/);
    expect((await probe(status(), { clis: null })).state).toBe('unknown');
    const noDisk = await probe(status({ disk: null }));
    expect(noDisk.state).toBe('unknown');
    expect(noDisk.reason).toMatch(/disk could not be read/);
  });

  it('spells home paths ~ in an engine error', async () => {
    const home = process.env['HOME'] ?? '/home/x';
    const row = await probeSeatImages({ containerFloor: true, clis: ['claude'], status: async () => { throw new Error(`spawn ${home}/bin/wicked-core ENOENT`); }, rebuild: () => null });
    expect(row.reason).toContain('~/bin/wicked-core');
    expect(row.reason).not.toContain(home);
  });

  it('says a running rebuild (and offers no second one); a failed one only while it is not fixed', async () => {
    const running = await probe(status({}, { codex: { present: false, held: false } }), {
      rebuild: () => ({ running: true, startedAt: '2026-10-31T20:00:00.000Z', finishedAt: null, rc: null, tail: [], error: null, clis: ['codex'] }),
    });
    expect(running.reason).toMatch(/rebuilding since 2026-10-31T20:00:00.000Z/);
    expect(running.remedy).toMatch(/^Wait for the running rebuild/);
    expect(seatImagesRebuildFixes(running)).toBe(false);
    // The failure is named by its own line, never by a later seat's success.
    const failedRebuild = { running: false, startedAt: 'a', finishedAt: 'b', rc: 1, tail: ['claude: building x failed: pull access denied', 'codex: built y'], error: 'claude: building x failed: pull access denied', clis: ['claude', 'codex'] };
    const failed = await probe(status({}, { codex: { present: false, held: false } }), { rebuild: () => failedRebuild });
    expect(failed.reason).toMatch(/the last rebuild failed \(exit 1\): claude: building x failed/);
    expect(failed.reason).not.toMatch(/codex: built y/);
    const healed = await probe(status(), { rebuild: () => failedRebuild });
    expect(healed.state).toBe('ok');
    expect(healed.reason).not.toMatch(/failed/);
  });
});

/** A fake engine run held open until `release(rc)`. */
function heldRunner() {
  const calls: string[][] = [];
  let release: (rc: number) => void = () => {};
  let line: (l: string) => void = () => {};
  const run: SpawnLines = (file, args, opts) => {
    calls.push([file, ...args]);
    line = opts.onLine;
    return { started: Promise.resolve(), done: new Promise<number>((res) => { release = res; }) };
  };
  return { run, calls, release: (rc: number) => release(rc), line: (l: string) => line(l) };
}

describe('SeatImageRebuilder', () => {
  it('runs one rebuild at a time, keeps its live tail (home paths spelled ~) and its result', async () => {
    const h = heldRunner();
    const r = new SeatImageRebuilder(() => '/opt/wicked-core', h.run);
    const first = await r.start(['claude', 'codex', 'claude', 'bad cli;rm']);
    expect(first.started).toBe(true);
    expect(h.calls).toEqual([['/opt/wicked-core', 'seat-image', 'build', 'claude', 'codex']]);
    expect(await r.start(['claude'])).toMatchObject({ started: false, reason: 'a rebuild is already running' });
    h.line('#5 [2/4] RUN npm install');
    h.line(`claude: building failed in ${process.env['HOME'] ?? '/home/x'}/x`);
    h.line('codex: built wicked-seat-codex:1');
    expect(r.current()!.tail).toEqual(['claude: building failed in ~/x', 'codex: built wicked-seat-codex:1']);
    expect(r.current()!.error).toBe('claude: building failed in ~/x');
    h.release(1);
    await new Promise((res) => setTimeout(res, 0));
    expect(r.current()).toMatchObject({ running: false, rc: 1 });
    expect((await r.start(['claude'])).started).toBe(true);
    expect(h.calls).toHaveLength(2);
  });

  it('refuses without an engine binary, with nothing to build, or when the engine cannot start', async () => {
    const h = heldRunner();
    expect(await new SeatImageRebuilder(() => null, h.run).start(['claude'])).toMatchObject({ started: false });
    expect(await new SeatImageRebuilder(() => '/x', h.run).start([])).toMatchObject({ started: false });
    const broken: SpawnLines = () => ({ started: Promise.reject(new Error('spawn /nope ENOENT')), done: new Promise(() => {}) });
    const r = new SeatImageRebuilder(() => '/nope', broken);
    const res = await r.start(['claude']);
    expect(res).toMatchObject({ started: false });
    expect((res as { reason: string }).reason).toMatch(/could not be started: spawn \/nope ENOENT/);
    // Not left "running": the next press can try again.
    expect(r.current()!.running).toBe(false);
  });
});

describe('spawnLines (the real runner)', () => {
  it.runIf(process.platform !== 'win32')('ends a process that ignores SIGTERM past its bound, and keeps the start of an overlong line', async () => {
    const lines: string[] = [];
    // An unterminated 600-char line (START…), then its end (…END) later: the start is kept, the
    // rest of that line is dropped, and the next line is read again.
    const script = `printf 'START%s' "$(printf 'x%.0s' $(seq 1 600))"; sleep 0.3; printf 'END\\nnext\\n'; trap '' TERM; sleep 30`;
    const h = spawnLines('/bin/sh', ['-c', script], {
      // Long enough for the shell to print and set its trap (a loaded host starts a shell slowly).
      timeout: 3_000,
      killAfterMs: 200,
      onLine: (l) => lines.push(l),
    });
    await h.started;
    const t0 = Date.now();
    const rc = await h.done;
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(rc).not.toBe(0);
    expect(lines[0]!.startsWith('STARTxxx')).toBe(true);
    expect(lines[0]!.length).toBe(240);
    expect(lines.some((l) => l.includes('END'))).toBe(false);
    expect(lines).toContain('next');
  }, 20_000);
});

describe('POST /system/seat-images/rebuild', () => {
  const apps: FastifyInstance[] = [];
  const saved = process.env['WICKED_SEAT_FLOOR'];
  afterEach(async () => {
    for (const a of apps.splice(0)) await a.close();
    if (saved === undefined) delete process.env['WICKED_SEAT_FLOOR'];
    else process.env['WICKED_SEAT_FLOOR'] = saved;
  });

  async function harness(st: SeatImageStatus | null = status({}, { codex: { present: false, held: false } }), roster: Array<{ key: string }> | null = [{ key: 'claude' }, { key: 'codex' }, { key: 'gemini' }]) {
    let statusOk = true;
    process.env['WICKED_SEAT_FLOOR'] = 'container';
    const h = heldRunner();
    const app = Fastify({ logger: false });
    app.decorateRequest('actor', null as unknown as never);
    app.addHook('onRequest', async (req) => {
      const a = req.headers['x-actor'];
      if (typeof a === 'string') {
        const [kind, trust] = a.split(':');
        (req as unknown as { actor: unknown }).actor = { id: `${kind}-1`, kind, trust };
      }
    });
    const adapter = { sessionsDetail: async () => [], sessions: async () => [], listRepos: async () => [], getSettings: async () => ({}) };
    registerRoutes(
      app,
      adapter as unknown as CoreAdapter,
      new GateCache(),
      new ElicitationCache(),
      { bus: null, index: new MembershipIndex(), log: () => undefined },
      { audit: AuditLog.noop(), authMode: 'required' },
      {
        seatImageRebuilder: new SeatImageRebuilder(() => '/opt/wicked-core', h.run),
        seatImageStatus: async () => {
          if (!statusOk) throw new Error('FAKE runtime busy');
          return st;
        },
        // The roster names a seat the engine has no image for: it is never passed to the build.
        rosterWithStanding: (() => {
          if (roster === null) throw new Error('FAKE roster unreadable');
          return roster;
        }) as unknown as NonNullable<RuntimeDeps['rosterWithStanding']>,
      },
    );
    await app.ready();
    apps.push(app);
    return { app, h, failStatus: () => { statusOk = false; } };
  }

  const HUMAN = { 'x-actor': 'human:operator' };
  const AGENT = { 'x-actor': 'agent:operator' };
  const post = (app: FastifyInstance, headers: Record<string, string>) => app.inject({ method: 'POST', url: '/api/v1/system/seat-images/rebuild', headers });

  it('is a person only: an operator-trust agent is refused and nothing runs', async () => {
    const { app, h } = await harness();
    expect((await post(app, AGENT)).statusCode).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  it('runs the engine once for the roster seats it has images for; a second press while it runs is 409', async () => {
    const { app, h } = await harness();
    const first = await post(app, HUMAN);
    expect(first.statusCode).toBe(202);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.slice(0, 3)).toEqual(['/opt/wicked-core', 'seat-image', 'build']);
    // The roster's seats the engine has an image for: never `gemini`.
    expect(h.calls[0]!.slice(3)).toEqual(['claude', 'codex']);
    const second = await post(app, HUMAN);
    expect(second.statusCode).toBe(409);
    expect(h.calls).toHaveLength(1);
    h.release(0);
  });

  it('a press while a rebuild runs is 409 even when the busy runtime cannot answer a status', async () => {
    const { app, h, failStatus } = await harness();
    expect((await post(app, HUMAN)).statusCode).toBe(202);
    failStatus();
    expect((await post(app, HUMAN)).statusCode).toBe(409);
    expect(h.calls).toHaveLength(1);
    h.release(0);
  });

  it('an unreadable roster is 503, never a build of nothing', async () => {
    const { app, h } = await harness(undefined, null);
    const res = await post(app, HUMAN);
    expect(res.statusCode).toBe(503);
    expect((res.json() as { reason: string }).reason).toMatch(/roster could not be read/);
    expect(h.calls).toHaveLength(0);
  });

  it('is 503 on the host floor and when the engine gives no status, and runs nothing', async () => {
    const off = await harness();
    process.env['WICKED_SEAT_FLOOR'] = 'host';
    expect((await post(off.app, HUMAN)).statusCode).toBe(503);
    const silent = await harness(null);
    expect((await post(silent.app, HUMAN)).statusCode).toBe(503);
    expect(off.h.calls.length + silent.h.calls.length).toBe(0);
  });
});
