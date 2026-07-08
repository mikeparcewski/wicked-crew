import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb, closeDb } from '../../src/store/db.js';
import { startSession, resolveHumanGate, resumeSession, resumeAllIncompleteSessions } from '../../src/fsm/runner.js';
import { setWorkers } from '../../src/dispatch/workers.js';
import { getSession, listPhases } from '../../src/store/sessions.js';
import { loadSnapshot } from '../../src/store/snapshots.js';

const FIXTURE = resolve('tests/fixtures/mock-worker.mjs');

let dbPath: string;

afterEach(() => {
  closeDb();
  if (dbPath) {
    try { rmSync(dbPath.replace('/test.db', ''), { recursive: true, force: true }); } catch { /* ok */ }
  }
});

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'crew-resume-'));
  dbPath = join(dir, 'test.db');
  return openDb(dbPath);
}

function workerMap() {
  return new Map([['w1', { id: 'w1', command: 'node', args: [FIXTURE], timeout_ms: 10000 }]]);
}

function poll(fn: () => boolean, maxMs = 15000, intervalMs = 100): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - start > maxMs) return reject(new Error('Poll timeout'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe('SC-002 — crash + resume', () => {
  it('snapshot is saved before AwaitingHuman; restored session completes after approval', async () => {
    const db = tempDb();
    setWorkers(workerMap());

    const sessionId = await startSession(db, {
      type: 'bugfix',
      goal: 'crash-resume test',
      workers: ['w1'],
      phaseGateOverrides: { clarify: 'human' },
    });

    // Wait for clarify to reach AwaitingHuman (snapshot is saved)
    await poll(() => {
      const phases = listPhases(db, sessionId);
      return phases.some((p) => p.phase_id === 'clarify' && p.state === 'AwaitingHuman');
    }, 8000);

    // Capture state before "crash"
    const phasesBefore = listPhases(db, sessionId);
    expect(phasesBefore.find((p) => p.phase_id === 'clarify')?.state).toBe('AwaitingHuman');

    // Verify snapshot was saved
    const snapshot = loadSnapshot(db, sessionId);
    expect(snapshot).not.toBeNull();

    // Simulate crash: no action needed — just call resumeSession with the same DB.
    // In production, the daemon process restarts; here we call resumeSession directly.
    await resumeSession(db, sessionId);

    // The resumed actor re-enters clarify (AwaitingHuman), creating a new deferred promise.
    await poll(() => {
      const phases = listPhases(db, sessionId);
      return phases.some((p) => p.phase_id === 'clarify' && p.state === 'AwaitingHuman');
    }, 8000);

    // Approve — session should complete
    resolveHumanGate(sessionId, 'clarify', 'approved');

    await poll(() => getSession(db, sessionId)?.status === 'completed', 15000);

    // A2: clarify phase record is still correct
    const phasesAfter = listPhases(db, sessionId);
    const clarify = phasesAfter.find((p) => p.phase_id === 'clarify');
    expect(clarify?.state).toBe('Approved');

    // A4: session status is completed (did not restart from scratch)
    expect(getSession(db, sessionId)?.status).toBe('completed');

    // A3: all phases ended up Approved
    expect(phasesAfter.every((p) => p.state === 'Approved')).toBe(true);
  });

  it('non-temporal fields are identical before and after resume', async () => {
    const db = tempDb();
    setWorkers(workerMap());

    const sessionId = await startSession(db, {
      type: 'bugfix',
      goal: 'field identity test',
      workers: ['w1'],
      phaseGateOverrides: { clarify: 'human', build: 'human' },
    });

    // Wait for clarify → AwaitingHuman, capture before snapshot
    await poll(() =>
      listPhases(db, sessionId).some((p) => p.phase_id === 'clarify' && p.state === 'AwaitingHuman'),
    8000);

    const before = listPhases(db, sessionId).map(({ updated_at, ...rest }) => rest);

    // Simulate crash + resume
    await resumeSession(db, sessionId);
    await poll(() =>
      listPhases(db, sessionId).some((p) => p.phase_id === 'clarify' && p.state === 'AwaitingHuman'),
    8000);

    const after = listPhases(db, sessionId).map(({ updated_at, ...rest }) => rest);

    // Non-temporal fields must be identical (A1 of SC-002)
    expect(after).toEqual(before);
  });

  it('resumeAllIncompleteSessions re-creates actors for running sessions (daemon crash recovery)', async () => {
    const db = tempDb();
    setWorkers(workerMap());

    // Two sessions parked at a human gate — simulate a daemon that died holding them
    const s1 = await startSession(db, {
      type: 'bugfix', goal: 'auto-resume 1', workers: ['w1'], phaseGateOverrides: { clarify: 'human' },
    });
    const s2 = await startSession(db, {
      type: 'bugfix', goal: 'auto-resume 2', workers: ['w1'], phaseGateOverrides: { clarify: 'human' },
    });
    await poll(() =>
      [s1, s2].every((id) => listPhases(db, id).some((p) => p.phase_id === 'clarify' && p.state === 'AwaitingHuman')),
    8000);

    // Both sessions are 'running'. Simulate fresh daemon boot: resume everything.
    const resumed = resumeAllIncompleteSessions(db);
    expect(resumed).toEqual(expect.arrayContaining([s1, s2]));
    expect(resumed.length).toBe(2);

    // Re-created actors re-park at AwaitingHuman with live deferred promises →
    // approving now advances each session to completion.
    await poll(() =>
      [s1, s2].every((id) => listPhases(db, id).some((p) => p.phase_id === 'clarify' && p.state === 'AwaitingHuman')),
    8000);
    resolveHumanGate(s1, 'clarify', 'approved');
    resolveHumanGate(s2, 'clarify', 'approved');

    await poll(() => [s1, s2].every((id) => getSession(db, id)?.status === 'completed'), 15000);
    expect(getSession(db, s1)?.status).toBe('completed');
    expect(getSession(db, s2)?.status).toBe('completed');
  });
});
