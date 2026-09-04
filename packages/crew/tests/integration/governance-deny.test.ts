// SC-005: verdict-gated governance deny test
//
// Proves that a deny policy blocks a run at the crew API layer:
// - A run whose unit description matches the deny trigger ends in `failed` status (gate blocked)
// - A run that does NOT match the trigger completes normally (gate allows)
//
// Why this lives here (not just in wicked-core):
//   wicked-core already tests deny in `seam_findings.rs::sync_launch_halts_as_failed_on_a_governance_deny`.
//   This test closes SC-005 at the crew HTTP/REST surface: the governance policy flows from the
//   crew API (POST /governance/policies) through the CoreAdapter into the wicked-core engine, and
//   the resulting `failed` status is readable from the crew run-status endpoint.
//
// Approach:
//   - Boot CoreAdapter(stub:true) + server once
//   - POST a deny policy scoped to a unit whose description contains a sentinel keyword
//   - Launch a run whose problem produces a unit with that keyword → expect `failed`
//   - Launch a run whose problem does NOT contain the keyword → expect `completed`
//
// Platform note:
//   The governance stub is only present in wicked-core-ts binaries built from the 0.2.0-equivalent
//   source. Earlier linux-x64 binaries (npm 0.1.0) don't expose `upsertPolicy` on the stub engine.
//   When the capability probe returns false the entire suite is skipped (describe.runIf); no tests
//   fail. Core-level evidence for deny is in seam_findings.rs::sync_launch_halts_as_failed_on_a_governance_deny.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import type { GovernancePolicy } from '../../src/core/types.js';
import { removeScratch } from '../setup/scratch.js';

const POLL_INTERVAL_MS = 50;
const RUN_TIMEOUT_MS = 15000;

const SEATS = JSON.stringify([
  { key: 'alpha', display_name: 'Alpha', binary: 'alpha', headless_invocation: 'alpha {PROMPT}' },
]);

/** Sentinel keyword embedded in the deny trigger. */
const DENY_KEYWORD = 'GOVDENYTEST';
const DENY_POLICY_ID = 'sc005-deny-sentinel';

/** Deny policy: blocks any unit whose description contains DENY_KEYWORD. */
const DENY_POLICY: GovernancePolicy = {
  id: DENY_POLICY_ID,
  kind: 'guard',
  applies_to: ['unit-1'],
  effect: 'deny',
  trigger: { contains: DENY_KEYWORD },
  obligations: [],
  criteria: '',
  severity: 'high',
  rule: 'deny',
};

// Probe whether the installed stub binary supports governance (upsertPolicy).
// Earlier linux-x64-gnu builds of wicked-core-ts 0.1.0 don't expose this method on the stub.
const _require = createRequire(import.meta.url);
function probeGovCapable(): boolean {
  try {
    const { Core } = _require('wicked-core-ts') as { Core: { spawnStub(p: string): Record<string, unknown> } };
    const probe = Core.spawnStub(join(tmpdir(), 'gov-probe.db'));
    return typeof probe['upsertPolicy'] === 'function';
  } catch {
    return false;
  }
}
const GOV_CAPABLE = probeGovCapable();

// FINDING-038's retire seam is newer than the governance seam above, so it gets its own probe —
// otherwise an older-but-governance-capable binary would fail the retire test instead of skipping it.
function probeRetireCapable(): boolean {
  try {
    const { Core } = _require('wicked-core-ts') as { Core: { spawnStub(p: string): Record<string, unknown> } };
    const probe = Core.spawnStub(join(tmpdir(), 'gov-probe.db'));
    return typeof probe['retirePolicy'] === 'function';
  } catch {
    return false;
  }
}
const RETIRE_CAPABLE = probeRetireCapable();

// STEERING generation probe: on an engine carrying the unified steering model (wicked-core-ts
// >= 0.7.5 — crew CI links wicked-core main, so this flips the day the model lands), the policy
// WRITE surface answers 410 Gone and the deny doctrine is authored through the rules CRUD
// instead. Same decide() semantics either way — that equivalence is the migration's golden test.
function probeSteeringCapable(): boolean {
  try {
    const { Core } = _require('wicked-core-ts') as { Core: { spawnStub(p: string): Record<string, unknown> } };
    const probe = Core.spawnStub(join(tmpdir(), 'gov-probe.db'));
    return typeof probe['steeringImport'] === 'function';
  } catch {
    return false;
  }
}
const STEERING = probeSteeringCapable();

/** DENY_POLICY projected onto the unified steering-rule model (steering_rule_from_policy). */
const DENY_RULE = {
  id: DENY_POLICY_ID,
  rule_type: 'policy',
  statement: `blocks any unit whose description contains ${DENY_KEYWORD} (SC-005 sentinel)`,
  severity: 'critical', // Policy 'high' ⇔ ConfSeverity Critical (steering.rs severity map)
  confidence: 1,
  provenance: { source: 'policy', source_kinds: [] },
  applies_to: ['unit-1'],
  effect: 'deny',
  trigger: { contains: DENY_KEYWORD },
};

describe.runIf(GOV_CAPABLE)('SC-005: verdict-gated governance deny blocks a run at the crew HTTP surface', () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  let adapter: CoreAdapter;
  let dir: string;
  let baseUrl: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'crew-gov-'));
    adapter = new CoreAdapter({ dbPath: join(dir, 'gov.db'), stub: true });
    app = await createServer(adapter);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

    // Register the deny doctrine via the crew HTTP API (validates the full crew → adapter →
    // engine path). Steering engines retire the policy write (410 → rules CRUD), so the surface
    // is picked by the same probe the engine answers.
    const writePath = STEERING ? 'governance/rules' : 'governance/policies';
    const res = await fetch(`${baseUrl}/api/v1/${writePath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(STEERING ? DENY_RULE : DENY_POLICY),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`POST /${writePath} failed ${res.status}: ${text}`);
    }
  }, 30000);

  afterAll(async () => {
    if (app) await app.close();
    if (adapter) adapter.close();
    if (dir) removeScratch(dir);
  });

  async function launchRun(sessionId: string, problem: string): Promise<void> {
    const res = await fetch(`${baseUrl}/api/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ problem, sessionId, clisJson: SEATS }),
    });
    if (res.status !== 201) {
      const body = await res.json().catch(() => null);
      throw new Error(`POST /runs failed ${res.status}: ${JSON.stringify(body)}`);
    }
  }

  async function waitForTerminal(sessionId: string): Promise<string> {
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const res = await fetch(`${baseUrl}/api/v1/runs/${sessionId}`);
      if (res.status === 404) {
        await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }
      if (!res.ok) throw new Error(`GET /runs/${sessionId} failed ${res.status}`);
      const body = await res.json() as { run: { session: { status: string } } };
      const { status } = body.run.session;
      if (status === 'completed' || status === 'failed' || status === 'cancelled') return status;
      await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(`run ${sessionId} did not reach terminal status within ${RUN_TIMEOUT_MS}ms`);
  }

  it('run matching deny trigger ends in failed status (gate blocked)', async () => {
    const sessionId = 'sc005-deny';
    // The problem embeds the sentinel keyword; the planner incorporates it into unit descriptions,
    // which the deny policy's trigger.contains check matches.
    await launchRun(sessionId, `please ${DENY_KEYWORD} this task step`);
    const status = await waitForTerminal(sessionId);
    expect(
      status,
      `expected run matching the deny trigger to be 'failed' but got '${status}'`,
    ).toBe('failed');
  });

  it('run NOT matching deny trigger completes normally (gate allows)', async () => {
    const sessionId = 'sc005-allow';
    await launchRun(sessionId, 'a benign task step with no sentinel keyword');
    const status = await waitForTerminal(sessionId);
    expect(
      status,
      `expected benign run to complete but got '${status}'`,
    ).toBe('completed');
  });

  // FINDING-038: governance state was append-only. A policy authored with a too-broad trigger denied
  // every matching unit forever, and no HTTP surface could withdraw it — the store had to be wiped.
  // Runs LAST: it retires the policy the two tests above depend on.
  it.runIf(RETIRE_CAPABLE)('a retired policy stops denying, stays listed, and 404s when unknown', async () => {
    const retireBase = STEERING ? 'governance/rules' : 'governance/policies';
    const unknown = await fetch(`${baseUrl}/api/v1/${retireBase}/no-such-policy`, { method: 'DELETE' });
    expect(unknown.status, 'retiring an id that was never registered must 404, not report a hollow success').toBe(404);

    const res = await fetch(`${baseUrl}/api/v1/${retireBase}/${DENY_POLICY.id}`, { method: 'DELETE' });
    // Read the body ONCE — a fetch body cannot be consumed twice, so it cannot double as the
    // failure message for a status assertion.
    const body = await res.json().catch(() => null) as unknown;
    expect(res.status, `DELETE returned ${res.status}: ${JSON.stringify(body)}`).toBe(200);
    expect(body).toEqual({ status: 'retired', id: DENY_POLICY.id });

    // Retire, not delete: past decisions cite this id, so it must still resolve. The listing
    // probe follows the write surface: rules-authored doctrine resolves through the rules browse
    // (`include_retired=true` — the engine's default listing withdraws retired rows), while the
    // legacy policies listing keeps answering for policy-authored doctrine.
    if (STEERING) {
      const listed = await fetch(`${baseUrl}/api/v1/governance/rules?include_retired=true`);
      const { rules } = await listed.json() as { rules: { id: string; retired?: boolean }[] };
      const found = rules.find((r) => r.id === DENY_POLICY.id);
      expect(found, 'the retired rule is still listed (include_retired)').toBeDefined();
      expect(found?.retired, 'and is flagged so the UI can show it is no longer enforced').toBe(true);
    } else {
      const listed = await fetch(`${baseUrl}/api/v1/governance/policies`);
      const { policies } = await listed.json() as { policies: GovernancePolicy[] };
      const found = policies.find((p) => p.id === DENY_POLICY.id);
      expect(found, 'the retired policy is still listed').toBeDefined();
      expect(found?.retired, 'and is flagged so the UI can show it is no longer enforced').toBe(true);
    }

    // The identical run that failed in the first test now completes — same trigger, same problem.
    const sessionId = 'sc005-retired';
    await launchRun(sessionId, `please ${DENY_KEYWORD} this task step`);
    const status = await waitForTerminal(sessionId);
    expect(
      status,
      `after retiring the policy the same run must complete, got '${status}'`,
    ).toBe('completed');
  });
});
