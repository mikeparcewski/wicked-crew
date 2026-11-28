// Advanced settings (crew#2013, DES-2013): the settings that exist as environment variables are
// saved through PUT /settings and exported into this process, which the in-process engine and
// crew's own readers use. The rules pinned here:
//   - a saved value is exported; "off" and "default" DELETE the variable (never '' or '0');
//   - `null` clears a key;
//   - only a person may change them (a worker's bearer gets 403);
//   - a variable the host environment set wins: GET names it, a PUT naming it gets 409, and no
//     save, including one for another key, touches it (the council size used to be deleted);
//   - every value is checked at the boundary (400 naming the key);
//   - a settings.json written by the real adapter and then hand-edited reads back without a bad value.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/api/audit.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes } from '../src/api/routes.js';
import { CoreAdapter } from '../src/core/adapter.js';
import type { CrewSystemSettings } from '../src/core/types.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { crewStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import { removeScratch } from './setup/scratch.js';

const VARS = [
  'WICKED_WORKER_INHERIT_OPERATOR_CONFIG',
  'WICKED_COUNCIL_SIZE',
  'WICKED_COUNCIL_SPAWN_STAGGER_MS',
  'WICKED_UNIT_TIMEOUT_SECS',
  'WICKED_ASK_TIMEOUT_SECS',
  'WICKED_DELIVER_CHECKS_TIMEOUT_SECS',
  'WICKED_DELIVER_CHECKS_POLL_SECS',
  'WICKED_CHAT_TURN_SECS',
  'WICKED_SEAT_MEMORY',
  'WICKED_FLOOR_MEMORY',
  'WICKED_REPO_CHECKS_CACHE_CAP_GB',
  'WICKED_REPO_CHECKS_TOTAL_CAP_GB',
  'WICKED_FLOOR_MIN_FREE_GB',
  'WICKED_COMPLETED_WORKTREE_KEEP_DAYS',
  'WICKED_SEAT_EGRESS_HOSTS',
  'WICKED_SEAT_NETWORK',
  'WICKED_CREW_DELIVER_TRAILERS',
  'WICKED_CREW_PUBLIC_ORIGIN',
  'WICKED_CREW_RUN_LEARNINGS',
] as const;
const saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));

const HUMAN = { 'x-actor': 'human:operator' };
const AGENT = { 'x-actor': 'agent:operator' };

/** In-memory settings store with the adapter's merge (defaults + patch; an undefined value drops the key). */
function memoryAdapter(): CoreAdapter {
  let store: Record<string, unknown> = { graphNodeLimit: 150 };
  const drop = (o: Record<string, unknown>): Record<string, unknown> =>
    JSON.parse(JSON.stringify(o)) as Record<string, unknown>;
  return {
    getSettings: async () => ({ ...store }),
    updateSettings: async (patch: Record<string, unknown>) => {
      store = drop({ ...store, ...patch });
      return { ...store };
    },
  } as unknown as CoreAdapter;
}

let app: FastifyInstance | undefined;
async function build(): Promise<FastifyInstance> {
  const a = Fastify({ logger: false });
  a.decorateRequest('actor', null as unknown as never);
  a.addHook('onRequest', async (req) => {
    const h = req.headers['x-actor'];
    if (typeof h === 'string') {
      const [kind, trust] = h.split(':');
      (req as unknown as { actor: unknown }).actor = { id: `${kind}-1`, kind, trust };
    }
  });
  registerRoutes(a, memoryAdapter(), new GateCache(), new ElicitationCache(),
    { bus: null, index: new MembershipIndex(), log: () => undefined }, { audit: AuditLog.noop(), authMode: 'required' }, {});
  await a.ready();
  app = a;
  return a;
}
const put = (a: FastifyInstance, payload: unknown, headers: Record<string, string> = HUMAN) =>
  a.inject({ method: 'PUT', url: '/api/v1/settings', headers, payload: payload as Record<string, unknown> });
const get = async (a: FastifyInstance) =>
  (await a.inject({ method: 'GET', url: '/api/v1/settings', headers: HUMAN })).json() as {
    settings: CrewSystemSettings;
    environment?: Record<string, { env: string[]; value: string }>;
  };

beforeEach(() => {
  for (const v of VARS) delete process.env[v];
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe('PUT /settings exports the Advanced settings (crew#2013)', () => {
  it('saves and exports each value, and off/open/default delete the variable', async () => {
    const a = await build();
    const res = await put(a, {
      inheritOperatorCliConfig: true,
      unitTimeoutSecs: 900,
      askTimeoutSecs: 120,
      deliverChecksTimeoutSecs: 3600,
      deliverChecksPollSecs: 30,
      chatTurnSecs: 300,
      seatMemory: '8g',
      floorMemory: '4096m',
      checkCacheRepoCapGb: 10,
      checkCacheTotalCapGb: 30,
      floorMinFreeGb: 25,
      completedWorktreeKeepDays: 0,
      seatNetwork: 'allowlist',
      seatEgressHosts: ['index.crates.io', '*.npmjs.org'],
      deliverTrailers: ['Co-Authored-By: Pat <pat@example.com>', 'Reviewed-by: Lee <lee@example.com>'],
      publicOrigin: 'https://studio.example.com',
      runLearnings: 'extract',
    });
    expect(res.statusCode).toBe(200);
    expect(process.env).toMatchObject({
      WICKED_WORKER_INHERIT_OPERATOR_CONFIG: '1',
      WICKED_UNIT_TIMEOUT_SECS: '900',
      WICKED_ASK_TIMEOUT_SECS: '120',
      WICKED_DELIVER_CHECKS_TIMEOUT_SECS: '3600',
      WICKED_DELIVER_CHECKS_POLL_SECS: '30',
      WICKED_CHAT_TURN_SECS: '300',
      WICKED_SEAT_MEMORY: '8g',
      WICKED_FLOOR_MEMORY: '4096m',
      WICKED_REPO_CHECKS_CACHE_CAP_GB: '10',
      WICKED_REPO_CHECKS_TOTAL_CAP_GB: '30',
      WICKED_FLOOR_MIN_FREE_GB: '25',
      WICKED_COMPLETED_WORKTREE_KEEP_DAYS: '0',
      WICKED_SEAT_EGRESS_HOSTS: 'index.crates.io,*.npmjs.org',
      WICKED_CREW_DELIVER_TRAILERS: 'Co-Authored-By: Pat <pat@example.com>\nReviewed-by: Lee <lee@example.com>',
      WICKED_CREW_PUBLIC_ORIGIN: 'https://studio.example.com',
      WICKED_CREW_RUN_LEARNINGS: 'extract',
    });
    const body = await get(a);
    expect(body.settings.unitTimeoutSecs).toBe(900);
    expect(body.environment).toEqual({});

    // Off is a DELETE: the engine reads any value, '0' included, as on.
    expect((await put(a, { inheritOperatorCliConfig: false, seatNetwork: 'open' })).statusCode).toBe(200);
    expect(process.env['WICKED_WORKER_INHERIT_OPERATOR_CONFIG']).toBeUndefined();
    // Open is a DELETE too: an empty WICKED_SEAT_EGRESS_HOSTS means no egress at all.
    expect(process.env['WICKED_SEAT_EGRESS_HOSTS']).toBeUndefined();
  });

  it("'none' and an empty allowlist both export none (nothing beyond the model gateway)", async () => {
    const a = await build();
    expect((await put(a, { seatNetwork: 'none' })).statusCode).toBe(200);
    expect(process.env['WICKED_SEAT_EGRESS_HOSTS']).toBe('none');
    expect((await put(a, { seatNetwork: 'allowlist', seatEgressHosts: [] })).statusCode).toBe(200);
    expect(process.env['WICKED_SEAT_EGRESS_HOSTS']).toBe('none');
    expect(process.env['WICKED_SEAT_NETWORK']).toBeUndefined();
  });

  it('null clears a key: the setting is gone and the variable deleted', async () => {
    const a = await build();
    expect((await put(a, { unitTimeoutSecs: 900 })).statusCode).toBe(200);
    expect(process.env['WICKED_UNIT_TIMEOUT_SECS']).toBe('900');
    expect((await put(a, { unitTimeoutSecs: null })).statusCode).toBe(200);
    expect(process.env['WICKED_UNIT_TIMEOUT_SECS']).toBeUndefined();
    expect('unitTimeoutSecs' in (await get(a)).settings).toBe(false);
  });

  it("a worker's bearer cannot change them (403), and nothing is exported", async () => {
    const a = await build();
    const res = await put(a, { inheritOperatorCliConfig: true }, AGENT);
    expect(res.statusCode).toBe(403);
    expect(process.env['WICKED_WORKER_INHERIT_OPERATOR_CONFIG']).toBeUndefined();
    expect((await put(a, { seatNetwork: 'open' }, AGENT)).statusCode).toBe(403);
  });

  it('a value the host environment set wins: GET names it, a PUT naming it is 409, other saves leave it', async () => {
    process.env['WICKED_SEAT_MEMORY'] = '5g';
    process.env['WICKED_SEAT_NETWORK'] = 'none';
    process.env['WICKED_COUNCIL_SIZE'] = '5';
    const a = await build();
    const env = (await get(a)).environment ?? {};
    expect(env['seatMemory']).toEqual({ env: ['WICKED_SEAT_MEMORY'], value: '5g' });
    expect(env['seatNetwork']).toEqual({ env: ['WICKED_SEAT_NETWORK'], value: 'none' });
    expect(env['seatEgressHosts']).toEqual({ env: ['WICKED_SEAT_NETWORK'], value: 'none' });
    expect(env['councilSize']).toEqual({ env: ['WICKED_COUNCIL_SIZE'], value: '5' });

    const res = await put(a, { seatMemory: '8g' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'env_pinned', key: 'seatMemory', env: ['WICKED_SEAT_MEMORY'] });
    expect(process.env['WICKED_SEAT_MEMORY']).toBe('5g');
    expect((await put(a, { seatNetwork: 'open' })).statusCode).toBe(409);
    expect((await put(a, { councilSize: 3 })).statusCode).toBe(409);

    // A save of another key re-exports the table and must leave every host value alone.
    expect((await put(a, { unitTimeoutSecs: 900 })).statusCode).toBe(200);
    expect(process.env['WICKED_SEAT_MEMORY']).toBe('5g');
    expect(process.env['WICKED_SEAT_NETWORK']).toBe('none');
    expect(process.env['WICKED_SEAT_EGRESS_HOSTS']).toBeUndefined();
    expect(process.env['WICKED_COUNCIL_SIZE']).toBe('5');
  });

  it.each([
    ['inheritOperatorCliConfig', 1],
    ['inheritOperatorCliConfig', 'true'],
    ['unitTimeoutSecs', 0],
    ['unitTimeoutSecs', 299],
    ['unitTimeoutSecs', 86_401],
    ['unitTimeoutSecs', 900.5],
    ['askTimeoutSecs', 9],
    ['askTimeoutSecs', 3601],
    ['deliverChecksTimeoutSecs', 59],
    ['deliverChecksPollSecs', 4],
    ['chatTurnSecs', 3601],
    ['seatMemory', '0g'],
    ['seatMemory', '512m'],
    ['seatMemory', '65g'],
    ['seatMemory', '8G'],
    ['seatMemory', '8gb'],
    ['floorMemory', '1g'],
    ['checkCacheRepoCapGb', 0],
    ['checkCacheTotalCapGb', 2001],
    ['floorMinFreeGb', 0],
    ['completedWorktreeKeepDays', -1],
    ['completedWorktreeKeepDays', 366],
    ['seatNetwork', 'closed'],
    ['seatEgressHosts', ['Index.Crates.io']],
    ['seatEgressHosts', ['*']],
    ['seatEgressHosts', ['a.io,b.io']],
    ['seatEgressHosts', ['localhost']],
    ['seatEgressHosts', 'index.crates.io'],
    ['deliverTrailers', ['not a trailer']],
    ['deliverTrailers', ['Co-Authored-By: A\u0007 <a@example.com>']],
    ['deliverTrailers', Array.from({ length: 11 }, (_, i) => `Reviewed-by: R${i} <r@example.com>`)],
    ['publicOrigin', "https://a'b.example.com"],
    ['publicOrigin', 'https://studio.example.com/runs'],
    ['publicOrigin', 'https://studio.example.com/'],
    ['publicOrigin', 'http://127.0.0.1:7701'],
    ['publicOrigin', 'ftp://studio.example.com'],
    ['runLearnings', 'on'],
  ])('400s %s = %j, names the key, and exports nothing', async (key, bad) => {
    const a = await build();
    const res = await put(a, { [key]: bad });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain(key);
    for (const v of VARS) expect(process.env[v]).toBeUndefined();
  });
});

describe('settings.json read (crew#2013)', () => {
  const armedHome = crewStateHome();
  const armedSettings = process.env['WICKED_CREW_SYSTEM_SETTINGS'];
  let dir = '';
  let adapter: CoreAdapter | undefined;
  afterEach(() => {
    adapter?.close();
    adapter = undefined;
    setCrewStateHome(armedHome);
    if (armedSettings === undefined) delete process.env['WICKED_CREW_SYSTEM_SETTINGS'];
    else process.env['WICKED_CREW_SYSTEM_SETTINGS'] = armedSettings;
    if (dir !== '') removeScratch(dir);
  });

  it('a file the adapter wrote, then hand-edited to a value the API refuses, reads back without it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'settings-advanced-'));
    const file = join(dir, 'settings.json');
    process.env['WICKED_CREW_SYSTEM_SETTINGS'] = file;
    setCrewStateHome(join(dir, 'home'));
    adapter = new CoreAdapter({ dbPath: join(dir, 'home', 'core.db'), stub: true });
    // The product's own writer (the PUT route's `adapter.updateSettings`), not a hand-written JSON.
    await adapter.updateSettings({ unitTimeoutSecs: 900, seatMemory: '8g', publicOrigin: 'https://studio.example.com' });
    const written = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(written).toMatchObject({ unitTimeoutSecs: 900, seatMemory: '8g' });
    writeFileSync(file, JSON.stringify({ ...written, unitTimeoutSecs: 0, seatMemory: '8 GB', publicOrigin: "https://a'b.example.com" }, null, 2));
    const back = await adapter.getSettings();
    expect(back.unitTimeoutSecs).toBeUndefined();
    expect(back.seatMemory).toBeUndefined();
    expect(back.publicOrigin).toBeUndefined();
  });
});
