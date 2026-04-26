import { db } from "./db";
import {
  upsertSession,
  getSession,
  listSessions,
  deleteSession,
  heartbeat,
  setIntent,
  setStatus,
  clearIntent,
  removeFileFromIntent,
  pruneStale,
  pruneDead,
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
const DAEMON_STARTED_AT = Date.now();
const VERSION = "0.1.0";

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

const STALE_SESSION_MS = 30 * 60_000; // 30 min — claude can think for many minutes between hooks

setInterval(() => {
  // Drop sessions whose claude process is gone (Ctrl+C / window close — cases
  // where SessionEnd hook never fired). Runs on the same 5s tick as the lock
  // pruner so the monitor reflects reality within ~5s of a session dying.
  const deadSessions = pruneDead();
  for (const id of deadSessions) {
    recordEvent({ ts: Date.now(), type: "session_left", session_id: id });
    releaseAllForSession(id);
  }
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
      if (path === "/health")
        return json({ status: "ok", ok: true, ts: Date.now(), started_at: DAEMON_STARTED_AT, version: VERSION });

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

      if (path === "/intents/clear" && method === "POST") {
        const body = await readJson(req);
        if (!body.session_id) return json({ error: "missing session_id" }, 400);
        clearIntent(body.session_id);
        return json({ ok: true });
      }

      if (path === "/intents/remove-file" && method === "POST") {
        const body = await readJson(req);
        if (!body.session_id || !body.file) return json({ error: "missing fields" }, 400);
        removeFileFromIntent(body.session_id, body.file);
        return json({ ok: true });
      }

      // Given a candidate intent, return any conflicting peer sessions.
      //
      // Conflict definition:
      //   - A peer holds a file LOCK on a path I plan to modify, OR
      //   - A peer has an active INTENT whose will_modify intersects mine,
      //     AND the peer joined the mesh before me (older started_at wins).
      //
      // The "older wins" tiebreaker prevents the deadlock where two sessions
      // start at almost the same time, each see the other's intent, and both
      // decide to wait. With the rule, the older session sees no conflict
      // from the younger one and proceeds; the younger one yields.
      //
      // Locks are independent of this rule — first-come-first-served on
      // file locks (a younger session already holding a lock still wins).
      if (path === "/intents/conflict" && method === "POST") {
        const body = await readJson(req);
        if (!body.session_id || !body.intent || !body.cwd) return json({ error: "missing fields" }, 400);
        const myParsed = IntentSchema.safeParse(body.intent);
        if (!myParsed.success) return json({ error: "invalid intent" }, 400);
        const myFiles = new Set(myParsed.data.will_modify.map(String));
        const me = getSession(body.session_id);
        const myStartedAt = me?.started_at ?? Number.MAX_SAFE_INTEGER;
        const peers = listSessions().filter((s) => s.id !== body.session_id && s.cwd === body.cwd);
        const peerLocks = listLocks();
        const conflicts: Array<{
          peer_id: string;
          peer_summary: string;
          via: "intent" | "lock";
          file: string;
        }> = [];
        for (const peer of peers) {
          const peerIntent = peer.current_intent;
          // Intent-vs-intent: only yield to peers that joined BEFORE me
          if (peerIntent && peerIntent.will_modify && peer.started_at < myStartedAt) {
            for (const f of peerIntent.will_modify.map(String)) {
              if (myFiles.has(f)) {
                conflicts.push({
                  peer_id: peer.id,
                  peer_summary: peerIntent.summary || "(no summary)",
                  via: "intent",
                  file: f,
                });
              }
            }
          }
          // Lock conflict: independent of join order
          const peerOwnedLocks = peerLocks.filter((l) => l.session_id === peer.id);
          for (const l of peerOwnedLocks) {
            if (myFiles.has(l.path)) {
              conflicts.push({
                peer_id: peer.id,
                peer_summary: peer.current_intent?.summary || "(no summary)",
                via: "lock",
                file: l.path,
              });
            }
          }
        }
        return json({ conflicts });
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
        if (body.type === "session_queued") {
          if (!body.session_id || !body.held_by || !body.reason) return json({ error: "missing fields" }, 400);
          recordEvent({
            ts: Date.now(),
            type: "session_queued",
            session_id: body.session_id,
            held_by: body.held_by,
            reason: body.reason,
          });
          return json({ ok: true });
        }
        if (body.type === "session_resumed") {
          if (!body.session_id) return json({ error: "missing session_id" }, 400);
          recordEvent({
            ts: Date.now(),
            type: "session_resumed",
            session_id: body.session_id,
            waited_ms: Number(body.waited_ms ?? 0),
          });
          return json({ ok: true });
        }
        return json({ error: "unsupported broadcast type" }, 400);
      }

      // Demo iteration helper — wipe all mesh state without restarting the
       // daemon. Used by sync-web-demo/repeat-demo.sh between takes so the
       // dashboard, dev server, and live claude panes can stay up across
       // iterations. NOT exposed publicly: 127.0.0.1 only, no auth.
      if (path === "/admin/wipe" && method === "POST") {
        db.exec("DELETE FROM sessions");
        db.exec("DELETE FROM locks");
        db.exec("DELETE FROM exports");
        db.exec("DELETE FROM events");
        return json({ ok: true });
      }

      if (path === "/state" && method === "GET") {
        const excluding = url.searchParams.get("excluding") ?? undefined;
        const cwdFilter = url.searchParams.get("cwd") ?? undefined;
        let sessions = listSessions(excluding ? { excluding } : {});
        if (cwdFilter) sessions = sessions.filter((s) => s.cwd === cwdFilter);
        const sessionIds = new Set(sessions.map((s) => s.id));
        let locks = listLocks();
        let exps = recentExports(20, excluding ? { excluding } : {});
        if (cwdFilter) {
          locks = locks.filter((l) => sessionIds.has(l.session_id));
          exps = exps.filter((e) => sessionIds.has(e.session_id));
        }
        return json({
          sessions,
          locks,
          recent_exports: exps,
          events: recentEvents(40),
        });
      }

      if (path === "/state/full" && method === "GET") {
        const cwdFilter = url.searchParams.get("cwd") ?? undefined;
        let sessions = listSessions();
        if (cwdFilter) sessions = sessions.filter((s) => s.cwd === cwdFilter);
        const sessionIds = new Set(sessions.map((s) => s.id));
        let locks = listLocks();
        let exps = recentExports(20);
        if (cwdFilter) {
          locks = locks.filter((l) => sessionIds.has(l.session_id));
          exps = exps.filter((e) => sessionIds.has(e.session_id));
        }
        return json({
          sessions,
          locks,
          recent_exports: exps,
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
