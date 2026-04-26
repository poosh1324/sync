#!/usr/bin/env bun
import {
  daemonHealth,
  getRepoRoot,
  readStdinJson,
  safeExit,
  shortIdFromInput,
  DAEMON_BASE,
} from "./util";

// SessionEnd fires for many reasons in Claude Code:
//   - "prompt_input_exit" — user typed /exit or Ctrl+D       ← actually ended
//   - "logout"            — user ran /logout                  ← actually ended
//   - "clear"             — user ran /clear (session lives on) ← KEEP session!
//   - "other" / undefined — auto-compact, subagent end, etc.   ← KEEP session!
// We only DELETE for true exits. For everything else we just heartbeat
// (so the row stays alive and the lock TTL keeps it visible).
const TRUE_EXIT_REASONS = new Set(["prompt_input_exit", "logout", "exit"]);

async function main() {
  try {
    const input = (await readStdinJson<any>()) ?? {};
    const id = shortIdFromInput(input);
    if (!id) safeExit(0);
    if (!(await daemonHealth())) safeExit(0);

    const reason: string = (input.reason ?? input.source ?? "other").toString();
    if (TRUE_EXIT_REASONS.has(reason)) {
      await fetch(`${DAEMON_BASE}/sessions/${encodeURIComponent(id)}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(1500),
      }).catch(() => {});
    } else {
      // /clear, compact, subagent finish — keep the session alive
      await fetch(`${DAEMON_BASE}/heartbeat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: id }),
        signal: AbortSignal.timeout(1500),
      }).catch(() => {});
    }
  } catch {
    /* never break the user's claude session */
  }
  safeExit(0);
}

main();
