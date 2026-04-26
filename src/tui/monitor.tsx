#!/usr/bin/env bun
import React, { useEffect, useState } from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import type { Session, Lock, Export, Event } from "../daemon/types";
import { basename } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { abbreviatePath, formatUptime } from "../util/path";
import { readSyncState } from "../util/state";

function setTerminalTitle(title: string): void {
  try {
    writeFileSync("/dev/tty", `\x1b]0;${title}\x07`);
  } catch {
    /* /dev/tty not available */
  }
}

const PORT = Number(process.env.SYNC_PORT ?? 7777);
const BASE = `http://127.0.0.1:${PORT}`;
const POLL_MS = 500;
const CWD = process.cwd();

function repoRoot(cwd: string): string {
  try {
    return execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return cwd;
  }
}

function gitBranch(cwd: string): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "?";
  }
}

const REPO_ROOT = repoRoot(CWD);
const SYNC_INITIALIZED = existsSync(join(REPO_ROOT, ".claude", "settings.json"));

type State = {
  sessions: Session[];
  locks: Lock[];
  recent_exports: Export[];
  events: Event[];
};

type Health = {
  status?: string;
  ok?: boolean;
  ts?: number;
  started_at?: number;
  version?: string;
};

async function fetchState(): Promise<State | null> {
  try {
    const res = await fetch(`${BASE}/state/full?cwd=${encodeURIComponent(REPO_ROOT)}`, {
      signal: AbortSignal.timeout(800),
    });
    if (!res.ok) return null;
    return (await res.json()) as State;
  } catch {
    return null;
  }
}

async function fetchHealth(): Promise<Health | null> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) });
    if (!res.ok) return null;
    return (await res.json()) as Health;
  } catch {
    return null;
  }
}

function statusColor(s: Session["status"]): string {
  switch (s) {
    case "editing":
      return "green";
    case "thinking":
      return "cyan";
    case "waiting":
      return "yellow";
    default:
      return "gray";
  }
}

function statusGlyph(s: Session["status"]): string {
  switch (s) {
    case "editing":
      return "✏️";
    case "thinking":
      return "🧠";
    case "waiting":
      return "⏳ queued";
    default:
      return "·";
  }
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function eventLabel(e: Event, idToLabel: Map<string, string>): string {
  const lbl = (id: string) => idToLabel.get(id) ?? id.slice(0, 6);
  switch (e.type) {
    case "session_joined":
      return `${lbl(e.session.id)} joined (${e.session.branch})`;
    case "session_left":
      return `${lbl(e.session_id)} left`;
    case "intent_announced":
      return `${lbl(e.session_id)} announced: ${e.intent.summary || "(empty)"}`;
    case "lock_acquired":
      return `${lbl(e.lock.session_id)} acquired ${basename(e.lock.path)}`;
    case "lock_released":
      return `${lbl(e.session_id)} released ${basename(e.path)}`;
    case "lock_denied":
      return `${lbl(e.requester)} BLOCKED on ${basename(e.path)} (held by ${lbl(e.held_by)})`;
    case "export_created":
      return `${lbl(e.session_id)} exported [${e.symbols.join(", ")}] from ${basename(e.file)}`;
    case "session_queued":
      return `${lbl(e.session_id)} ⏳ QUEUED — waiting on ${lbl(e.held_by)}`;
    case "session_resumed":
      return `${lbl(e.session_id)} ▶ RESUMED after ${(e.waited_ms / 1000).toFixed(1)}s wait`;
  }
}

function eventColor(e: Event): string {
  switch (e.type) {
    case "lock_denied":
      return "red";
    case "session_queued":
      return "yellow";
    case "session_resumed":
      return "greenBright";
    case "lock_acquired":
      return "green";
    case "export_created":
      return "magenta";
    case "intent_announced":
      return "cyan";
    case "session_joined":
      return "blueBright";
    case "session_left":
      return "gray";
    case "lock_released":
      return "gray";
  }
}

function SessionCard({ session, locks }: { session: Session; locks: Lock[] }) {
  const intent = session.current_intent;
  const heldByMe = locks.filter((l) => l.session_id === session.id);
  const display = session.label ?? session.id.slice(0, 6);
  return (
    <Box
      borderStyle="round"
      borderColor={statusColor(session.status)}
      flexDirection="column"
      paddingX={1}
      marginBottom={0}
    >
      <Box>
        <Text bold color={statusColor(session.status)}>
          [{display}]
        </Text>
        <Text color="gray"> ({session.id.slice(0, 6)})</Text>
        <Text> </Text>
        <Text>{intent?.summary || "(no intent yet)"}</Text>
        <Text> </Text>
        <Text color={statusColor(session.status)}>
          {statusGlyph(session.status)} {session.status}
        </Text>
      </Box>
      {intent && intent.will_create.length > 0 && (
        <Text color="magenta">  Will create: {intent.will_create.join(", ")}</Text>
      )}
      {intent && intent.depends_on.length > 0 && (
        <Text color="yellow">  Depends on: {intent.depends_on.join(", ")}</Text>
      )}
      {intent && intent.will_modify.length > 0 && (
        <Text color="gray">  Will modify: {intent.will_modify.map((p) => basename(p)).join(", ")}</Text>
      )}
      {heldByMe.length > 0 && (
        <Text color="green">  Holding: {heldByMe.map((l) => basename(l.path)).join(", ")}</Text>
      )}
    </Box>
  );
}

function Header({
  state,
  health,
  syncEnabled,
}: {
  state: State | null;
  health: Health | null;
  syncEnabled: boolean;
}) {
  if (!SYNC_INITIALIZED) {
    return (
      <Box borderStyle="double" borderColor="red" paddingX={1} flexDirection="column">
        <Text color="red" bold>🔴 Not initialized in this directory</Text>
        <Text color="gray">Run `syncc init` to enable Sync for this project</Text>
      </Box>
    );
  }
  const branch = gitBranch(REPO_ROOT);
  const sessionCount = state?.sessions?.length ?? 0;
  const queuedCount = state?.sessions?.filter((s) => s.status === "waiting").length ?? 0;
  const word = sessionCount === 1 ? "session" : "sessions";
  const statusGlyph = syncEnabled ? "🟢 enabled" : "🟡 paused";
  const statusColor = syncEnabled ? "green" : "yellow";
  const uptime = health?.started_at ? formatUptime(Date.now() - health.started_at) : "—";
  return (
    <Box borderStyle="double" borderColor="cyan" paddingX={1} flexDirection="column">
      <Box>
        <Text>📂 </Text>
        <Text bold color="cyan">{abbreviatePath(REPO_ROOT)}</Text>
        <Text color="gray">  ·  branch: </Text>
        <Text>{branch}</Text>
        <Text color="gray">  ·  </Text>
        <Text>{sessionCount} {word}</Text>
        {queuedCount > 0 ? (
          <>
            <Text color="gray">  ·  </Text>
            <Text color="yellow">⏳ {queuedCount} queued</Text>
          </>
        ) : null}
      </Box>
      <Box>
        <Text color={statusColor}>{statusGlyph}</Text>
        <Text color="gray">  ·  daemon: 127.0.0.1:{PORT}</Text>
        <Text color="gray">  ·  uptime: </Text>
        <Text>{uptime}</Text>
        <Text color="gray">  ·  q to quit</Text>
      </Box>
    </Box>
  );
}

function App() {
  const { exit } = useApp();
  const [state, setState] = useState<State | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [syncEnabled, setSyncEnabled] = useState<boolean>(true);
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);

  if (process.stdin.isTTY) {
    useInput((input, key) => {
      if (input === "q" || key.escape || (key.ctrl && input === "c")) exit();
    });
  }

  useEffect(() => {
    let mounted = true;
    let timer: NodeJS.Timeout;
    setTerminalTitle(`sync mon · ${basename(REPO_ROOT)}`);
    const loop = async () => {
      const [s, h] = await Promise.all([fetchState(), fetchHealth()]);
      if (!mounted) return;
      if (s) {
        setState(s);
        setError(null);
        const labels = s.sessions.map((x) => x.label ?? x.id.slice(0, 4)).join(",");
        const queued = s.sessions.filter((x) => x.status === "waiting").length;
        const queuedTag = queued > 0 ? ` · ⏳${queued}` : "";
        const peerTag = labels ? ` [${labels}]` : "";
        setTerminalTitle(`sync mon · ${basename(REPO_ROOT)}${peerTag}${queuedTag}`);
      } else if (SYNC_INITIALIZED) {
        setError(`daemon not responding at ${BASE}`);
      }
      setHealth(h);
      try {
        setSyncEnabled(readSyncState().enabled);
      } catch {
        /* ignore */
      }
      setTick((t) => t + 1);
      timer = setTimeout(loop, POLL_MS);
    };
    loop();
    return () => {
      mounted = false;
      if (timer!) clearTimeout(timer);
    };
  }, []);

  if (!SYNC_INITIALIZED) {
    return (
      <Box flexDirection="column">
        <Header state={null} health={null} syncEnabled={syncEnabled} />
      </Box>
    );
  }

  if (!state) {
    return (
      <Box flexDirection="column">
        <Header state={null} health={health} syncEnabled={syncEnabled} />
        <Box marginTop={1}>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text> connecting to sync daemon at {BASE}…</Text>
          {error ? <Text color="red"> {error}</Text> : null}
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header state={state} health={health} syncEnabled={syncEnabled} />

      {state.sessions.length === 0 ? (
        <Box paddingX={1} marginTop={1}>
          <Text color="gray">No sessions registered yet. Start `claude` in this repo to join the mesh.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {state.sessions.map((s) => (
            <SessionCard key={s.id} session={s} locks={state.locks} />
          ))}
        </Box>
      )}

      <Box borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1} marginTop={1}>
        <Text bold>Event log</Text>
        {state.events.length === 0 ? (
          <Text color="gray">  (waiting for activity…)</Text>
        ) : (
          (() => {
            const idToLabel = new Map<string, string>(
              state.sessions.map((s) => [s.id, s.label ?? s.id.slice(0, 6)])
            );
            return state.events.slice(-12).map((e, i) => (
              <Box key={`${e.ts}-${i}-${e.type}`}>
                <Text color="gray">{fmtTime(e.ts)}  </Text>
                <Text color={eventColor(e)}>{eventLabel(e, idToLabel)}</Text>
              </Box>
            ));
          })()
        )}
      </Box>

      {error ? (
        <Box marginTop={1}>
          <Text color="red">! {error}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

render(<App />);
