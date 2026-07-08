import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/store/db.js';
import { saveSnapshot, loadSnapshot, deleteSnapshot } from '../../src/store/snapshots.js';
import { createSession } from '../../src/store/sessions.js';

let dbPath: string;

afterEach(() => {
  closeDb();
  if (dbPath) rmSync(dbPath, { force: true });
});

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'crew-test-'));
  dbPath = join(dir, 'test.db');
  return openDb(dbPath);
}

describe('snapshots', () => {
  it('save + restore round-trip', () => {
    const db = tempDb();
    const session = createSession(db, { type: 'feature', goal: 'test', workers: [] });
    const snap = { value: 'clarify', context: { sessionId: session.id, lastActivePhase: 'clarify' } };

    saveSnapshot(db, session.id, snap);
    const loaded = loadSnapshot(db, session.id);
    expect(loaded).toEqual(snap);
  });

  it('overwrites existing snapshot (upsert)', () => {
    const db = tempDb();
    const session = createSession(db, { type: 'feature', goal: 'test', workers: [] });
    saveSnapshot(db, session.id, { value: 'clarify' });
    saveSnapshot(db, session.id, { value: 'design' });
    expect((loadSnapshot(db, session.id) as { value: string }).value).toBe('design');
  });

  it('returns null when no snapshot exists', () => {
    const db = tempDb();
    expect(loadSnapshot(db, 'nonexistent-id')).toBeNull();
  });

  it('deletes snapshot', () => {
    const db = tempDb();
    const session = createSession(db, { type: 'feature', goal: 'test', workers: [] });
    saveSnapshot(db, session.id, { value: 'x' });
    deleteSnapshot(db, session.id);
    expect(loadSnapshot(db, session.id)).toBeNull();
  });
});
