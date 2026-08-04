// SC-003: 100-run gate-evaluation determinism test
//
// Proves that the governance gate evaluation is deterministic at the crew API layer:
// identical inputs (same workflow, same governance policy, same stub worker output)
// always produce identical terminal outcomes across N consecutive runs.
//
// Why this lives here (not just in wicked-core):
//   The crew-level adapter + HTTP surface introduces its own code paths (gate cache,
//   WS fan-out, run indexing). Determinism must hold end-to-end through those layers,
//   not only in the wicked-core Rust engine. This test closes the SC-003 gap that the
//   wicked-core governance_in_run.rs / events_governance_deep.rs tests leave open.
//
// Approach:
//   - Boot CoreAdapter(stub:true) + server once; reuse across runs (no LLM, no network)
//   - POST /runs N times with identical inputs using the free-text planning path (no explicit
//     workflow field — this exercises the auto-gate path that SC-003 targets; any named
//     workflow would also exercise the gate, but the free-text path is simpler and equally
//     valid for determinism testing)
//   - Poll GET /api/v1/runs/:id until each session reaches a terminal status
//   - Assert every terminal status is 'completed' and every unit has denial_reason=null
//   - Assert no run ended in 'failed' or 'cancelled'
//   - Assert unit-level signature (ord+stage+description+status+denial_reason) is identical
//     across all 100 runs — determinism proven at the unit level, not only at session level
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';

const RUNS = 100;
const POLL_INTERVAL_MS = 50;
const RUN_TIMEOUT_MS = 15000;

const SEATS = JSON.stringify([
  { key: 'alpha', display_name: 'Alpha', binary: 'alpha', headless_invocation: 'alpha {PROMPT}' },
]);

interface UnitView {
  ord: number;
  stage: string;
  description: string;
  status: string;
  denial_reason: string | null;
}

interface SessionView {
  session: { id: string; status: string };
  units: UnitView[];
}

interface RunResult {
  status: string;
  /** Normalized unit signature — stable across runs with identical inputs. */
  signature: string;
}

let app: Awaited<ReturnType<typeof createServer>>;
let adapter: CoreAdapter;
let dir: string;
let baseUrl: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-det-'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'det.db'), stub: true });
  app = await createServer(adapter);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
}, 30000);

afterAll(async () => {
  if (app) await app.close();
  if (adapter) adapter.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function launchRun(sessionId: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/v1/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      problem: 'determinism probe step',
      sessionId,
      clisJson: SEATS,
    }),
  });
  const body = await res.json().catch(() => null);
  if (res.status !== 201) {
    throw new Error(`POST /runs failed ${res.status}: ${JSON.stringify(body)}`);
  }
}

async function waitForTerminal(sessionId: string): Promise<RunResult> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/api/v1/runs/${sessionId}`);
    if (res.status === 404) {
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GET /runs/${sessionId} failed with status ${res.status}: ${text}`);
    }
    const body = (await res.json()) as { run: SessionView };
    const { status } = body.run.session;
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      const signature = JSON.stringify(
        (body.run.units ?? [])
          .sort((a, b) => a.ord - b.ord)
          .map((u) => ({
            ord: u.ord,
            stage: u.stage,
            description: u.description,
            status: u.status,
            denial_reason: u.denial_reason,
          })),
      );
      return { status, signature };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`run ${sessionId} did not reach terminal status within ${RUN_TIMEOUT_MS}ms`);
}

describe(`SC-003: gate evaluation is deterministic across ${RUNS} consecutive runs`, () => {
  it(`all ${RUNS} auto-gated runs complete with identical terminal status and unit signatures`, async () => {
    const results: RunResult[] = [];

    for (let i = 0; i < RUNS; i++) {
      const sessionId = `det-run-${String(i).padStart(3, '0')}`;
      await launchRun(sessionId);
      const result = await waitForTerminal(sessionId);
      results.push(result);
    }

    const statuses = results.map((r) => r.status);
    const completed = statuses.filter((s) => s === 'completed').length;
    const failed = statuses.filter((s) => s === 'failed').length;
    const cancelled = statuses.filter((s) => s === 'cancelled').length;

    expect(
      failed,
      `${failed}/${RUNS} runs unexpectedly failed — gate evaluation is not deterministic`,
    ).toBe(0);
    expect(
      cancelled,
      `${cancelled}/${RUNS} runs were unexpectedly cancelled`,
    ).toBe(0);
    expect(
      completed,
      `expected all ${RUNS} runs to complete, got ${completed}`,
    ).toBe(RUNS);

    // Every run produced the same terminal status — determinism proven at the session level.
    const uniqueStatuses = new Set(statuses);
    expect(uniqueStatuses.size).toBe(1);
    expect([...uniqueStatuses][0]).toBe('completed');

    // Every run produced the same unit-level signature (ord, stage, description, status,
    // denial_reason) — determinism proven at the unit level too.
    const uniqueSignatures = new Set(results.map((r) => r.signature));
    expect(
      uniqueSignatures.size,
      `unit signatures differed across runs — nondeterminism detected at the unit level`,
    ).toBe(1);

    // Gate allowance: assert no unit was denied across any run.
    // Parse the common (and unique) signature and check every unit's denial_reason.
    const [signature] = uniqueSignatures;
    // The size assertion above already proves this is present. Stated rather than asserted away with
    // `!`, so that if that assertion is ever relaxed this fails with a sentence instead of a
    // `JSON.parse(undefined)` TypeError twelve lines later.
    if (signature === undefined) throw new Error('unreachable: signature count was asserted to be 1');
    const units = JSON.parse(signature) as UnitView[];
    for (const unit of units) {
      expect(
        unit.denial_reason,
        `unit ord=${unit.ord} was denied (denial_reason: ${unit.denial_reason})`,
      ).toBeNull();
    }
  }, 60000);
});
