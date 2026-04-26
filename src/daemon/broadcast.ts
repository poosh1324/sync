import { db } from "./db";
import type { Event, Export } from "./types";

const MAX_EVENTS_RETURNED = 100;

export function recordEvent(event: Event): void {
  db.prepare("INSERT INTO events (ts, payload) VALUES (?, ?)").run(event.ts, JSON.stringify(event));
}

export function recentEvents(limit = 30): Event[] {
  const rows = db
    .prepare("SELECT payload FROM events ORDER BY id DESC LIMIT ?")
    .all(Math.min(limit, MAX_EVENTS_RETURNED)) as { payload: string }[];
  return rows.map((r) => JSON.parse(r.payload) as Event).reverse();
}

export function recordExport(input: { session_id: string; file: string; symbols: string[] }): Export {
  const created_at = Date.now();
  db.prepare(
    "INSERT INTO exports (session_id, file, symbols, created_at) VALUES (?, ?, ?, ?)"
  ).run(input.session_id, input.file, JSON.stringify(input.symbols), created_at);
  return { ...input, created_at };
}

export function recentExports(limit = 20, opts: { excluding?: string } = {}): Export[] {
  const rows = (
    opts.excluding
      ? db
          .prepare(
            "SELECT session_id, file, symbols, created_at FROM exports WHERE session_id != ? ORDER BY id DESC LIMIT ?"
          )
          .all(opts.excluding, limit)
      : db
          .prepare(
            "SELECT session_id, file, symbols, created_at FROM exports ORDER BY id DESC LIMIT ?"
          )
          .all(limit)
  ) as { session_id: string; file: string; symbols: string; created_at: number }[];
  return rows
    .map((r) => ({
      session_id: r.session_id,
      file: r.file,
      symbols: JSON.parse(r.symbols) as string[],
      created_at: r.created_at,
    }))
    .reverse();
}
