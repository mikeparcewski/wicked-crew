#!/usr/bin/env -S npx tsx
// DES-PROJECT-001 §8 — the Phase 7 functional test, VERBATIM: one project created in studio,
// continued in interactive, both reflecting the same state. This run is the Phase-7 gate
// evidence (task #87): every numbered step below is the ADR's numbered assertion boundary.
//
// Scratch stack (nothing touches the operator's real docs root, bus, or engine store):
//
//   crew daemon (REAL engine addon, wrapped-CLI runner + deterministic stub seat)
//        │ /api/v1 (+ /ws) — the contract BOTH skins are pure clients of (§5.1); the studio
//        │ bundle and interactive's panel render these same reads, so the API drive below IS
//        │ the two-skin proof at the layer the ADR fixes.
//        ▼
//   wicked-interactive serve (scratch docs root, same scratch bus)
//
// Steps (ADR §8): 1 boot · 2 create project · 3 gated run auto-attached · 4 durable prompt ·
// 5 RESTART SURVIVAL · 6 continue in interactive (create --project) · 7 activity interleave
// + live /ws · 8 gate answered from the creator skin · 9 foundation record · 10 offline
// regression. Pass = all ten.
//
// Run (crew repo root; wicked-interactive checked out as a sibling or via WICKED_INTERACTIVE_REPO):
//   npx tsx e2e/project_model_e2e.mjs

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chmodSync } from 'node:fs';
import WebSocket from 'ws';

const HERE = dirname(fileURLToPath(import.meta.url));
const CREW_ROOT = resolve(HERE, '..');
const INTERACTIVE_ROOT =
  process.env.WICKED_INTERACTIVE_REPO ?? resolve(CREW_ROOT, '..', 'wicked-interactive');
const DOC = 'keystone-brief';
const RUN_ID = 'e2e-keystone-run';
const STEP_TIMEOUT_MS = 120_000;

if (!existsSync(join(INTERACTIVE_ROOT, 'bin', 'wicked-interactive.js'))) {
  console.error(`wicked-interactive not found at ${INTERACTIVE_ROOT} (set WICKED_INTERACTIVE_REPO)`);
  process.exit(2);
}

// ── Scratch stack ─────────────────────────────────────────────────────────────
const T = mkdtempSync(join(tmpdir(), 'project-model-e2e-'));
const DOCS_ROOT = join(T, 'docs');
const BUS_DIR = join(T, 'bus');
const BUS_DB = join(BUS_DIR, 'bus.db');
const CORE_DB = join(T, 'core.db');
for (const d of [DOCS_ROOT, BUS_DIR]) mkdirSync(d, { recursive: true });
process.env.WICKED_BUS_DATA_DIR = BUS_DIR;
process.env.WICKED_MEMORY_EMBEDDER = 'hash';

// Deterministic stub seat: a REAL engine run (planning, dispatch, gates, durable event log)
// with a scripted worker — "stub seats acceptable; every step must actually execute".
const STUB = join(T, 'stub-seat.sh');
writeFileSync(STUB, `#!/bin/sh\necho "did: $*"\n`, 'utf8');
chmodSync(STUB, 0o755);
const STUB_SEATS = JSON.stringify([
  { key: 'stub-seat', display_name: 'Stub Seat', binary: STUB, headless_invocation: `${STUB} {PROMPT}` },
]);

// ── Harness helpers ───────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label, cond, timeoutMs = STEP_TIMEOUT_MS, stepMs = 300) {
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
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(`assertion failed: ${name}`);
}
async function api(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

let interactiveProc;
let crewApp;
let adapter;
let ws;
const wsFrames = [];

async function bootCrew() {
  const { CoreAdapter } = await import('../packages/crew/src/core/adapter.ts');
  const { createServer } = await import('../packages/crew/src/api/server.ts');
  adapter = new CoreAdapter({ dbPath: CORE_DB, stub: false });
  crewApp = await createServer(adapter, {
    projectEvents: { dbPath: BUS_DB, pollIntervalMs: 300 },
  });
  await crewApp.listen({ port: 0, host: '127.0.0.1' });
  const addr = crewApp.server.address();
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}
async function stopCrew() {
  try { if (ws) { ws.close(); ws = null; } } catch { /* closing */ }
  if (crewApp) await crewApp.close();
  if (adapter) adapter.close();
  crewApp = undefined;
  adapter = undefined;
}
function busRows() {
  return import('wicked-bus').then((bus) => {
    const db = bus.openDb({ db_path: BUS_DB });
    return db.prepare('SELECT event_type, producer_id, payload FROM events ORDER BY event_id').all()
      .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  });
}

try {
  // ═══ 1. BOOT — fresh core.db; crew daemon (+ /api/v1, the studio contract); interactive serve
  //        (bus-connected); gh/network not required. ═══
  let CREW = await bootCrew();
  const WI_PORT = 4491;
  interactiveProc = spawn(
    process.execPath,
    [join(INTERACTIVE_ROOT, 'bin', 'wicked-interactive.js'), 'serve', '--root', DOCS_ROOT, '--port', String(WI_PORT)],
    {
      env: { ...process.env, WICKED_BUS_DATA_DIR: BUS_DIR, WICKED_CREW_API: CREW },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let wiLog = '';
  interactiveProc.stdout.on('data', (d) => { wiLog += String(d); });
  interactiveProc.stderr.on('data', (d) => { wiLog += String(d); });
  const WI = await waitFor('interactive service up', async () => {
    try {
      const res = await fetch(`http://localhost:${WI_PORT}/api/health`);
      if (res.ok) return `http://localhost:${WI_PORT}`;
    } catch { /* booting */ }
    return null;
  }, 60_000);
  check('1. boot: crew daemon + interactive serve up on a fresh scratch stack', true, `crew=${CREW} wi=${WI}`);

  // ═══ 2. CREATE IN STUDIO — the studio skin is a pure client of POST /api/v1/projects (§5.1);
  //        assert 201, the wicked.crew.project.created bus event, and the list read. ═══
  const created = await api(CREW, 'POST', '/api/v1/projects', {
    name: 'e2e-keystone',
    description: 'one project, two skins, one state',
  });
  check('2a. POST /projects → 201', created.status === 201, `status=${created.status}`);
  const project = created.json.project;
  const createdEvent = await waitFor('wicked.crew.project.created on the bus', async () => {
    const rows = await busRows();
    return rows.find((r) => r.event_type === 'wicked.crew.project.created' && r.payload.project_id === project.id) ?? null;
  }, 20_000);
  check('2b. wicked.crew.project.created on the bus', createdEvent !== null, `scope=${createdEvent.payload.scope}`);
  const listed = await api(CREW, 'GET', '/api/v1/projects');
  check(
    '2c. project appears in GET /projects (beside the synthesized default)',
    listed.json.projects.some((p) => p.id === project.id) && listed.json.projects.some((p) => p.id === 'default'),
  );

  // ═══ 3. LAUNCH GOVERNED WORK — from studio, a run with projectId + a human-confirm gate;
  //        assert membership.attached with member.kind crew.run. ═══
  const launched = await api(CREW, 'POST', '/api/v1/runs', {
    problem: 'Do step one. Do step two',
    sessionId: RUN_ID,
    clisJson: STUB_SEATS,
    humanConfirm: 'before:1',
    projectId: project.id,
  });
  check('3a. POST /runs {projectId, humanConfirm} → 201', launched.status === 201, `run=${launched.json.runId}`);
  const attachedEvent = await waitFor('membership.attached on the bus', async () => {
    const rows = await busRows();
    return rows.find(
      (r) => r.event_type === 'wicked.crew.membership.attached'
        && r.payload.project_id === project.id
        && r.payload.member?.kind === 'crew.run'
        && r.payload.member?.ref === RUN_ID,
    ) ?? null;
  }, 20_000);
  check('3b. wicked.crew.membership.attached {kind: crew.run}', attachedEvent !== null);
  const members = await api(CREW, 'GET', `/api/v1/projects/${project.id}/members`);
  check(
    '3c. the run is a member (attached atomically with the launch record)',
    members.json.members.some((m) => m.member_kind === 'crew.run' && m.member_ref === RUN_ID),
  );

  // ═══ 4. GATE BECOMES DURABLE STATE — at awaiting_human, GET /projects/:id/prompts returns
  //        one open gate with the prompt text. ═══
  await waitFor('run reaches awaiting_human', async () => {
    const run = await api(CREW, 'GET', `/api/v1/runs/${RUN_ID}`);
    return run.json?.run?.session?.status === 'awaiting_human' ? true : null;
  });
  const inbox = await api(CREW, 'GET', `/api/v1/projects/${project.id}/prompts`);
  check(
    '4. one OPEN gate in the durable prompt inbox, with the prompt text',
    inbox.json.prompts.length === 1
      && inbox.json.prompts[0].kind === 'gate'
      && inbox.json.prompts[0].status === 'open'
      && inbox.json.prompts[0].prompt.length > 0,
    `prompt="${inbox.json.prompts[0]?.prompt?.slice(0, 60)}…"`,
  );
  const promptBeforeRestart = inbox.json.prompts[0];

  // ═══ 5. RESTART SURVIVAL — restart the crew daemon; the SAME open prompt returns.
  //        (The ephemeral-GateCache fix, proven, not promised.) ═══
  await stopCrew();
  CREW = await bootCrew();
  const inboxAfter = await api(CREW, 'GET', `/api/v1/projects/${project.id}/prompts`);
  check(
    '5. the open prompt SURVIVES the daemon restart (fresh process, cold caches)',
    inboxAfter.json.prompts.length === 1
      && inboxAfter.json.prompts[0].id === promptBeforeRestart.id
      && inboxAfter.json.prompts[0].prompt === promptBeforeRestart.prompt,
    `ir=${inboxAfter.json.prompts[0]?.id}`,
  );

  // Open the live /ws tap NOW (step 7 asserts liveness on it; the daemon tags frames with
  // project_id from the membership table, and bridges interactive bus events as projectActivity).
  ws = new WebSocket(`${CREW.replace('http', 'ws')}/ws`);
  ws.on('message', (data) => { try { wsFrames.push(JSON.parse(String(data))); } catch { /* raw */ } });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

  // ═══ 6. CONTINUE IN INTERACTIVE — `wicked-interactive create … --project <proj_id>`; assert
  //        the interactive.doc membership and the project.json breadcrumb beside versions.json. ═══
  const wiContent = {
    schema_version: '1.0',
    artifact_id: 'e2e-keystone-brief',
    title: 'Keystone Brief',
    created_at: new Date().toISOString(),
    source_type: 'file',
    sections: [
      { type: 'header', content: 'One project, two skins' },
      { type: 'summary', content: 'The keystone e2e: created in studio, continued in interactive.' },
    ],
  };
  const contentPath = join(T, 'wi-content.json');
  writeFileSync(contentPath, JSON.stringify(wiContent, null, 2));
  // Async spawn, NOT spawnSync: the crew daemon runs IN THIS process, and the CLI must be able
  // to call it while we wait — a sync child would deadlock the answerer.
  const createDoc = await new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      [
        join(INTERACTIVE_ROOT, 'bin', 'wicked-interactive.js'), 'create',
        '--from-file', contentPath,
        '--project', project.id,
        '--name', DOC,
        '--root', DOCS_ROOT,
        '--crew-api', CREW,
      ],
      { env: { ...process.env, WICKED_BUS_DATA_DIR: BUS_DIR }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { out += String(d); });
    child.on('close', (code) => resolveRun({ status: code, out }));
  });
  check('6a. create --project exits 0', createDoc.status === 0, createDoc.out.trim().split('\n')[0]);
  const membersAfterDoc = await api(CREW, 'GET', `/api/v1/projects/${project.id}/members`);
  check(
    '6b. interactive.doc membership registered (registration is the authority)',
    membersAfterDoc.json.members.some((m) => m.member_kind === 'interactive.doc' && m.member_ref === DOC),
  );
  const docDir = join(DOCS_ROOT, DOC);
  const crumb = JSON.parse(readFileSync(join(docDir, 'project.json'), 'utf8'));
  check(
    '6c. project.json breadcrumb BESIDE versions.json (manifest untouched)',
    existsSync(join(docDir, 'versions.json'))
      && crumb.project_id === project.id
      && JSON.parse(readFileSync(join(docDir, 'versions.json'), 'utf8')).project_id === undefined,
    `breadcrumb={project_id:${crumb.project_id}, name:${crumb.project_name}}`,
  );

  // ═══ 7. CREATOR-SIDE PROGRESS VISIBLE TO THE CODER SKIN — iterate the doc once (feedback →
  //        new version); version.created carries project_id; /activity interleaves run + doc
  //        entries in ts order; the doc event shows on /ws without reload. ═══
  const v0 = readFileSync(join(docDir, '_v0.html'), 'utf8');
  const anchor = v0.match(/data-wid="([^"]+)"/);
  check('7a. the doc is instrumented (data-wid anchors to iterate against)', anchor !== null);
  const feedback = await fetch(`${WI}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event_type: 'wicked.interactive.feedback.submitted',
      payload: {
        document_id: DOC,
        version_target: 0,
        items: [{ selector: anchor[1], type: 'content-edit', value: 'One project, two skins, one state' }],
      },
    }),
  });
  check('7b. feedback.submitted accepted by the creator skin', feedback.ok, `status=${feedback.status}`);
  const versionEvent = await waitFor('version.created carrying project_id', async () => {
    const rows = await busRows();
    return rows.find(
      (r) => r.event_type === 'wicked.interactive.version.created'
        && r.payload.document_id === DOC
        && r.payload.project_id === project.id,
    ) ?? null;
  });
  check('7c. wicked.interactive.version.created carries project_id', versionEvent !== null, `v${versionEvent.payload.version}`);

  const activity = await api(CREW, 'GET', `/api/v1/projects/${project.id}/activity?limit=100`);
  const entries = activity.json.entries;
  const hasRunEntry = entries.some((e) => e.source === 'crew' && e.ref === RUN_ID && e.kind === 'awaitingHuman');
  const hasDocEntry = entries.some((e) => e.source === 'interactive' && e.kind === 'wicked.interactive.version.created');
  const sorted = entries.every((e, i) => i === 0 || entries[i - 1].ts >= e.ts);
  check(
    '7d. /activity interleaves the run gate entry and the doc version entry, timestamp-ordered',
    hasRunEntry && hasDocEntry && sorted,
    `${entries.length} entries (crew=${entries.filter((e) => e.source === 'crew').length}, interactive=${entries.filter((e) => e.source === 'interactive').length})`,
  );
  const liveDocFrame = await waitFor('doc event over /ws (no reload)', async () =>
    wsFrames.find((f) => f.type === 'projectActivity' && f.project_id === project.id
      && String(f.event_type).startsWith('wicked.interactive.')) ?? null, 30_000);
  check('7e. the open project view sees the doc event LIVE over /ws', liveDocFrame !== null, liveDocFrame.event_type);

  // ═══ 8. ANSWER THE GATE FROM THE CREATOR SKIN — interactive's prompt card calls the SAME
  //        POST /runs/:id/gate; the run resumes; studio reflects it live; /prompts empties. ═══
  const answer = await api(CREW, 'POST', `/api/v1/runs/${RUN_ID}/gate`, { approve: true });
  check('8a. POST /runs/:id/gate (approve) from the creator surface → 200', answer.status === 200, `status→${answer.json.status}`);
  await waitFor('run resumes → completed', async () => {
    const run = await api(CREW, 'GET', `/api/v1/runs/${RUN_ID}`);
    return run.json?.run?.session?.status === 'completed' ? true : null;
  });
  const resumedLive = wsFrames.find((f) => f.type === 'resumed' && f.session === RUN_ID);
  check(
    '8b. the coder skin reflects the resume LIVE (frame tagged with project_id)',
    resumedLive !== undefined && resumedLive.project_id === project.id,
    `frame={type:resumed, project_id:${resumedLive?.project_id}}`,
  );
  const emptied = await api(CREW, 'GET', `/api/v1/projects/${project.id}/prompts`);
  check('8c. the prompt inbox is EMPTY once answered', emptied.json.prompts.length === 0);

  // ═══ 9. FOUNDATION RECORD — memory.coverage scope_prefix=project:<id> > 0, and the charter
  //        retrievable from the knowledge store under project:<id>. ═══
  const memories = await adapter.listMemories(`project:${project.id}`, 20);
  check(
    '9a. memory coverage at scope_prefix project:<id> > 0',
    memories.length > 0,
    `${memories.length} memories (charter + run outcome)`,
  );
  const charterHits = await adapter.recallKnowledge(`project:${project.id}`, 5);
  check(
    '9b. the project charter is retrievable from the knowledge store under project:<id>',
    charterHits.some((h) => h.content.includes(project.id) && /charter/i.test(h.content)),
    charterHits[0]?.content?.slice(0, 80),
  );

  // ═══ 10. OFFLINE REGRESSION — stop the daemon; a plain doc with no --project runs the full
  //         local loop: no breadcrumb, no errors, no queued side effects. ═══
  await stopCrew();
  const soloCreate = await fetch(`${WI}/api/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'solo-doc', html: '<h1>Solo</h1><p>works offline</p>' }),
  });
  check('10a. doc create with no --project succeeds with the daemon STOPPED', soloCreate.ok, `status=${soloCreate.status}`);
  const soloFork = await fetch(`${WI}/d/solo-doc/api/fork`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: 0 }),
  });
  check('10b. iterate (fork → new version) succeeds offline', soloFork.ok);
  const soloRows = (await busRows()).filter((r) => r.payload?.document_id === 'solo-doc');
  check(
    '10c. no breadcrumb, no project_id on any solo-doc event, no queued side effects',
    !existsSync(join(DOCS_ROOT, 'solo-doc', 'project.json'))
      && soloRows.length > 0
      && soloRows.every((r) => r.payload.project_id === undefined),
    `${soloRows.length} solo events, all unbound`,
  );

  console.log(`\n§8 e2e: ${results.filter((r) => r.ok).length}/${results.length} assertions passed — ALL TEN STEPS EXECUTED`);
  process.exitCode = 0;
} catch (e) {
  console.error(`\n§8 e2e FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  try { await stopCrew(); } catch { /* already down */ }
  try { if (interactiveProc) interactiveProc.kill('SIGTERM'); } catch { /* already down */ }
  setTimeout(() => process.exit(process.exitCode ?? 1), 1_500).unref();
}
