/**
 * crew#1934: a run made on THIS daemon must read as this daemon's rule store.
 *
 * Studio decides "this daemon's store or another" by comparing two wire strings: a recorded run's
 * `rule_store` (GET /testing/evals[/:id]) and the `core.db` path GET /diagnostics lists. Diagnostics
 * is home-masked (`~/…`, the ui-text backstop), so a run recorded with the absolute path never matched
 * on a daemon whose store lives under the home directory: every run was tagged "another rule store".
 *
 * These cases pin the two route shapes together on one scratch daemon whose store lives under a
 * scratch HOME, through the product's own routes: the run route records the run, the read routes and
 * diagnostics answer it.
 */
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import type { CoreAdapter } from '../src/core/adapter.js';
import type { GovernanceEvalReport } from '../src/core/types.js';
import { createServer } from '../src/api/server.js';
import { removeScratch } from './setup/scratch.js';

const REPORT: GovernanceEvalReport = {
  results: [
    {
      sample: { id: 'S-001', description: 'writes production config during the build phase', kind: 'bad', steering_type: 'security' },
      expected: 'deny',
      fired: ['POL-007'],
      verdict: 'caught',
    },
  ],
  summary: { total: 1, caught: 1, gaps: 0, false_positives: 0 },
  degraded: null,
};

const HOME_KEYS = ['HOME', 'USERPROFILE', 'LOG_LEVEL'] as const;
const saved: Record<string, string | undefined> = {};

let scratch: string;
let home: string;
let evalsRoot: string;

async function daemon(dbPath: string): Promise<FastifyInstance> {
  const adapter = {
    stub: true,
    dbPath,
    projectsSupported: () => false,
    getSettings: async () => ({}),
    onLaunch: (): (() => void) => () => undefined,
    onEvent: () => () => {},
    governanceEvalsSupported: () => true,
    runGovernanceEvals: async () => REPORT,
  } as unknown as CoreAdapter;
  const app = await createServer(adapter, {
    auth: { mode: 'off' },
    auditPath: join(scratch, `audit-${Math.random().toString(36).slice(2)}.log`),
    evalStoreRoot: evalsRoot,
    projectEvents: { disabled: true },
    interactiveWsRelay: { disabled: true },
    stallWatchdog: { enabled: false },
  });
  await app.ready();
  return app;
}

async function daemonStore(app: FastifyInstance): Promise<string> {
  const res = await app.inject({ method: 'GET', url: '/api/v1/diagnostics' });
  expect(res.statusCode).toBe(200);
  const stores = (res.json() as { stores: Array<{ name: string; path: string }> }).stores;
  const core = stores.find((s) => s.name === 'core.db');
  expect(core, 'diagnostics lists core.db').toBeDefined();
  return core!.path;
}

async function runs(app: FastifyInstance, corpus: string): Promise<Array<Record<string, unknown>>> {
  const res = await app.inject({ method: 'GET', url: `/api/v1/testing/evals?corpus=${encodeURIComponent(corpus)}` });
  expect(res.statusCode).toBe(200);
  return (res.json() as { runs: Array<Record<string, unknown>> }).runs;
}

async function detail(app: FastifyInstance, id: string): Promise<Record<string, unknown>> {
  const res = await app.inject({ method: 'GET', url: `/api/v1/testing/evals/${id}` });
  expect(res.statusCode).toBe(200);
  return res.json() as Record<string, unknown>;
}

async function runOnce(app: FastifyInstance, corpus: string): Promise<void> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/testing/evals/run', payload: { corpus } });
  expect(res.statusCode).toBe(200);
}

beforeAll(() => {
  for (const k of HOME_KEYS) saved[k] = process.env[k];
  process.env['LOG_LEVEL'] = 'error';
  scratch = mkdtempSync(join(tmpdir(), 'crew-eval-rule-store-'));
  home = join(scratch, 'home');
  mkdirSync(home);
  // `os.homedir()` reads these, and the diagnostics backstop masks the home it names.
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  evalsRoot = join(scratch, 'evals');
});

afterAll(() => {
  for (const k of HOME_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  removeScratch(scratch);
});

describe('crew#1934: a run made on this daemon names the same store diagnostics does', () => {
  it('a store under the home directory: the recorded run and diagnostics core.db compare equal, masked', async () => {
    const stateHome = join(home, '.wicked-crew');
    mkdirSync(stateHome, { recursive: true });
    const db = join(stateHome, 'core.db');
    writeFileSync(db, 'not-a-real-sqlite-file', 'utf8');
    const app = await daemon(db);
    try {
      await runOnce(app, 'evals:home-store');
      const store = await daemonStore(app);
      const [row] = await runs(app, 'evals:home-store');
      expect(row).toBeDefined();
      // The pin: studio's comparison of these two strings is what decides "this daemon's store".
      expect(row!['rule_store']).toBe(store);
      expect((await detail(app, row!['id'] as string))['rule_store']).toBe(store);
      // And neither carries the home directory: masked for display, on both routes.
      expect(store.startsWith('~')).toBe(true);
      for (const s of [String(row!['rule_store']), store]) {
        expect(s.includes(home)).toBe(false);
        expect(s.includes(realpathSync(home))).toBe(false);
      }
    } finally {
      await app.close();
    }
  });

  it('a history row recorded before the fix (absolute path) also reads as this daemon store', async () => {
    const stateHome = join(home, 'legacy-home');
    mkdirSync(stateHome, { recursive: true });
    const db = join(stateHome, 'core.db');
    writeFileSync(db, 'x', 'utf8');
    // The exact rollup line the pre-fix run route wrote (testing.ts `rule_store: adapter.dbPath`,
    // appended by EvalRunStore.writeRun), plus its detail file.
    const row = { id: 'legacy-1', created_at: 1_700_000_000, actor: 'local', corpus: 'evals:legacy', type_filter: null, rule_store: db, summary: REPORT.summary, per_type: {}, degraded: null };
    mkdirSync(join(evalsRoot, 'results'), { recursive: true });
    writeFileSync(join(evalsRoot, 'results', 'legacy-1.json'), JSON.stringify({ ...row, results: REPORT.results }), 'utf8');
    appendFileSync(join(evalsRoot, 'runs.jsonl'), `${JSON.stringify(row)}\n`, 'utf8');
    const app = await daemon(db);
    try {
      const store = await daemonStore(app);
      const [listed] = await runs(app, 'evals:legacy');
      expect(listed!['rule_store']).toBe(store);
      expect((await detail(app, 'legacy-1'))['rule_store']).toBe(store);
    } finally {
      await app.close();
    }
  });

  it('the same store reached through a symlink reads as this daemon store (canonical, not textual)', async () => {
    const real = join(home, 'real-state');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'core.db'), 'x', 'utf8');
    const link = join(home, 'linked-state');
    symlinkSync(real, link, 'dir');
    // The run was recorded under the real spelling; this daemon was started on the link.
    const row = { id: 'sym-1', created_at: 1_700_000_001, actor: 'local', corpus: 'evals:sym', type_filter: null, rule_store: join(real, 'core.db'), summary: REPORT.summary, per_type: {}, degraded: null };
    mkdirSync(join(evalsRoot, 'results'), { recursive: true });
    writeFileSync(join(evalsRoot, 'results', 'sym-1.json'), JSON.stringify({ ...row, results: REPORT.results }), 'utf8');
    appendFileSync(join(evalsRoot, 'runs.jsonl'), `${JSON.stringify(row)}\n`, 'utf8');
    const app = await daemon(join(link, 'core.db'));
    try {
      const store = await daemonStore(app);
      const [listed] = await runs(app, 'evals:sym');
      expect(listed!['rule_store']).toBe(store);
    } finally {
      await app.close();
    }
  });

  it('a run judged against ANOTHER store still reads as another store, home-masked', async () => {
    const mine = join(home, 'mine');
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, 'core.db'), 'x', 'utf8');
    const theirs = join(home, 'harness-copy', 'core.db');
    const row = { id: 'other-1', created_at: 1_700_000_002, actor: 'local', corpus: 'evals:other', type_filter: null, rule_store: theirs, summary: REPORT.summary, per_type: {}, degraded: null };
    mkdirSync(join(evalsRoot, 'results'), { recursive: true });
    writeFileSync(join(evalsRoot, 'results', 'other-1.json'), JSON.stringify({ ...row, results: REPORT.results }), 'utf8');
    appendFileSync(join(evalsRoot, 'runs.jsonl'), `${JSON.stringify(row)}\n`, 'utf8');
    const app = await daemon(join(mine, 'core.db'));
    try {
      const store = await daemonStore(app);
      const [listed] = await runs(app, 'evals:other');
      expect(listed!['rule_store']).not.toBe(store);
      expect(listed!['rule_store']).toBe('~/harness-copy/core.db');
      expect((await detail(app, 'other-1'))['rule_store']).toBe('~/harness-copy/core.db');
    } finally {
      await app.close();
    }
  });
});
