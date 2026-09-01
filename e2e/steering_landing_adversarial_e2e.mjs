#!/usr/bin/env -S npx tsx
// ADVERSARIAL verifier E2E for the steering-author landing (crew#388) — lane 1.
// Independent of e2e/steering_landing_e2e.mjs: same scratch-stack pattern, DIFFERENT checks:
//
//   A. approve LANDS: GET /governance/rules serves the rule with provenance.source "chat",
//      audit carries governance.rule.upserted; a double-posted approve leaves EXACTLY ONE rule.
//   B. broken proposal record: the propose seat writes GARBAGE to proposed-rules.json and emits
//      prose with no JSON array anywhere — the approve must answer a LOUD landing failure
//      (landing.outcome=failed + error) and the audit must carry
//      governance.steering.landing_failed. Silent success fails the lane.
//   C. reject lands NOTHING.
//   D. an ordinary non-steering human gate behaves byte-identically: response body is exactly
//      {"status": ...} — no landing key, no rule writes, no governance audit rows.
//
// Scratch everything: scratch HOME, scratch engine db, scratch inbox/overlay, port 7951.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.STEERING_ADV_E2E_PORT ?? 7951);
const RUN_TIMEOUT_MS = 3 * 60_000;

const T = mkdtempSync(join(tmpdir(), 'steering-landing-adv-'));
const HOME = join(T, 'home');
const OVERLAY = join(T, 'overlay');
const INBOX = join(T, 'inbox');
for (const d of [HOME, OVERLAY, INBOX]) mkdirSync(d, { recursive: true });

process.env.HOME = HOME;
process.env.WICKED_WORKFLOWS_DIR = OVERLAY;
process.env.WICKED_STEERING_INBOX_DIR = INBOX;
process.env.WICKED_CREW_AUDIT_LOG = join(HOME, 'audit.log');
process.env.WICKED_MEMORY_EMBEDDER = 'hash';

// ── Deterministic stub seat, branching on a BREAK token in the problem statement ──
const GOOD_PROPOSAL = JSON.stringify([
  {
    id: 'POL-9001',
    rule_type: 'policy',
    statement: 'all schema migrations require a rollback script reviewed before merge',
    severity: 'error',
    confidence: 0.95,
    targets: {},
    provenance: { source: 'chat', source_kinds: [] },
    steering_type: 'operations',
  },
]);
const STUB = join(T, 'stub-seat.sh');
writeFileSync(
  STUB,
  `#!/bin/sh
PROMPT="$*"
case "$PROMPT" in
  *"SAVE that JSON array"*"BREAK-THE-RECORD"*|*"BREAK-THE-RECORD"*"SAVE that JSON array"*)
    OUT=$(printf '%s' "$PROMPT" | grep -oE '/[^ ]*proposed-rules\\.json' | head -1)
    if [ -n "$OUT" ]; then mkdir -p "$(dirname "$OUT")"; printf '%s' 'not json {{{ definitely broken' > "$OUT"; fi
    echo "I drafted some thoughts about migration policy but produced no structured output this time."
    ;;
  *"SAVE that JSON array"*)
    OUT=$(printf '%s' "$PROMPT" | grep -oE '/[^ ]*proposed-rules\\.json' | head -1)
    if [ -z "$OUT" ]; then echo "no proposal path found in prompt" >&2; exit 1; fi
    mkdir -p "$(dirname "$OUT")"
    cat > "$OUT" <<'JSON'
${GOOD_PROPOSAL}
JSON
    echo "Proposed steering rules (also saved to $OUT):"
    cat "$OUT"
    ;;
  *)
    echo "ANALYSIS: candidate rule identified from the operator intent. Analysis only, no JSON yet."
    ;;
esac
`,
  'utf8',
);
chmodSync(STUB, 0o755);
const STUB_SEATS = [
  { key: 'stub-seat', display_name: 'Stub Seat', binary: STUB, headless_invocation: `${STUB} {PROMPT}` },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label, cond, timeoutMs = RUN_TIMEOUT_MS, stepMs = 400) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`TIMEOUT waiting for: ${label}`);
    await sleep(stepMs);
  }
}
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

let crewApp;
let adapter;
try {
  const { CoreAdapter } = await import('../packages/crew/src/core/adapter.ts');
  const { createServer } = await import('../packages/crew/src/api/server.ts');
  CoreAdapter.roster = () => STUB_SEATS;
  adapter = new CoreAdapter({ dbPath: join(T, 'core.db'), stub: false });
  crewApp = await createServer(adapter, {});
  await crewApp.listen({ port: PORT, host: '127.0.0.1' });
  const BASE = `http://127.0.0.1:${PORT}/api/v1`;
  console.log(`adversarial scratch daemon: ${BASE} (HOME=${HOME})`);

  const send = async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const rules = async () => (await send('GET', '/governance/rules')).body.rules ?? [];
  const audit = async (runId, action) =>
    (await send('GET', `/audit?runId=${runId}&action=${action}`)).body.entries ?? [];
  const authorAndWaitGate = async (instructions) => {
    const author = await send('POST', '/governance/steering/author', { instructions, type: 'operations' });
    if (author.status !== 201) throw new Error(`author launch failed: ${author.status} ${JSON.stringify(author.body)}`);
    const runId = author.body.runId;
    await waitFor(`run ${runId} awaiting_human`, async () => {
      const res = await send('GET', `/runs/${runId}`);
      const s = res.body.run?.session?.status;
      if (s === 'failed' || s === 'cancelled') throw new Error(`run ${runId} terminal ${s} before gate`);
      return s === 'awaiting_human';
    });
    return runId;
  };

  // ════ A. APPROVE LANDS + double-post = exactly one rule ═══════════════════
  {
    const before = (await rules()).length;
    const runId = await authorAndWaitGate('Codify: every schema migration ships a reviewed rollback script.');
    const approve = await send('POST', `/runs/${runId}/gate`, { approve: true });
    check('A: approve → 200', approve.status === 200, JSON.stringify(approve.body).slice(0, 200));
    check('A: landing.outcome=landed', approve.body.landing?.outcome === 'landed', JSON.stringify(approve.body.landing));
    const after = await rules();
    const row = after.find((r) => r.id === 'POL-9001');
    check('A: GET /governance/rules serves POL-9001', row !== undefined, `rules: ${after.map((r) => r.id).join(',')}`);
    check('A: provenance.source === "chat"', row?.provenance?.source === 'chat', JSON.stringify(row?.provenance));
    const up = await audit(runId, 'governance.rule.upserted');
    check('A: audit governance.rule.upserted present', up.length === 1, `${up.length} entries`);

    // double-post: the run has moved on — the guard answers 409 and the store stays at one row.
    const again = await send('POST', `/runs/${runId}/gate`, { approve: true });
    const count = (await rules()).filter((r) => r.id === 'POL-9001').length;
    check('A: double-posted approve refused (409)', again.status === 409, `status=${again.status}`);
    check('A: exactly one POL-9001 after double-post', count === 1, `${count} rows`);
    check('A: store grew by exactly 1', after.length === before + 1, `${before} → ${after.length}`);
  }

  // ════ B. BROKEN proposal record → LOUD failure, no landing ════════════════
  {
    const before = (await rules()).length;
    const runId = await authorAndWaitGate('BREAK-THE-RECORD adversarial lane: this proposal record is deliberately corrupted.');
    // The stub already wrote garbage; corrupt it AGAIN from here for belt-and-braces.
    const proposalFile = join(INBOX, runId, 'proposed-rules.json');
    writeFileSync(proposalFile, 'garbage ]] not [[ json', 'utf8');
    const approve = await send('POST', `/runs/${runId}/gate`, { approve: true });
    check('B: approve itself still 200 (gate decision stands)', approve.status === 200, `status=${approve.status}`);
    const landing = approve.body.landing;
    check('B: LOUD in the response — landing.outcome=failed', landing?.outcome === 'failed', JSON.stringify(landing).slice(0, 300));
    check('B: operator-readable error present', typeof landing?.error === 'string' && landing.error.length > 20, String(landing?.error).slice(0, 120));
    check('B: no ruleIds landed', Array.isArray(landing?.ruleIds) && landing.ruleIds.length === 0, JSON.stringify(landing?.ruleIds));
    const failedAudit = await audit(runId, 'governance.steering.landing_failed');
    check('B: LOUD in the audit — governance.steering.landing_failed recorded', failedAudit.length === 1, `${failedAudit.length} entries`);
    const upserts = await audit(runId, 'governance.rule.upserted');
    check('B: no governance.rule.upserted rows', upserts.length === 0, `${upserts.length} entries`);
    check('B: store unchanged', (await rules()).length === before, '');
  }

  // ════ C. REJECT lands nothing ═════════════════════════════════════════════
  {
    const before = (await rules()).length;
    const runId = await authorAndWaitGate('Codify: deploys are announced in the ops channel first.');
    const reject = await send('POST', `/runs/${runId}/gate`, { approve: false });
    check('C: reject → 200', reject.status === 200, JSON.stringify(reject.body).slice(0, 200));
    check('C: no landing key on reject', !('landing' in reject.body), Object.keys(reject.body).join(','));
    check('C: store unchanged after reject', (await rules()).length === before, '');
    const upserts = await audit(runId, 'governance.rule.upserted');
    check('C: no upsert audit rows', upserts.length === 0, `${upserts.length}`);
    const st = await waitFor('C run terminal', async () => {
      const res = await send('GET', `/runs/${runId}`);
      const s = res.body.run?.session?.status;
      return ['cancelled', 'failed', 'completed'].includes(s) ? s : null;
    }, 60_000);
    check('C: run cancelled', st === 'cancelled', `status=${st}`);
  }

  // ════ D. ordinary non-steering human gate: byte-identical behavior ════════
  {
    const before = (await rules()).length;
    const reg = await send('POST', '/workflows', {
      id: 'plain-gated',
      is_system: false,
      phases: [
        { id: 'think', kind: 'recon', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: [], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
        { id: 'decide', kind: 'review', gate_type: 'value', gate: { human_confirm: { unconditional: true } }, executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['think'], role: 'evaluator', skill_ref: null, allowed_skills: [], validator_pin: null },
      ],
    });
    check('D: custom non-steering workflow registered', reg.status === 201, JSON.stringify(reg.body));
    const launch = await send('POST', '/runs', { problem: 'Ordinary gated run: summarize the plan and pause for a decision.', workflow: 'plain-gated' });
    check('D: ordinary run launched', launch.status === 201, JSON.stringify(launch.body));
    const runId = launch.body.runId;
    await waitFor(`ordinary run ${runId} awaiting_human`, async () => {
      const res = await send('GET', `/runs/${runId}`);
      const s = res.body.run?.session?.status;
      if (s === 'failed' || s === 'cancelled') throw new Error(`ordinary run terminal ${s} before gate`);
      return s === 'awaiting_human';
    });
    const res = await fetch(`${BASE}/runs/${runId}/gate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approve: true }),
    });
    const rawBody = await res.text();
    const parsed = JSON.parse(rawBody);
    check('D: approve → 200', res.status === 200, rawBody.slice(0, 200));
    check('D: body is EXACTLY {status} — no landing key, byte-identical shape', Object.keys(parsed).length === 1 && typeof parsed.status === 'string', rawBody);
    check('D: store untouched by ordinary gate', (await rules()).length === before, '');
    check('D: no governance audit rows for the ordinary run',
      (await audit(runId, 'governance.rule.upserted')).length === 0 &&
      (await audit(runId, 'governance.steering.landing_failed')).length === 0, '');
  }
} catch (err) {
  check('adversarial e2e ran to completion', false, err instanceof Error ? err.stack ?? err.message : String(err));
} finally {
  try { if (crewApp) await crewApp.close(); } catch {}
  try { if (adapter) adapter.close(); } catch {}
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
if (failed.length === 0) {
  try { rmSync(T, { recursive: true, force: true }); } catch {}
} else {
  console.log(`scratch stack kept: ${T}`);
}
process.exit(failed.length === 0 ? 0 : 1);
