#!/usr/bin/env bun
import { Command } from "commander";
import { join, resolve, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import {
  daemonHealth,
  ensureDaemon,
  getJson,
  postJson,
  SYNC_HOME,
  SYNC_PORT,
} from "../hooks/util";
import type { Session, Lock, Export, Event } from "../daemon/types";

const HOOKS_DIR = join(SYNC_HOME, "hooks");
const DAEMON_ENTRY = join(HOOKS_DIR, "daemon-entry.ts");

function findSourceRoot(): string {
  // Resolve directory containing src/hooks/*.ts so we can copy hook scripts
  // When run via `bun run src/cli/index.ts`, __dirname-equivalent is import.meta.dir
  return resolve(import.meta.dir, "..", "..");
}

function copyHookScripts(sourceRoot: string) {
  mkdirSync(HOOKS_DIR, { recursive: true });
  const srcHooksDir = join(sourceRoot, "src", "hooks");
  const srcDaemonDir = join(sourceRoot, "src", "daemon");
  const srcIntentDir = join(sourceRoot, "src", "intent");

  // Copy hook scripts
  for (const f of ["session-start.ts", "user-prompt-submit.ts", "pre-tool-use.ts", "post-tool-use.ts", "util.ts"]) {
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

function makeHookEntry(scriptName: string, matcher?: string) {
  const entry: any = {
    hooks: [
      {
        type: "command",
        command: `bun ${join(HOOKS_DIR, scriptName)}`,
        [SYNC_HOOK_TAG]: true,
      },
    ],
  };
  if (matcher) entry.matcher = matcher;
  return entry;
}

function mergeSettings(existing: Settings): Settings {
  const next: Settings = { ...existing };
  next.hooks = { ...(existing.hooks ?? {}) };

  const map: Array<[string, string, string | undefined]> = [
    ["SessionStart", "session-start.ts", undefined],
    ["UserPromptSubmit", "user-prompt-submit.ts", undefined],
    ["PreToolUse", "pre-tool-use.ts", "Edit|Write|MultiEdit"],
    ["PostToolUse", "post-tool-use.ts", "Edit|Write|MultiEdit"],
  ];

  for (const [event, script, matcher] of map) {
    const existingArr: any[] = next.hooks![event] ?? [];
    // Drop any prior sync-managed entries
    const filtered = existingArr.filter(
      (e) => !e?.hooks?.some?.((h: any) => h?.[SYNC_HOOK_TAG] === true)
    );
    filtered.push(makeHookEntry(script, matcher));
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
program.name("sync").description("Self-coordinating multi-session layer for Claude Code").version("0.1.0");

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
    await ensureDaemon();
    console.log(`[sync] hooks installed in ${p}`);
    console.log(`[sync] daemon listening on http://127.0.0.1:${SYNC_PORT}`);
    console.log(`[sync] run \`sync mon\` in a separate terminal to watch the mesh`);
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
  .command("mon")
  .description("Open the live mesh dashboard")
  .action(async () => {
    await ensureDaemon();
    const sourceRoot = findSourceRoot();
    const monitor = join(sourceRoot, "src", "tui", "monitor.tsx");
    spawn("bun", [monitor], { stdio: "inherit" });
  });

program.parseAsync(process.argv);
