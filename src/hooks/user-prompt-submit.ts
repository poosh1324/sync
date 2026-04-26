#!/usr/bin/env bun
import {
  ensureDaemon,
  getJson,
  getRepoRoot,
  postJson,
  readSessionId,
  readStdinJson,
  safeExit,
} from "./util";
import type { Session, Export } from "../daemon/types";

type State = {
  sessions: Session[];
  recent_exports: Export[];
};

function buildContext(state: State): string {
  const lines: string[] = [];
  lines.push("<sync-context>");
  lines.push(
    "You are part of a multi-session coding mesh. The user is running multiple Claude Code sessions on this repo simultaneously."
  );
  lines.push("");

  if (state.sessions.length === 0) {
    lines.push("No other active sessions on this repo right now.");
  } else {
    lines.push("Other active sessions on this repo:");
    for (const s of state.sessions) {
      const intent = s.current_intent;
      const summary = intent?.summary?.trim() || "(no intent yet)";
      const modifying =
        intent && intent.will_modify.length > 0 ? ` — modifying ${intent.will_modify.join(", ")}` : "";
      lines.push(`- session ${s.id}: "${summary}" [${s.status}]${modifying}`);
    }
  }
  lines.push("");

  if (state.recent_exports.length > 0) {
    lines.push(
      "Recent exports announced by peers (you can use these directly without recreating):"
    );
    for (const ex of state.recent_exports) {
      for (const sym of ex.symbols) {
        lines.push(`- ${sym} from ${ex.file} — by session ${ex.session_id}`);
      }
    }
    lines.push("");
  }

  lines.push(
    "REQUIRED FORMAT: Begin your response with EXACTLY this block (the user will not see it; sync strips it):"
  );
  lines.push("");
  lines.push("<sync-intent>");
  lines.push("{");
  lines.push('  "summary": "<one line task description>",');
  lines.push('  "will_modify": ["<repo-relative paths you plan to edit>"],');
  lines.push('  "will_create": ["<symbol names you will export>"],');
  lines.push('  "depends_on": ["<peer-created symbols you will use, names only>"]');
  lines.push("}");
  lines.push("</sync-intent>");
  lines.push("");
  lines.push("Then proceed with your work as normal.");
  lines.push("");
  lines.push("If your task overlaps with another session, prefer to:");
  lines.push("(a) reuse their planned/completed exports rather than duplicating");
  lines.push(
    "(b) wait for their work if you depend on it (mention this in your reply, do not edit conflicting files)"
  );
  lines.push("(c) focus on a non-overlapping slice");
  lines.push("</sync-context>");
  return lines.join("\n");
}

async function main() {
  try {
    const input = (await readStdinJson<any>()) ?? {};
    const cwd = input.cwd ?? process.cwd();
    const repo = getRepoRoot(cwd);
    const sessionId = readSessionId(repo);
    if (!sessionId) {
      safeExit(0);
    }
    await ensureDaemon();
    // heartbeat first so peers see this session as live even if it never edits
    await postJson("/heartbeat", { session_id: sessionId });
    const state = await getJson<State>(`/state?excluding=${sessionId}`);
    if (!state) {
      safeExit(0);
    }
    const context = buildContext(state!);
    process.stdout.write(context + "\n");
  } catch {
    /* never break the user's claude session */
  }
  safeExit(0);
}

main();
