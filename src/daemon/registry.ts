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
  label: string | null;
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
    label: row.label ?? null,
  };
}

// Pick the next available label (A, B, C, ..., Z, then A2, B2, ...) for a
// session being created in `cwd`. Already-used labels in that cwd are skipped,
// so when an old session leaves its letter is recycled for the next joiner.
function nextLabel(cwd: string, excludingId: string): string {
  const peers = (
    db.prepare("SELECT label FROM sessions WHERE cwd = ? AND id != ?").all(cwd, excludingId) as {
      label: string | null;
    }[]
  );
  const used = new Set(peers.map((p) => p.label).filter((l): l is string => Boolean(l)));
  for (let n = 1; n < 100; n++) {
    for (let i = 0; i < 26; i++) {
      const letter = String.fromCharCode(65 + i);
      const candidate = n === 1 ? letter : `${letter}${n}`;
      if (!used.has(candidate)) return candidate;
    }
  }
  return excludingId.slice(0, 4); // fallback (shouldn't happen)
}

export function upsertSession(input: {
  id: string;
  pid: number | null;
  cwd: string;
  branch: string;
}): Session {
  const now = Date.now();
  const existing = getSession(input.id);
  // Preserve an existing label if this session was already registered;
  // otherwise allocate the next free letter for this cwd.
  const label = existing?.label ?? nextLabel(input.cwd, input.id);
  db.prepare(
    `INSERT INTO sessions (id, pid, cwd, branch, started_at, last_heartbeat, current_intent, status, label)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 'idle', ?)
     ON CONFLICT(id) DO UPDATE SET pid=excluded.pid, cwd=excluded.cwd, branch=excluded.branch, last_heartbeat=excluded.last_heartbeat`
  ).run(input.id, input.pid, input.cwd, input.branch, now, now, label);
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

export function clearIntent(id: string): void {
  db.prepare("UPDATE sessions SET current_intent = NULL WHERE id = ?").run(id);
}

// Remove a single file from a session's intent.will_modify list.
// Called by PostToolUse on lock release: once a session has finished
// touching a file in its plan, that file no longer counts as a conflict
// for queued peers.
export function removeFileFromIntent(id: string, file: string): void {
  const session = getSession(id);
  if (!session?.current_intent) return;
  const next = {
    ...session.current_intent,
    will_modify: session.current_intent.will_modify.filter((f) => f !== file),
  };
  setIntent(id, next);
}

export function pruneStale(maxIdleMs: number): string[] {
  const cutoff = Date.now() - maxIdleMs;
  const rows = db.prepare("SELECT id FROM sessions WHERE last_heartbeat < ?").all(cutoff) as {
    id: string;
  }[];
  for (const row of rows) deleteSession(row.id);
  return rows.map((r) => r.id);
}

// Detect sessions whose claude process is gone (Ctrl+C, window close, kill —
// any case where SessionEnd hook didn't fire). `pid` was recorded at
// SessionStart as the hook's ppid (= the claude process that spawned it).
// `process.kill(pid, 0)` sends signal 0, which only checks existence:
//   - ESRCH → process does not exist → session is dead, drop it
//   - EPERM → process exists but we don't own it → keep it (rare; same user)
export function pruneDead(): string[] {
  const rows = db.prepare("SELECT id, pid FROM sessions").all() as {
    id: string;
    pid: number | null;
  }[];
  const dead: string[] = [];
  for (const row of rows) {
    if (row.pid == null || row.pid <= 1) continue;
    try {
      process.kill(row.pid, 0);
    } catch (err: any) {
      if (err?.code === "ESRCH") dead.push(row.id);
    }
  }
  for (const id of dead) deleteSession(id);
  return dead;
}
