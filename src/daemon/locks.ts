import { db } from "./db";
import type { Lock } from "./types";

const DEFAULT_TTL_MS = 60_000;

export function acquireLock(input: { session_id: string; path: string; ttl_ms?: number }):
  | { ok: true; lock: Lock }
  | { ok: false; held_by: string; held_by_summary: string | null } {
  const ttl = input.ttl_ms ?? DEFAULT_TTL_MS;
  const now = Date.now();

  const existing = db.prepare("SELECT * FROM locks WHERE path = ?").get(input.path) as Lock | undefined;
  if (existing) {
    const expired = existing.acquired_at + existing.ttl_ms < now;
    if (!expired && existing.session_id !== input.session_id) {
      const peer = db.prepare("SELECT current_intent FROM sessions WHERE id = ?").get(existing.session_id) as
        | { current_intent: string | null }
        | undefined;
      let summary: string | null = null;
      if (peer?.current_intent) {
        try {
          summary = JSON.parse(peer.current_intent).summary ?? null;
        } catch {
          /* ignore */
        }
      }
      return { ok: false, held_by: existing.session_id, held_by_summary: summary };
    }
  }

  db.prepare(
    `INSERT INTO locks (path, session_id, acquired_at, ttl_ms)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET session_id=excluded.session_id, acquired_at=excluded.acquired_at, ttl_ms=excluded.ttl_ms`
  ).run(input.path, input.session_id, now, ttl);

  return { ok: true, lock: { path: input.path, session_id: input.session_id, acquired_at: now, ttl_ms: ttl } };
}

export function releaseLock(input: { session_id: string; path: string }): boolean {
  const result = db
    .prepare("DELETE FROM locks WHERE path = ? AND session_id = ?")
    .run(input.path, input.session_id);
  return result.changes > 0;
}

export function listLocks(): Lock[] {
  return db.prepare("SELECT * FROM locks ORDER BY acquired_at ASC").all() as Lock[];
}

export function pruneExpiredLocks(): string[] {
  const now = Date.now();
  const rows = db
    .prepare("SELECT path FROM locks WHERE acquired_at + ttl_ms < ?")
    .all(now) as { path: string }[];
  for (const row of rows) {
    db.prepare("DELETE FROM locks WHERE path = ?").run(row.path);
  }
  return rows.map((r) => r.path);
}

export function releaseAllForSession(session_id: string): string[] {
  const rows = db
    .prepare("SELECT path FROM locks WHERE session_id = ?")
    .all(session_id) as { path: string }[];
  db.prepare("DELETE FROM locks WHERE session_id = ?").run(session_id);
  return rows.map((r) => r.path);
}
