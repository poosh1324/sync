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
    return execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf8" }).trim();
  } catch {
    return "(no-git)";
  }
}

export function getRepoRoot(cwd: string): string {
  try {
    const { execSync } = require("node:child_process");
    return execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf8" }).trim();
  } catch {
    return cwd;
  }
}

export function safeExit(code = 0): never {
  process.exit(code);
}
