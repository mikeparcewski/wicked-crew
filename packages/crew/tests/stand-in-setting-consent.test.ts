// wicked-core#1930 F6: a run launched under the `standInReview: 'always'` setting records the PERSON who saved the
// setting as its consent's `by`, not whoever launched it. A workload token's launch inherits a person's consent; its
// record names that person. The settings live in crew's real store (CoreAdapter on a scratch settings file), written
// by the real `PUT /settings` route and the real `use_stand_ins` gate answer, and read back by the real launch route.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { AuditLog } from '../src/api/audit.js';
import { CoreAdapter } from '../src/core/adapter.js';
import type { LaunchRunInput } from '../src/core/types.js';
import { crewStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import { removeScratch } from './setup/scratch.js';
import { withRunViews } from './support/run-views.js';

/** The engine's own preflight for a one-CLI roster (see stand-in-launch.test.ts), copied verbatim. */
const ONE_HELPER = readFileSync(new URL('./fixtures/stand-in-preflight-one-helper.json', import.meta.url), 'utf8');

const HELD = {
  session: {
    id: 'run-s', workflow_id: 'bug', problem: 'p', entity_mode: 'shared', collection_scope: null, clis: ['claude'],
    status: 'awaiting_human', human_confirm: 'none', unit_ix: 0, attempt: 0, workdir: null, repo_ref: null,
    extra_write_roots: [], archived_at: null, archive_note: null,
  },
  units: [{ id: 'run-s:review', session_id: 'run-s', ord: 4, description: 'review', phase_ref: 'review', status: 'rejected', assigned_cli: 'claude' }],
};

/** The words a launch records when the setting carries no author (it was saved before crew recorded one). */
const STAND_IN_SETTING_UNRECORDED = 'the standInReview setting (author not recorded)';

const armedHome = crewStateHome();
const armedSettings = process.env['WICKED_CREW_SYSTEM_SETTINGS'];
let dir: string;
let file: string;
let store: CoreAdapter;
let app: FastifyInstance;
const launched: LaunchRunInput[] = [];
const grants: unknown[][] = [];

// The adapter and a settings save write process.env (the bus, the engine path, the worker and council settings): each
// case puts it back as it found it.
let envBefore: NodeJS.ProcessEnv = {};

beforeEach(async () => {
  envBefore = { ...process.env };
  dir = mkdtempSync(join(tmpdir(), 'stand-in-setting-consent-'));
  file = join(dir, 'settings.json');
  process.env['WICKED_CREW_SYSTEM_SETTINGS'] = file;
  setCrewStateHome(join(dir, 'home'));
  store = new CoreAdapter({ dbPath: join(dir, 'home', 'core.db'), stub: true });
  launched.length = 0;
  grants.length = 0;
  // Settings go through the real store; the launch and the engine's stand-in calls are recorded.
  const adapter = withRunViews({
    getSettings: () => store.getSettings(),
    updateSettings: (patch: never, derive?: never) => store.updateSettings(patch, derive),
    // One run held at a stand_in_needed gate, as stand-in-launch.test.ts builds it (the engine's durable gate row,
    // wicked-core `src/interaction.rs` `InteractionRequest`, serde snake_case).
    sessions: async () => [], sessionsDetail: async () => [HELD], listRepos: async () => [], listWorkflows: () => [], getWorkflow: () => null,
    interactionRequests: vi.fn(async () => [{ kind: 'gate', ord: 4, prompt: 'No helper left to judge this step', gate_kind: 'stand_in_needed', gate_seq: 3, created_at: 1 }]),
    runEvents: vi.fn(async () => []),
    launchRun: vi.fn(async (input: LaunchRunInput) => { launched.push(input); return input.sessionId; }),
    supportsStandIns: () => true,
    isDraining: () => false,
    independencePreflight: vi.fn(async () => ONE_HELPER),
    grantStandIns: vi.fn(async (...args: unknown[]) => { grants.push(args); return 'granted'; }),
  });
  app = Fastify({ logger: false });
  app.addHook('onRequest', async (req) => {
    const named = req.headers['x-test-actor'];
    if (typeof named === 'string') {
      const [id, kind, trust] = named.split('/');
      (req as unknown as { actor: unknown }).actor = { id, kind, trust };
    }
  });
  registerRoutes(app, adapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), undefined, {
    audit: { record: vi.fn(() => Date.now()) } as unknown as AuditLog, authMode: 'off',
  }, { rosterWithStanding: () => [], judgeCoverage: () => null });
  await app.ready();
});

afterEach(async () => {
  try {
    await app.close();
    store.close();
  } finally {
    setCrewStateHome(armedHome);
    if (armedSettings === undefined) delete process.env['WICKED_CREW_SYSTEM_SETTINGS'];
    else process.env['WICKED_CREW_SYSTEM_SETTINGS'] = armedSettings;
    for (const k of Object.keys(process.env)) if (!(k in envBefore)) delete process.env[k];
    for (const [k, v] of Object.entries(envBefore)) if (process.env[k] !== v) process.env[k] = v;
    removeScratch(dir);
  }
});

const put = (body: Record<string, unknown>, actor = 'priya/human/admin') =>
  app.inject({ method: 'PUT', url: '/api/v1/settings', headers: { 'x-test-actor': actor }, payload: body });
const launch = (actor = 'ci-bot/agent/operator') =>
  app.inject({ method: 'POST', url: '/api/v1/runs', headers: { 'x-test-actor': actor }, payload: { problem: 'fix it', clisJson: '[]' } });
const stored = () => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

describe("a launch under standInReview 'always' records the person who saved it (wicked-core#1930 F6)", () => {
  it("a workload token's launch names the person who saved always, and when", async () => {
    const before = Date.now();
    expect((await put({ standInReview: 'always' })).statusCode).toBe(200);
    const consent = stored()['standInConsent'] as { at: number };
    expect(consent).toEqual({ scope: 'always', by: 'priya (human)', at: consent.at, via: 'setting' });
    expect(consent.at).toBeGreaterThanOrEqual(before);

    const res = await launch();
    expect(res.statusCode).toBe(201);
    expect(launched).toHaveLength(1);
    expect(launched[0]?.standInAware).toBe(true);
    expect(launched[0]?.standIn).toEqual({ scope: 'always', by: 'priya (human)', at: consent.at, via: 'setting' });
  });

  it("the gate's every-job answer saves the person who gave it", async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/runs/run-s/gate', headers: { 'x-test-actor': 'ann/human/operator' },
      payload: { approve: true, action: 'use_stand_ins', scope: 'always' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(grants).toEqual([['run-s', 'always', 3, 'ann (human)', 4]]);
    expect(stored()['standInReview']).toBe('always');
    expect(stored()['standInConsent']).toMatchObject({ scope: 'always', by: 'ann (human)', via: 'setting' });
    // …and a later launch by a workload token names her.
    await launch();
    expect(launched[0]?.standIn).toMatchObject({ scope: 'always', by: 'ann (human)', via: 'setting' });
  });

  it('saving always again keeps the person who turned it on; saving ask clears it', async () => {
    await put({ standInReview: 'always' });
    const first = stored()['standInConsent'];
    expect((await put({ standInReview: 'always', graphNodeLimit: 120 }, 'omar/human/admin')).statusCode).toBe(200);
    expect(stored()['graphNodeLimit']).toBe(120);
    expect(stored()['standInConsent']).toEqual(first);
    await put({ standInReview: 'ask' }, 'omar/human/admin');
    expect(stored()).not.toHaveProperty('standInConsent');
    await put({ standInReview: 'always' }, 'omar/human/admin');
    expect(stored()['standInConsent']).toMatchObject({ by: 'omar (human)' });
  });

  it('a body cannot write the consent: it is dropped and the stored one stays', async () => {
    await put({ standInReview: 'always' });
    const first = stored()['standInConsent'];
    const res = await put({ standInConsent: { scope: 'always', by: 'mallory (human)', at: 1, via: 'setting' } }, 'omar/human/admin');
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.standInConsent).toEqual(first);
    expect(stored()['standInConsent']).toEqual(first);
    // Not even beside a save of the setting itself.
    await put({ standInReview: 'ask' }, 'omar/human/admin');
    await put({ standInReview: 'always', standInConsent: { scope: 'always', by: 'mallory (human)', at: 1, via: 'setting' } }, 'omar/human/admin');
    expect(stored()['standInConsent']).toMatchObject({ by: 'omar (human)' });
  });

  it('a setting saved before its author was recorded says so, and a malformed record reads as that', async () => {
    writeFileSync(file, JSON.stringify({ standInReview: 'always' }, null, 2));
    await launch();
    expect(launched[0]?.standIn).toMatchObject({ scope: 'always', by: STAND_IN_SETTING_UNRECORDED, via: 'setting' });
    // Out of shape, or a record the engine would refuse (a blank author, a timestamp that is not an i64 of ms).
    const bad = [{ scope: 'job', by: 7 }, { scope: 'always', by: '   ', at: 5, via: 'setting' }, { scope: 'always', by: 'x (human)', at: 1.5, via: 'setting' },
      { scope: 'always', by: 'x (human)', at: 1e100, via: 'setting' }];
    for (const [i, standInConsent] of bad.entries()) {
      writeFileSync(file, JSON.stringify({ standInReview: 'always', standInConsent }, null, 2));
      await launch();
      expect(launched[i + 1]?.standIn).toMatchObject({ scope: 'always', by: STAND_IN_SETTING_UNRECORDED, via: 'setting' });
    }
    // A person's next save of always repairs it: there was no valid author to keep.
    expect((await put({ standInReview: 'always' })).statusCode).toBe(200);
    expect(stored()['standInConsent']).toMatchObject({ by: 'priya (human)' });
  });
});
