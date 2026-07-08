import Database from 'better-sqlite3';
import { applySchema } from './schema.js';

let _db: Database.Database | null = null;

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  applySchema(db);
  _db = db;
  return db;
}

export function getDb(): Database.Database {
  if (!_db) throw new Error('DB not initialized — call openDb() first');
  return _db;
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}
