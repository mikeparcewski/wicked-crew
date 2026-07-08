#!/usr/bin/env node
// SC-007 (startup < 3s), SC-008 (workers.json hot-reload <= 30s), SC-009
// (terminal HITL gate advances phase < 5s). Each runs against a REAL daemon
// subprocess.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { spawnDaemon, apiGet, apiPost, poll, stopDaemon, tempDbPath, REPO_ROOT, DAEMON_BIN } from './harness.mjs';

const EVIDENCE_DIR = resolve(REPO_ROOT, '.product/evidence/dod');
const write = (sub, name, obj) => {
  const dir = resolve(EVIDENCE_DIR, sub);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, name), JSON.stringify(obj, null, 2));
};
const FIXTURE = resolve(REPO_ROOT, 'packages/crew/tests/fixtures/mock-worker.mjs');

// ── SC-007: startup < 3s (measured N times; report median + max + internal) ──
async function sc007() {
  const runs = [];
  const N = 7;
  for (let i = 0; i < N; i++) {
    const { dbPath } = tempDbPath('sc007');
    const d = spawnDaemon('start', ['--type', 'feature', '--goal', 'startup timing', '--db', dbPath, '--port', '0'], { env: { WICKED_CREW_DISABLE_BUS: '1' } });
    const r = await d.ready;
    runs.push({ iteration: i, internalStartupMs: r.startupMs, spawnToReadyMs: r.spawnToReadyMs, cold: i === 0 });
    await stopDaemon(d.proc);
  }
  const warm = runs.filter((r) => !r.cold);
  const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const medWall = median(warm.map((r) => r.spawnToReadyMs));
  const medInternal = median(warm.map((r) => r.internalStartupMs));
  const maxWall = Math.max(...warm.map((r) => r.spawnToReadyMs));
  const result = {
    scenario: 'startup-under-3s', maps_to: ['SC-007'],
    runs, warm_median_wall_ms: medWall, warm_max_wall_ms: maxWall, warm_median_internal_ms: medInternal,
    note: 'First (cold) run pays one-time Node native-addon load + cold FS cache; steady-state is the warm median. Internal startupMs = main() start → server listening + session created.',
    assertions: {
      A_warm_median_under_3s: { pass: medWall < 3000, actual_ms: medWall },
      A_warm_max_under_3s: { pass: maxWall < 3000, actual_ms: maxWall },
      A_internal_under_3s: { pass: medInternal < 3000, actual_ms: medInternal },
    },
  };
  result.verdict = Object.values(result.assertions).every((a) => a.pass) ? 'PASS' : 'FAIL';
  write('sc007', 'verdict.json', result);
  return result;
}

// ── SC-008: hot-reload a new worker within 30s, then dispatch to it ──
async function sc008() {
  const { dir } = tempDbPath('sc008-cfg');
  const workersPath = resolve(dir, 'workers.json');
  writeFileSync(workersPath, JSON.stringify([{ id: 'mock-worker', command: 'node', args: [FIXTURE, '--verdict', 'PASS'], timeout_ms: 10000 }]));
  const { dbPath } = tempDbPath('sc008');

  const d = spawnDaemon('serve', ['--db', dbPath, '--port', '0'], { workers: workersPath, env: { WICKED_CREW_DISABLE_BUS: '1' } });
  const r = await d.ready;

  // Baseline registry.
  const before = await apiGet(r.port, '/api/v1/workers');

  // Add a new worker by rewriting workers.json (direct write → fs.watch fires).
  const t0 = Date.now();
  writeFileSync(workersPath, JSON.stringify([
    { id: 'mock-worker', command: 'node', args: [FIXTURE, '--verdict', 'PASS'], timeout_ms: 10000 },
    { id: 'hot-added-worker', command: 'node', args: [FIXTURE, '--verdict', 'PASS'], timeout_ms: 10000 },
  ]));

  // Wait until the daemon sees the new worker (<= 30s).
  await poll(async () => {
    const w = await apiGet(r.port, '/api/v1/workers');
    return w.workers.some((x) => x.id === 'hot-added-worker');
  }, { maxMs: 32000, intervalMs: 250, label: 'hot-added-worker visible' });
  const reloadMs = Date.now() - t0;

  // Dispatch to the newly added worker via a session that uses it.
  const created = await apiPost(r.port, '/api/v1/sessions', { type: 'bugfix', goal: 'hot reload dispatch', workers: ['hot-added-worker'] });
  const sessionId = created.body.session.id;
  const final = await poll(async () => {
    const s = await apiGet(r.port, `/api/v1/sessions/${sessionId}`);
    return ['completed', 'failed'].includes(s.session.status) ? s : null;
  }, { maxMs: 30000, intervalMs: 300, label: 'session terminal' });

  const rdb = new Database(dbPath, { readonly: true });
  const dispatches = rdb.prepare('SELECT worker_id, exit_code FROM dispatches WHERE session_id = ?').all(sessionId);
  rdb.close();

  await stopDaemon(d.proc);

  const dispatchedToNew = dispatches.some((x) => x.worker_id === 'hot-added-worker' && x.exit_code === 0);
  const result = {
    scenario: 'workers-hot-reload', maps_to: ['SC-008'],
    before_worker_ids: before.workers.map((w) => w.id), reloadMs, session_status: final.session.status, dispatches,
    assertions: {
      A_reload_within_30s: { pass: reloadMs <= 30000, actual_ms: reloadMs },
      A_dispatched_to_new_worker: { pass: dispatchedToNew, dispatches },
      A_session_completed: { pass: final.session.status === 'completed', actual: final.session.status },
    },
  };
  result.verdict = Object.values(result.assertions).every((a) => a.pass) ? 'PASS' : 'FAIL';
  write('sc008', 'verdict.json', result);
  return result;
}

// ── SC-009: terminal `wicked-crew gate` advances phase < 5s ──
function runGateCli(sessionId, phase, port) {
  return new Promise((res) => {
    const t0 = Date.now();
    const cp = spawn('node', [DAEMON_BIN, 'gate', '--session', sessionId, '--phase', phase, '--action', 'approve', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    cp.stdout.on('data', (d) => { out += d.toString(); });
    cp.stderr.on('data', (d) => { err += d.toString(); });
    cp.on('exit', (code) => res({ exitCode: code, durationMs: Date.now() - t0, stdout: out.trim(), stderr: err.trim() }));
  });
}

async function sc009() {
  const { dir } = tempDbPath('sc009-cfg');
  const workersPath = resolve(dir, 'workers.json');
  writeFileSync(workersPath, JSON.stringify([{ id: 'mock-worker', command: 'node', args: [FIXTURE, '--verdict', 'PASS'], timeout_ms: 10000 }]));
  const { dbPath } = tempDbPath('sc009');

  const d = spawnDaemon('serve', ['--db', dbPath, '--port', '0'], { workers: workersPath, env: { WICKED_CREW_DISABLE_BUS: '1' } });
  const r = await d.ready;

  const created = await apiPost(r.port, '/api/v1/sessions', { type: 'feature', goal: 'terminal gate', workers: ['mock-worker'], phase_gate_overrides: { design: 'human' } });
  const sessionId = created.body.session.id;

  await poll(async () => {
    const p = await apiGet(r.port, `/api/v1/sessions/${sessionId}/phases`);
    return p.phases.some((x) => x.phase_id === 'design' && x.state === 'AwaitingHuman');
  }, { maxMs: 15000, label: 'design AwaitingHuman' });

  const t0 = Date.now();
  const cli = await runGateCli(sessionId, 'design', r.port);

  await poll(async () => {
    const p = await apiGet(r.port, `/api/v1/sessions/${sessionId}/phases`);
    return p.phases.some((x) => x.phase_id === 'design' && x.state === 'Approved');
  }, { maxMs: 5000, intervalMs: 100, label: 'design Approved' });
  const advanceMs = Date.now() - t0;

  const p = await apiGet(r.port, `/api/v1/sessions/${sessionId}/phases`);
  const ts = p.phases.find((x) => x.phase_id === 'test-strategy');
  await stopDaemon(d.proc);

  const result = {
    scenario: 'terminal-hitl-gate', maps_to: ['SC-009'], cli, advanceMs,
    phase_states: Object.fromEntries(p.phases.map((x) => [x.phase_id, x.state])),
    assertions: {
      A1_cli_exit_0: { pass: cli.exitCode === 0, actual: cli.exitCode },
      A2_cli_under_5s: { pass: cli.durationMs < 5000, actual_ms: cli.durationMs },
      A3_advance_under_5s: { pass: advanceMs < 5000, actual_ms: advanceMs },
      A4_next_phase_started: { pass: !!ts && ts.state !== 'Pending', actual: ts?.state },
    },
  };
  result.verdict = Object.values(result.assertions).every((a) => a.pass) ? 'PASS' : 'FAIL';
  write('sc009', 'verdict.json', result);
  // Scenario-named artifacts (terminal-hitl-gate.md §Evidence).
  write('sc009', 'cli-exit.json', { exitCode: cli.exitCode, durationMs: cli.durationMs, stdout: cli.stdout, stderr: cli.stderr });
  write('sc009', 'phase-states.json', result.phase_states);
  return result;
}

async function main() {
  const r7 = await sc007();
  const r8 = await sc008();
  const r9 = await sc009();
  const summary = { SC007: r7.verdict, SC008: r8.verdict, SC009: r9.verdict };
  console.log('SC-007:', JSON.stringify(r7.assertions));
  console.log('SC-008:', JSON.stringify(r8.assertions));
  console.log('SC-009:', JSON.stringify(r9.assertions));
  console.log('SUMMARY:', JSON.stringify(summary));
  process.exit(Object.values(summary).every((v) => v === 'PASS') ? 0 : 1);
}

main().catch((err) => { console.error('HARNESS ERROR:', err); process.exit(2); });
