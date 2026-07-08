import type Database from 'better-sqlite3';

export function applySchema(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      goal        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      workers     TEXT NOT NULL DEFAULT '[]',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS phases (
      id                TEXT PRIMARY KEY,
      session_id        TEXT NOT NULL REFERENCES sessions(id),
      phase_id          TEXT NOT NULL,
      state             TEXT NOT NULL DEFAULT 'Pending',
      gate_kind         TEXT NOT NULL DEFAULT 'auto',
      blocking_raid_ids TEXT NOT NULL DEFAULT '[]',
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dispatches (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL REFERENCES sessions(id),
      phase_id      TEXT NOT NULL,
      worker_id     TEXT NOT NULL,
      prompt        TEXT NOT NULL,
      exit_code     INTEGER,
      stdout        TEXT,
      stderr        TEXT,
      started_at    TEXT NOT NULL,
      completed_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS evidence (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      phase_id    TEXT NOT NULL,
      kind        TEXT NOT NULL,
      payload     TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gates (
      id                TEXT PRIMARY KEY,
      session_id        TEXT NOT NULL REFERENCES sessions(id),
      phase_id          TEXT NOT NULL,
      result            TEXT,
      blocking_policies TEXT NOT NULL DEFAULT '[]',
      council_score     REAL,
      conditions        TEXT,
      evaluated_at      TEXT,
      created_at        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS raid_items (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      phase_id    TEXT NOT NULL,
      kind        TEXT NOT NULL,
      title       TEXT NOT NULL,
      description TEXT NOT NULL,
      blocking    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS xstate_snapshots (
      session_id   TEXT PRIMARY KEY REFERENCES sessions(id),
      snapshot     TEXT NOT NULL,
      saved_at     TEXT NOT NULL
    );
  `);
}
