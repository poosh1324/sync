import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const SYNC_DIR = join(homedir(), ".sync");
mkdirSync(SYNC_DIR, { recursive: true });

const DB_PATH = process.env.SYNC_DB_PATH ?? join(SYNC_DIR, "sync.db");

export const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    pid INTEGER,
    cwd TEXT NOT NULL,
    branch TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    last_heartbeat INTEGER NOT NULL,
    current_intent TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    label TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS locks (
    path TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    acquired_at INTEGER NOT NULL,
    ttl_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS exports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    file TEXT NOT NULL,
    symbols TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    payload TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_exports_created_at ON exports(created_at)`,
];
for (const stmt of SCHEMA) db.exec(stmt);
// Migration: add label column to existing tables created before label was a feature.
try {
  db.exec("ALTER TABLE sessions ADD COLUMN label TEXT");
} catch {
  /* column already exists */
}
