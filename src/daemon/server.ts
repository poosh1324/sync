import "./db";
import {
  upsertSession,
  getSession,
  listSessions,
  deleteSession,
  heartbeat,
  setIntent,
  setStatus,
  pruneStale,
} from "./registry";
import {
  acquireLock,
  releaseLock,
  listLocks,
  pruneExpiredLocks,
  releaseAllForSession,
} from "./locks";
import { recordEvent, recentEvents, recordExport, recentExports } from "./broadcast";
import { IntentSchema } from "./types";

const PORT = Number(process.env.SYNC_PORT ?? 7777);
const HOST = "127.0.0.1";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

const STALE_SESSION_MS = 60_000;

setInterval(() => {
  const removedSessions = pruneStale(STALE_SESSION_MS);
  for (const id of removedSessions) {
    recordEvent({ ts: Date.now(), type: "session_left", session_id: id });
    releaseAllForSession(id);
  }
  const expiredLocks = pruneExpiredLocks();
  for (const path of expiredLocks) {
    recordEvent({ ts: Date.now(), type: "lock_released", path, session_id: "(expired)" });
  }
}, 5000);

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    try {
      if (path === "/health") return json({ ok: true, ts: Date.now() });

      if (path === "/sessions" && method === "POST") {
        const body = await readJson(req);
        if (!body.id || !body.cwd || !body.branch) return json({ error: "missing fields" }, 400);
        const sess = upsertSession({
          id: body.id,
          pid: body.pid ?? null,
          cwd: body.cwd,
          branch: body.branch,
        });
        recordEvent({ ts: Date.now(), type: "session_joined", session: sess });
        return json(sess);
      }

      if (path === "/sessions" && method === "GET") {
        return json(listSessions());
      }

      if (path.startsWith("/sessions/") && method === "DELETE") {
        const id = path.slice("/sessions/".length);
        deleteSession(id);
        releaseAllForSession(id);
        recordEvent({ ts: Date.now(), type: "session_left", session_id: id });
        return json({ ok: true });
      }

      if (path === "/heartbeat" && method === "POST") {
        const body = await readJson(req);
        if (!body.session_id) return json({ error: "missing session_id" }, 400);
        heartbeat(body.session_id);
        return json({ ok: true });
      }

      if (path === "/intents" && method === "POST") {
        const body = await readJson(req);
        if (!body.session_id) return json({ error: "missing session_id" }, 400);
        const parsed = IntentSchema.safeParse(body.intent);
        if (!parsed.success) return json({ error: "invalid intent", issues: parsed.error.issues }, 400);
        setIntent(body.session_id, parsed.data);
        recordEvent({
          ts: Date.now(),
          type: "intent_announced",
          session_id: body.session_id,
          intent: parsed.data,
        });
        return json({ ok: true });
      }

      if (path === "/status" && method === "POST") {
        const body = await readJson(req);
        if (!body.session_id || !body.status) return json({ error: "missing fields" }, 400);
        setStatus(body.session_id, body.status);
        return json({ ok: true });
      }

      if (path === "/locks/acquire" && method === "POST") {
        const body = await readJson(req);
        if (!body.session_id || !body.path) return json({ error: "missing fields" }, 400);
        const result = acquireLock({ session_id: body.session_id, path: body.path });
        if (!result.ok) {
          recordEvent({
            ts: Date.now(),
            type: "lock_denied",
            path: body.path,
            held_by: result.held_by,
            requester: body.session_id,
          });
          return json(
            {
              ok: false,
              held_by: result.held_by,
              held_by_summary: result.held_by_summary,
            },
            409
          );
        }
        recordEvent({ ts: Date.now(), type: "lock_acquired", lock: result.lock });
        return json({ ok: true, lock: result.lock });
      }

      if (path === "/locks/release" && method === "POST") {
        const body = await readJson(req);
        if (!body.session_id || !body.path) return json({ error: "missing fields" }, 400);
        const released = releaseLock({ session_id: body.session_id, path: body.path });
        if (released) {
          recordEvent({
            ts: Date.now(),
            type: "lock_released",
            path: body.path,
            session_id: body.session_id,
          });
        }
        return json({ ok: true, released });
      }

      if (path === "/locks" && method === "GET") {
        return json(listLocks());
      }

      if (path === "/broadcast" && method === "POST") {
        const body = await readJson(req);
        if (body.type === "export_created") {
          if (!body.session_id || !body.file || !Array.isArray(body.symbols)) {
            return json({ error: "missing fields" }, 400);
          }
          recordExport({ session_id: body.session_id, file: body.file, symbols: body.symbols });
          recordEvent({
            ts: Date.now(),
            type: "export_created",
            session_id: body.session_id,
            file: body.file,
            symbols: body.symbols,
          });
          return json({ ok: true });
        }
        return json({ error: "unsupported broadcast type" }, 400);
      }

      if (path === "/state" && method === "GET") {
        const excluding = url.searchParams.get("excluding") ?? undefined;
        return json({
          sessions: listSessions(excluding ? { excluding } : {}),
          locks: listLocks(),
          recent_exports: recentExports(20, excluding ? { excluding } : {}),
          events: recentEvents(40),
        });
      }

      if (path === "/state/full" && method === "GET") {
        return json({
          sessions: listSessions(),
          locks: listLocks(),
          recent_exports: recentExports(20),
          events: recentEvents(40),
        });
      }

      return json({ error: "not found", path }, 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: "internal", message }, 500);
    }
  },
});

console.log(`[sync] daemon listening on http://${HOST}:${server.port}`);
