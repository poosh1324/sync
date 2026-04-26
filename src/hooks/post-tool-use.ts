#!/usr/bin/env bun
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  ensureDaemon,
  getRepoRoot,
  postJson,
  readSessionId,
  readStdinJson,
  safeExit,
} from "./util";
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
    const sessionId = readSessionId(repo);
    const filePath = input.tool_input?.file_path;
    if (!sessionId) safeExit(0);

    await ensureDaemon();

    if (filePath) {
      const absPath = resolve(repo, filePath);
      await postJson("/locks/release", { session_id: sessionId, path: absPath });

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
        await postJson("/intents", { session_id: sessionId, intent });
      }
    }

    await postJson("/heartbeat", { session_id: sessionId });
  } catch {
    /* never break the user's claude session */
  }
  safeExit(0);
}

main();
