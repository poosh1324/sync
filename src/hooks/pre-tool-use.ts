#!/usr/bin/env bun
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  ensureDaemon,
  getJson,
  getRepoRoot,
  postJson,
  readStdinJson,
  safeExit,
  shortIdFromInput,
  logHookError,
  logHookInfo,
} from "./util";
import { parseIntentFromText } from "../intent/parse";

// Note: we do NOT write to /dev/tty during PreToolUse anymore — claude is
// actively rendering its TUI here and direct writes drew over the prompt
// area, breaking box-drawing characters. Mid-turn queue/resume visibility
// lives in `syncc mon` (the dashboard pane).

type PreToolInput = {
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; [k: string]: any };
  transcript_path?: string;
};

type Conflict = {
  peer_id: string;
  peer_summary: string;
  via: "intent" | "lock";
  file: string;
};

const LOCK_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
const MAX_WAIT_MS = 9 * 60_000;
const POLL_MS = 800;

function readTranscriptTail(transcriptPath?: string): string {
  if (!transcriptPath || !existsSync(transcriptPath)) return "";
  try {
    const raw = readFileSync(transcriptPath, "utf8");
    const lines = raw.trim().split("\n").slice(-60);
    const texts: string[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const message = obj?.message;
        if (!message) continue;
        if (message.role === "assistant" && Array.isArray(message.content)) {
          for (const c of message.content) {
            if (c?.type === "text" && typeof c.text === "string") texts.push(c.text);
          }
        }
      } catch {
        /* skip */
      }
    }
    return texts.join("\n");
  } catch {
    return "";
  }
}

function denyJson(reason: string) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
}

async function fetchConflicts(sessionId: string, cwd: string, intent: any): Promise<Conflict[]> {
  const r = await postJson<{ conflicts: Conflict[] }>("/intents/conflict", {
    session_id: sessionId,
    cwd,
    intent,
  });
  return r.data?.conflicts ?? [];
}

function conflictBanner(conflicts: Conflict[]): string {
  const lines = ["[sync] queued — peer session(s) hold pieces of your plan:"];
  for (const c of conflicts) {
    lines.push(
      `  • ${c.file} — peer ${c.peer_id} (${c.peer_summary}) ${c.via === "lock" ? "is editing it now" : "has it in their plan"}`
    );
  }
  return lines.join("\n");
}

async function getMySession(sessionId: string): Promise<any | null> {
  const all = await getJson<any[]>("/sessions");
  return all?.find((s) => s.id === sessionId) ?? null;
}

async function main() {
  try {
    const input = (await readStdinJson<PreToolInput>()) ?? {};
    const cwd = input.cwd ?? process.cwd();
    const repo = getRepoRoot(cwd);
    const sessionId = shortIdFromInput(input as any);
    const tool = input.tool_name ?? "";
    if (!sessionId) safeExit(0);

    await ensureDaemon();

    // Step 1: figure out the authoritative intent for this session in this turn.
    // - If daemon already holds an intent for me → use it (it's the in-flight,
    //   PostToolUse-narrowed version).
    // - If daemon has none → parse from transcript and post once.
    let mySession = await getMySession(sessionId);
    let activeIntent = mySession?.current_intent ?? null;
    const myLabel: string = mySession?.label ?? "?";
    if (!activeIntent) {
      const transcript = readTranscriptTail(input.transcript_path);
      const parsed = parseIntentFromText(transcript);
      if (parsed) {
        parsed.will_modify = parsed.will_modify.map((p) =>
          p && !p.startsWith("/") ? resolve(repo, p) : p
        );
        await postJson("/intents", { session_id: sessionId, intent: parsed });
        activeIntent = parsed;
        logHookInfo(
          "pre-tool-use",
          `session=${sessionId} intent registered: [${parsed.will_modify.join(", ")}]`
        );
      }
    }

    // Step 2: status update — visible in mon
    const niceStatus = LOCK_TOOLS.has(tool) ? "editing" : "thinking";
    await postJson("/status", { session_id: sessionId, status: niceStatus }).catch(() => {});

    // Step 3: conflict check using authoritative intent (if any)
    if (activeIntent) {
      const startedAt = Date.now();
      let conflicts = await fetchConflicts(sessionId, repo, activeIntent);
      let bannerLogged = false;
      while (conflicts.length > 0) {
        if (!bannerLogged) {
          logHookInfo(
            "pre-tool-use",
            `session=${sessionId} QUEUED on ${conflicts.map((c) => c.file).join(", ")}`
          );
          bannerLogged = true;
          await postJson("/status", { session_id: sessionId, status: "waiting" }).catch(() => {});
          await postJson("/broadcast", {
            type: "session_queued",
            session_id: sessionId,
            held_by: conflicts[0].peer_id,
            reason: conflicts.map((c) => `${c.file}@${c.peer_id}`).join(","),
          }).catch(() => {});
        }
        if (Date.now() - startedAt > MAX_WAIT_MS) {
          await postJson("/status", { session_id: sessionId, status: "idle" }).catch(() => {});
          denyJson(
            conflictBanner(conflicts) +
              `\n\nSync waited ${Math.round((Date.now() - startedAt) / 1000)}s but the conflict did not clear. STOP this turn — tell the user the peer session(s) are still working and to retry later.`
          );
          safeExit(0);
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
        await postJson("/heartbeat", { session_id: sessionId }).catch(() => {});
        conflicts = await fetchConflicts(sessionId, repo, activeIntent);
      }
      if (bannerLogged) {
        const waitedMs = Date.now() - startedAt;
        logHookInfo(
          "pre-tool-use",
          `session=${sessionId} RESUMED after ${Math.round(waitedMs / 1000)}s wait`
        );
        await postJson("/status", { session_id: sessionId, status: niceStatus }).catch(() => {});
        await postJson("/broadcast", {
          type: "session_resumed",
          session_id: sessionId,
          waited_ms: waitedMs,
        }).catch(() => {});
      }
    }

    // Step 4: file-level lock for actual write tools — also wait-loop
    const filePath = input.tool_input?.file_path;
    if (LOCK_TOOLS.has(tool) && filePath) {
      const absPath = resolve(repo, filePath);
      const lockStartedAt = Date.now();
      let lockWaited = false;
      while (true) {
        const result = await postJson<{
          ok: boolean;
          held_by?: string;
          held_by_summary?: string | null;
        }>("/locks/acquire", { session_id: sessionId, path: absPath });
        if (result.status === 200) {
          if (lockWaited) {
            logHookInfo(
              "pre-tool-use",
              `session=${sessionId} acquired ${absPath} after ${Math.round((Date.now() - lockStartedAt) / 1000)}s wait`
            );
            await postJson("/status", { session_id: sessionId, status: "editing" }).catch(() => {});
          }
          break;
        }
        if (result.status === 409 && result.data) {
          if (!lockWaited) {
            lockWaited = true;
            logHookInfo(
              "pre-tool-use",
              `session=${sessionId} QUEUED on lock ${absPath} (held by ${result.data.held_by})`
            );
            await postJson("/status", { session_id: sessionId, status: "waiting" }).catch(() => {});
            await postJson("/broadcast", {
              type: "session_queued",
              session_id: sessionId,
              held_by: result.data.held_by!,
              reason: `lock:${absPath}`,
            }).catch(() => {});
          }
          if (Date.now() - lockStartedAt > MAX_WAIT_MS) {
            await postJson("/status", { session_id: sessionId, status: "idle" }).catch(() => {});
            denyJson(
              `[sync] FILE LOCK timeout — ${absPath} held by ${result.data.held_by}` +
                ` for ${Math.round((Date.now() - lockStartedAt) / 1000)}s. STOP this turn.`
            );
            safeExit(0);
          }
          await new Promise((r) => setTimeout(r, POLL_MS));
          await postJson("/heartbeat", { session_id: sessionId }).catch(() => {});
        } else {
          break;
        }
      }
    }
  } catch (err) {
    logHookError("pre-tool-use", err);
  }
  safeExit(0);
}

main();
