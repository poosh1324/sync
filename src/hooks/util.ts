import { homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";

export const SYNC_HOME = join(homedir(), ".sync");
export const SYNC_PORT = Number(process.env.SYNC_PORT ?? 7777);
export const SYNC_HOST = process.env.SYNC_HOST ?? "127.0.0.1";
export const DAEMON_BASE = `http://${SYNC_HOST}:${SYNC_PORT}`;

export function sessionIdPath(cwd: string): string {
  return join(cwd, ".claude", ".sync-session-id");
}

export function readSessionId(cwd: string): string | null {
  const p = sessionIdPath(cwd);
  return existsSync(p) ? readFileSync(p, "utf8").trim() : null;
}

export function writeSessionId(cwd: string, id: string): void {
  const p = sessionIdPath(cwd);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, id, "utf8");
}

// Derive our short session id from claude's own session_id (UUID).
// Using claude's id directly fixes two bugs:
//   1) Two concurrent claude sessions in the same repo no longer collide on
//      .sync-session-id (they each pass a distinct UUID per hook invocation).
//   2) SessionStart firing multiple times (startup/resume/clear/compact)
//      always derives the same id, so we never duplicate-register.
export function shortIdFromInput(input: { session_id?: string } | null | undefined): string | null {
  const sid = input?.session_id;
  if (typeof sid !== "string" || sid.length === 0) return null;
  return sid.replace(/-/g, "").slice(0, 8);
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readStdinJson<T = any>(): Promise<T | null> {
  const raw = await readStdin();
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function daemonHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${DAEMON_BASE}/health`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ensureDaemon(): Promise<void> {
  if (await daemonHealth()) return;
  const daemonScript = join(SYNC_HOME, "hooks", "daemon-entry.ts");
  const logFile = join(SYNC_HOME, "daemon.log");
  if (!existsSync(daemonScript)) return;
  const logFd = require("node:fs").openSync(logFile, "a");
  const child = spawn("bun", [daemonScript], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, SYNC_PORT: String(SYNC_PORT) },
  });
  child.unref();
  for (let i = 0; i < 20; i++) {
    if (await daemonHealth()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function postJson<T = any>(path: string, body: unknown): Promise<{ status: number; data: T | null }> {
  try {
    const res = await fetch(`${DAEMON_BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
    let data: T | null = null;
    try {
      data = (await res.json()) as T;
    } catch {
      /* ignore */
    }
    return { status: res.status, data };
  } catch {
    return { status: 0, data: null };
  }
}

export async function getJson<T = any>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${DAEMON_BASE}${path}`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function getGitBranch(cwd: string): string {
  try {
    const { execSync } = require("node:child_process");
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "(no-git)";
  }
}

export function getRepoRoot(cwd: string): string {
  try {
    const { execSync } = require("node:child_process");
    return execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return cwd;
  }
}

export function safeExit(code = 0): never {
  process.exit(code);
}

import { appendFileSync } from "node:fs";
const HOOK_LOG = join(SYNC_HOME, "hook-errors.log");

export function logHookError(hook: string, err: unknown): void {
  try {
    const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    appendFileSync(HOOK_LOG, `[${new Date().toISOString()}] ${hook}: ${msg}\n`, "utf8");
  } catch {
    /* swallow */
  }
}

export function logHookInfo(hook: string, msg: string): void {
  try {
    appendFileSync(HOOK_LOG, `[${new Date().toISOString()}] ${hook} INFO: ${msg}\n`, "utf8");
  } catch {
    /* swallow */
  }
}

// Set the title bar of the terminal that's running this claude session by
// writing the OSC escape sequence directly to /dev/tty. iTerm/Terminal.app
// surface this in the window/tab title.
export function setTerminalTitle(title: string): void {
  try {
    const { writeFileSync: w } = require("node:fs");
    w("/dev/tty", `\x1b]0;${title}\x07`);
  } catch {
    /* /dev/tty not available — silently skip */
  }
}

// Print a multi-line message directly to the user's terminal pane.
//
// Claude Code's TUI keeps a divider line + input box anchored at the bottom
// of the screen. To stop our box overlapping those:
//   1) leading newlines separate our top border from any divider that's
//      currently on screen
//   2) trailing newlines push claude's TUI farther down so when it redraws
//      the divider lands well below our box
// Numbers tuned so the box settles cleanly into the scrollback above the
// prompt across iTerm / Terminal.app / typical setups.
export function printToPane(text: string, leadLines = 2, trailLines = 8): void {
  try {
    const { writeFileSync: w } = require("node:fs");
    const lead = "\n".repeat(leadLines);
    const trail = "\n".repeat(trailLines);
    const body = text.endsWith("\n") ? text : text + "\n";
    w("/dev/tty", lead + body + trail);
  } catch {
    /* /dev/tty not available */
  }
}
