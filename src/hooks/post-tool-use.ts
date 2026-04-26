#!/usr/bin/env bun
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  ensureDaemon,
  getJson,
  getRepoRoot,
  postJson,
  readStdinJson,
  safeExit,
  setTerminalTitle,
  shortIdFromInput,
  logHookError,
  logHookInfo,
} from "./util";
import { basename } from "node:path";
import { parseIntentFromText, detectExports } from "../intent/parse";

type PostToolInput = {
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; [k: string]: any };
  tool_response?: any;
  transcript_path?: string;
};

function readTranscriptTail(transcriptPath: string | undefined): string {
  if (!transcriptPath || !existsSync(transcriptPath)) return "";
  try {
    const raw = readFileSync(transcriptPath, "utf8");
    const lines = raw.trim().split("\n").slice(-40);
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
        /* skip malformed line */
      }
    }
    return texts.join("\n");
  } catch {
    return "";
  }
}

async function main() {
  try {
    const input = (await readStdinJson<PostToolInput>()) ?? {};
    const cwd = input.cwd ?? process.cwd();
    const repo = getRepoRoot(cwd);
    const sessionId = shortIdFromInput(input as any);
    const filePath = input.tool_input?.file_path;
    logHookInfo(
      "post-tool-use",
      `session=${sessionId} tool=${input.tool_name} file=${filePath} hasTranscript=${Boolean(input.transcript_path)}`
    );
    if (!sessionId) safeExit(0);

    await ensureDaemon();

    if (filePath) {
      const absPath = resolve(repo, filePath);
      const releaseRes = await postJson("/locks/release", { session_id: sessionId, path: absPath });
      logHookInfo("post-tool-use", `release ${absPath} → ${releaseRes.status}`);
      // Mark this file as done in our active intent so any peer waiting
      // on it can dequeue. Idempotent — calling repeatedly is harmless.
      await postJson("/intents/remove-file", { session_id: sessionId, file: absPath }).catch(() => {});

      if (existsSync(absPath)) {
        try {
          const source = readFileSync(absPath, "utf8");
          const symbols = detectExports(source);
          if (symbols.length > 0) {
            await postJson("/broadcast", {
              type: "export_created",
              session_id: sessionId,
              file: absPath,
              symbols,
            });
          }
        } catch {
          /* ignore read failure */
        }
      }
    }

    const transcript = readTranscriptTail(input.transcript_path);
    if (transcript) {
      const intent = parseIntentFromText(transcript);
      if (intent) {
        // Normalize will_modify to absolute paths — PreToolUse does this on
        // first registration, but if we re-post raw transcript paths we'd
        // overwrite the daemon's absolute paths with relative ones, which
        // breaks conflict detection (peers compare absolute paths) and
        // remove-file (path mismatch leaves files stuck in will_modify).
        intent.will_modify = intent.will_modify.map((p) =>
          p && !p.startsWith("/") ? resolve(repo, p) : p
        );
        await postJson("/intents", { session_id: sessionId, intent });
      }
    }

    await postJson("/heartbeat", { session_id: sessionId });
    // After completing the tool, mark idle so peers see we're not actively
    // editing right now (between tool calls). PreToolUse will flip it back.
    await postJson("/status", { session_id: sessionId, status: "idle" }).catch(() => {});
    // (We don't touch the terminal title here — Claude Code immediately
    // overwrites it with its own task description and we lose. Only the Stop
    // hook restores "sync <label> · idle" once the whole turn is done.)
  } catch (err) {
    logHookError("post-tool-use", err);
  }
  safeExit(0);
}

main();
