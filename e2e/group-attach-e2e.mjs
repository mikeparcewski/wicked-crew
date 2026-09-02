#!/usr/bin/env node
// wicked-studio#27 — ad-hoc run grouping + campaigns delivery rollup, LIVE (api-types 0.19.0).
//
// Drives the REAL built daemon (dist CLI, real engine addon, deterministic stub seat) on a
// scratch HOME + scratch --db on a 79xx port — the operator's ~/.wicked-crew and :7701 are
// never touched. Proves, against a running daemon:
//
//   1.  a tool campaign launches, completes, and GET /campaigns/:id carries `node_delivery`
//       per node (the 0.19.0 daemon join) beside the engine's own node_run_id/node_status;
//   2.  THE JOIN: every campaign node run id is served by GET /runs with the same
//       delivery tri-state — the runs-list join studio can also build a rollup from;
//   3.  NARRATION correlation: live /ws frames for a node carry `session === node_run_id[node]`
//       (and `campaignNodeStarted.runId` spells the same id) — no extra wire needed;
//   4.  two ad-hoc runs launched with the same `groupLabel` form ONE group on GET /campaigns,
//       each member carrying runId + status + delivery;
//   5.  `campaignId` attaches an ad-hoc run to the existing campaign (`attached_runs`), echoed
//       as `campaign_id` on the run DTO;
//   6.  an unknown `campaignId` is a 404 and nothing launches; campaignId+groupLabel is a 400;
//   7.  an ungrouped launch is unchanged: `{runId}` body, no grouping keys on its DTO;
//   8.  RESTART SURVIVAL: a rebooted daemon (same scratch home) still serves the group, the
//       attach, and the DTO echoes — the audit trail is the durable record.
//
// Run (crew repo root, after `npm run build -w packages/crew`):
//   node e2e/group-attach-e2e.mjs

import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const HERE = dirname(fileURLToPath(import.meta.url));
const CREW_ROOT = resolve(HERE, '..');
const CLI = join(CREW_ROOT, 'packages', 'crew', 'dist', 'cli', 'index.js');
const PORT = Number(process.env.E2E_PORT ?? 7913);
const BASE = `http://127.0.0.1:${PORT}`;
const CAMP = 'e2e-camp';
const STEP_TIMEOUT_MS = 120_000;

// ── Scratch home (HOME + --db both point here; audit trail lands beside the db) ──
const T = mkdtempSync(join(tmpdir(), 'group-attach-e2e-'));
const CORE_DB = join(T, 'core.db');
const STUB = join(T, 'stub-seat.sh');
writeFileSync(STUB, `#!/bin/sh\necho "did: $*"\n`, 'utf8');
chmodSync(STUB, 0o755);
const STUB_SEATS = JSON.stringify([
  { key: 'stub-seat', display_name: 'Stub Seat', binary: STUB, headless_invocation: `${STUB} {PROMPT}` },
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(`assertion failed: ${name}`);
}
async function waitFor(label, cond, timeoutMs = STEP_TIMEOUT_MS, stepMs = 400) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`TIMEOUT waiting for: ${label}`);
    await sleep(stepMs);
  }
}
async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

let daemon = null;
let daemonLog = '';
async function bootDaemon() {
  daemon = spawn(process.execPath, [CLI, 'serve', '--port', String(PORT), '--db', CORE_DB], {
    env: {
      ...process.env,
      HOME: T,
      USERPROFILE: T,
      WICKED_MEMORY_EMBEDDER: 'hash',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemon.stdout.on('data', (d) => { daemonLog += String(d); });
  daemon.stderr.on('data', (d) => { daemonLog += String(d); });
  await waitFor('daemon /health', async () => {
    try {
      const res = await fetch(`${BASE}/api/v1/health`);
      return res.ok;
    } catch { return false; }
  }, 60_000);
}
async function stopDaemon() {
  if (daemon === null) return;
  const p = daemon;
  daemon = null;
  p.kill('SIGTERM');
  await new Promise((r) => { p.once('exit', r); setTimeout(r, 8_000); });
}

const wsFrames = [];
function openWs() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  ws.on('message', (d) => {
    try { wsFrames.push(JSON.parse(String(d))); } catch { /* non-JSON frame */ }
  });
  return ws;
}

try {
  // ═══ 1. Boot the scratch daemon ═══
  await bootDaemon();
  check('1. scratch daemon up on :' + PORT + ' (scratch HOME + --db)', true, T);
  const ws = openWs();

  // ═══ 2. Tool campaign completes; GET /campaigns/:id carries node_delivery ═══
  const launched = await api('POST', '/api/v1/campaigns', {
    id: CAMP,
    scenarios: [
      { id: 'a', tool: { cmd: [process.execPath, '--version'] } },
      { id: 'b', tool: { cmd: [process.execPath, '--version'] } },
    ],
    maxConcurrency: 2,
  });
  check('2a. POST /campaigns 201', launched.status === 201, JSON.stringify(launched.json));
  const detail = await waitFor('campaign terminal', async () => {
    const res = await api('GET', `/api/v1/campaigns/${CAMP}`);
    if (res.status !== 200) return null;
    const c = res.json.campaign;
    return ['completed', 'partially_completed', 'failed'].includes(c.status) ? c : null;
  });
  check('2b. campaign completed', detail.status === 'completed', detail.status);
  const nodeRunIds = Object.values(detail.node_run_id).sort();
  check(
    '2c. node_run_id keys the engine session ids ({campaign}:{node}:a0)',
    JSON.stringify(nodeRunIds) === JSON.stringify([`${CAMP}:a:a0`, `${CAMP}:b:a0`]),
    JSON.stringify(nodeRunIds),
  );
  check(
    '2d. node_delivery present per dispatched node with an honest tri-state',
    ['a', 'b'].every((n) => ['delivered', 'stranded', 'vacuous', 'none'].includes(detail.node_delivery?.[n]?.delivery)),
    JSON.stringify(detail.node_delivery),
  );
  check(
    '2e. repo-less completed tool nodes read delivery none (nothing to lift, nothing invented)',
    ['a', 'b'].every((n) => detail.node_delivery[n].delivery === 'none'),
    JSON.stringify(detail.node_delivery),
  );

  // ═══ 3. THE JOIN: node run ids ride GET /runs with the same delivery fields ═══
  const runsRes = await api('GET', '/api/v1/runs');
  const runsById = new Map(runsRes.json.runs.map((r) => [r.session.id, r.session]));
  for (const id of nodeRunIds) {
    const s = runsById.get(id);
    check(
      `3. GET /runs serves campaign node ${id} with status + delivery (the runs-list join)`,
      s !== undefined && s.status === 'completed' && s.delivery === detail.node_delivery[id.split(':')[1]].delivery,
      s === undefined ? 'MISSING' : `status=${s.status} delivery=${s.delivery}`,
    );
  }

  // ═══ 4. Narration correlation on /ws: session === node_run_id[node] ═══
  const nodeStarted = wsFrames.filter((f) => f.type === 'campaignNodeStarted');
  check(
    '4a. campaignNodeStarted frames spell runId === node_run_id[node]',
    ['a', 'b'].every((n) => nodeStarted.some((f) => f.node === n && f.runId === detail.node_run_id[n])),
    JSON.stringify(nodeStarted.map((f) => [f.node, f.runId])),
  );
  check(
    '4b. session-scoped /ws frames carry the node run id as `session` (live narration join)',
    nodeRunIds.every((id) => wsFrames.some((f) => f.session === id)),
    `${wsFrames.filter((f) => nodeRunIds.includes(f.session)).length} frames matched`,
  );

  // ═══ 5. Two ad-hoc runs into ONE label group ═══
  const sib = (n) =>
    api('POST', '/api/v1/runs', {
      problem: `e2e sibling ${n}`,
      sessionId: `e2e-sib-${n}`,
      clisJson: STUB_SEATS,
      groupLabel: 'e2e-group',
    });
  const s1 = await sib(1);
  const s2 = await sib(2);
  check('5a. two grouped ad-hoc launches 201', s1.status === 201 && s2.status === 201,
    `${s1.status}/${s2.status}`);
  await waitFor('grouped siblings terminal', async () => {
    const res = await api('GET', '/api/v1/runs');
    const byId = new Map(res.json.runs.map((r) => [r.session.id, r.session]));
    return ['e2e-sib-1', 'e2e-sib-2'].every((id) =>
      ['completed', 'failed', 'cancelled'].includes(byId.get(id)?.status));
  });
  const listRes = await api('GET', '/api/v1/campaigns');
  const group = listRes.json.groups.find((g) => g.label === 'e2e-group');
  check('5b. GET /campaigns serves the label group', group !== undefined, JSON.stringify(listRes.json.groups?.map((g) => g.label)));
  check(
    '5c. group members in launch order, each with runId + status + delivery',
    JSON.stringify(group.runs.map((r) => r.runId)) === JSON.stringify(['e2e-sib-1', 'e2e-sib-2']) &&
      group.runs.every((r) => typeof r.status === 'string' && ['delivered', 'stranded', 'vacuous', 'none'].includes(r.delivery)),
    JSON.stringify(group.runs),
  );
  const sibDto = (await api('GET', '/api/v1/runs')).json.runs.find((r) => r.session.id === 'e2e-sib-1').session;
  check('5d. run DTO echoes group_label', sibDto.group_label === 'e2e-group', JSON.stringify(sibDto.group_label));

  // ═══ 6. campaignId attach onto the existing campaign ═══
  const att = await api('POST', '/api/v1/runs', {
    problem: 'e2e attached extra',
    sessionId: 'e2e-att-1',
    clisJson: STUB_SEATS,
    campaignId: CAMP,
  });
  check('6a. campaignId attach 201', att.status === 201, JSON.stringify(att.json));
  await waitFor('attached run terminal', async () => {
    const res = await api('GET', '/api/v1/runs');
    const s = res.json.runs.find((r) => r.session.id === 'e2e-att-1')?.session;
    return s !== undefined && ['completed', 'failed', 'cancelled'].includes(s.status);
  });
  const enriched = (await api('GET', `/api/v1/campaigns/${CAMP}`)).json.campaign;
  check(
    '6b. campaign detail carries attached_runs with the run wire fields',
    enriched.attached_runs.length === 1 &&
      enriched.attached_runs[0].runId === 'e2e-att-1' &&
      ['delivered', 'stranded', 'vacuous', 'none'].includes(enriched.attached_runs[0].delivery),
    JSON.stringify(enriched.attached_runs),
  );
  const attDto = (await api('GET', '/api/v1/runs')).json.runs.find((r) => r.session.id === 'e2e-att-1').session;
  check('6c. run DTO echoes campaign_id', attDto.campaign_id === CAMP, JSON.stringify(attDto.campaign_id));

  // ═══ 7. Loud validation ═══
  const runsBefore = (await api('GET', '/api/v1/runs')).json.runs.length;
  const bad = await api('POST', '/api/v1/runs', { problem: 'x', campaignId: 'no-such-campaign' });
  check('7a. unknown campaignId is a 404 naming it', bad.status === 404 && /unknown campaign: no-such-campaign/.test(bad.json.error), `${bad.status} ${bad.json.error}`);
  const both = await api('POST', '/api/v1/runs', { problem: 'x', campaignId: CAMP, groupLabel: 'g' });
  check('7b. campaignId+groupLabel is a 400 naming the exclusivity', both.status === 400 && /mutually exclusive/.test(JSON.stringify(both.json)), String(both.status));
  const runsAfter = (await api('GET', '/api/v1/runs')).json.runs.length;
  check('7c. neither refusal launched anything', runsAfter === runsBefore, `${runsBefore} -> ${runsAfter}`);

  // ═══ 8. Ungrouped launch unchanged ═══
  const plain = await api('POST', '/api/v1/runs', {
    problem: 'e2e plain',
    sessionId: 'e2e-plain-1',
    clisJson: STUB_SEATS,
  });
  check('8a. ungrouped launch 201 with the legacy {runId} body, byte for byte',
    plain.status === 201 && JSON.stringify(Object.keys(plain.json)) === JSON.stringify(['runId']),
    JSON.stringify(plain.json));
  const plainDto = (await api('GET', '/api/v1/runs')).json.runs.find((r) => r.session.id === 'e2e-plain-1').session;
  check('8b. ungrouped DTO carries NO grouping keys',
    !('campaign_id' in plainDto) && !('group_label' in plainDto), Object.keys(plainDto).join(','));
  const groupsNow = (await api('GET', '/api/v1/campaigns')).json.groups;
  check('8c. the ungrouped launch joined no group', groupsNow.length === 1 && groupsNow[0].runs.length === 2, JSON.stringify(groupsNow.map((g) => [g.label, g.runs.length])));

  // ═══ 9. Restart survival ═══
  ws.close();
  await stopDaemon();
  await bootDaemon();
  const rRuns = (await api('GET', '/api/v1/runs')).json.runs;
  const rById = new Map(rRuns.map((r) => [r.session.id, r.session]));
  check('9a. restarted daemon still echoes group_label + campaign_id (trail hydrate)',
    rById.get('e2e-sib-2')?.group_label === 'e2e-group' && rById.get('e2e-att-1')?.campaign_id === CAMP,
    `sib2=${rById.get('e2e-sib-2')?.group_label} att=${rById.get('e2e-att-1')?.campaign_id}`);
  const rList = (await api('GET', '/api/v1/campaigns')).json;
  const rGroup = rList.groups.find((g) => g.label === 'e2e-group');
  const rCamp = rList.campaigns.find((c) => c.id === CAMP);
  check('9b. restarted daemon still serves the group + attached_runs + node_delivery',
    rGroup?.runs.length === 2 &&
      rCamp?.attached_runs?.length === 1 &&
      ['a', 'b'].every((n) => rCamp?.node_delivery?.[n] !== undefined),
    JSON.stringify({ group: rGroup?.runs.map((r) => r.runId), attached: rCamp?.attached_runs?.map((r) => r.runId) }));

  console.log(`\nALL ${results.length} CHECKS PASSED`);
} catch (err) {
  console.error(`\nE2E FAILED: ${err?.message ?? err}`);
  console.error('--- daemon log tail ---');
  console.error(daemonLog.split('\n').slice(-40).join('\n'));
  process.exitCode = 1;
} finally {
  await stopDaemon();
}
