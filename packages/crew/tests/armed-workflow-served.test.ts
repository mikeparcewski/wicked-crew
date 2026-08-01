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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreAdapter } from '../src/core/adapter.js';
import type { WorkflowDef } from '../src/core/types.js';

/** The approved content-address pin core's `coverage` phase carries. */
const COVERAGE_PIN = '4a4b10bf4277bd34';

let adapter: CoreAdapter;
let dir: string;
let def: WorkflowDef | null;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'armed-wf-'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'armed.db'), stub: true });
  def = adapter.listWorkflows().find((w) => w.id === 'domain-extraction') ?? null;
});

afterAll(() => {
  adapter?.close?.();
  rmSync(dir, { recursive: true, force: true });
});

describe('the armed workflow is served', () => {
  it('appears in the catalog an operator selects from', () => {
    expect(def, 'domain-extraction must be in listWorkflows() — it is the only workflow that arms the gate').not.toBeNull();
  });

  it('still carries the approved validator pin', () => {
    // Serving the workflow with a null/edited pin would be worse than not serving it: the run
    // would proceed UNGATED and read as governed.
    const pinned = def!.phases.filter((p) => p.validator_pin !== null);
    expect(pinned.map((p) => p.id)).toEqual(['coverage']);
    expect(pinned[0]!.validator_pin).toBe(COVERAGE_PIN);
    expect(pinned[0]!.role).toBe('evaluator');
    expect(pinned[0]!.verified_evidence).toBe(true);
  });

  it('has a well-formed phase DAG (core rejects the overlay otherwise)', () => {
    // Crew writes this def to core's overlay dir verbatim; core validates on load and rejects a
    // def whose `depends_on` does not resolve. A broken mirror would surface only at launch.
    const ids = new Set(def!.phases.map((p) => p.id));
    expect(ids.size).toBe(def!.phases.length);
    for (const p of def!.phases) {
      for (const d of p.depends_on) {
        expect(ids.has(d), `phase ${p.id} depends on unknown phase ${d}`).toBe(true);
      }
    }
  });
});

// ── Cross-repo drift guard ───────────────────────────────────────────────────
// Crew's entry is a hand-transcribed mirror of core's JSON (core ships the def as a drop-in and
// exposes no dump command). Nothing in crew's own build can detect core changing it. When a
// wicked-core checkout IS resolvable — the sibling layout every developer has, or an explicit
// WICKED_CORE_DIR — compare the two directly. Skipped, not failed, when core is absent, so crew's
// CI stays self-contained; this is a developer-machine tripwire, not a build dependency.
const CORE_DIR =
  process.env['WICKED_CORE_DIR'] ??
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'wicked-core');
const CORE_DEF = join(CORE_DIR, 'workflows', 'domain-extraction.json');

function readCoreDef(): WorkflowDef | null {
  try {
    return JSON.parse(readFileSync(CORE_DEF, 'utf8')) as WorkflowDef;
  } catch {
    return null;
  }
}

describe.skipIf(readCoreDef() === null)('mirror matches wicked-core', () => {
  it('is field-for-field identical to workflows/domain-extraction.json', () => {
    const core = readCoreDef()!;
    // `is_system` is crew-only metadata and is stripped before the overlay write; the mirror does
    // not set it here, so a plain deep-equal is the honest comparison.
    expect(def).toEqual(core);
  });
});
