// crew#1960 (the fails-without-the-fix pin): at boot the daemon ends a chat answer run the previous daemon left parked
// at its turn gate. Ask paths live in memory (src/api/ask-paths.ts), so after a restart no chat can continue or close
// that run; without this sweep it waits `awaiting_human` forever (train-16 cert: 6 such runs on one daemon).

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { AuditLog } from '../src/api/audit.js';
import { recordRunLaunched } from '../src/api/run-timing-index.js';
import { createServer } from '../src/api/server.js';
import { CoreAdapter } from '../src/core/adapter.js';
import type { Actor, AuditEntry } from '../src/core/types.js';
import { answeredAsk, plainGate } from './fixtures/ask-turn-1960.js';
import { removeScratch } from './setup/scratch.js';

describe('crew#1960 — createServer runs the sweep at boot', () => {
  const dirs: string[] = [];
  const servers: FastifyInstance[] = [];
  const adapters: CoreAdapter[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
    for (const a of adapters.splice(0)) a.close();
  });
  afterAll(() => dirs.forEach(removeScratch));

  function trail(auditPath: string): AuditEntry[] {
    if (!existsSync(auditPath)) return [];
    return readFileSync(auditPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as AuditEntry);
  }

  it('an answered ask the previous daemon launched is cancelled through the adapter and audited by the daemon actor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-1960-'));
    dirs.push(dir);
    const auditPath = join(dir, 'audit.log');
    // The previous daemon's launch records, as the chat route writes them (routes.ts recordRunLaunched {askPath}).
    const before = new AuditLog(auditPath, () => undefined);
    const person = { id: 'local', kind: 'human', trust: 'operator' } as Actor;
    recordRunLaunched(before, undefined, person, 'answered', { chatId: 'c1', askPath: true, deliver: 'none' });
    recordRunLaunched(before, undefined, person, 'escalated', { chatId: 'c2', askPath: true, deliver: 'none' });
    recordRunLaunched(before, undefined, person, 'job', { workflow: 'bug', deliver: 'none' });
    await before.flush();

    const adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
    adapters.push(adapter);
    const cancelled: string[] = [];
    adapter.sessionsDetail = async () => [answeredAsk('answered'), answeredAsk('escalated', 'rejected'), plainGate('job')];
    adapter.cancelRun = async (id: string) => {
      cancelled.push(id);
      return 'cancelled';
    };
    const app = await createServer(adapter, { auditPath });
    servers.push(app);
    await vi.waitFor(() => {
      const line = trail(auditPath).find((e) => e.action === 'run.cancelled');
      expect(line).toMatchObject({ runId: 'answered', actor: { id: 'daemon' }, detail: { via: 'boot', reason: 'ask_turn_orphaned', status: 'cancelled' } });
    });
    expect(cancelled).toEqual(['answered']);
  });
});
