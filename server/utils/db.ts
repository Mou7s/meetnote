import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { getDataDir } from './env'

let cached: { dir: string; db: Database } | null = null

export function getDb(): Database {
  const dir = getDataDir()
  if (cached && cached.dir === dir) return cached.db
  if (cached) {
    cached.db.close()
    cached = null
  }
  mkdirSync(dir, { recursive: true })
  const db = new Database(join(dir, 'meetnote.sqlite'), { create: true })
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','member')),
      password TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS session_expiration ON sessions(expires);
    CREATE TABLE IF NOT EXISTS attempts (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      ciphertext TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS meetings_owner ON meetings(owner);
  `)
  cached = { dir, db }
  return db
}

export function closeDb() {
  if (!cached) return
  cached.db.close()
  cached = null
}
