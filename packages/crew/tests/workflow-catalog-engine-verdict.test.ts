// crew#718 regression: `GET /workflows` must serve the catalog the ENGINE will honour.
//
// From the MCP S8 dogfood (F-3). A hand-authored drop-in at `$WICKED_WORKFLOWS_DIR/
// mcp-s8-dogfood.json` declared `executes_code: true` on an auto-gated phase with no
// `validator_pin`, so wicked-core refused it at boot and said exactly why:
//
//   wicked-core: skipping workflow file …/mcp-s8-dogfood.json: gate evaluates nothing:
//    write-a-note — the phase declares executes_code but pins no validator and has no human
//    gate, so its gate would approve with nothing checked.
//
// `GET /api/v1/workflows` listed it anyway — `readOverlayWorkflows` only checks a
// `{id, phases[]}` shape — studio offered it in the selector, and the launch 400'd
// `unknown workflow`. The operator learnt about the refusal from the failed launch, not from
// the catalog, and never saw core's reason.
//
// The fix asks core's own parser, which is the doctrine `registerWorkflow` already states for
// the WRITE path: a refused def leaves `workflows` and appears in `unavailable` with core's
// verbatim reason. `stub: true` is the real engine in offline mode, so the verdict below is
// core's, not a TypeScript re-implementation of `WorkflowDef::validate()`.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter, judgeOverlayWorkflows } from '../src/core/adapter.js';
import type { WorkflowDef } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

/** The dogfood's def, reduced to the one property that made core refuse it. */
const UNGATED = {
  id: 'dogfood-ungated',
  phases: [
    {
      id: 'write-a-note',
      kind: 'build',
      role: 'creator',
      gate: 'auto',
      gate_type: 'execution',
      executes_code: true,
    },
  ],
};

/** A drop-in core accepts — the control, so the fix cannot pass by emptying the catalog. */
const SOUND = {
  id: 'dogfood-sound',
  phases: [
    { id: 'explore', kind: 'recon' },
    { id: 'prototype', kind: 'build', depends_on: ['explore'] },
  ],
};

let adapter: CoreAdapter;
let dir: string;
let priorOverlayDir: string | undefined;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wf-verdict-'));
  const overlayDir = join(dir, 'workflows');
  priorOverlayDir = process.env['WICKED_WORKFLOWS_DIR'];
  process.env['WICKED_WORKFLOWS_DIR'] = overlayDir;
  // Written before the adapter exists, exactly as a drop-in reaches the dir: by hand.
  mkdirSync(overlayDir, { recursive: true });
  writeFileSync(join(overlayDir, 'dogfood-ungated.json'), JSON.stringify(UNGATED, null, 2), 'utf8');
  writeFileSync(join(overlayDir, 'dogfood-sound.json'), JSON.stringify(SOUND, null, 2), 'utf8');
  adapter = new CoreAdapter({ dbPath: join(dir, 'verdict.db'), stub: true });
  await adapter.loadBuiltinCatalog(() => {});
});

afterAll(() => {
  if (priorOverlayDir === undefined) delete process.env['WICKED_WORKFLOWS_DIR'];
  else process.env['WICKED_WORKFLOWS_DIR'] = priorOverlayDir;
  if (adapter) adapter.close();
  if (dir) removeScratch(dir);
});

it('the catalog omits a drop-in the engine refused and names core\'s reason', async () => {
  const { workflows, unavailable } = await adapter.workflowCatalog();

  const refused = unavailable.find((w) => w.id === 'dogfood-ungated');
  expect(refused, `the refused drop-in must be reported; got ${JSON.stringify(unavailable)}`).toBeDefined();
  expect(refused!.reason, 'core\'s own words, so the author knows what to fix').toMatch(/gate evaluates nothing/);

  expect(
    workflows.find((w) => w.id === 'dogfood-ungated'),
    'a def the engine refused must not be offered — the launch would 400 `unknown workflow`',
  ).toBeUndefined();
  expect(
    adapter.listWorkflows().find((w) => w.id === 'dogfood-ungated'),
    'and it must be gone from every other reader of the catalog too',
  ).toBeUndefined();

  // The control: a sound drop-in survives, and the built-ins are untouched.
  expect(workflows.find((w) => w.id === 'dogfood-sound')).toBeDefined();
  expect(unavailable.find((w) => w.id === 'dogfood-sound')).toBeUndefined();
  expect(workflows.find((w) => w.id === 'feature')).toBeDefined();
});

it('workflowRefusal judges on FIRST call, so a by-id lookup never serves a refused def', async () => {
  // (review of PR #724, MEDIUM) `GET /workflows/:id` reads the refusal BEFORE `getWorkflow`,
  // because `getWorkflow` only hydrates the overlay dir. A fresh adapter that is asked by id
  // first — the launch's own lookup path — must not answer with the def the engine threw away.
  const fresh = new CoreAdapter({ dbPath: join(dir, 'byid.db'), stub: true });
  try {
    expect(await fresh.workflowRefusal('dogfood-ungated')).toMatch(/gate evaluates nothing/);
    expect(
      fresh.getWorkflow('dogfood-ungated'),
      'the verdict pass ran, so every later sync reader is clean too',
    ).toBeNull();
    expect(fresh.getWorkflow('dogfood-sound')).not.toBeNull();
  } finally {
    fresh.close();
  }
});

it('workflowRefusal answers for the refused id only', async () => {
  expect(await adapter.workflowRefusal('dogfood-ungated')).toMatch(/gate evaluates nothing/);
  expect(await adapter.workflowRefusal('dogfood-sound')).toBeNull();
  expect(await adapter.workflowRefusal('feature')).toBeNull();
  expect(await adapter.workflowRefusal('no-such-workflow')).toBeNull();
});

it('judgeOverlayWorkflows strips is_system and reports the engine\'s message verbatim', async () => {
  const seen: string[] = [];
  const register = async (json: string): Promise<string> => {
    seen.push(json);
    const def = JSON.parse(json) as { id: string };
    if (def.id === 'bad') throw new Error('gate evaluates nothing: p — pin a validator');
    return def.id;
  };
  const defs = [
    { id: 'good', phases: [], is_system: true },
    { id: 'bad', phases: [] },
  ] as unknown as WorkflowDef[];

  const { accepted, refused } = await judgeOverlayWorkflows(defs, register);

  expect(accepted.map((d) => d.id)).toEqual(['good']);
  expect(refused).toEqual([{ id: 'bad', reason: 'gate evaluates nothing: p — pin a validator' }]);
  // `is_system` is crew's display flag; core's strict def parser rejects the key, so every write
  // path strips it and so must this read path — otherwise EVERY def would be "refused".
  expect(seen.some((j) => j.includes('is_system')), `offered: ${seen.join(' | ')}`).toBe(false);
});
