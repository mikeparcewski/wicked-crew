// FINDING-034 regression: the one workflow that ARMS the governance gate must be reachable
// through the product.
//
// `domain-extraction` is the only workflow in the ecosystem whose phase carries a
// `validator_pin` — layer 1 of the dual-validator gate is live there and inert in every other
// workflow. It lives in wicked-core as a *shipped drop-in* (`workflows/domain-extraction.json`),
// but what an operator can actually reach is decided here, by crew's `BUILTIN_WORKFLOWS`: that
// array is what `listWorkflows()` serves to `GET /api/v1/workflows` and the work-mode selector,
// and what gets written to core's overlay dir on first launch.
//
// It was missing from that array, so:
//
//     POST /runs {"workflow":"domain-extraction"}
//     → {"error":"unknown workflow `domain-extraction` — known workflows: bug, chat, collab, …"}
//
// while crew's own CLI help advertised the id (`cli/index.ts`, "e.g. domain-extraction"). The
// product referenced a workflow the product did not serve, which is the whole reason a governance
// survey of the served workflows found zero armed validators.
//
// Note what this test does NOT assert: that a run of it succeeds. Running it needs a one-time
// `wicked-core seed-domain-validators` to vault + approve the pinned validator, and until then a
// launch fails CLOSED at plan time. That is deliberate — approval is an audited act a human/council
// owns. Reachability is the defect; the seed step is the design.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../src/core/adapter.js';
import type { WorkflowDef } from '../src/core/types.js';
import { SKIP_CORE_CHECKS, readCoreJson } from './support/core-checkout.js';
import { removeScratch } from './setup/scratch.js';

/**
 * The approved content-address pin core's `coverage` phase carries — READ FROM CORE, not transcribed.
 *
 * This was a fourth hardcoded copy of that hash (after core's const, core's JSON, and crew's
 * adapter mirror), and it drifted: it still held `4a4b10bf4277bd34` after core moved on, so this
 * test asserted crew was serving a pin core had retired. A test that pins a stale value does not
 * guard the contract, it guards the drift.
 *
 * Deriving beats duplicating. The P1 rule this ecosystem applies elsewhere is "one source, or a test
 * that reads both" — here one source is available, so take it (FINDING-084/009).
 */
const COVERAGE_PIN: string | null = SKIP_CORE_CHECKS
  ? null
  : (() => {
      const def = readCoreJson<WorkflowDef>('workflows', 'domain-extraction.json');
      const pin = def.phases.find((p) => p.id === 'coverage')?.validator_pin;
      if (pin === null || pin === undefined) {
        throw new Error(
          "core's domain-extraction.json has no validator_pin on its `coverage` phase. Either the " +
            'floor was removed from the one workflow that arms the gate, or the phase was renamed ' +
            '— both are the kind of change this guard exists to make loud.',
        );
      }
      return pin;
    })();

let adapter: CoreAdapter;
let dir: string;
let def: WorkflowDef | null;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'armed-wf-'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'armed.db'), stub: true });
  def = adapter.listWorkflows().find((w) => w.id === 'domain-extraction') ?? null;
});

afterAll(() => {
  if (adapter) adapter.close();
  // `close()` returns before the Rust actor thread has finished flushing SQLite's WAL/SHM
  // sidecars, so an immediate recursive remove can lose a race with a file being recreated and
  // fail ENOTEMPTY (observed intermittently — it passed on the first run and failed on the next).
  // `force` does not cover ENOTEMPTY; retries do.
  if (dir) removeScratch(dir);
});

/** The served def, or a clear failure. The content tests below are meaningless without it, and a
 *  bare `def!` would crash them with a TypeError that buries the actual regression. */
function served(): WorkflowDef {
  if (!def) throw new Error('domain-extraction is not in listWorkflows() — see the catalog test');
  return def;
}

describe('the armed workflow is served', () => {
  it('appears in the catalog an operator selects from', () => {
    expect(def, 'domain-extraction must be in listWorkflows() — it is the only workflow that arms the gate').not.toBeNull();
  });

  it('still carries a validator pin, on the evaluator phase', () => {
    // Serving the workflow with a null/edited pin would be worse than not serving it: the run
    // would proceed UNGATED and read as governed.
    //
    // Deliberately NOT the cross-repo comparison — this claim is checkable from crew alone, so it
    // is asserted unconditionally. Whether the pin is the one core approved is a separate claim
    // needing core's artifact, and it is asserted separately below. Folding them together made a
    // locally-checkable invariant hostage to an environmental prerequisite.
    const pinned = served().phases.filter((p) => p.validator_pin !== null);
    expect(pinned.map((p) => p.id)).toEqual(['coverage']);
    expect(pinned[0]!.role).toBe('evaluator');
    expect(pinned[0]!.verified_evidence).toBe(true);
  });

  it.skipIf(SKIP_CORE_CHECKS)('serves the exact pin core approved', () => {
    // A pin crew serves that core's vault does not hold is unresolvable, and every
    // domain-extraction run fails closed on it (FINDING-066/080). Crew's overlay write is the only
    // delivery path for this def, so this mirror is not display — it IS what reaches the engine.
    expect(served().phases.find((p) => p.id === 'coverage')?.validator_pin).toBe(COVERAGE_PIN);
  });

  it('has a well-formed phase DAG (core rejects the overlay otherwise)', () => {
    // Crew writes this def to core's overlay dir verbatim; core validates on load and rejects a
    // def whose `depends_on` does not resolve. A broken mirror would surface only at launch.
    const phases = served().phases;
    const ids = new Set(phases.map((p) => p.id));
    expect(ids.size).toBe(phases.length);
    for (const p of phases) {
      for (const d of p.depends_on) {
        expect(ids.has(d), `phase ${p.id} depends on unknown phase ${d}`).toBe(true);
      }
    }
  });
});

// ── Cross-repo drift guard ───────────────────────────────────────────────────
// Crew's entry is a hand-transcribed mirror of core's JSON (core ships the def as a drop-in and
// exposes no dump command), so nothing in crew's own build can detect core changing it. Compare
// the two directly.
//
// This block used to resolve the checkout itself and SKIP when it was absent — a second resolver
// and a second, opposite policy inside the same file as the derivation above, which threw. One
// prerequisite, one resolver, one policy (FINDING-094).
//
// Read ONCE, at collection time: the skip predicate and the assertion must agree on what they saw.
// Re-reading in the test body would let the file vanish in between, turning a skip into a crash.
const coreDef: WorkflowDef | null = SKIP_CORE_CHECKS
  ? null
  : readCoreJson<WorkflowDef>('workflows', 'domain-extraction.json');

describe.skipIf(SKIP_CORE_CHECKS)('mirror matches wicked-core', () => {
  it('is field-for-field identical to workflows/domain-extraction.json', () => {
    // `is_system` is crew-only metadata and is stripped before the overlay write; the mirror does
    // not set it here, so a plain deep-equal is the honest comparison.
    expect(def).toEqual(coreDef);
  });
});
