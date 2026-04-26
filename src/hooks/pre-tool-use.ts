#!/usr/bin/env bun
import { resolve } from "node:path";
import {
  ensureDaemon,
  getRepoRoot,
  postJson,
  readSessionId,
  readStdinJson,
  safeExit,
} from "./util";

type PreToolInput = {
  cwd?: string;
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    [k: string]: any;
  };
};

async function main() {
  try {
    const input = (await readStdinJson<PreToolInput>()) ?? {};
    const cwd = input.cwd ?? process.cwd();
    const repo = getRepoRoot(cwd);
    const sessionId = readSessionId(repo);
    const filePath = input.tool_input?.file_path;
    if (!sessionId || !filePath) safeExit(0);

    const absPath = resolve(repo, filePath!);

    await ensureDaemon();
    const result = await postJson<{
      ok: boolean;
      held_by?: string;
      held_by_summary?: string | null;
    }>("/locks/acquire", { session_id: sessionId, path: absPath });

    if (result.status === 200) safeExit(0);
    if (result.status === 409 && result.data) {
      const reason = `[sync] File ${absPath} is currently being edited by session ${result.data.held_by}` +
        (result.data.held_by_summary ? ` ("${result.data.held_by_summary}")` : "") +
        ". Try a different file, or wait and retry. Consider using their planned exports if relevant.";
      const out = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      };
      process.stdout.write(JSON.stringify(out));
      safeExit(0);
    }
  } catch {
    /* never break the user's claude session */
  }
  safeExit(0);
}

main();
