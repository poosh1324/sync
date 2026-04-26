#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import {
  ensureDaemon,
  getGitBranch,
  getRepoRoot,
  postJson,
  readStdinJson,
  safeExit,
  writeSessionId,
} from "./util";

async function main() {
  try {
    const input = (await readStdinJson<any>()) ?? {};
    const cwd = input.cwd ?? process.cwd();
    const repo = getRepoRoot(cwd);
    const branch = getGitBranch(repo);
    const id = randomUUID().slice(0, 8);

    await ensureDaemon();
    await postJson("/sessions", {
      id,
      pid: process.ppid,
      cwd: repo,
      branch,
    });
    writeSessionId(repo, id);
  } catch {
    /* never break the user's claude session */
  }
  safeExit(0);
}

main();
