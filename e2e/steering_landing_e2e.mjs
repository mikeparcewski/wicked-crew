#!/usr/bin/env -S npx tsx
// E2E gate for the steering-author LANDING (crew#388) — the full journey the C5 campaign
// scenario walked, on a SCRATCH stack (scratch HOME, scratch engine store, scratch inbox,
// scratch overlay dir; nothing touches the operator's ~/.wicked-crew or the live daemon):
//
//   POST /governance/steering/author  (intent → governed steering-author run, REAL engine)
//        │  analyze → propose under a deterministic stub SEAT (the e2e/ pattern: real
//        │  planning, dispatch, gates and event log; only the LLM is a script — it writes
//        │  proposed-rules.json to the path the problem statement names AND echoes the array)
//        ▼
//   run pauses awaiting_human at the propose gate (TH-12)
//        │  POST /runs/:id/gate {approve:true}
//        ▼
//   THE LANDING: response carries landing.outcome=landed, GET /governance/rules serves the
//   rule with provenance.source "chat", audit shows governance.rule.upserted — the write that
//   was silently missing (run f3db4335: the approved POL-0001 orphaned in the transcript).
//
// Run (repo root):  npx tsx e2e/steering_landing_e2e.mjs
// Not CI-wired: the vitest suite covers the landing hermetically; this is the cross-product
// proof over the real engine.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.STEERING_E2E_PORT ?? 7943);
const RUN_TIMEOUT_MS = 3 * 60_000;

// ── Scratch stack: everything under one disposable HOME ──────────────────────
const T = mkdtempSync(join(tmpdir(), 'steering-landing-e2e-'));
const HOME = join(T, 'home');
const OVERLAY = join(T, 'overlay');
const INBOX = join(T, 'inbox');
for (const d of [HOME, OVERLAY, INBOX]) mkdirSync(d, { recursive: true });

// Scope every global the stack reads BEFORE importing crew modules.
process.env.HOME = HOME; // ~/.wicked-crew + ~/.wicked resolve inside the scratch
process.env.WICKED_WORKFLOWS_DIR = OVERLAY;
process.env.WICKED_STEERING_INBOX_DIR = INBOX;
process.env.WICKED_CREW_AUDIT_LOG = join(HOME, 'audit.log');
process.env.WICKED_MEMORY_EMBEDDER = 'hash';

// ── Deterministic stub seat (the e2e/ SHIM pattern) ──────────────────────────
// A real ENGINE run with a fake WORKER. The propose phase's instructions say "SAVE that JSON
// array … to the absolute proposal file path named in the problem statement"; the shim does
// exactly that (grep the path out of the prompt, write the file) and echoes the array so the
// human gate has something to render — the same dual contract a real seat follows.
const PROPOSAL_JSON = JSON.stringify([
  {
    id: 'POL-7101',
    rule_type: 'policy',
    statement: 'never deploy on friday afternoons; the change freeze starts 14:00 local',
    severity: 'error',
    confidence: 0.9,
    targets: {},
    provenance: { source: 'chat', source_kinds: [] },
    steering_type: 'operations',
  },
  {
    id: 'PAT-7102',
    rule_type: 'pattern',
    statement: 'every deploy is announced in the ops channel before it starts',
    severity: 'warn',
    confidence: 0.8,
    targets: {},
    provenance: { source: 'chat', source_kinds: [] },
  },
]);
const STUB = join(T, 'stub-author.sh');
writeFileSync(
  STUB,
  `#!/bin/sh
PROMPT="$*"
case "$PROMPT" in
  *"SAVE that JSON array"*)
    OUT=$(printf '%s' "$PROMPT" | grep -oE '/[^ ]*proposed-rules\\.json' | head -1)
    if [ -z "$OUT" ]; then echo "no proposal path found in prompt" >&2; exit 1; fi
    mkdir -p "$(dirname "$OUT")"
    cat > "$OUT" <<'JSON'
${PROPOSAL_JSON}
JSON
    echo "Proposed steering rules (also saved to $OUT):"
    cat "$OUT"
    ;;
  *)
    echo "ANALYSIS: the operator intent names a deploy freeze. Candidate rules: (1) POLICY never deploy on friday afternoons, severity error, steering_type operations — evidence: the intent text; (2) PATTERN announce deploys in the ops channel, severity warn — evidence: the intent text. Analysis only; no rule JSON yet, nothing written to any store."
    ;;
esac
`,
  'utf8',
);
chmodSync(STUB, 0o755);
const STUB_SEATS = [
  {
    key: 'stub-author',
    display_name: 'Stub Author',
    binary: STUB,
    headless_invocation: `${STUB} {PROMPT}`,
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label, cond, timeoutMs = RUN_TIMEOUT_MS, stepMs = 500) {
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
async function cleanup() {
  try { if (crewApp) await crewApp.close(); } catch {}
  try { if (adapter) adapter.close(); } catch {}
}

try {
  // ── 1. crew daemon: REAL engine, stub seat roster, scratch HOME, 79xx port ──
  const { CoreAdapter } = await import('../packages/crew/src/core/adapter.ts');
  const { createServer } = await import('../packages/crew/src/api/server.ts');
  // The author route rosters through CoreAdapter.roster() (the production council); pin it to
  // the deterministic stub seat for this scratch daemon.
  CoreAdapter.roster = () => STUB_SEATS;
  adapter = new CoreAdapter({ dbPath: join(T, 'core.db'), stub: false });
  crewApp = await createServer(adapter, {});
  await crewApp.listen({ port: PORT, host: '127.0.0.1' });
  const BASE = `http://127.0.0.1:${PORT}/api/v1`;
  console.log(`crew daemon: ${BASE} (REAL engine, stub seat, HOME=${HOME})`);

  const send = async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  // Baseline: the rules store starts without the proposal ids.
  const before = await send('GET', '/governance/rules');
  const beforeIds = (before.body.rules ?? []).map((r) => r.id);
  check('baseline: store has neither proposed rule', !beforeIds.includes('POL-7101') && !beforeIds.includes('PAT-7102'), `store ids: ${beforeIds.join(', ') || '(empty)'}`);

  // ── 2. the journey: author-with-chat ────────────────────────────────────────
  const author = await send('POST', '/governance/steering/author', {
    instructions: 'Codify our deploy-freeze practice: no friday-afternoon deploys, and every deploy is announced in the ops channel first.',
    type: 'operations',
  });
  check('POST /governance/steering/author → 201', author.status === 201, JSON.stringify(author.body));
  const runId = author.body.runId;
  console.log(`governed steering-author run: ${runId}`);

  // ── 3. the run pauses at the propose gate (TH-12) ───────────────────────────
  const gated = await waitFor('run awaiting_human at the propose gate', async () => {
    const res = await send('GET', `/runs/${runId}`);
    if (res.status !== 200) return null;
    const run = res.body.run;
    if (run.session.status === 'failed' || run.session.status === 'cancelled') {
      throw new Error(`run went terminal ${run.session.status} before the gate: ${JSON.stringify(run.units.map((u) => [u.id, u.status, u.denial_reason]))}`);
    }
    return run.session.status === 'awaiting_human' ? run : null;
  });
  check('run parked awaiting_human after analyze→propose', gated.units.length === 2, `units: ${gated.units.map((u) => `${u.id}:${u.status}`).join(', ')}`);

  // The propose phase's machine-readable artifact exists BEFORE the approve.
  const proposalFile = join(INBOX, runId, 'proposed-rules.json');
  check('propose phase wrote proposed-rules.json (the machine-readable proposal)', existsSync(proposalFile), proposalFile);

  // ── 4. APPROVE → THE LANDING ────────────────────────────────────────────────
  const approve = await send('POST', `/runs/${runId}/gate`, { approve: true });
  check('POST /runs/:id/gate approve → 200', approve.status === 200, JSON.stringify(approve.body).slice(0, 300));
  const landing = approve.body.landing;
  check('response carries landing.outcome=landed', landing?.outcome === 'landed', JSON.stringify(landing));
  check('landing read the DELIVERABLE (not transcript scraping)', landing?.source === 'deliverable', `source=${landing?.source}`);
  check('landing names both rule ids', Array.isArray(landing?.ruleIds) && landing.ruleIds.includes('POL-7101') && landing.ruleIds.includes('PAT-7102'), JSON.stringify(landing?.ruleIds));

  // ── 5. the store GET proves it (the exact check run f3db4335 failed) ────────
  const after = await send('GET', '/governance/rules');
  const pol = (after.body.rules ?? []).find((r) => r.id === 'POL-7101');
  const pat = (after.body.rules ?? []).find((r) => r.id === 'PAT-7102');
  check('GET /governance/rules serves POL-7101 with provenance.source "chat"', pol !== undefined && pol.provenance?.source === 'chat', JSON.stringify(pol?.provenance));
  check('PAT-7102 landed too, steering_type stamped from the authored type', pat !== undefined && pat.steering_type === 'operations', JSON.stringify({ steering_type: pat?.steering_type }));

  // ── 6. auditable: governance.rule.upserted per rule, on this run ────────────
  const audit = await send('GET', `/audit?runId=${runId}&action=governance.rule.upserted`);
  check('audit trail: one governance.rule.upserted per landed rule', (audit.body.entries ?? []).length === 2, `${(audit.body.entries ?? []).length} entries`);

  // ── 7. idempotency at the API surface: a re-post cannot double-land ─────────
  const repost = await send('POST', `/runs/${runId}/gate`, { approve: true });
  check('re-posted approve → 409 (run moved on), store unchanged', repost.status === 409, `status=${repost.status}`);
  const again = await send('GET', '/governance/rules');
  const polCount = (again.body.rules ?? []).filter((r) => r.id === 'POL-7101').length;
  check('exactly one POL-7101 row after the re-post', polCount === 1, `${polCount} rows`);

  // ── 8. the run itself completed (the approve resolved the terminal gate) ────
  const finalRun = await waitFor('run terminal after approve', async () => {
    const res = await send('GET', `/runs/${runId}`);
    return ['completed', 'failed', 'cancelled'].includes(res.body.run?.session?.status) ? res.body.run : null;
  }, 60_000);
  check('run completed', finalRun.session.status === 'completed', `status=${finalRun.session.status}`);
} catch (err) {
  check('e2e ran to completion', false, err instanceof Error ? err.message : String(err));
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
if (failed.length === 0) {
  try { rmSync(T, { recursive: true, force: true }); } catch {}
} else {
  console.log(`scratch stack kept for inspection: ${T}`);
}
process.exit(failed.length === 0 ? 0 : 1);
