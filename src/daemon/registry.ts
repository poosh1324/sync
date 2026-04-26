import { db } from "./db";
import type { Session, SessionStatus, Intent } from "./types";

type SessionRow = {
  id: string;
  pid: number | null;
  cwd: string;
  branch: string;
  started_at: number;
  last_heartbeat: number;
  current_intent: string | null;
  status: SessionStatus;
};

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    pid: row.pid,
    cwd: row.cwd,
    branch: row.branch,
    started_at: row.started_at,
    last_heartbeat: row.last_heartbeat,
    current_intent: row.current_intent ? (JSON.parse(row.current_intent) as Intent) : null,
    status: row.status,
  };
}

export function upsertSession(input: {
  id: string;
  pid: number | null;
  cwd: string;
  branch: string;
}): Session {
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, pid, cwd, branch, started_at, last_heartbeat, current_intent, status)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 'idle')
     ON CONFLICT(id) DO UPDATE SET pid=excluded.pid, cwd=excluded.cwd, branch=excluded.branch, last_heartbeat=excluded.last_heartbeat`
  ).run(input.id, input.pid, input.cwd, input.branch, now, now);
  return getSession(input.id)!;
}

export function getSession(id: string): Session | null {
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  return row ? rowToSession(row) : null;
}

export function listSessions(opts: { excluding?: string } = {}): Session[] {
  const rows = (
    opts.excluding
      ? db.prepare("SELECT * FROM sessions WHERE id != ? ORDER BY started_at ASC").all(opts.excluding)
      : db.prepare("SELECT * FROM sessions ORDER BY started_at ASC").all()
  ) as SessionRow[];
  return rows.map(rowToSession);
}

export function deleteSession(id: string): void {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

export function heartbeat(id: string): void {
  db.prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?").run(Date.now(), id);
}

export function setIntent(id: string, intent: Intent): void {
  db.prepare(
    "UPDATE sessions SET current_intent = ?, last_heartbeat = ? WHERE id = ?"
  ).run(JSON.stringify(intent), Date.now(), id);
}

export function setStatus(id: string, status: SessionStatus): void {
  db.prepare("UPDATE sessions SET status = ?, last_heartbeat = ? WHERE id = ?").run(
    status,
    Date.now(),
    id
  );
}

export function pruneStale(maxIdleMs: number): string[] {
  const cutoff = Date.now() - maxIdleMs;
  const rows = db.prepare("SELECT id FROM sessions WHERE last_heartbeat < ?").all(cutoff) as {
    id: string;
  }[];
  for (const row of rows) deleteSession(row.id);
  return rows.map((r) => r.id);
}
