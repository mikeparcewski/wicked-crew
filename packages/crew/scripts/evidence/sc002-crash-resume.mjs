#!/usr/bin/env node
// SC-002 + DoD working-app behavior 5 — REAL SIGKILL crash + resume.
// Daemon1 parks a feature session at design (human gate). We SIGKILL the
// process (not a graceful shutdown), boot a fresh daemon2 against the same
// SQLite DB (which auto-resumes), approve the gate, and prove the session
// continues from design — not from the beginning — with no state regression.
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { spawnDaemon, apiGet, apiPost, poll, stopDaemon, sigkillDaemon, tempDbPath, REPO_ROOT } from './harness.mjs';

const EVIDENCE_DIR = resolve(REPO_ROOT, '.product/evidence/dod/sc002');
mkdirSync(EVIDENCE_DIR, { recursive: true });
const write = (name, obj) => writeFileSync(resolve(EVIDENCE_DIR, name), JSON.stringify(obj, null, 2));

// Workers file with a delay so we can deterministically observe test-strategy
// in InProgress after resume (real workers take time; this mirrors that).
function writeDelayedWorkers() {
  const fixture = resolve(REPO_ROOT, 'packages/crew/tests/fixtures/mock-worker.mjs');
  const { dir } = tempDbPath('sc002-cfg');
  const path = resolve(dir, 'workers.json');
  writeFileSync(path, JSON.stringify([{ id: 'mock-worker', command: 'node', args: [fixture, '--verdict', 'PASS', '--delay', '1500'], timeout_ms: 10000 }]));
  return path;
}

const NON_TEMPORAL = ['session_id', 'phase_id', 'state', 'gate_kind', 'blocking_raid_ids'];
const pick = (row) => Object.fromEntries(NON_TEMPORAL.map((k) => [k, row[k]]));

function readPhases(dbPath, sessionId) {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare('SELECT * FROM phases WHERE session_id = ? ORDER BY created_at').all(sessionId);
  db.close();
  return rows;
}
function readSnapshot(dbPath, sessionId) {
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare('SELECT snapshot, saved_at FROM xstate_snapshots WHERE session_id = ?').get(sessionId);
  db.close();
  return row;
}

async function main() {
  const results = { scenario: 'crash-and-resume', maps_to: ['SC-002'], startedAt: new Date().toISOString(), assertions: {} };
  const workers = writeDelayedWorkers();
  const { dbPath } = tempDbPath('sc002');
  const { dbPath: busDb } = tempDbPath('sc002-bus');

  // ---- Daemon 1 ----
  const d1 = spawnDaemon('serve', ['--db', dbPath, '--port', '0'], { workers, env: { WICKED_CREW_BUS_DB: busDb } });
  const r1 = await d1.ready;
  const created = await apiPost(r1.port, '/api/v1/sessions', {
    type: 'feature', goal: 'crash test', workers: ['mock-worker'], phase_gate_overrides: { design: 'human' },
  });
  const sessionId = created.body.session.id;
  results.session_id = sessionId;
  results.daemon1_pid = d1.proc.pid;

  // Wait for design → AwaitingHuman (clarify auto-approves first).
  await poll(async () => {
    const p = await apiGet(r1.port, `/api/v1/sessions/${sessionId}/phases`);
    return p.phases.some((x) => x.phase_id === 'design' && x.state === 'AwaitingHuman');
  }, { maxMs: 15000, label: 'design AwaitingHuman (daemon1)' });

  // before.json — SQLite phases snapshot before kill.
  const before = readPhases(dbPath, sessionId);
  write('before.json', before);
  const snapBefore = readSnapshot(dbPath, sessionId);
  write('snapshot-before.json', { present: !!snapBefore, saved_at: snapBefore?.saved_at, value: snapBefore ? JSON.parse(snapBefore.snapshot).value : null });

  // ---- REAL SIGKILL ----
  const killedAt = Date.now();
  await sigkillDaemon(d1.proc);
  results.kill = { signal: 'SIGKILL', exitCode: d1.proc.exitCode, signalCode: d1.proc.signalCode, at: new Date(killedAt).toISOString() };

  // ---- Daemon 2 (fresh process, same DB) ----
  const d2 = spawnDaemon('serve', ['--db', dbPath, '--port', '0'], { workers, env: { WICKED_CREW_BUS_DB: busDb } });
  const r2 = await d2.ready;
  results.daemon2_pid = d2.proc.pid;
  results.daemon2_resumed = r2.resumed;

  // Auto-resume re-parks design at AwaitingHuman (re-runs the human-gate phase).
  await poll(async () => {
    const p = await apiGet(r2.port, `/api/v1/sessions/${sessionId}/phases`);
    return p.phases.some((x) => x.phase_id === 'design' && x.state === 'AwaitingHuman');
  }, { maxMs: 15000, label: 'design AwaitingHuman (daemon2)' });

  // Approve the design gate on the NEW daemon.
  const approve = await apiPost(r2.port, `/api/v1/sessions/${sessionId}/gates/design/approve`);
  results.approve_status = approve.status;

  // Poll until design=Approved AND test-strategy has started (InProgress).
  await poll(async () => {
    const p = await apiGet(r2.port, `/api/v1/sessions/${sessionId}/phases`);
    const design = p.phases.find((x) => x.phase_id === 'design');
    const ts = p.phases.find((x) => x.phase_id === 'test-strategy');
    return design?.state === 'Approved' && ts && ts.state !== 'Pending';
  }, { maxMs: 15000, label: 'design Approved + test-strategy started' });

  const after = readPhases(dbPath, sessionId);
  write('after.json', after);

  await stopDaemon(d2.proc);

  // ---- Assertions ----
  const A = results.assertions;

  // A1 / behavior5 — pre-design phases identical on non-temporal fields.
  const preBefore = before.filter((p) => p.phase_id === 'clarify').map(pick);
  const preAfter = after.filter((p) => p.phase_id === 'clarify').map(pick);
  const fieldDiff = JSON.stringify(preBefore) === JSON.stringify(preAfter) ? [] : { before: preBefore, after: preAfter };
  write('field-diff.json', fieldDiff);
  A.A1_pre_design_identical = { pass: Array.isArray(fieldDiff) && fieldDiff.length === 0, clarify_before: preBefore, clarify_after: preAfter };

  // A2 — design Approved.
  const designAfter = after.find((p) => p.phase_id === 'design');
  A.A2_design_approved = { pass: designAfter?.state === 'Approved', actual: designAfter?.state };

  // A3 — test-strategy exists + InProgress (observed via worker delay).
  const tsAfter = after.find((p) => p.phase_id === 'test-strategy');
  A.A3_test_strategy_inprogress = { pass: !!tsAfter && tsAfter.state === 'InProgress', actual: tsAfter?.state };

  // A4 — no duplicate clarify (session did NOT restart from beginning).
  const clarifyCount = after.filter((p) => p.phase_id === 'clarify').length;
  A.A4_no_duplicate_clarify = { pass: clarifyCount === 1, count: clarifyCount };

  // behavior5 — resume worked at all (daemon2 resumed this session).
  A.behavior5_resumed = { pass: r2.resumed.includes(sessionId), resumed: r2.resumed };

  // Sanity — the kill really was a SIGKILL and daemon1 died from it.
  A.real_sigkill = { pass: d1.proc.signalCode === 'SIGKILL' || d1.proc.exitCode === null, signalCode: d1.proc.signalCode, exitCode: d1.proc.exitCode };

  results.verdict = Object.values(A).every((a) => a.pass) ? 'PASS' : 'FAIL';
  results.finishedAt = new Date().toISOString();
  write('verdict.json', results);

  console.log(JSON.stringify(results, null, 2));
  process.exit(results.verdict === 'PASS' ? 0 : 1);
}

main().catch((err) => { console.error('HARNESS ERROR:', err); process.exit(2); });
