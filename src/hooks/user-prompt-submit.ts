#!/usr/bin/env bun
import {
  ensureDaemon,
  getGitBranch,
  getJson,
  getRepoRoot,
  postJson,
  readStdinJson,
  safeExit,
  shortIdFromInput,
} from "./util";
import type { Session, Export } from "../daemon/types";

type State = {
  sessions: Session[];
  recent_exports: Export[];
};

function buildContext(state: State, myLabel: string): string {
  const lines: string[] = [];
  lines.push("<sync-context>");
  lines.push(
    `You are session [${myLabel}] in a multi-session coding mesh. The user is running multiple Claude Code sessions on this repo simultaneously.`
  );
  lines.push("");

  if (state.sessions.length === 0) {
    lines.push("No other active sessions on this repo right now.");
  } else {
    lines.push("Other active sessions on this repo:");
    for (const s of state.sessions) {
      const lbl = s.label ?? s.id.slice(0, 6);
      const intent = s.current_intent;
      const summary = intent?.summary?.trim() || "(no intent yet)";
      const modifying =
        intent && intent.will_modify.length > 0 ? ` — modifying ${intent.will_modify.join(", ")}` : "";
      lines.push(`- session [${lbl}]: "${summary}" [${s.status}]${modifying}`);
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
    "## STRICT REQUIREMENT — Sync planning protocol"
  );
  lines.push("");
  lines.push(
    "Sync enforces plan-before-execute. The FIRST tokens of your response MUST be a `<sync-intent>` block listing every file you intend to read/edit/write this turn. The block goes before any narration, before any tool call. Sync strips it — the user never sees it."
  );
  lines.push("");
  lines.push("Format:");
  lines.push("");
  lines.push("<sync-intent>");
  lines.push("{");
  lines.push('  "summary": "<one short line — what you will accomplish this turn>",');
  lines.push('  "will_modify": ["<every file you might touch — repo-relative path>", "..."],');
  lines.push('  "will_create": ["<every symbol you will newly export>", "..."],');
  lines.push('  "depends_on": ["<peer-created symbol names you will use>"]');
  lines.push("}");
  lines.push("</sync-intent>");
  lines.push("");
  lines.push("Hard rules:");
  lines.push("- `will_modify` must include EVERY file you anticipate writing to this turn. Over-declare; do not under-declare.");
  lines.push("- It must be the very first thing in your response, before any other text or tool call.");
  lines.push("- After the block, proceed normally with your work.");
  lines.push("");
  lines.push("## What happens when your plan overlaps a peer's");
  lines.push("");
  lines.push("On your first tool call, Sync checks your plan against peer sessions' active plans and held file locks. If there is a conflict, Sync will TRANSPARENTLY HOLD your tool call until the conflict clears (peer finishes their turn, releases their lock, or their plan changes). You don't need to do anything special — your tool call simply takes longer the first time. When it returns, your tool runs normally.");
  lines.push("");
  lines.push("If, after about nine minutes, the conflict still hasn't cleared, Sync will deny the call with a `[sync]` message. Only in that case should you stop and tell the user the peer is taking too long.");
  lines.push("");
  lines.push("Practical implication: when you see a long pause before your first Read/Edit, that's Sync queuing you. It's expected. Don't retry, don't work around it — just wait for the tool to come back.");
  lines.push("");
  lines.push("## Coordinating with peers proactively");
  lines.push("");
  lines.push("If you can see in the active sessions list above that a peer plans to modify a file you also need:");
  lines.push("(a) reuse their planned exports rather than duplicating them yourself");
  lines.push("(b) carve out a non-overlapping slice of work and only declare those files in your `will_modify`");
  lines.push("(c) if no non-overlapping slice exists, do the same wait-and-retry handoff in step 1–3 above");
  lines.push("</sync-context>");
  return lines.join("\n");
}

async function main() {
  try {
    const input = (await readStdinJson<any>()) ?? {};
    const cwd = input.cwd ?? process.cwd();
    const repo = getRepoRoot(cwd);
    const sessionId = shortIdFromInput(input);
    if (!sessionId) safeExit(0);
    await ensureDaemon();
    const upsert = await postJson<{ label: string | null }>("/sessions", {
      id: sessionId,
      pid: process.ppid,
      cwd: repo,
      branch: getGitBranch(repo),
    });
    const myLabel = upsert.data?.label ?? "?";
    await postJson("/heartbeat", { session_id: sessionId });
    // Wipe last turn's intent at the START of a new turn. Stop hook also clears
    // it, but Stop may not fire (Ctrl+C, crash, /clear mid-turn) — clearing here
    // guarantees that PreToolUse re-parses the fresh <sync-intent> from THIS
    // turn's transcript instead of reusing a stale plan that's still blocking peers.
    await postJson("/intents/clear", { session_id: sessionId });
    await postJson("/status", { session_id: sessionId, status: "thinking" }).catch(() => {});

    const state = await getJson<State>(`/state?excluding=${sessionId}`);
    if (!state) {
      safeExit(0);
    }

    // Visible status banner (printed BEFORE the sync-context block).
    // Claude Code surfaces hook stdout as a system reminder so this appears
    // in the user's pane on every prompt — they always see which session
    // they're typing into and what the mesh looks like right now.
    const peerLines: string[] = [];
    for (const s of state!.sessions) {
      const lbl = s.label ?? s.id.slice(0, 6);
      const status = s.status === "waiting" ? "⏳ queued" : s.status;
      const summary = s.current_intent?.summary || "(no intent)";
      peerLines.push(`  • [${lbl}] ${status} — ${summary}`);
    }
    const headerBanner =
      `\n[Sync · you are session ${myLabel}]` +
      (peerLines.length > 0 ? "\nPeers in this repo right now:\n" + peerLines.join("\n") : "\n(no peer sessions)") +
      "\n";
    process.stdout.write(headerBanner);

    const context = buildContext(state!, myLabel);
    process.stdout.write(context + "\n");
  } catch {
    /* never break the user's claude session */
  }
  safeExit(0);
}

main();
