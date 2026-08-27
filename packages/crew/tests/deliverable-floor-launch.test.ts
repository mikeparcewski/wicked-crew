// crew#311 — launchRun threads requireDeliverables as PER-RUN workflow composition.
//
// What must hold, and what these tests pin:
//   - requireDeliverables + a workflow ⇒ ONE composed def is hot-registered (base phases + the
//     floor appended once) and the launch runs the composed id;
//   - the declared paths reach the floor's argv verbatim, so the phase checks the artifacts the
//     LAUNCHER named — not something re-derived downstream;
//   - the SHARED def is untouched, nothing lands in the overlay dir, the catalog never grows;
//   - combined with deliver:"pr", ONE def carries BOTH, floor BEFORE deliver — a run that
//     produced nothing must fail rather than open a PR over an empty branch;
//   - without requireDeliverables the launch is byte-for-byte the old path.
//
// Same fake-engine technique as deliver-launch.test.ts: own properties shadow the napi prototype
// methods, so the assertions are about crew's composition behaviour, not the engine's.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../src/core/adapter.js';
import { DELIVER_PHASE_ID } from '../src/core/deliver.js';
import { DELIVERABLE_FLOOR_PHASE_ID } from '../src/core/deliverable-floor.js';
import type { LaunchOptions } from 'wicked-core-ts';
import type { PhaseDef, WorkflowDef } from '../src/core/types.js';

let dir: string;
let overlayDir: string;
let priorOverlayDir: string | undefined;
let adapter: CoreAdapter;
let registered: string[];
let launched: LaunchOptions[];

function stubCore(a: CoreAdapter, name: string, impl: unknown) {
  (a as unknown as { core: Record<string, unknown> }).core[name] = impl;
}

/**
 * The floor phase of a registered composed def, the launch instant it judges freshness against,
 * and the paths it will actually check.
 *
 * argv after `node -e <script>` is `<launchedAtMs> <path...>` (crew#320).
 */
function floorOf(json: string): { phase: PhaseDef; launchedAtMs: number; checked: string[] } {
  const def = JSON.parse(json) as WorkflowDef;
  const phase = def.phases.find((p) => p.id === DELIVERABLE_FLOOR_PHASE_ID)!;
  const cmd = (phase.executor as { type: 'tool'; cmd: string[] }).cmd;
  return { phase, launchedAtMs: Number(cmd[3]), checked: cmd.slice(4) };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'floor-launch-'));
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
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('launchRun with requireDeliverables (crew#311)', () => {
  it('arms ONE composed per-run def whose floor checks exactly the declared paths', async () => {
    const sharedBefore = JSON.stringify(adapter.getWorkflow('feature'));

    const runId = await adapter.launchRun({
      problem: 'p',
      sessionId: 'run-xyz',
      clisJson: '[]',
      workflow: 'feature',
      requireDeliverables: ['/inbox/run-xyz/draft.html', '/inbox/run-xyz/fragments'],
    });
    expect(runId).toBe('run-xyz');

    expect(registered).toHaveLength(1);
    const def = JSON.parse(registered[0]!) as WorkflowDef;
    expect(def.id).toBe('feature-verified-run-xyz');
    expect(def.phases.map((p: PhaseDef) => p.id)).toEqual([
      'clarify', 'design', 'build', 'adversarial-review', 'test', 'review',
      DELIVERABLE_FLOOR_PHASE_ID,
    ]);

    // The floor checks what the LAUNCHER declared, verbatim and in order.
    expect(floorOf(registered[0]!).checked).toEqual([
      '/inbox/run-xyz/draft.html',
      '/inbox/run-xyz/fragments',
    ]);

    expect(launched).toHaveLength(1);
    expect(launched[0]!.workflow).toBe('feature-verified-run-xyz');

    // Shared def untouched, overlay dir empty, catalog clean — per-run defs are hot-only.
    expect(JSON.stringify(adapter.getWorkflow('feature'))).toBe(sharedBefore);
    expect(readdirSync(overlayDir)).toEqual([]);
    expect(adapter.listWorkflows().map((w) => w.id)).not.toContain('feature-verified-run-xyz');
  });

  it('combined with deliver:"pr": ONE def, ONE registration, floor BEFORE the PR phase', async () => {
    await adapter.launchRun({
      problem: 'p',
      sessionId: 'run-both',
      clisJson: '[]',
      workflow: 'feature',
      deliver: 'pr',
      requireDeliverables: ['/inbox/out.html'],
    });

    // One registration — composing twice would arm two ids and leave the first as engine litter.
    expect(registered).toHaveLength(1);
    const ids = (JSON.parse(registered[0]!) as WorkflowDef).phases.map((p: PhaseDef) => p.id);
    expect(ids.filter((id) => id === DELIVERABLE_FLOOR_PHASE_ID)).toHaveLength(1);
    expect(ids.filter((id) => id === DELIVER_PHASE_ID)).toHaveLength(1);
    // Order is the point: a run that produced nothing FAILS at the floor and never reaches the
    // phase that pushes a branch and opens a pull request.
    expect(ids.indexOf(DELIVERABLE_FLOOR_PHASE_ID)).toBeLessThan(ids.indexOf(DELIVER_PHASE_ID));
    expect(launched[0]!.workflow).toBe((JSON.parse(registered[0]!) as WorkflowDef).id);
  });

  // crew#320: the floor's freshness half is only real if the LAUNCH threads a live timestamp.
  // A placeholder, a zero, or a value copied from a previous composition would let the artifact
  // of a prior run over the same document-id-keyed path satisfy this run's floor.
  it('arms the floor with THIS launch\'s instant, so a prior run\'s artifact cannot satisfy it', async () => {
    const before = Date.now();
    await adapter.launchRun({
      problem: 'p',
      sessionId: 'run-fresh',
      clisJson: '[]',
      workflow: 'feature',
      requireDeliverables: ['/inbox/doc-42/draft.html'],
    });
    const after = Date.now();

    const { launchedAtMs } = floorOf(registered[0]!);
    expect(Number.isFinite(launchedAtMs)).toBe(true);
    expect(launchedAtMs).toBeGreaterThanOrEqual(before);
    expect(launchedAtMs).toBeLessThanOrEqual(after);
  });

  it('two floored launches compose two independent defs — no cross-run sharing', async () => {
    await adapter.launchRun({
      problem: 'p', sessionId: 'run-a', clisJson: '[]', workflow: 'feature',
      requireDeliverables: ['/inbox/a.html'],
    });
    await adapter.launchRun({
      problem: 'p', sessionId: 'run-b', clisJson: '[]', workflow: 'feature',
      requireDeliverables: ['/inbox/b.html'],
    });
    expect(registered.map((j) => (JSON.parse(j) as WorkflowDef).id)).toEqual([
      'feature-verified-run-a',
      'feature-verified-run-b',
    ]);
    expect(floorOf(registered[0]!).checked).toEqual(['/inbox/a.html']);
    expect(floorOf(registered[1]!).checked).toEqual(['/inbox/b.html']);
  });

  // The interactive seams' shape: their defs are USER workflows registered at arm time, not
  // built-ins, so composition has to resolve through `getWorkflow`'s userWorkflows/overlay path.
  it('composes over a REGISTERED user def too — the interactive seams are not built-ins', async () => {
    await adapter.registerWorkflow({
      id: 'interactive-draft-lookalike',
      phases: [
        { id: 'outline' },
        { id: 'draft' },
      ],
    } as unknown as WorkflowDef);
    const registrationsBefore = registered.length;

    await adapter.launchRun({
      problem: 'p', sessionId: 'run-u', clisJson: '[]',
      workflow: 'interactive-draft-lookalike',
      requireDeliverables: ['/inbox/run-u/doc-v1.html'],
    });

    expect(registered.length).toBe(registrationsBefore + 1);
    const composed = JSON.parse(registered[registered.length - 1]!) as WorkflowDef;
    expect(composed.id).toBe('interactive-draft-lookalike-verified-run-u');
    expect(composed.phases.map((p: PhaseDef) => p.id)).toEqual([
      'outline', 'draft', DELIVERABLE_FLOOR_PHASE_ID,
    ]);
    expect(floorOf(registered[registered.length - 1]!).checked).toEqual([
      '/inbox/run-u/doc-v1.html',
    ]);
    expect(launched[0]!.workflow).toBe('interactive-draft-lookalike-verified-run-u');
    // The shared user def is untouched — it keeps its two phases for the next launch.
    expect(adapter.getWorkflow('interactive-draft-lookalike')!.phases).toHaveLength(2);
  });

  it('an EMPTY requireDeliverables is the old path exactly — no composition, no vacuous floor', async () => {
    await adapter.launchRun({
      problem: 'p', sessionId: 'run-1', clisJson: '[]', workflow: 'feature',
      requireDeliverables: [],
    });
    expect(registered).toEqual([]);
    expect(launched[0]!.workflow).toBe('feature');
  });

  it('requireDeliverables with an unknown workflow rejects before anything launches', async () => {
    await expect(
      adapter.launchRun({
        problem: 'p', sessionId: 'run-1', clisJson: '[]', workflow: 'no-such-workflow',
        requireDeliverables: ['/inbox/a.html'],
      }),
    ).rejects.toThrow(/not registered/);
    expect(launched).toEqual([]);
    expect(registered).toEqual([]);
  });

  it('a blank declared path REJECTS the launch rather than arming a floor that checks nothing', async () => {
    await expect(
      adapter.launchRun({
        problem: 'p', sessionId: 'run-1', clisJson: '[]', workflow: 'feature',
        requireDeliverables: ['   '],
      }),
    ).rejects.toThrow(/must not be blank/);
    expect(launched).toEqual([]);
  });
});
