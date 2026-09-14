// FINDING-049 regression: crew must not shadow a workflow wicked-core seeds itself.
//
// Core resolves a workflow id from its own registry, then overlays every `*.json` in
// `~/.config/wicked-core/workflows` on top — `register` overwrites by id and `load_dir` runs after
// `with_defaults()`, so a file there REPLACES the compiled built-in wholesale. Silently: same id,
// same phase ids, no error.
//
// Crew wrote one. `BUILTIN_WORKFLOWS` is a hand-transcribed mirror of core's defs, and on the first
// launch of any built-in the adapter wrote that mirror to the overlay dir. The mirror predated
// core's evidence floors, so the write took `validator_pin` back off `feature.adversarial-review`,
// `bug.verify` and `migration.verify` — every gate floor core ships, removed by a file write, on a
// run that still reported the right workflow and the right phases.
//
// Two halves fix it. Core REFUSES a shadow that drops a gate (registration judges the def as
// authored — wicked-core#414; the earlier `carry_shadowed_pins` backstop is gone).
// This is the other half, and it is the one that stops the shadowing: the write is now scoped to
// the ids core does NOT seed, which is the only reason the write existed.
//
// What is deliberately NOT asserted here: that the overlay dir is empty. Six drop-ins legitimately
// live there, and the onboarding path deliberately shadows core's `onboarding` with a def carrying
// runtime-baked `--db` paths. Scoping, not silence, is the property.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../src/core/adapter.js';
import type { WorkflowDef } from '../src/core/types.js';
import { SKIP_CORE_CHECKS, readCoreJson } from './support/core-checkout.js';
import { BUG_FIX_SWEEP_INSTRUCTIONS } from '../src/core/deliver.js';
import { removeScratch } from './setup/scratch.js';

const SEATS = JSON.stringify([
  { key: 'alpha', display_name: 'Alpha', binary: 'alpha', headless_invocation: 'alpha {PROMPT}' },
]);

let adapter: CoreAdapter;
let dir: string;
let overlayDir: string;
let priorOverlayDir: string | undefined;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'overlay-shadow-'));
  overlayDir = join(dir, 'workflows');
  // Point the adapter's overlay writes at a temp dir. Without this the test would write into the
  // developer's real `~/.config/wicked-core/workflows` — which is exactly the dir whose contents
  // this test is about, so polluting it would be its own small version of the bug.
  priorOverlayDir = process.env['WICKED_WORKFLOWS_DIR'];
  process.env['WICKED_WORKFLOWS_DIR'] = overlayDir;
  adapter = new CoreAdapter({ dbPath: join(dir, 'shadow.db'), stub: true });
});

afterAll(() => {
  if (priorOverlayDir === undefined) delete process.env['WICKED_WORKFLOWS_DIR'];
  else process.env['WICKED_WORKFLOWS_DIR'] = priorOverlayDir;
  if (adapter) adapter.close();
  // See armed-workflow-served.test.ts: close() returns before the actor thread finishes flushing
  // SQLite's WAL sidecars, and `force` does not cover the ENOTEMPTY that races with it.
  if (dir) removeScratch(dir);
});

/** Launch and ignore the run's own outcome — the write under test happens before the run starts,
 *  so a stub run that fails later still exercises it, and swallowing that keeps an unrelated
 *  engine failure from masquerading as this regression. */
async function launched(workflow: string): Promise<void> {
  try {
    await adapter.launchRun({ problem: `probe ${workflow}`, sessionId: `s-${workflow}`, clisJson: SEATS, workflow });
  } catch {
    /* not what this test measures */
  }
}

describe('launching a built-in does not shadow core', () => {
  it('writes no overlay file for a workflow core seeds itself', async () => {
    await launched('feature');
    expect(
      existsSync(join(overlayDir, 'feature.json')),
      'writing feature.json replaces core\'s compiled def with this mirror and strips its gate floor',
    ).toBe(false);
  });

  it('still writes the drop-ins, which core does not seed', async () => {
    // The mirror of `survey-repo` is the ONLY reason core can resolve that id — remove this write
    // and the fix above turns a silent ungating into a hard "unknown workflow" on six workflows.
    await launched('survey-repo');
    expect(existsSync(join(overlayDir, 'survey-repo.json'))).toBe(true);
  });
});

// ── Cross-repo drift guard ───────────────────────────────────────────────────
// Same tripwire as armed-workflow-served.test.ts, widened to the three defs that carry a floor.
// The mirror is hand-transcribed and nothing in crew's build can detect core changing it — which
// is how it came to be missing three pins in the first place.
//
// Resolution and the absence policy both live in tests/support/core-checkout.ts now: this file's
// own copy skipped silently, which in the release job meant the widened tripwire covering the five
// mirrors crew actually writes never ran at all (FINDING-094).

/** Core writes `executor` explicitly; the mirror omits it where it is the default. Same def. */
function normalized(def: WorkflowDef): unknown {
  // `is_system` is crew-only bookkeeping and `registerWorkflow` STRIPS it before writing, so it can
  // never reach core's overlay. Comparing it would fail on a field that by construction never
  // crosses the boundary this test guards.
  const rest: Record<string, unknown> = { ...(def as unknown as Record<string, unknown>) };
  delete rest['is_system'];
  return {
    ...rest,
    phases: def.phases.map((p) => ({ executor: { type: 'agent' }, ...p })),
  };
}

/**
 * DES-L9 BC-60 (crew #601 ↔ wicked-core #522): the `bug.fix` sweep `instructions` land on BOTH
 * carriers, but this suite compares the mirror with core MAIN (`WICKED_CORE_REF: main` in CI), which
 * gains the field only when #522 merges. Exactly ONE pending difference is tolerated, in ONE
 * direction: the mirror carries `BUG_FIX_SWEEP_INSTRUCTIONS` while core's `fix` phase has no
 * `instructions` yet. A different literal, the field on another phase, or the reverse direction
 * still fails. Row 6.9 (the `^0.7.27` pin PR) DELETES this function once core main carries the line.
 */
function withoutPendingBugFixInstructions(id: string, served: WorkflowDef, core: WorkflowDef): WorkflowDef {
  if (id !== 'bug') return served;
  const coreFix = core.phases.find((p) => p.id === 'fix');
  const servedFix = served.phases.find((p) => p.id === 'fix');
  if (coreFix === undefined || servedFix === undefined) return served;
  if (coreFix.instructions !== undefined && coreFix.instructions !== null) return served; // core carries it: byte-identical again
  if (servedFix.instructions !== BUG_FIX_SWEEP_INSTRUCTIONS) return served;
  return {
    ...served,
    phases: served.phases.map((p) => {
      if (p.id !== 'fix') return p;
      const copy = { ...p } as Record<string, unknown>;
      delete copy['instructions'];
      return copy as unknown as typeof p;
    }),
  };
}

/**
 * Mirrors checked against core's JSON.
 *
 * `feature`/`bug`/`migration` are mirrors crew never writes. The others are core's DROP-INS, which
 * crew DOES write — its write is the only way core can resolve them — so those are the mirrors that
 * can actually reach the engine, and they were the ones nobody checked (FINDING-084).
 *
 * ONE list, consumed by both the fixture loader and the assertions below. Two hardcoded lists that
 * must agree is precisely the defect this file exists to document.
 */
const MIRRORED_IDS = [
  'feature',
  'bug',
  'migration',
  'domain-extraction',
  'domain-graph-slice',
  // survey-repo is a core DROP-IN crew writes (its overlay write is the only def the engine resolves
  // at runtime), so its mirror CAN reach the engine — yet it was excluded here, which is why the
  // stale 3-phase mirror (no instructions, no synthesize) ran in production while the 4-phase fix sat
  // unused in core's JSON (FINDING-011). Guarding it makes the mirror drift a build failure.
  'survey-repo',
];

const coreDefs: Record<string, WorkflowDef | null> = Object.fromEntries(
  MIRRORED_IDS.map((id) =>
    SKIP_CORE_CHECKS
      ? [id, null]
      : // No try/catch: a checkout that resolved but is missing one of core's shipped defs means an
        // id was renamed or removed on core's side. Swallowing that turned a real cross-repo break
        // into a silent skip of the whole block, including the four ids that were still present.
        [id, readCoreJson<WorkflowDef>('workflows', `${id}.json`)],
  ),
);

describe.skipIf(SKIP_CORE_CHECKS)('mirror matches wicked-core', () => {
  // FINDING-084: this list covered only the three mirrors crew does NOT write. The five it DOES
  // write — core's drop-ins — were unchecked, and `domain-extraction` drifted: crew carried
  // `4a4b10bf4277bd34` while core had moved to `e7f84b91d030fdcc`. Because the write is the
  // delivery mechanism for those ids (see the survey-repo case above), the stale value reached the
  // engine and a governed run gated on the PRE-substance-rule validator — and restored itself after
  // being fixed by hand, because the write repeats on every launch.
  //
  // The unchecked ones are exactly the ones that can do damage. Checking the mirrors crew never
  // writes, while leaving the mirrors it does write unchecked, is the inverse of the risk.
  for (const id of MIRRORED_IDS) {
    it(`${id} is field-for-field identical to workflows/${id}.json`, () => {
      const served = adapter.listWorkflows().find((w) => w.id === id);
      expect(served, `${id} must be served`).toBeDefined();
      expect(normalized(withoutPendingBugFixInstructions(id, served!, coreDefs[id]!))).toEqual(normalized(coreDefs[id]!));
    });
  }

  it('the bug.fix tolerance is exactly one field in one direction — any other drift still fails', () => {
    const core = coreDefs['bug']!;
    const served = adapter.listWorkflows().find((w) => w.id === 'bug')!;
    // The mirror carries the literal (BC-60, both carriers).
    expect(served.phases.find((p) => p.id === 'fix')!.instructions).toBe(BUG_FIX_SWEEP_INSTRUCTIONS);
    // A different literal on the mirror is NOT tolerated.
    const drifted: WorkflowDef = { ...served, phases: served.phases.map((p) => (p.id === 'fix' ? { ...p, instructions: 'something else' } : p)) };
    expect(normalized(withoutPendingBugFixInstructions('bug', drifted, core))).not.toEqual(normalized(core));
    // Nor is the field on any other phase.
    const spread: WorkflowDef = { ...served, phases: served.phases.map((p) => (p.id === 'verify' ? { ...p, instructions: BUG_FIX_SWEEP_INSTRUCTIONS } : p)) };
    expect(normalized(withoutPendingBugFixInstructions('bug', spread, core))).not.toEqual(normalized(core));
  });

  it('reports the evidence floor on exactly the phases core gates', () => {
    // The assertion the mirror failed. `listWorkflows()` is what GET /api/v1/workflows and the
    // work-mode selector render, so a null pin here tells an operator a gated phase is ungated.
    const gated = ['feature', 'bug', 'migration'].map((id) => {
      const def = adapter.listWorkflows().find((w) => w.id === id)!;
      return [id, def.phases.filter((p) => p.validator_pin !== null).map((p) => p.id)];
    });
    // wicked-core F-039: the code-writing Creator phases carry the floor too — the `fix` gate
    // (and `build`/`execute`) must evaluate something, never fold `combined: true` over nothing.
    expect(gated).toEqual([
      ['feature', ['build', 'adversarial-review', 'test']],
      ['bug', ['fix', 'verify']],
      ['migration', ['execute', 'verify']],
    ]);
  });
});
