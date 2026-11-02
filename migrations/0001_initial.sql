PRAGMA foreign_keys=ON;
CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member')), password TEXT NOT NULL);
CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
CREATE INDEX session_expiration ON sessions(expires);
CREATE TABLE attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE meetings (id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(id), summary TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
CREATE INDEX meetings_owner ON meetings(owner);
CREATE TABLE setup (id INTEGER PRIMARY KEY CHECK(id=1), user_id TEXT NOT NULL REFERENCES users(id));
