import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Session, SessionStatus, Phase, GateKind } from './types.js';

function now(): string {
  return new Date().toISOString();
}

// ── sessions ──────────────────────────────────────────────────────────────────

export function createSession(
  db: Database.Database,
  opts: { type: string; goal: string; workers: string[] },
): Session {
  const session: Session = {
    id: randomUUID(),
    type: opts.type,
    goal: opts.goal,
    status: 'pending',
    workers: opts.workers,
    created_at: now(),
    updated_at: now(),
  };
  db.prepare(`
    INSERT INTO sessions (id, type, goal, status, workers, created_at, updated_at)
    VALUES (@id, @type, @goal, @status, @workers, @created_at, @updated_at)
  `).run({ ...session, workers: JSON.stringify(session.workers) });
  return session;
}

export function getSession(db: Database.Database, id: string): Session | null {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : null;
}

export function updateSessionStatus(db: Database.Database, id: string, status: SessionStatus): void {
  db.prepare('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
}

export function listActiveSessions(db: Database.Database): Session[] {
  const rows = db.prepare("SELECT * FROM sessions WHERE status IN ('pending','running','paused')").all() as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/** All sessions, most-recent first — for the studio session list ("active and recent"). */
export function listSessions(db: Database.Database, limit = 50): Session[] {
  const rows = db.prepare('SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

function rowToSession(row: Record<string, unknown>): Session {
  return {
    ...(row as Omit<Session, 'workers'>),
    workers: JSON.parse(row['workers'] as string) as string[],
  };
}

// ── phases ────────────────────────────────────────────────────────────────────

export function createPhase(
  db: Database.Database,
  opts: { session_id: string; phase_id: string; gate_kind: GateKind },
): Phase {
  const phase: Phase = {
    id: randomUUID(),
    session_id: opts.session_id,
    phase_id: opts.phase_id,
    state: 'Pending',
    gate_kind: opts.gate_kind,
    blocking_raid_ids: [],
    created_at: now(),
    updated_at: now(),
  };
  db.prepare(`
    INSERT INTO phases (id, session_id, phase_id, state, gate_kind, blocking_raid_ids, created_at, updated_at)
    VALUES (@id, @session_id, @phase_id, @state, @gate_kind, @blocking_raid_ids, @created_at, @updated_at)
  `).run({ ...phase, blocking_raid_ids: JSON.stringify(phase.blocking_raid_ids) });
  return phase;
}

export function getPhase(db: Database.Database, sessionId: string, phaseId: string): Phase | null {
  const row = db.prepare('SELECT * FROM phases WHERE session_id = ? AND phase_id = ?').get(sessionId, phaseId) as Record<string, unknown> | undefined;
  return row ? rowToPhase(row) : null;
}

export function updatePhaseState(
  db: Database.Database,
  sessionId: string,
  phaseId: string,
  state: Phase['state'],
): void {
  db.prepare('UPDATE phases SET state = ?, updated_at = ? WHERE session_id = ? AND phase_id = ?')
    .run(state, now(), sessionId, phaseId);
}

export function listPhases(db: Database.Database, sessionId: string): Phase[] {
  const rows = db.prepare('SELECT * FROM phases WHERE session_id = ? ORDER BY created_at').all(sessionId) as Record<string, unknown>[];
  return rows.map(rowToPhase);
}

function rowToPhase(row: Record<string, unknown>): Phase {
  return {
    ...(row as Omit<Phase, 'blocking_raid_ids'>),
    blocking_raid_ids: JSON.parse(row['blocking_raid_ids'] as string) as string[],
  };
}
