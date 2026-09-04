// crew#293 — launchRun threads deliver:"pr" as PER-RUN workflow composition.
//
// What must hold, and what these tests pin:
//   - deliver:"pr" + a workflow ⇒ ONE composed def is hot-registered with the engine (base
//     phases + deliver appended once) and the launch runs the composed id;
//   - the SHARED def is untouched, nothing lands in the overlay dir, and the catalog
//     (listWorkflows) never grows a per-run entry;
//   - without deliver, the launch is byte-for-byte the old path (no registration);
//   - deliver without a workflow, or with an unknown workflow, REJECTS before launch.
//
// Same fake-engine technique as register-workflow-atomic.test.ts: own properties shadow the
// napi prototype methods, so the assertions are about crew's composition behaviour, not the
// engine's.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../src/core/adapter.js';
import { DELIVER_PHASE_ID } from '../src/core/deliver.js';
import type { LaunchOptions } from 'wicked-core-ts';
import type { PhaseDef, WorkflowDef } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

let dir: string;
let overlayDir: string;
let priorOverlayDir: string | undefined;
let adapter: CoreAdapter;
let registered: string[];
let launched: LaunchOptions[];

/** Shadow a napi prototype method with an own property (delete would silently keep the real one). */
function stubCore(a: CoreAdapter, name: string, impl: unknown) {
  (a as unknown as { core: Record<string, unknown> }).core[name] = impl;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deliver-launch-'));
  overlayDir = join(dir, 'workflows');
  mkdirSync(overlayDir, { recursive: true });
  priorOverlayDir = process.env['WICKED_WORKFLOWS_DIR'];
  process.env['WICKED_WORKFLOWS_DIR'] = overlayDir;
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  registered = [];
  launched = [];
  stubCore(adapter, 'registerWorkflow', (json: string) => {
    registered.push(json);
    return Promise.resolve('ok');
  });
  stubCore(adapter, 'launchRun', (opts: LaunchOptions) => {
    launched.push(opts);
    return Promise.resolve(opts.sessionId);
  });
});

afterEach(() => {
  if (priorOverlayDir === undefined) delete process.env['WICKED_WORKFLOWS_DIR'];
  else process.env['WICKED_WORKFLOWS_DIR'] = priorOverlayDir;
  adapter.close();
  removeScratch(dir);
});

describe('launchRun with deliver:"pr" (crew#293)', () => {
  it('arms ONE composed per-run def and launches its id, leaving the shared def alone', async () => {
    const sharedBefore = JSON.stringify(adapter.getWorkflow('feature'));

    const runId = await adapter.launchRun({
      problem: 'p',
      sessionId: 'run-xyz',
      clisJson: '[]',
      workflow: 'feature',
      deliver: 'pr',
    });
    expect(runId).toBe('run-xyz');

    // Exactly one hot registration, of the composed def: base phases + deliver appended once.
    expect(registered).toHaveLength(1);
    const def = JSON.parse(registered[0]!) as WorkflowDef;
    expect(def.id).toBe('feature-deliver-run-xyz');
    expect(def.phases.map((p: PhaseDef) => p.id)).toEqual([
      'clarify', 'design', 'build', 'adversarial-review', 'test', 'review', DELIVER_PHASE_ID,
    ]);
    expect(def.phases.filter((p: PhaseDef) => p.id === DELIVER_PHASE_ID)).toHaveLength(1);

    // The launch ran the composed id, not the base.
    expect(launched).toHaveLength(1);
    expect(launched[0]!.workflow).toBe('feature-deliver-run-xyz');

    // The shared def is untouched, the overlay dir stays empty (per-run defs are hot-only),
    // and the catalog never shows the per-run id.
    expect(JSON.stringify(adapter.getWorkflow('feature'))).toBe(sharedBefore);
    expect(readdirSync(overlayDir)).toEqual([]);
    expect(adapter.listWorkflows().map((w) => w.id)).not.toContain('feature-deliver-run-xyz');
  });

  it('two delivered launches compose two independent defs — no cross-run sharing', async () => {
    await adapter.launchRun({ problem: 'p', sessionId: 'run-a', clisJson: '[]', workflow: 'feature', deliver: 'pr' });
    await adapter.launchRun({ problem: 'p', sessionId: 'run-b', clisJson: '[]', workflow: 'feature', deliver: 'pr' });

    const ids = registered.map((j) => (JSON.parse(j) as WorkflowDef).id);
    expect(ids).toEqual(['feature-deliver-run-a', 'feature-deliver-run-b']);
    // Each composed def still carries exactly one deliver phase — appending is per-run,
    // never cumulative on a shared object.
    for (const j of registered) {
      const def = JSON.parse(j) as WorkflowDef;
      expect(def.phases.filter((p: PhaseDef) => p.id === DELIVER_PHASE_ID)).toHaveLength(1);
    }
  });

  it('without deliver, nothing is registered and the base id launches (the old path)', async () => {
    await adapter.launchRun({ problem: 'p', sessionId: 'run-1', clisJson: '[]', workflow: 'feature' });
    expect(registered).toEqual([]);
    expect(launched[0]!.workflow).toBe('feature');
  });

  it('deliver:"pr" without a workflow rejects before anything launches', async () => {
    await expect(
      adapter.launchRun({ problem: 'p', sessionId: 'run-1', clisJson: '[]', deliver: 'pr' }),
    ).rejects.toThrow(/requires a workflow/);
    expect(launched).toEqual([]);
    expect(registered).toEqual([]);
  });

  it('deliver:"pr" with an unknown workflow rejects before anything launches', async () => {
    await expect(
      adapter.launchRun({
        problem: 'p',
        sessionId: 'run-1',
        clisJson: '[]',
        workflow: 'no-such-workflow',
        deliver: 'pr',
      }),
    ).rejects.toThrow(/not registered/);
    expect(launched).toEqual([]);
    expect(registered).toEqual([]);
  });

  it('a user def that already delivers launches AS-IS — no second deliver phase', async () => {
    // Register an operator's own feature-pr-style def (its last phase is already `deliver`).
    const userDef = {
      id: 'feature-pr-style',
      phases: [
        { id: 'build', executor: { type: 'tool', cmd: ['true'] } },
        { id: DELIVER_PHASE_ID, executor: { type: 'tool', cmd: ['true'] } },
      ],
    } as unknown as WorkflowDef;
    await adapter.registerWorkflow(userDef);
    const registrationsBeforeLaunch = registered.length; // registerWorkflow validates via the same binding

    await adapter.launchRun({
      problem: 'p',
      sessionId: 'run-1',
      clisJson: '[]',
      workflow: 'feature-pr-style',
      deliver: 'pr',
    });

    expect(registered.length).toBe(registrationsBeforeLaunch); // no per-run composition happened
    expect(launched[0]!.workflow).toBe('feature-pr-style');
  });
});
