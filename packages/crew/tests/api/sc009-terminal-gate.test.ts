import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb, closeDb } from '../../src/store/db.js';
import { createServer } from '../../src/api/server.js';
import { setWorkers } from '../../src/dispatch/workers.js';
import { startSession } from '../../src/fsm/runner.js';
import { listPhases } from '../../src/store/sessions.js';
import { execa } from 'execa';

const FIXTURE = resolve('tests/fixtures/mock-worker.mjs');

let app: Awaited<ReturnType<typeof createServer>>;
let dbPath: string;
let baseUrl: string;
let port: number;

function poll(fn: () => boolean, maxMs = 10000, intervalMs = 100): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - start > maxMs) return reject(new Error(`Poll timeout after ${maxMs}ms`));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-sc009-'));
  dbPath = join(dir, 'test.db');
  const db = openDb(dbPath);

  setWorkers(new Map([
    ['mock-worker', { id: 'mock-worker', command: 'node', args: [FIXTURE], timeout_ms: 10000 }],
  ]));

  app = await createServer(db);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (typeof addr === 'object' && addr) {
    port = addr.port;
    baseUrl = `http://127.0.0.1:${port}`;
  }
});

afterAll(async () => {
  await app.close();
  closeDb();
  rmSync(dbPath.replace('/test.db', ''), { recursive: true, force: true });
});

describe('SC-009 — terminal HITL gate', () => {
  it('wicked-crew gate CLI exits 0 and phase advances to Approved within 5s', async () => {
    // Import db from the already-opened module singleton
    const { getDb } = await import('../../src/store/db.js');
    const db = getDb();

    const sessionId = await startSession(db, {
      type: 'bugfix',
      goal: 'SC-009 terminal gate test',
      workers: ['mock-worker'],
      phaseGateOverrides: { clarify: 'human' },
    });

    // Wait for clarify to reach AwaitingHuman
    await poll(() => {
      const phases = listPhases(db, sessionId);
      return phases.some((p) => p.phase_id === 'clarify' && p.state === 'AwaitingHuman');
    }, 8000);

    const t0 = Date.now();

    // Run the built CLI binary
    const cliPath = resolve('dist/cli/index.js');
    const result = await execa('node', [cliPath, 'gate',
      '--session', sessionId,
      '--phase', 'clarify',
      '--action', 'approve',
      '--port', String(port),
    ], { reject: false, timeout: 8000 });

    const t1 = Date.now();

    expect(result.exitCode).toBe(0);
    expect(t1 - t0).toBeLessThan(5000);

    // Phase should advance to Approved
    await poll(() => {
      const phases = listPhases(db, sessionId);
      return phases.some((p) => p.phase_id === 'clarify' && p.state === 'Approved');
    }, 5000);

    const phases = listPhases(db, sessionId);
    const clarify = phases.find((p) => p.phase_id === 'clarify');
    expect(clarify?.state).toBe('Approved');
  });
});
