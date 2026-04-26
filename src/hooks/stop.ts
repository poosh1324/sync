#!/usr/bin/env bun
import {
  daemonHealth,
  getJson,
  getRepoRoot,
  postJson,
  readStdinJson,
  safeExit,
  shortIdFromInput,
} from "./util";
import { basename } from "node:path";

type Session = {
  id: string;
  cwd: string;
  status: string;
  label: string | null;
  current_intent: { summary?: string; will_modify?: string[] } | null;
};

async function main() {
  try {
    const input = (await readStdinJson<any>()) ?? {};
    const id = shortIdFromInput(input);
    const cwd = input.cwd ?? process.cwd();
    const repo = getRepoRoot(cwd);
    if (!id) safeExit(0);
    if (!(await daemonHealth())) safeExit(0);

    await postJson("/heartbeat", { session_id: id });
    // Reset status to idle when the turn ends. PostToolUse only fires for
    // Edit/Write/MultiEdit, so a turn that only ran Read/Grep would otherwise
    // stay stuck on "thinking" from the last PreToolUse.
    await postJson("/status", { session_id: id, status: "idle" }).catch(() => {});
    // Intent is scoped to a single turn — clear it on Stop so peers queued on
    // over-declared files (declared in will_modify but never actually edited)
    // are unblocked the moment this turn ends, not when the user's next prompt
    // arrives. Also forces PreToolUse on the next turn to re-parse the fresh
    // <sync-intent> from the transcript instead of reusing this turn's stale plan.
    await postJson("/intents/clear", { session_id: id }).catch(() => {});

    // Build a turn-summary box so the user can see, at the moment Claude
    // hands the turn back, what the mesh looks like — who is queued, who is
    // editing, what files are in flight.
    const all = await getJson<Session[]>("/sessions");
    if (!all) safeExit(0);
    const me = all.find((s) => s.id === id);
    const myLabel = me?.label ?? "?";
    const peers = all.filter((s) => s.cwd === me?.cwd && s.id !== id);

    // Box geometry: 56 chars wide total = "│ " + 52 char content + " │".
    const W = 52;
    const pad = (s: string) => s.length > W ? s.slice(0, W - 1) + "…" : s + " ".repeat(W - s.length);
    const titleContent = `Session [${myLabel}] finished a turn in ${truncate(basename(repo), 20)}`;
    const peerLines: string[] = [];
    for (const p of peers) {
      const lbl = p.label ?? p.id.slice(0, 6);
      const summary = p.current_intent?.summary || "(no intent)";
      const stat = p.status === "waiting" ? "⏳ queued" : p.status;
      peerLines.push(`│ ${pad(`[${lbl}] ${stat}  ${summary}`)} │`);
    }
    if (peerLines.length === 0) {
      peerLines.push(`│ ${pad("(no other sessions in this repo)")} │`);
    }

    const box = [
      "",
      "╭" + "─".repeat(W + 2) + "╮",
      `│ ${pad(titleContent)} │`,
      "├" + "─".repeat(W + 2) + "┤",
      ...peerLines,
      "╰" + "─".repeat(W + 2) + "╯",
      "",
    ].join("\n");
    // stdout only — Claude Code surfaces it in the conversation area.
    // Direct /dev/tty writes broke claude's TUI rendering.
    process.stdout.write(box);
  } catch {
    /* never break the user's claude session */
  }
  safeExit(0);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

main();
