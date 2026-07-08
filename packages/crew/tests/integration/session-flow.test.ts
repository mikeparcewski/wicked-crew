import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb, closeDb } from '../../src/store/db.js';
import { startSession, resolveHumanGate, pauseSession, resumeSession } from '../../src/fsm/runner.js';
import { setWorkers } from '../../src/dispatch/workers.js';
import { getSession, listPhases } from '../../src/store/sessions.js';

const FIXTURE = resolve('tests/fixtures/mock-worker.mjs');

let dbPath: string;

afterEach(() => {
  closeDb();
  if (dbPath) {
    try { rmSync(dbPath.replace('/test.db', ''), { recursive: true, force: true }); } catch { /* ok */ }
  }
});

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'crew-flow-'));
  dbPath = join(dir, 'test.db');
  return openDb(dbPath);
}

function workerMap(...ids: string[]) {
  return new Map(ids.map((id) => [id, { id, command: 'node', args: [FIXTURE], timeout_ms: 10000 }]));
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

describe('auto-gate session flow', () => {
  it('SC-001: bugfix workflow completes autonomously — all phases Approved', async () => {
    const db = tempDb();
    setWorkers(workerMap('w1'));

    const sessionId = await startSession(db, {
      type: 'bugfix',
      goal: 'e2e auto flow',
      workers: ['w1'],
    });

    await poll(() => {
      const session = getSession(db, sessionId);
      return session?.status === 'completed';
    }, 20000);

    const session = getSession(db, sessionId);
    expect(session?.status).toBe('completed');

    const phases = listPhases(db, sessionId);
    expect(phases.every((p) => p.state === 'Approved')).toBe(true);
    expect(phases.length).toBe(3); // clarify, build, test
  });
});

describe('human gate flow', () => {
  it('SC-009 / SC-002: human gate waits, then advances on resolveHumanGate', async () => {
    const db = tempDb();
    setWorkers(workerMap('w1'));

    const sessionId = await startSession(db, {
      type: 'bugfix',
      goal: 'human gate test',
      workers: ['w1'],
      phaseGateOverrides: { clarify: 'human' },
    });

    // Wait for clarify to reach AwaitingHuman
    await poll(() => {
      const phases = listPhases(db, sessionId);
      return phases.some((p) => p.phase_id === 'clarify' && p.state === 'AwaitingHuman');
    }, 5000);

    const phasesBefore = listPhases(db, sessionId);
    expect(phasesBefore.find((p) => p.phase_id === 'clarify')?.state).toBe('AwaitingHuman');

    // Approve via the deferred promise resolver (same as HTTP endpoint calls this)
    const resolved = resolveHumanGate(sessionId, 'clarify', 'approved');
    expect(resolved).toBe(true);

    // Session should complete after human approval
    await poll(() => {
      const session = getSession(db, sessionId);
      return session?.status === 'completed';
    }, 20000);

    const session = getSession(db, sessionId);
    expect(session?.status).toBe('completed');

    const phases = listPhases(db, sessionId);
    expect(phases.find((p) => p.phase_id === 'clarify')?.state).toBe('Approved');
    expect(phases.every((p) => p.state === 'Approved')).toBe(true);
  });

  it('human gate reject → session fails', async () => {
    const db = tempDb();
    setWorkers(workerMap('w1'));

    const sessionId = await startSession(db, {
      type: 'bugfix',
      goal: 'reject test',
      workers: ['w1'],
      phaseGateOverrides: { clarify: 'human' },
    });

    await poll(() => {
      const phases = listPhases(db, sessionId);
      return phases.some((p) => p.phase_id === 'clarify' && p.state === 'AwaitingHuman');
    }, 5000);

    resolveHumanGate(sessionId, 'clarify', 'rejected');

    await poll(() => {
      const session = getSession(db, sessionId);
      return session?.status === 'failed';
    }, 10000);

    expect(getSession(db, sessionId)?.status).toBe('failed');
  });
});

describe('pause + resume flow', () => {
  it('pauseSession causes next phase to enter paused state; resumeSession advances', async () => {
    const db = tempDb();
    setWorkers(workerMap('w1'));

    const sessionId = await startSession(db, {
      type: 'bugfix',
      goal: 'pause flow test',
      workers: ['w1'],
    });

    // Request pause during the first phase (clarify)
    pauseSession(sessionId);

    // DB status must reach 'paused' (set by actor.subscribe when FSM enters paused state)
    await poll(() => getSession(db, sessionId)?.status === 'paused', 10000);
    expect(getSession(db, sessionId)?.status).toBe('paused');

    // Resume — status must flip paused → running (CRIT-1 guard fix) before completing.
    await resumeSession(db, sessionId);
    expect(getSession(db, sessionId)?.status).toBe('running');

    await poll(() => {
      const session = getSession(db, sessionId);
      return session?.status === 'completed';
    }, 20000);

    expect(getSession(db, sessionId)?.status).toBe('completed');
  });

  it('blocking RAID item causes no-blocking-raid policy to fail', async () => {
    const db = tempDb();
    setWorkers(workerMap('w1'));
    const { randomUUID } = await import('node:crypto');

    const sessionId = await startSession(db, {
      type: 'bugfix',
      goal: 'raid block test',
      workers: ['w1'],
    });

    // Insert a blocking RAID risk before the session completes
    db.prepare(`
      INSERT INTO raid_items (id, session_id, phase_id, kind, title, description, blocking, created_at)
      VALUES (?, ?, 'clarify', 'risk', 'Blocking risk', 'Blocks gate', 1, ?)
    `).run(randomUUID(), sessionId, new Date().toISOString());

    // Gate should reject → session fails
    await poll(() => {
      const session = getSession(db, sessionId);
      return session?.status === 'failed';
    }, 20000);

    expect(getSession(db, sessionId)?.status).toBe('failed');
  });
});

describe('worker exit failure', () => {
  it('gate rejects when worker exits non-zero', async () => {
    const db = tempDb();
    setWorkers(new Map([
      ['fail-worker', { id: 'fail-worker', command: 'node', args: [FIXTURE, '--exit', '1'], timeout_ms: 5000 }],
    ]));

    const sessionId = await startSession(db, {
      type: 'bugfix',
      goal: 'failure test',
      workers: ['fail-worker'],
    });

    await poll(() => {
      const session = getSession(db, sessionId);
      return session?.status === 'failed';
    }, 20000);

    expect(getSession(db, sessionId)?.status).toBe('failed');
  });
});
