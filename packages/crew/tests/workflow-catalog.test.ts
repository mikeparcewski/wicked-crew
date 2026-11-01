// wf-catalog (api-types 0.168.0): `GET /workflows/catalog` — the categorised workflow catalog with the
// requesting operator's usage. The seeds are the ONE place browsing metadata lives; what a workflow is
// (title, summary, use-when) stays on its def; usage is derived from runs + the launch trail's principal.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import { RunTimingIndex, recordRunLaunched } from '../src/api/run-timing-index.js';
import { AuditLog } from '../src/api/audit.js';
import { buildWorkflowCatalog, TOP_MAX, type CatalogRun } from '../src/workflow-catalog/build.js';
import { CATALOG_CATEGORIES, CATALOG_EXCLUDED, CATALOG_SEEDS } from '../src/workflow-catalog/catalog-data.js';
import type { Preset, WorkflowCatalogResponse, WorkflowDef } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

const def = (id: string, extra: Partial<WorkflowDef> = {}): WorkflowDef => ({
  id,
  phases: [{ id: 'p', executes_code: false } as unknown as WorkflowDef['phases'][number]],
  title: `T ${id}`,
  summary: `S ${id}`,
  use_when: [`u ${id}`],
  ...extra,
});
const builtin = (name: string): Preset => ({ name, scope: 'global', steps: [{ catalog: 'understand', id: 'u' }], created_by: 'builtin', updated_at: 1 } as Preset);
const RUN_IDS = CATALOG_SEEDS.flatMap((s) => (s.launch.kind === 'run' ? [s.launch.workflow] : []));

/** Every seeded run workflow served as a built-in, plus `extra`. */
function served(extra: WorkflowDef[] = []): { defs: WorkflowDef[]; presets: Preset[] } {
  return { defs: [...RUN_IDS.map((id) => def(id)), ...extra], presets: RUN_IDS.map(builtin) };
}

let n = 0;
const run = (workflow: string | null, over: Partial<CatalogRun> = {}): CatalogRun => ({
  id: `r${++n}`,
  workflow,
  projectId: null,
  status: 'completed',
  createdAt: 1_800_000_000,
  endedAt: 1_800_000_600,
  principal: 'local',
  ...over,
});

describe('the catalog seeds (one source of truth)', () => {
  it('ids are unique, every subcategory belongs to its category, and run seeds repeat nothing their def says', () => {
    const ids = CATALOG_SEEDS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of CATALOG_SEEDS) {
      const cat = CATALOG_CATEGORIES.find((c) => c.id === s.category);
      expect(cat, s.id).toBeDefined();
      if (s.subcategory !== null) expect(cat!.subcategories.map((x) => x.id), s.id).toContain(s.subcategory);
      if (s.launch.kind === 'run') {
        expect(s.launch.workflow, s.id).toBe(s.id);
        expect([s.title, s.summary, s.useWhen, s.status], s.id).toEqual([undefined, undefined, undefined, undefined]);
      } else {
        expect(s.title && s.summary, s.id).toBeTruthy();
      }
      if (s.status === 'coming_soon') expect(s.launch.kind, s.id).toBe('none');
      expect(s.outcome.length, s.id).toBeGreaterThan(0);
    }
  });

  it("covers the operator's taxonomy: every subcategory of create/resolve/analyze/test has a card", () => {
    for (const c of CATALOG_CATEGORIES.filter((x) => ['create', 'resolve', 'analyze', 'test'].includes(x.id))) {
      for (const sub of c.subcategories) {
        expect(CATALOG_SEEDS.some((s) => s.category === c.id && s.subcategory === sub.id), `${c.id}/${sub.id}`).toBe(true);
      }
    }
  });
});

describe('buildWorkflowCatalog', () => {
  it('takes a run entry\'s title, summary and use-when from its def, and QE from its instruments', () => {
    const { defs, presets } = served();
    defs[defs.findIndex((d) => d.id === 'feature')] = def('feature', { required_instruments: ['distinct_evaluator', 'judge', 'qe_acceptance'] });
    const out = buildWorkflowCatalog({ defs, presets, runs: [], actorId: 'local', projectId: null });
    const feature = out.entries.find((e) => e.id === 'feature')!;
    expect([feature.title, feature.summary, feature.useWhen, feature.requiresQe, feature.source, feature.status]).toEqual(['T feature', 'S feature', ['u feature'], true, 'builtin', 'available']);
    expect(out.entries.find((e) => e.id === 'bug')!.requiresQe).toBe(false);
  });

  it('marks a seeded workflow the engine does not serve unavailable, never drops it', () => {
    const { defs, presets } = served();
    const out = buildWorkflowCatalog({ defs: defs.filter((d) => d.id !== 'test-plan'), presets, runs: [], actorId: 'local', projectId: null });
    const e = out.entries.find((x) => x.id === 'test-plan')!;
    expect([e.status, e.title]).toEqual(['unavailable', 'test-plan']);
    expect(e.statusNote).toMatch(/does not serve/);
  });

  it('lists coming-soon cards unlaunchable, and studio flows with their own launch kind', () => {
    const { defs, presets } = served();
    const out = buildWorkflowCatalog({ defs, presets, runs: [], actorId: 'local', projectId: null });
    const create = out.entries.find((e) => e.id === 'create-app')!;
    expect([create.status, create.launch, create.source]).toEqual(['coming_soon', { kind: 'none' }, 'none']);
    expect(out.entries.find((e) => e.id === 'presentation')!.launch).toEqual({ kind: 'document', style: 'ppt' });
    expect(out.entries.find((e) => e.id === 'demo-video')!.launch).toEqual({ kind: 'demo' });
  });

  it('never loses a launchable workflow: an unseeded non-system def joins more; system and excluded ones do not', () => {
    const { defs, presets } = served([def('brand-new'), def('chat', { is_system: true }), def('distill-learnings')]);
    expect(CATALOG_EXCLUDED['distill-learnings']).toBeDefined();
    const out = buildWorkflowCatalog({ defs, presets, runs: [], actorId: 'local', projectId: null });
    const fresh = out.entries.find((e) => e.id === 'brand-new')!;
    expect([fresh.category, fresh.title, fresh.launch]).toEqual(['more', 'T brand-new', { kind: 'run', workflow: 'brand-new' }]);
    expect(out.entries.some((e) => e.id === 'chat' || e.id === 'distill-learnings')).toBe(false);
  });

  it('lists saved presets under yours (only then is the category served); a saved row shadowing a card is not doubled', () => {
    const { defs, presets } = served();
    const none = buildWorkflowCatalog({ defs, presets, runs: [], actorId: 'local', projectId: null });
    expect(none.categories.map((c) => c.id)).toEqual(['create', 'resolve', 'analyze', 'test', 'more']);
    const saved = [
      ...presets,
      { name: 'my-flow', scope: 'global', steps: [{ catalog: 'build', id: 'b' }], created_by: 'api', updated_at: 2 } as Preset,
      { name: 'feature', scope: 'project:p', steps: [{ catalog: 'understand', id: 'u' }], created_by: 'api', updated_at: 2 } as Preset,
    ];
    const out = buildWorkflowCatalog({ defs, presets: saved, runs: [], actorId: 'local', projectId: 'p' });
    expect(out.categories.map((c) => c.id)).toContain('yours');
    const mine = out.entries.filter((e) => e.category === 'yours');
    expect(mine.map((e) => [e.id, e.source, e.delivers])).toEqual([['my-flow', 'saved', 'pr']]);
    expect(out.entries.filter((e) => e.id === 'feature')).toHaveLength(1);
  });

  it('orders entries by category, then subcategory, then catalog order', () => {
    const { defs, presets } = served();
    const out = buildWorkflowCatalog({ defs, presets, runs: [], actorId: 'local', projectId: null });
    const order = ['create', 'resolve', 'analyze', 'test', 'more', 'yours'];
    const cats = out.entries.map((e) => order.indexOf(e.category));
    expect([...cats].sort((a, b) => a - b)).toEqual(cats);
    expect(out.entries.filter((e) => e.category === 'create').map((e) => e.subcategory)[0]).toBe('create');
  });

  it("counts only this principal's launches, skips retries and system launchers, and filters by project", () => {
    const { defs, presets } = served();
    const runs = [
      run('bug', { createdAt: 1_800_000_000, endedAt: 1_800_000_600 }),
      run('bug', { createdAt: 1_800_100_000, endedAt: 1_800_101_200, projectId: 'p' }),
      run('bug', { status: 'failed', createdAt: 1_800_200_000, endedAt: undefined }),
      run('bug', { retryOf: 'r1' }),
      run('bug', { principal: 'someone-else' }),
      run('review-recent-work', { principal: 'workflow-schedule' }),
      run('demo', { createdAt: 1_800_000_100 }),
      run(null),
    ];
    const out = buildWorkflowCatalog({ defs, presets, runs, actorId: 'local', projectId: null });
    const bug = out.entries.find((e) => e.id === 'bug')!;
    expect(bug.usage).toEqual({ launches: 3, lastUsedAt: new Date(1_800_200_000 * 1000).toISOString(), medianMinutes: 15 });
    expect(out.entries.find((e) => e.id === 'review-recent-work')!.usage.launches).toBe(0);
    expect(out.entries.find((e) => e.id === 'demo-video')!.usage.launches).toBe(1);
    expect(out.usage).toEqual({ scope: 'operator', projectId: null, actorId: 'local', launches: 4 });
    const inP = buildWorkflowCatalog({ defs, presets, runs, actorId: 'local', projectId: 'p' });
    expect(inP.entries.find((e) => e.id === 'bug')!.usage.launches).toBe(1);
    expect(inP.usage.scope).toBe('project');
  });

  it(`serves "your top": available entries with launches, by launches then recency, at most ${TOP_MAX}`, () => {
    const { defs, presets } = served();
    const runs = [
      ...['bug', 'bug', 'bug'].map((w) => run(w)),
      run('feature', { createdAt: 1_800_000_000 }),
      run('migration', { createdAt: 1_800_500_000 }),
      ...['docs', 'test-plan', 'validate-docs', 'test-analysis', 'qe-author-tests'].map((w) => run(w)),
      run('create-app'),
    ];
    const out = buildWorkflowCatalog({ defs, presets, runs, actorId: 'local', projectId: null });
    expect(out.top).toHaveLength(TOP_MAX);
    expect(out.top.slice(0, 2)).toEqual(['bug', 'migration']);
    expect(out.top).not.toContain('create-app');
    expect(buildWorkflowCatalog({ defs, presets, runs: [], actorId: 'local', projectId: null }).top).toEqual([]);
  });
});

describe('the launch principal (the usage key)', () => {
  it('is recorded live by recordRunLaunched and rehydrated from the trail', () => {
    const idx = new RunTimingIndex();
    recordRunLaunched(AuditLog.noop(), idx, { id: 'alice', kind: 'human', trust: 'admin' } as never, 'run-a', {});
    expect(idx.principalFor('run-a')).toBe('alice');
    const again = new RunTimingIndex();
    again.hydrateFromLaunchEntries([
      { ts: 1, action: 'run.launched', actor: { id: 'bob', kind: 'human', trust: 'admin' }, runId: 'run-b' } as never,
    ]);
    expect(again.principalFor('run-b')).toBe('bob');
    expect(again.principalFor('run-a')).toBeUndefined();
  });
});

describe('GET /workflows/catalog (booted daemon)', () => {
  let dir: string;
  let adapter: CoreAdapter;
  let app: Awaited<ReturnType<typeof createServer>> | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'workflow-catalog-'));
    adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    adapter.close();
    removeScratch(dir);
  });

  it('serves the catalog, says so on health, and refuses a malformed projectId', async () => {
    await adapter.loadBuiltinCatalog(() => {});
    app = await createServer(adapter, { auditPath: join(dir, 'audit.log') });
    const res = await app.inject({ method: 'GET', url: '/api/v1/workflows/catalog' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as WorkflowCatalogResponse;
    expect(body.categories.slice(0, 4).map((c) => c.id)).toEqual(['create', 'resolve', 'analyze', 'test']);
    const feature = body.entries.find((e) => e.id === 'feature')!;
    expect([feature.status, feature.launch]).toEqual(['available', { kind: 'run', workflow: 'feature' }]);
    expect(body.usage.actorId).toBe('local');
    expect(body.top).toEqual([]);
    const health = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect((health.json() as { capabilities: Record<string, unknown> }).capabilities['workflowCatalog']).toBe(true);
    const bad = await app.inject({ method: 'GET', url: '/api/v1/workflows/catalog?projectId=x&projectId=y' });
    expect(bad.statusCode).toBe(400);
    // `/workflows/:id` still answers its own route.
    expect((await app.inject({ method: 'GET', url: '/api/v1/workflows/feature' })).statusCode).toBe(200);
  });
});
