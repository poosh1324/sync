#!/usr/bin/env bun
import {
  daemonHealth,
  ensureDaemon,
  getGitBranch,
  getJson,
  getRepoRoot,
  postJson,
  readStdinJson,
  safeExit,
  shortIdFromInput,
} from "./util";
import { abbreviatePath } from "../util/path";
import { readSyncState } from "../util/state";
import { basename } from "node:path";

function emitBanner(text: string) {
  process.stdout.write(`[Sync] ${text}\n`);
}

async function main() {
  try {
    const input = (await readStdinJson<any>()) ?? {};
    const cwd = input.cwd ?? process.cwd();
    const repo = getRepoRoot(cwd);
    const branch = getGitBranch(repo);

    const state = readSyncState();
    if (!state.enabled) {
      emitBanner("Paused. Run `syncc resume` to re-enable. (Skipped registration for this session.)");
      safeExit(0);
    }

    const id = shortIdFromInput(input);
    if (!id) safeExit(0);

    await ensureDaemon();
    if (!(await daemonHealth())) safeExit(0);

    // Idempotent upsert — same id from same claude session always lands on the
    // same daemon row, so SessionStart firing for resume/clear/compact is safe.
    const upsertRes = await postJson<{ label: string | null }>("/sessions", {
      id,
      pid: process.ppid,
      cwd: repo,
      branch,
    });
    const myLabel = upsertRes.data?.label ?? "?";

    const peers = await getJson<{ sessions: Array<{ id: string; label: string | null }> }>(
      `/state/full?cwd=${encodeURIComponent(repo)}`
    );
    const peerLabels = (peers?.sessions ?? [])
      .filter((s) => s.label && s.label !== myLabel)
      .map((s) => s.label as string);
    const n = peers?.sessions?.length ?? 1;
    const word = n === 1 ? "session" : "sessions";
    const peerSummary =
      peerLabels.length === 0 ? "you are alone in the mesh" : `peers: ${peerLabels.join(", ")}`;

    // Box geometry: same width as stop hook box for consistency.
    const W = 52;
    const pad = (s: string) => s.length > W ? s.slice(0, W - 1) + "…" : s + " ".repeat(W - s.length);
    const banner = [
      "",
      "╭" + "─".repeat(W + 2) + "╮",
      `│ ${pad(`You are session [${myLabel}]   · ${peerSummary}`)} │`,
      `│ ${pad(`Repo:   ${abbreviatePath(repo)}`)} │`,
      `│ ${pad(`Branch: ${branch}`)} │`,
      `│ ${pad(`Mesh:   ${n} ${word}`)} │`,
      `│ ${pad("View live: `syncc mon` in another pane")} │`,
      "╰" + "─".repeat(W + 2) + "╯",
      "",
    ].join("\n");
    // stdout only — Claude Code surfaces SessionStart hook stdout inside its
    // own TUI as a system reminder. Writing to /dev/tty (printToPane) drove
    // Claude's input cursor to the wrong row and broke its layout, so we
    // accept the tradeoff: the banner shows up the first time Claude renders
    // (typically when the user submits their first prompt).
    process.stdout.write(banner);
  } catch {
    /* never break the user's claude session */
  }
  safeExit(0);
}

main();
