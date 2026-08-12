#!/usr/bin/env -S npx tsx
// Functional spike gate for the interactive-draft seam (task #86, Phase 7c first leg).
//
// End-to-end on a SCRATCH stack — nothing touches the operator's real docs root, bus,
// engine store, workflow overlay dir, or draft ledger:
//
//   wicked-interactive serve (scratch docs root + scratch WICKED_BUS_DATA_DIR)
//        │  POST /api/docs {kind:"source"} → emits wicked.interactive.doc.created
//        ▼
//   crew daemon (REAL engine, in-process here) — interactive-draft subscriber
//        │  governed `interactive-draft` run (outline → draft) under a deterministic
//        │  stub seat (default) or the real council roster (WI_SPIKE_REAL=1)
//        ▼
//   wicked.interactive.status.posted narration + wicked.interactive.draft.completed
//        │
//        ▼
//   the service materializes _v1.html (data-wid instrumentation) + version.created
//
// Asserts (the spike gate):
//   1. _v1.html exists and carries data-wid instrumentation;
//   2. status narration from producer `wi-crew` appeared on the bus DURING generation;
//   3. a REPLAYED doc.created produces no duplicate version and no second run;
//   4. the run + its recorded events are visible via crew's API (GET /runs/:id).
//
// Run (from the wicked-crew repo root; wicked-interactive checked out as a sibling):
//   npx tsx e2e/interactive_draft_spike.mjs
//   WI_SPIKE_REAL=1 npx tsx e2e/interactive_draft_spike.mjs   # real council seat (claude)
//
// Not CI-wired on purpose: it needs the sibling wicked-interactive checkout (and, in real
// mode, a working `claude` CLI). The vitest suite covers the seam's own logic hermetically;
// this script is the cross-product proof.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CREW_ROOT = resolve(HERE, '..');
const INTERACTIVE_ROOT =
  process.env.WICKED_INTERACTIVE_REPO ?? resolve(CREW_ROOT, '..', 'wicked-interactive');
const REAL = process.env.WI_SPIKE_REAL === '1';
const DOC = 'spike-demo';
const RUN_TIMEOUT_MS = REAL ? 15 * 60_000 : 3 * 60_000;

if (!existsSync(join(INTERACTIVE_ROOT, 'bin', 'wicked-interactive.js'))) {
  console.error(`wicked-interactive not found at ${INTERACTIVE_ROOT} (set WICKED_INTERACTIVE_REPO)`);
  process.exit(2);
}

// ── Scratch stack ─────────────────────────────────────────────────────────────
const T = mkdtempSync(join(tmpdir(), 'wi-draft-spike-'));
const DOCS_ROOT = join(T, 'docs');
const BUS_DIR = join(T, 'bus');
const BUS_DB = join(BUS_DIR, 'bus.db');
const OVERLAY = join(T, 'overlay');
const DRAFTS = join(T, 'drafts');
const LEDGER = join(T, 'ledger.json');
for (const d of [DOCS_ROOT, BUS_DIR, OVERLAY, DRAFTS]) mkdirSync(d, { recursive: true });

// Scope every global the stack reads to the scratch dir BEFORE importing crew modules.
process.env.WICKED_BUS_DATA_DIR = BUS_DIR;
process.env.WICKED_WORKFLOWS_DIR = OVERLAY;
process.env.WICKED_MEMORY_EMBEDDER = 'hash';

// ── Deterministic stub seat (default mode) ────────────────────────────────────
// A real ENGINE run with a fake WORKER: the governed path (planning, dispatch, gates,
// event log, run visibility) is all real; only the LLM seat is replaced by a script that
// answers the outline phase with text and the draft phase by writing valid HTML to the
// output path named in the prompt.
const STUB = join(T, 'stub-drafter.sh');
writeFileSync(
  STUB,
  `#!/bin/sh
PROMPT="$*"
case "$PROMPT" in
  outline*)
    echo "OUTLINE: 1) hero — what the wicked ecosystem is; 2) three product cards; 3) closing call to action. Tone: crisp, confident. Style: web."
    ;;
  *)
    OUT=$(printf '%s' "$PROMPT" | grep -oE '/[^ ]*\\.html' | head -1)
    if [ -z "$OUT" ]; then echo "no output path found in prompt" >&2; exit 1; fi
    mkdir -p "$(dirname "$OUT")"
    cat > "$OUT" <<'HTML'
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>The wicked ecosystem</title>
<style>body{font-family:system-ui;margin:0;color:#1a1a2e}
.hero{padding:4rem 2rem;background:#0b1020;color:#fff}
.cards{display:flex;gap:1rem;padding:2rem}.card{flex:1;border:1px solid #ddd;border-radius:8px;padding:1.25rem}
.cta{padding:3rem 2rem;text-align:center}</style></head>
<body>
<section class="hero"><h1>The wicked ecosystem</h1><p>AI-native developer tooling: a knowledge layer, a governed orchestrator, and an acceptance gate that compose over one event bus.</p></section>
<section class="cards">
<div class="card"><h2>wicked-estate</h2><p>Code graph, memory, and knowledge in one binary — the center of gravity everything else queries.</p></div>
<div class="card"><h2>wicked-crew</h2><p>The harness for your agent harnesses: intent in, verified work out, evaluator never equals creator.</p></div>
<div class="card"><h2>wicked-testing</h2><p>A QE team that separates test authorship from judgment, so nothing grades its own homework.</p></div>
</section>
<section class="cta"><h2>One bus, many hands</h2><p>Every product speaks the same event vocabulary — which is how this very page was drafted by a governed crew.</p></section>
</body></html>
HTML
    echo "Draft written to $OUT"
    ;;
esac
`,
  'utf8',
);
chmodSync(STUB, 0o755);

const STUB_SEATS = JSON.stringify([
  {
    key: 'stub-drafter',
    display_name: 'Stub Drafter',
    binary: STUB,
    headless_invocation: `${STUB} {PROMPT}`,
  },
]);

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

let interactiveProc;
let crewApp;
let adapter;
async function cleanup() {
  try { if (crewApp) await crewApp.close(); } catch {}
  try { if (adapter) adapter.close(); } catch {}
  try { if (interactiveProc) interactiveProc.kill('SIGTERM'); } catch {}
}

try {
  // ── 1. interactive service on the scratch stack ─────────────────────────────
  const WI_PORT = 4471;
  interactiveProc = spawn(
    process.execPath,
    [join(INTERACTIVE_ROOT, 'bin', 'wicked-interactive.js'), 'serve', '--root', DOCS_ROOT, '--port', String(WI_PORT)],
    { env: { ...process.env, WICKED_BUS_DATA_DIR: BUS_DIR }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let wiOut = '';
  interactiveProc.stdout.on('data', (d) => { wiOut += String(d); });
  interactiveProc.stderr.on('data', (d) => { wiOut += String(d); });
  const WI_BASE = await waitFor('interactive service up', async () => {
    const m = wiOut.match(/on (http:\/\/localhost:\d+)/);
    const base = m ? m[1] : `http://localhost:${WI_PORT}`;
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) {
        const h = await res.json();
        if (resolve(h.root) === resolve(DOCS_ROOT)) return base;
      }
    } catch {}
    return null;
  }, 60_000);
  console.log(`interactive service: ${WI_BASE} (root ${DOCS_ROOT})`);

  // ── 2. crew daemon (REAL engine) with the seam armed ────────────────────────
  const { CoreAdapter } = await import('../packages/crew/src/core/adapter.ts');
  const { createServer } = await import('../packages/crew/src/api/server.ts');
  adapter = new CoreAdapter({ dbPath: join(T, 'core.db'), stub: false });
  crewApp = await createServer(adapter, {
    interactiveDraftEvents: {
      enabled: true,
      dbPath: BUS_DB,
      pollIntervalMs: 500,
      heartbeatMs: 5_000,
      ledgerPath: LEDGER,
      draftDir: DRAFTS,
      ...(REAL ? {} : { clisJson: STUB_SEATS }),
    },
  });
  await crewApp.listen({ port: 0, host: '127.0.0.1' });
  const addr = crewApp.server.address();
  const CREW_BASE = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  console.log(`crew daemon: ${CREW_BASE} (${REAL ? 'REAL council roster' : 'deterministic stub seat'})`);
  await sleep(1_500); // let the durable cursor register at `latest` before the trigger fires

  // ── 3. the trigger: create a source doc via interactive's API ──────────────
  const brief =
    'A one-page overview of the wicked ecosystem for a technical audience: what it is, ' +
    'the three flagship products (wicked-estate, wicked-crew, wicked-testing), and why an ' +
    'event bus ties them together. Crisp and confident, no marketing fluff.';
  const createRes = await fetch(`${WI_BASE}/api/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: DOC, kind: 'source', brief, style: 'web' }),
  });
  if (!createRes.ok) throw new Error(`POST /api/docs failed: ${createRes.status} ${await createRes.text()}`);
  console.log(`doc created: ${DOC} (kind source) → doc.created emitted`);

  // ── 4. crew answers: run appears, completes; service lands _v1.html ────────
  const runId = await waitFor('crew run for the doc', async () => {
    const res = await fetch(`${CREW_BASE}/api/v1/runs`);
    if (!res.ok) return null;
    const { runs } = await res.json();
    const run = (runs ?? []).find((r) => r.session?.problem?.includes(`"${DOC}"`));
    return run ? run.session.id : null;
  }, 60_000);
  console.log(`governed run: ${runId}`);

  const finalRun = await waitFor('run terminal', async () => {
    const res = await fetch(`${CREW_BASE}/api/v1/runs/${runId}`);
    if (!res.ok) return null;
    const { run } = await res.json();
    return ['completed', 'failed', 'cancelled'].includes(run.session.status) ? run : null;
  });
  check('governed run completed', finalRun.session.status === 'completed', `status=${finalRun.session.status}, units=${finalRun.units.length}`);

  const v1 = join(DOCS_ROOT, DOC, '_v1.html');
  await waitFor('service lands _v1.html', async () => existsSync(v1), 60_000);
  const html = readFileSync(v1, 'utf8');
  const widCount = (html.match(/data-wid="/g) ?? []).length;
  check('_v1.html exists with data-wid instrumentation', widCount > 0, `${widCount} anchors, ${html.length} bytes`);

  const versions = await (await fetch(`${WI_BASE}/d/${DOC}/api/versions`)).json();
  check('manifest head is v1 (write-once version landed)', versions.head === 1, `head=${versions.head}`);

  // ── 5. the bus trace: narration during generation, stamped wi-crew ─────────
  const bus = await import('wicked-bus');
  const db = bus.openDb({ db_path: BUS_DB });
  const rows = db
    .prepare('SELECT event_type, producer_id, payload FROM events ORDER BY event_id')
    .all();
  const crewStatus = rows.filter((r) => r.event_type === 'wicked.interactive.status.posted' && r.producer_id === 'wi-crew');
  const crewDraft = rows.filter((r) => r.event_type === 'wicked.interactive.draft.completed' && r.producer_id === 'wi-crew');
  const versionCreated = rows.filter((r) => r.event_type === 'wicked.interactive.version.created');
  check('status narration appeared during generation (producer wi-crew)', crewStatus.length >= 2, `${crewStatus.length} status.posted frames`);
  check('exactly one draft.completed (producer wi-crew)', crewDraft.length === 1, `${crewDraft.length} frame(s)`);
  check('service announced version.created', versionCreated.length >= 1, `${versionCreated.length} frame(s)`);
  console.log('narration trace:');
  for (const r of crewStatus) {
    const p = JSON.parse(r.payload);
    console.log(`  [${p.state}] ${p.message ?? ''}`);
  }

  // ── 6. replay: a redelivered doc.created must NOT produce a duplicate ───────
  const config = bus.loadConfig({ db_path: BUS_DB });
  bus.emit(db, config, {
    event_type: 'wicked.interactive.doc.created',
    domain: 'wicked-interactive',
    subdomain: 'docs',
    payload: { document_id: DOC, kind: 'source', brief, style: 'web', ts: new Date().toISOString() },
    producer_id: 'wi-service',
  });
  console.log('replayed doc.created — waiting to prove nothing happens…');
  await sleep(REAL ? 20_000 : 10_000);
  const versionsAfter = await (await fetch(`${WI_BASE}/d/${DOC}/api/versions`)).json();
  const runsAfter = await (await fetch(`${CREW_BASE}/api/v1/runs`)).json();
  const docRuns = (runsAfter.runs ?? []).filter((r) => r.session?.problem?.includes(`"${DOC}"`));
  check('replayed doc.created produced no duplicate version', versionsAfter.head === 1 && !existsSync(join(DOCS_ROOT, DOC, '_v2.html')), `head=${versionsAfter.head}`);
  check('replayed doc.created launched no second run', docRuns.length === 1, `${docRuns.length} run(s) for the doc`);

  // ── 7. run + evidence visibility via crew's API ─────────────────────────────
  const runDetail = await (await fetch(`${CREW_BASE}/api/v1/runs/${runId}`)).json();
  const unitStatuses = runDetail.run.units.map((u) => `${u.id.split(':').pop()}=${u.status}`).join(', ');
  check('run visible via GET /runs/:id with its units', runDetail.run.units.length === 2, unitStatuses);
  const eventsRes = await fetch(`${CREW_BASE}/api/v1/runs/${runId}/events`);
  const recorded = eventsRes.ok ? await eventsRes.json() : null;
  const recordedCount = Array.isArray(recorded?.events) ? recorded.events.length : Array.isArray(recorded) ? recorded.length : 0;
  check('run event history readable via GET /runs/:id/events', eventsRes.ok && recordedCount > 0, `${recordedCount} recorded events`);

  // ── Verdict ─────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? 'SPIKE GATE: PASS' : `SPIKE GATE: FAIL (${failed.length})`} — ${results.length} checks, scratch stack at ${T}`);
  await cleanup();
  if (failed.length === 0 && process.env.WI_SPIKE_KEEP !== '1') {
    // Leave the scratch dir for inspection on failure (or when WI_SPIKE_KEEP=1 for evidence capture).
    rmSync(T, { recursive: true, force: true });
  }
  process.exit(failed.length === 0 ? 0 : 1);
} catch (err) {
  console.error(`SPIKE GATE: ERROR — ${err?.stack ?? err}`);
  console.error(`scratch stack left at ${T} for inspection`);
  await cleanup();
  process.exit(1);
}
