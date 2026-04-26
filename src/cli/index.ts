#!/usr/bin/env bun
import { Command } from "commander";
import { join, resolve, dirname } from "node:path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import {
  DAEMON_BASE,
  daemonHealth,
  ensureDaemon,
  getJson,
  postJson,
  SYNC_HOME,
  SYNC_PORT,
} from "../hooks/util";
import type { Session, Lock, Export, Event } from "../daemon/types";
import { readSyncState, writeSyncState } from "../util/state";

const HOOKS_DIR = join(SYNC_HOME, "hooks");
const DAEMON_ENTRY = join(HOOKS_DIR, "daemon-entry.ts");

function findSourceRoot(): string {
  // Walk up from import.meta.dir looking for the dir that contains src/hooks.
  // Works for both `bun run src/cli/index.ts` (dir = .../src/cli/) and
  // bundled `dist/index.js` (dir = .../dist/).
  let dir = import.meta.dir;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "src", "hooks", "session-start.ts"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: assume two levels up (legacy)
  return resolve(import.meta.dir, "..", "..");
}

// Slash commands available in every claude session: /sync-me, /sync-status,
// /sync-peers. Installed user-globally so they work from any project once
// the user has run `syncc init` once.
const SYNC_COMMAND_FILES = ["sync-me.md", "sync-status.md", "sync-peers.md"];

function installSlashCommands(sourceRoot: string): { installed: number; skipped: number } {
  const userCommandsDir = join(homedir(), ".claude", "commands");
  mkdirSync(userCommandsDir, { recursive: true });
  const srcCommandsDir = join(sourceRoot, "src", "commands");
  let installed = 0;
  let skipped = 0;
  for (const f of SYNC_COMMAND_FILES) {
    const src = join(srcCommandsDir, f);
    const dst = join(userCommandsDir, f);
    if (!existsSync(src)) {
      skipped++;
      continue;
    }
    copyFileSync(src, dst);
    installed++;
  }
  return { installed, skipped };
}

function uninstallSlashCommands(): number {
  const userCommandsDir = join(homedir(), ".claude", "commands");
  let removed = 0;
  for (const f of SYNC_COMMAND_FILES) {
    const p = join(userCommandsDir, f);
    if (existsSync(p)) {
      try {
        require("node:fs").unlinkSync(p);
        removed++;
      } catch {
        /* ignore */
      }
    }
  }
  return removed;
}

function copyHookScripts(sourceRoot: string) {
  mkdirSync(HOOKS_DIR, { recursive: true });
  const srcHooksDir = join(sourceRoot, "src", "hooks");
  const srcDaemonDir = join(sourceRoot, "src", "daemon");
  const srcIntentDir = join(sourceRoot, "src", "intent");

  // Copy hook scripts
  for (const f of [
    "session-start.ts",
    "session-end.ts",
    "user-prompt-submit.ts",
    "pre-tool-use.ts",
    "post-tool-use.ts",
    "stop.ts",
    "util.ts",
  ]) {
    copyFileSync(join(srcHooksDir, f), join(HOOKS_DIR, f));
  }

  // Copy daemon files (so hooks can import them via relative path)
  const daemonOut = join(SYNC_HOME, "hooks", "..", "daemon");
  mkdirSync(daemonOut, { recursive: true });
  for (const f of readdirSync(srcDaemonDir)) {
    copyFileSync(join(srcDaemonDir, f), join(daemonOut, f));
  }

  // Copy intent files
  const intentOut = join(SYNC_HOME, "hooks", "..", "intent");
  mkdirSync(intentOut, { recursive: true });
  for (const f of readdirSync(srcIntentDir)) {
    copyFileSync(join(srcIntentDir, f), join(intentOut, f));
  }

  // Copy util files
  const srcUtilDir = join(sourceRoot, "src", "util");
  const utilOut = join(SYNC_HOME, "hooks", "..", "util");
  mkdirSync(utilOut, { recursive: true });
  for (const f of readdirSync(srcUtilDir)) {
    copyFileSync(join(srcUtilDir, f), join(utilOut, f));
  }

  // Daemon entry that imports the daemon server
  writeFileSync(
    DAEMON_ENTRY,
    `#!/usr/bin/env bun\nimport "../daemon/server";\n`,
    "utf8"
  );

  // node_modules: we need zod & bun:sqlite. bun:sqlite is built-in.
  // We rely on the user having installed sync's node_modules; for hackathon
  // MVP we copy package.json + node_modules from the source root.
  const linkTarget = join(SYNC_HOME, "node_modules");
  if (!existsSync(linkTarget)) {
    try {
      const { symlinkSync } = require("node:fs");
      symlinkSync(join(sourceRoot, "node_modules"), linkTarget, "dir");
    } catch {
      /* fallback: leave alone, bun will resolve via parent if symlink fails */
    }
  }
  const pkgTarget = join(SYNC_HOME, "package.json");
  if (!existsSync(pkgTarget)) {
    copyFileSync(join(sourceRoot, "package.json"), pkgTarget);
  }
}

type Settings = {
  hooks?: Record<string, any[]>;
  [k: string]: any;
};

const SYNC_HOOK_TAG = "sync-managed";

function makeHookEntry(scriptName: string, matcher?: string, timeoutSec?: number) {
  const command: any = {
    type: "command",
    command: `bun ${join(HOOKS_DIR, scriptName)}`,
    [SYNC_HOOK_TAG]: true,
  };
  if (timeoutSec) command.timeout = timeoutSec;
  const entry: any = { hooks: [command] };
  if (matcher) entry.matcher = matcher;
  return entry;
}

function mergeSettings(existing: Settings): Settings {
  const next: Settings = { ...existing };
  next.hooks = { ...(existing.hooks ?? {}) };

  // 4th tuple slot: per-hook timeout in seconds. PreToolUse needs a long
  // timeout because it now blocks waiting for peer conflicts to clear.
  const map: Array<[string, string, string | undefined, number | undefined]> = [
    ["SessionStart", "session-start.ts", undefined, undefined],
    ["SessionEnd", "session-end.ts", undefined, undefined],
    ["UserPromptSubmit", "user-prompt-submit.ts", undefined, undefined],
    ["PreToolUse", "pre-tool-use.ts", undefined, 600],
    ["PostToolUse", "post-tool-use.ts", "Edit|Write|MultiEdit", undefined],
    ["Stop", "stop.ts", undefined, undefined],
  ];

  for (const [event, script, matcher, timeoutSec] of map) {
    const existingArr: any[] = next.hooks![event] ?? [];
    const filtered = existingArr.filter(
      (e) => !e?.hooks?.some?.((h: any) => h?.[SYNC_HOOK_TAG] === true)
    );
    filtered.push(makeHookEntry(script, matcher, timeoutSec));
    next.hooks![event] = filtered;
  }
  return next;
}

function unmergeSettings(existing: Settings): Settings {
  const next: Settings = { ...existing };
  if (!next.hooks) return next;
  next.hooks = { ...next.hooks };
  for (const event of Object.keys(next.hooks)) {
    const arr: any[] = next.hooks[event] ?? [];
    const filtered = arr.filter(
      (e) => !e?.hooks?.some?.((h: any) => h?.[SYNC_HOOK_TAG] === true)
    );
    if (filtered.length === 0) delete next.hooks[event];
    else next.hooks[event] = filtered;
  }
  return next;
}

const SYNC_GITIGNORE_MARKER = "# Sync (Claude Code coordination layer)";
const SYNC_GITIGNORE_BLOCK = `\n${SYNC_GITIGNORE_MARKER}\n.claude/settings.json\n.claude/.sync-session-id\n`;

function updateGitignore(cwd: string): { added: boolean; created: boolean } {
  const p = join(cwd, ".gitignore");
  if (existsSync(p)) {
    const current = readFileSync(p, "utf8");
    if (current.includes(SYNC_GITIGNORE_MARKER)) {
      return { added: false, created: false };
    }
    appendFileSync(p, SYNC_GITIGNORE_BLOCK);
    return { added: true, created: false };
  }
  writeFileSync(p, SYNC_GITIGNORE_BLOCK.trimStart());
  return { added: true, created: true };
}

function cleanGitignore(cwd: string): boolean {
  const p = join(cwd, ".gitignore");
  if (!existsSync(p)) return false;
  const current = readFileSync(p, "utf8");
  const cleaned = current.replace(
    /\n?# Sync \(Claude Code coordination layer\)\n\.claude\/settings\.json\n\.claude\/\.sync-session-id\n?/,
    ""
  );
  if (cleaned !== current) {
    writeFileSync(p, cleaned);
    return true;
  }
  return false;
}

function settingsPath(scope: "project" | "user", projectDir: string): string {
  if (scope === "user") return join(homedir(), ".claude", "settings.json");
  return join(projectDir, ".claude", "settings.json");
}

function readSettings(p: string): Settings {
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function writeSettings(p: string, s: Settings) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(s, null, 2), "utf8");
}

const program = new Command();
program.name("syncc").description("Self-coordinating multi-session layer for Claude Code").version("0.1.0");

program
  .command("init")
  .description("Install Sync hooks into the current project (or user) settings")
  .option("-u, --user", "Install to ~/.claude/settings.json instead of project")
  .option("-p, --project <dir>", "Project directory", process.cwd())
  .action(async (opts: { user?: boolean; project: string }) => {
    const sourceRoot = findSourceRoot();
    copyHookScripts(sourceRoot);
    const scope = opts.user ? "user" : "project";
    const p = settingsPath(scope, opts.project);
    const existing = readSettings(p);
    const merged = mergeSettings(existing);
    writeSettings(p, merged);
    if (scope === "project") {
      const r = updateGitignore(opts.project);
      if (r.created) {
        console.log("✔ Created .gitignore with Sync entries (your hook config stays local)");
      } else if (r.added) {
        console.log("✔ Added Sync entries to .gitignore (private hook config won't be committed)");
      } else {
        console.log("ℹ .gitignore already covers Sync entries");
      }
    }
    const slash = installSlashCommands(sourceRoot);
    if (slash.installed > 0) {
      console.log(`✔ Installed ${slash.installed} Claude slash commands (/sync-me, /sync-status, /sync-peers)`);
    }
    await ensureDaemon();
    console.log(`[sync] hooks installed in ${p}`);
    console.log(`[sync] daemon listening on http://127.0.0.1:${SYNC_PORT}`);
    console.log(`[sync] run \`syncc mon\` in a separate terminal to watch the mesh`);
  });

program
  .command("uninstall")
  .description("Remove Sync hooks from settings")
  .option("-u, --user", "Uninstall from ~/.claude/settings.json")
  .option("-p, --project <dir>", "Project directory", process.cwd())
  .action((opts: { user?: boolean; project: string }) => {
    const scope = opts.user ? "user" : "project";
    const p = settingsPath(scope, opts.project);
    if (!existsSync(p)) {
      console.log(`[sync] no settings file at ${p}`);
      return;
    }
    const existing = readSettings(p);
    const cleaned = unmergeSettings(existing);
    writeSettings(p, cleaned);
    console.log(`[sync] hooks removed from ${p}`);
    if (scope === "project" && cleanGitignore(opts.project)) {
      console.log("✔ Removed Sync entries from .gitignore");
    }
    const removed = uninstallSlashCommands();
    if (removed > 0) {
      console.log(`✔ Removed ${removed} Sync slash commands from ~/.claude/commands/`);
    }
  });

program
  .command("status")
  .description("Print the current mesh state")
  .action(async () => {
    if (!(await daemonHealth())) {
      console.log("[sync] daemon not running");
      process.exit(1);
    }
    const state = await getJson<{
      sessions: Session[];
      locks: Lock[];
      recent_exports: Export[];
      events: Event[];
    }>("/state");
    if (!state) return console.log("[sync] failed to fetch state");
    console.log("Sessions:");
    for (const s of state.sessions) {
      console.log(
        `  ${s.id}  [${s.status}]  ${s.current_intent?.summary ?? "(no intent)"}  cwd=${s.cwd}  branch=${s.branch}`
      );
    }
    console.log("Locks:");
    for (const l of state.locks) console.log(`  ${l.session_id}  ${l.path}`);
    console.log("Recent exports:");
    for (const ex of state.recent_exports) console.log(`  ${ex.session_id}  ${ex.file}  [${ex.symbols.join(", ")}]`);
  });

program
  .command("stop")
  .description("Kill the local daemon")
  .action(async () => {
    if (!(await daemonHealth())) {
      console.log("[sync] daemon not running");
      return;
    }
    // best-effort: spawn a one-liner that kills processes listening on the port
    spawnSync("sh", [
      "-c",
      `lsof -t -iTCP:${SYNC_PORT} -sTCP:LISTEN | xargs kill 2>/dev/null || true`,
    ]);
    console.log("[sync] daemon stopped");
  });

program
  .command("lock <file>")
  .description("Demo helper: hold a lock on <file> for N seconds (default 30) so a peer session gets BLOCKED")
  .option("-s, --seconds <n>", "How long to hold the lock", "30")
  .option("-i, --id <id>", "Fake session id to attribute the lock to", "demo-hold")
  .option("--summary <text>", "Fake intent summary shown in the deny reason", "Holding for demo")
  .action(async (file: string, opts: { seconds: string; id: string; summary: string }) => {
    await ensureDaemon();
    const absPath = resolve(process.cwd(), file);
    const ttl = Math.max(1, parseInt(opts.seconds, 10)) * 1000;
    // register a fake session so peer sees a meaningful "held_by_summary"
    await postJson("/sessions", {
      id: opts.id,
      pid: process.pid,
      cwd: process.cwd(),
      branch: "demo",
    });
    await postJson("/intents", {
      session_id: opts.id,
      intent: { summary: opts.summary, will_modify: [absPath], will_create: [], depends_on: [] },
    });
    const r = await postJson<any>("/locks/acquire", { session_id: opts.id, path: absPath });
    if (r.status !== 200) {
      console.log(`[sync] could not acquire lock (status ${r.status}):`, r.data);
      process.exit(1);
    }
    console.log(`[sync] holding lock on ${absPath} for ${ttl / 1000}s as session "${opts.id}"`);
    console.log("[sync] start a peer claude session NOW and have it edit this file → BLOCKED event will fire");
    console.log(`[sync] press Ctrl+C to release early`);
    const release = async () => {
      await postJson("/locks/release", { session_id: opts.id, path: absPath });
      // also unregister the fake session so the demo mesh stays clean
      await fetch(`${DAEMON_BASE}/sessions/${encodeURIComponent(opts.id)}`, { method: "DELETE" }).catch(() => {});
      console.log(`\n[sync] lock released, fake session removed`);
    };
    process.on("SIGINT", async () => {
      await release();
      process.exit(0);
    });
    await new Promise((r) => setTimeout(r, ttl));
    await release();
  });

program
  .command("reset")
  .description("Wipe daemon state (kills daemon + deletes SQLite DB). Settings + .gitignore untouched.")
  .action(() => {
    spawnSync("sh", [
      "-c",
      `lsof -t -iTCP:${SYNC_PORT} -sTCP:LISTEN | xargs kill 2>/dev/null || true`,
    ]);
    const dbPath = join(SYNC_HOME, "sync.db");
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = dbPath + suffix;
      if (existsSync(p)) {
        try {
          require("node:fs").unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
    }
    console.log("[sync] daemon stopped & DB wiped. Run `syncc init` (or any syncc command) to restart.");
  });

program
  .command("pause")
  .description("Temporarily disable Sync (sessions still register? no — they skip)")
  .action(() => {
    writeSyncState({ enabled: false });
    console.log("[sync] paused — new claude sessions will skip Sync. Run `syncc resume` to re-enable.");
  });

program
  .command("resume")
  .description("Re-enable Sync after a pause")
  .action(() => {
    writeSyncState({ enabled: true });
    console.log("[sync] resumed — new claude sessions will join the mesh again.");
  });

program
  .command("mon")
  .description("Open the live mesh dashboard")
  .action(async () => {
    await ensureDaemon();
    const sourceRoot = findSourceRoot();
    const monitor = join(sourceRoot, "src", "tui", "monitor.tsx");
    spawn("bun", [monitor], { stdio: "inherit" });
  });

program.parseAsync(process.argv);
