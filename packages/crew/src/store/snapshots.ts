import type Database from 'better-sqlite3';

export function saveSnapshot(db: Database.Database, sessionId: string, snapshot: unknown): void {
  db.prepare(`
    INSERT INTO xstate_snapshots (session_id, snapshot, saved_at)
    VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET snapshot = excluded.snapshot, saved_at = excluded.saved_at
  `).run(sessionId, JSON.stringify(snapshot), new Date().toISOString());
}

export function loadSnapshot(db: Database.Database, sessionId: string): unknown | null {
  const row = db.prepare('SELECT snapshot FROM xstate_snapshots WHERE session_id = ?').get(sessionId) as { snapshot: string } | undefined;
  if (!row) return null;
  return JSON.parse(row.snapshot) as unknown;
}

export function deleteSnapshot(db: Database.Database, sessionId: string): void {
  db.prepare('DELETE FROM xstate_snapshots WHERE session_id = ?').run(sessionId);
}
