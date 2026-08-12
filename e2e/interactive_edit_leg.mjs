#!/usr/bin/env -S npx tsx
// Functional gate for the interactive STRUCTURAL-edit seam (task #86, Phase 7c final leg).
//
// End-to-end on a SCRATCH stack — nothing touches the operator's real docs root, bus,
// engine store, workflow overlay dir, or ledgers. The full chain, both legs:
//
//   wicked-interactive serve (scratch docs root + scratch WICKED_BUS_DATA_DIR)
//        │  POST /api/docs {kind:"source", project} → doc BOUND at creation (DES-PROJECT-001,
//        │  registration-first via WICKED_CREW_API) → doc.created carries project_id
//        │  → crew DRAFT leg → governed run FILED into the project (P7 DEFECT-1) → _v1.html
//        ▼
//   POST /api/events feedback.submitted — ONE deterministic style-edit + ONE structural-change
//        │  service applies the deterministic edit INSTANTLY (model-free) → _v2.html partial
//        │  service emits feedback.processed {awaiting_structural:1, project_id, fragments inline}
//        ▼
//   crew daemon (REAL engine, in-process) — interactive-edit subscriber
//        │  governed `interactive-edit` run (single edit phase) under a deterministic stub seat
//        │  (default) or the real council roster (WI_EDIT_REAL=1); run FILED into the project
//        │  crew-side INV-2 pre-emit self-check on the worker's fragments
//        ▼
//   wicked.interactive.edit.completed {version:2, results} → service INV-2 gate → _v3.html
//
// Asserts (the leg's gate):
//   1. the deterministic edit landed in _v2.html BEFORE any crew involvement (stays local);
//   2. _v3.html exists with EVERY _v1 data-wid intact byte-exact + the requested change applied;
//   3. status narration from producer `wi-crew` appeared during the edit; exactly one
//      edit.completed; the service announced version.created {kind:"structural"};
//   4. BOTH governed runs (draft + edit) are FILED in the crew project (member_kind crew.run)
//      with membership.attached announced on the bus — the 7b surface + the DEFECT-1 fix;
//   5. a REPLAYED feedback.processed produces no second run and no duplicate version;
//   6. NEGATIVE (stub mode only): a worker output that strips data-wids is REJECTED by the
//      crew-side self-check — error status naming data-wid, no edit.completed, no new version.
//
// Run (from the wicked-crew repo root; wicked-interactive checked out as a sibling):
//   npx tsx e2e/interactive_edit_leg.mjs
//   WI_EDIT_REAL=1 npx tsx e2e/interactive_edit_leg.mjs   # real council seat (claude)
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
const REAL = process.env.WI_EDIT_REAL === '1';
const DOC = 'edit-leg-demo';
const MARKER = 'Powered by a governed crew';
const RUN_TIMEOUT_MS = REAL ? 15 * 60_000 : 3 * 60_000;

if (!existsSync(join(INTERACTIVE_ROOT, 'bin', 'wicked-interactive.js'))) {
  console.error(`wicked-interactive not found at ${INTERACTIVE_ROOT} (set WICKED_INTERACTIVE_REPO)`);
  process.exit(2);
}

// ── Scratch stack ─────────────────────────────────────────────────────────────
const T = mkdtempSync(join(tmpdir(), 'wi-edit-leg-'));
const DOCS_ROOT = join(T, 'docs');
const BUS_DIR = join(T, 'bus');
const BUS_DB = join(BUS_DIR, 'bus.db');
const OVERLAY = join(T, 'overlay');
const DRAFTS = join(T, 'drafts');
const EDITS = join(T, 'edits');
for (const d of [DOCS_ROOT, BUS_DIR, OVERLAY, DRAFTS, EDITS]) mkdirSync(d, { recursive: true });

// Scope every global the stack reads to the scratch dir BEFORE importing crew modules.
process.env.WICKED_BUS_DATA_DIR = BUS_DIR;
process.env.WICKED_WORKFLOWS_DIR = OVERLAY;
process.env.WICKED_MEMORY_EMBEDDER = 'hash';

// ── Deterministic stub seat (default mode) ────────────────────────────────────
// A real ENGINE run with a fake WORKER: planning, dispatch, gates, event log, and run
// visibility are all real; only the LLM seat is a script. Three behaviors:
//   outline phase        → answers with a plan (draft leg);
//   edit-handoff prompt  → node helper reads the handoff JSON and edits each fragment —
//                          wid-preserving normally, wid-STRIPPING when the user instruction
//                          says NEGATIVE-TEST (the deliberate INV-2 violation);
//   anything else        → writes the full first-draft HTML (draft leg).
const EDIT_HELPER = join(T, 'edit-stub.mjs');
writeFileSync(
  EDIT_HELPER,
  `import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const prompt = process.argv.slice(2).join(' ');
const m = prompt.match(/\\/[^ ]*handoff\\.json/);
if (!m) { console.error('no handoff path in prompt'); process.exit(1); }
const handoff = JSON.parse(readFileSync(m[0], 'utf8'));
for (const item of handoff.items) {
  const violate = String(item.instruction).includes('NEGATIVE-TEST');
  const edited = violate
    ? item.fragment.replace(/ data-wid="[^"]*"/g, '')                       // INV-2 violation
    : item.fragment.replace(/^(<[^>]+>)[\\s\\S]*(<\\/[a-zA-Z0-9]+>)\\s*$/, '$1${MARKER}$2');
  mkdirSync(dirname(item.output_path), { recursive: true });
  writeFileSync(item.output_path, edited, 'utf8');
  console.log('wrote', item.output_path, violate ? '(NEGATIVE-TEST: wids stripped)' : '');
}
`,
  'utf8',
);
const STUB = join(T, 'stub-worker.sh');
writeFileSync(
  STUB,
  `#!/bin/sh
PROMPT="$*"
case "$PROMPT" in
  outline*)
    echo "OUTLINE: 1) hero — what the wicked ecosystem is; 2) three product cards; 3) closing call to action. Tone: crisp, confident. Style: web."
    ;;
  *handoff.json*)
    exec ${process.execPath} ${EDIT_HELPER} "$PROMPT"
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
    key: 'stub-worker',
    display_name: 'Stub Worker',
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
const widsOf = (html) => [...html.matchAll(/data-wid="([^"]*)"/g)].map((m) => m[1]);

let interactiveProc;
let crewApp;
let adapter;
async function cleanup() {
  try { if (crewApp) await crewApp.close(); } catch {}
  try { if (adapter) adapter.close(); } catch {}
  try { if (interactiveProc) interactiveProc.kill('SIGTERM'); } catch {}
}

try {
  // ── 1. crew daemon (REAL engine) with BOTH interactive seams armed ─────────
  // Crew comes up FIRST: the doc is bound to a project AT CREATION (registration-first,
  // DES-PROJECT-001) and interactive's bind path calls crew's API via WICKED_CREW_API.
  const { CoreAdapter } = await import('../packages/crew/src/core/adapter.ts');
  const { createServer } = await import('../packages/crew/src/api/server.ts');
  adapter = new CoreAdapter({ dbPath: join(T, 'core.db'), stub: false });
  crewApp = await createServer(adapter, {
    // The draft leg is this harness's PREREQUISITE, not its subject — it stays on the stub
    // seat even in real mode (its own real-seat evidence is the spike's, PR #241).
    interactiveDraftEvents: {
      enabled: true,
      dbPath: BUS_DB,
      pollIntervalMs: 500,
      heartbeatMs: 5_000,
      ledgerPath: join(T, 'draft-ledger.json'),
      draftDir: DRAFTS,
      clisJson: STUB_SEATS,
    },
    // The EDIT seam is the leg under test: real council roster when WI_EDIT_REAL=1.
    interactiveEditEvents: {
      enabled: true,
      dbPath: BUS_DB,
      pollIntervalMs: 500,
      heartbeatMs: 5_000,
      ledgerPath: join(T, 'edit-ledger.json'),
      editDir: EDITS,
      ...(REAL ? {} : { clisJson: STUB_SEATS }),
    },
    projectEvents: { dbPath: BUS_DB },
  });
  await crewApp.listen({ port: 0, host: '127.0.0.1' });
  const addr = crewApp.server.address();
  const CREW_BASE = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  console.log(`crew daemon: ${CREW_BASE} (${REAL ? 'REAL council roster' : 'deterministic stub seat'})`);
  await sleep(1_500); // let the durable cursors register at `latest` before any trigger fires

  // ── 2. interactive service on the scratch stack, pointed at the crew daemon ─
  const WI_PORT = 4473;
  interactiveProc = spawn(
    process.execPath,
    [join(INTERACTIVE_ROOT, 'bin', 'wicked-interactive.js'), 'serve', '--root', DOCS_ROOT, '--port', String(WI_PORT)],
    { env: { ...process.env, WICKED_BUS_DATA_DIR: BUS_DIR, WICKED_CREW_API: CREW_BASE }, stdio: ['ignore', 'pipe', 'pipe'] },
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

  // ── 3. a crew project + a source doc BOUND TO IT AT CREATION (the 7b surface) ─
  const projRes = await fetch(`${CREW_BASE}/api/v1/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Interactive edit leg', description: 'task #86 final leg e2e' }),
  });
  if (!projRes.ok) throw new Error(`POST /projects failed: ${projRes.status} ${await projRes.text()}`);
  const { project } = await projRes.json();
  console.log(`crew project: ${project.id}`);

  const brief =
    'A one-page overview of the wicked ecosystem for a technical audience: what it is, ' +
    'the three flagship products, and why an event bus ties them together.';
  const createRes = await fetch(`${WI_BASE}/api/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: DOC, kind: 'source', brief, style: 'web', project: project.id }),
  });
  if (!createRes.ok) throw new Error(`POST /api/docs failed: ${createRes.status} ${await createRes.text()}`);
  const created = await createRes.json();
  check('doc bound to the project at creation (registration-first)', created.project_id === project.id, `project_id=${created.project_id}`);
  console.log(`doc created + bound: ${DOC} → project ${project.id}`);

  // ── 4. the DRAFT leg lands _v1.html — and the run is FILED (P7 DEFECT-1) ───
  const v1Path = join(DOCS_ROOT, DOC, '_v1.html');
  await waitFor('draft leg lands _v1.html', async () => existsSync(v1Path));
  const v1 = readFileSync(v1Path, 'utf8');
  const v1Wids = widsOf(v1);
  check('draft leg: _v1.html landed with data-wid instrumentation', v1Wids.length > 0, `${v1Wids.length} anchors`);
  const draftRunId = await waitFor('draft run visible', async () => {
    const res = await fetch(`${CREW_BASE}/api/v1/runs`);
    if (!res.ok) return null;
    const { runs } = await res.json();
    const run = (runs ?? []).find((r) => r.session?.problem?.includes('first draft'));
    return run ? run.session.id : null;
  }, 30_000);

  // Pick targets from the REAL instrumented markup (content is seat-authored, so no text
  // pinning): the first leaf block (structural rewrite) and the first h1 (deterministic
  // style-edit) — falling back to any other anchor when the draft carries no h1.
  const pickLeaf = (html) => {
    for (const tag of ['h2', 'p', 'li']) {
      const m = html.match(new RegExp(`<${tag}[^>]*data-wid="([^"]+)"`));
      if (m) return { tag, wid: m[1] };
    }
    return null;
  };
  const target = pickLeaf(v1);
  const heroWid =
    (v1.match(/<h1[^>]*data-wid="([^"]+)"/) ?? [])[1] ??
    [...new Set(v1Wids)].find((w) => w !== target?.wid);
  if (!target || !heroWid || target.wid === heroWid) {
    throw new Error(`could not pick distinct target wids in _v1.html (leaf=${target?.wid}, hero=${heroWid})`);
  }
  const ctaWid = target.wid;
  const innerOf = (html) =>
    (html.match(new RegExp(`<${target.tag}[^>]*data-wid="${ctaWid}"[^>]*>([\\s\\S]*?)</${target.tag}>`)) ?? [])[1];

  // ── 5. the trigger: ONE feedback batch — deterministic + structural ────────
  const fbRes = await fetch(`${WI_BASE}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_type: 'wicked.interactive.feedback.submitted',
      payload: {
        document_id: DOC,
        items: [
          { selector: heroWid, type: 'style-edit', style: { color: '#c00000' } },
          { selector: ctaWid, type: 'structural-change', instruction: 'Rewrite this block to be punchier and more concrete' },
        ],
      },
    }),
  });
  if (!fbRes.ok) throw new Error(`feedback.submitted failed: ${fbRes.status} ${await fbRes.text()}`);

  // The deterministic half lands INSTANTLY in the model-free service (_v2 partial) — before
  // any crew run exists. Only the structural remainder climbs.
  const v2Path = join(DOCS_ROOT, DOC, '_v2.html');
  await waitFor('service lands the deterministic partial _v2.html', async () => existsSync(v2Path), 30_000);
  const v2 = readFileSync(v2Path, 'utf8');
  check('deterministic edit stayed LOCAL: style landed in _v2 with no crew run yet', v2.includes('#c00000'), 'style-edit applied by the service');

  // ── 6. crew answers the structural handoff with a governed run ─────────────
  const editRunId = await waitFor('crew edit run for the handoff', async () => {
    const res = await fetch(`${CREW_BASE}/api/v1/runs`);
    if (!res.ok) return null;
    const { runs } = await res.json();
    const run = (runs ?? []).find((r) => r.session?.problem?.includes('structural edit'));
    return run ? run.session.id : null;
  }, 60_000);
  console.log(`governed edit run: ${editRunId}`);

  const finalRun = await waitFor('edit run terminal', async () => {
    const res = await fetch(`${CREW_BASE}/api/v1/runs/${editRunId}`);
    if (!res.ok) return null;
    const { run } = await res.json();
    return ['completed', 'failed', 'cancelled'].includes(run.session.status) ? run : null;
  });
  check('governed edit run completed', finalRun.session.status === 'completed', `status=${finalRun.session.status}, units=${finalRun.units.length}`);

  // The handoff FILE carried ONLY the structural item (the deterministic one never climbed).
  const handoffPath = join(EDITS, `${DOC}-v2-handoff.json`);
  const handoff = existsSync(handoffPath) ? JSON.parse(readFileSync(handoffPath, 'utf8')) : null;
  check(
    'handoff file carries ONLY the structural item',
    handoff !== null && handoff.items.length === 1 && handoff.items[0].selector === ctaWid,
    `${handoff?.items?.length ?? 0} item(s), selector ${handoff?.items?.[0]?.selector}`,
  );

  // ── 7. the service materializes the follow-on version through its INV-2 gate ─
  const v3Path = join(DOCS_ROOT, DOC, '_v3.html');
  await waitFor('service lands the structural _v3.html', async () => existsSync(v3Path), 60_000);
  const v3 = readFileSync(v3Path, 'utf8');
  const v3Wids = new Set(widsOf(v3));
  const missing = [...new Set(v1Wids)].filter((w) => !v3Wids.has(w));
  check('INV-2 at scale: EVERY _v1 data-wid survives into _v3 byte-exact', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${new Set(v1Wids).size} anchors preserved`);
  const changed = innerOf(v3) !== undefined && innerOf(v3) !== innerOf(v2);
  check('the requested change applied in _v3', REAL ? changed : v3.includes(MARKER), REAL ? `target ${ctaWid} rewritten by the real seat` : `marker "${MARKER}" present`);
  check('the deterministic edit persists through the structural version', v3.includes('#c00000'), 'style-edit still applied');
  const versions = await (await fetch(`${WI_BASE}/d/${DOC}/api/versions`)).json();
  check('manifest head is v3 (draft → partial → structural)', versions.head === 3, `head=${versions.head}`);

  // ── 8. the bus trace ────────────────────────────────────────────────────────
  const bus = await import('wicked-bus');
  const db = bus.openDb({ db_path: BUS_DB });
  const rows = () => db.prepare('SELECT event_type, producer_id, payload, idempotency_key FROM events ORDER BY event_id').all();
  let r = rows();
  const editStatus = r.filter((x) => x.event_type === 'wicked.interactive.status.posted' && x.producer_id === 'wi-crew' && JSON.parse(x.payload).version !== undefined);
  const editCompleted = r.filter((x) => x.event_type === 'wicked.interactive.edit.completed' && x.producer_id === 'wi-crew');
  const structuralVersion = r.filter((x) => x.event_type === 'wicked.interactive.version.created' && JSON.parse(x.payload).kind === 'structural');
  check('status narration appeared during the edit (producer wi-crew)', editStatus.length >= 2, `${editStatus.length} status.posted frames`);
  check('exactly one edit.completed (producer wi-crew) with the doc+version key', editCompleted.length === 1 && editCompleted[0].idempotency_key === `crew:interactive.edit:${DOC}:v2`, `${editCompleted.length} frame(s), key=${editCompleted[0]?.idempotency_key}`);
  check('service announced version.created {kind:"structural"}', structuralVersion.length === 1, `${structuralVersion.length} frame(s)`);
  const fbFrame = r.find((x) => x.event_type === 'wicked.interactive.feedback.processed' && JSON.parse(x.payload).awaiting_structural > 0);
  check('the handoff event carried the doc’s project binding', fbFrame !== undefined && JSON.parse(fbFrame.payload).project_id === project.id, `project_id=${fbFrame ? JSON.parse(fbFrame.payload).project_id : '(none)'}`);
  console.log('narration trace:');
  for (const x of editStatus) {
    const p = JSON.parse(x.payload);
    console.log(`  [${p.state}] ${p.message ?? ''}`);
  }

  // ── 9. BOTH runs are FILED in the project (LaunchOptions.projectId, 7b) ────
  const members = await (await fetch(`${CREW_BASE}/api/v1/projects/${project.id}/members`)).json();
  const memberRefs = (members.members ?? []).filter((m) => m.member_kind === 'crew.run').map((m) => m.member_ref);
  check('governed DRAFT run filed as a crew.run member (P7 DEFECT-1 regression)', memberRefs.includes(draftRunId), `draft run ${draftRunId}`);
  check('governed EDIT run filed as a crew.run member of the project', memberRefs.includes(editRunId), `edit run ${editRunId}`);
  const docMember = (members.members ?? []).find((m) => m.member_kind === 'interactive.doc' && m.member_ref === DOC);
  check('the doc itself is an interactive.doc member (bind-at-creation)', docMember !== undefined);
  const attachFrames = r.filter((x) => x.event_type === 'wicked.crew.membership.attached');
  const attachedRefs = attachFrames.map((x) => JSON.parse(x.payload).member?.ref);
  check('membership.attached announced for BOTH governed runs', attachedRefs.includes(draftRunId) && attachedRefs.includes(editRunId), `${attachFrames.length} attach frame(s)`);
  const activity = await (await fetch(`${CREW_BASE}/api/v1/projects/${project.id}/activity`)).json();
  check('edit run visible in the project activity feed', (activity.entries ?? []).some((e) => JSON.stringify(e).includes(editRunId)), `${activity.entries?.length ?? 0} entries`);

  // ── 10. replay: a redelivered handoff must NOT produce a duplicate ─────────
  const config = bus.loadConfig({ db_path: BUS_DB });
  bus.emit(db, config, {
    event_type: 'wicked.interactive.feedback.processed',
    domain: 'wicked-interactive',
    subdomain: 'feedback',
    payload: JSON.parse(fbFrame.payload),
    producer_id: 'wi-service',
  });
  console.log('replayed feedback.processed — waiting to prove nothing happens…');
  await sleep(REAL ? 20_000 : 10_000);
  const versionsAfter = await (await fetch(`${WI_BASE}/d/${DOC}/api/versions`)).json();
  r = rows();
  const editRunsAfter = (await (await fetch(`${CREW_BASE}/api/v1/runs`)).json()).runs.filter(
    (x) => x.session?.problem?.includes('structural edit') && x.session?.problem?.includes('version 2'),
  );
  check('replayed handoff produced no duplicate version', versionsAfter.head === 3 && !existsSync(join(DOCS_ROOT, DOC, '_v4.html')), `head=${versionsAfter.head}`);
  check('replayed handoff launched no second run', editRunsAfter.length === 1, `${editRunsAfter.length} run(s) for the v2 handoff`);
  check('still exactly one edit.completed after the replay', r.filter((x) => x.event_type === 'wicked.interactive.edit.completed').length === 1);

  // ── 11. NEGATIVE (stub mode): a wid-stripping worker output is REJECTED ────
  if (!REAL) {
    const negRes = await fetch(`${WI_BASE}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_type: 'wicked.interactive.feedback.submitted',
        payload: {
          document_id: DOC,
          items: [
            { selector: ctaWid, type: 'structural-change', instruction: 'NEGATIVE-TEST: strip the anchors from this block' },
          ],
        },
      }),
    });
    if (!negRes.ok) throw new Error(`negative feedback.submitted failed: ${negRes.status} ${await negRes.text()}`);
    // The service lands the (empty) partial _v4, then hands off v4; the stub worker
    // deliberately strips every data-wid; crew's pre-emit self-check must reject it.
    const errFrame = await waitFor('crew rejects the INV-2-violating worker output', async () => {
      const rowsNow = rows();
      return rowsNow.find(
        (x) =>
          x.event_type === 'wicked.interactive.status.posted' &&
          x.producer_id === 'wi-crew' &&
          JSON.parse(x.payload).state === 'error' &&
          String(JSON.parse(x.payload).message).includes('data-wid'),
      ) ?? null;
    }, 120_000);
    check('NEGATIVE: self-check rejected the wid-stripping edit with an honest error', errFrame !== undefined, JSON.parse(errFrame.payload).message.slice(0, 120));
    await sleep(3_000); // grace: prove no version materializes after the rejection
    r = rows();
    const versionsNeg = await (await fetch(`${WI_BASE}/d/${DOC}/api/versions`)).json();
    check('NEGATIVE: no edit.completed emitted for the violating handoff', r.filter((x) => x.event_type === 'wicked.interactive.edit.completed').length === 1);
    check('NEGATIVE: no structural version landed (head stays at the partial)', versionsNeg.head === 4 && !existsSync(join(DOCS_ROOT, DOC, '_v5.html')), `head=${versionsNeg.head}`);
  } else {
    console.log('real mode: negative INV-2 leg skipped (a real seat is instructed to preserve anchors; the deterministic violation needs the stub)');
  }

  // ── 12. run + evidence visibility via crew's API ────────────────────────────
  const runDetail = await (await fetch(`${CREW_BASE}/api/v1/runs/${editRunId}`)).json();
  const unitStatuses = runDetail.run.units.map((u) => `${u.id.split(':').pop()}=${u.status}`).join(', ');
  check('edit run visible via GET /runs/:id with its single edit unit', runDetail.run.units.length === 1, unitStatuses);
  const eventsRes = await fetch(`${CREW_BASE}/api/v1/runs/${editRunId}/events`);
  const recorded = eventsRes.ok ? await eventsRes.json() : null;
  const recordedCount = Array.isArray(recorded?.events) ? recorded.events.length : Array.isArray(recorded) ? recorded.length : 0;
  check('edit run event history readable via GET /runs/:id/events', eventsRes.ok && recordedCount > 0, `${recordedCount} recorded events`);

  // ── Verdict ─────────────────────────────────────────────────────────────────
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${failed.length === 0 ? 'EDIT LEG GATE: PASS' : `EDIT LEG GATE: FAIL (${failed.length})`} — ${results.length} checks, scratch stack at ${T}`);
  await cleanup();
  if (failed.length === 0 && process.env.WI_EDIT_KEEP !== '1') {
    // Leave the scratch dir for inspection on failure (or when WI_EDIT_KEEP=1 for evidence capture).
    rmSync(T, { recursive: true, force: true });
  }
  process.exit(failed.length === 0 ? 0 : 1);
} catch (err) {
  console.error(`EDIT LEG GATE: ERROR — ${err?.stack ?? err}`);
  console.error(`scratch stack left at ${T} for inspection`);
  await cleanup();
  process.exit(1);
}
