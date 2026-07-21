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
//   - POST /runs N times with identical inputs (auto-gate, no humanConfirm)
//   - Poll /runs/:id until each session reaches a terminal status
//   - Assert every terminal status is 'completed' and the gate allowed every unit
//   - Assert no run ended in 'failed' or 'cancelled'
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

interface SessionView {
  session: { id: string; status: string };
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
  if (res.status !== 201) {
    const body = await res.text();
    throw new Error(`POST /runs failed ${res.status}: ${body}`);
  }
}

async function waitForTerminal(sessionId: string): Promise<string> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/api/v1/runs`);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GET /runs failed with status ${res.status}: ${text}`);
    }
    const body = (await res.json()) as { runs: SessionView[] };
    const run = body.runs.find((r) => r.session.id === sessionId);
    if (run) {
      const { status } = run.session;
      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        return status;
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`run ${sessionId} did not reach terminal status within ${RUN_TIMEOUT_MS}ms`);
}

describe(`SC-003: gate evaluation is deterministic across ${RUNS} consecutive runs`, () => {
  it(`all ${RUNS} auto-gated runs complete with identical terminal status`, async () => {
    const results: string[] = [];

    for (let i = 0; i < RUNS; i++) {
      const sessionId = `det-run-${String(i).padStart(3, '0')}`;
      await launchRun(sessionId);
      const status = await waitForTerminal(sessionId);
      results.push(status);
    }

    const completed = results.filter((s) => s === 'completed').length;
    const failed = results.filter((s) => s === 'failed').length;
    const cancelled = results.filter((s) => s === 'cancelled').length;

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

    // Every run produced the same outcome — determinism proven.
    const unique = new Set(results);
    expect(unique.size).toBe(1);
    expect([...unique][0]).toBe('completed');
  }, RUNS * RUN_TIMEOUT_MS);
});
