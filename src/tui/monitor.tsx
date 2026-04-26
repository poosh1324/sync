#!/usr/bin/env bun
import React, { useEffect, useState } from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import type { Session, Lock, Export, Event } from "../daemon/types";
import { basename } from "node:path";

const PORT = Number(process.env.SYNC_PORT ?? 7777);
const BASE = `http://127.0.0.1:${PORT}`;
const POLL_MS = 500;

type State = {
  sessions: Session[];
  locks: Lock[];
  recent_exports: Export[];
  events: Event[];
};

async function fetchState(): Promise<State | null> {
  try {
    const res = await fetch(`${BASE}/state/full`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return null;
    return (await res.json()) as State;
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
      return "⏳";
    default:
      return "·";
  }
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function eventLabel(e: Event): string {
  switch (e.type) {
    case "session_joined":
      return `${e.session.id} joined (${e.session.branch})`;
    case "session_left":
      return `${e.session_id} left`;
    case "intent_announced":
      return `${e.session_id} announced: ${e.intent.summary || "(empty)"}`;
    case "lock_acquired":
      return `${e.lock.session_id} acquired ${basename(e.lock.path)}`;
    case "lock_released":
      return `${e.session_id} released ${basename(e.path)}`;
    case "lock_denied":
      return `${e.requester} BLOCKED on ${basename(e.path)} (held by ${e.held_by})`;
    case "export_created":
      return `${e.session_id} exported [${e.symbols.join(", ")}] from ${basename(e.file)}`;
  }
}

function eventColor(e: Event): string {
  switch (e.type) {
    case "lock_denied":
      return "red";
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
          [{session.id}]
        </Text>
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

function App() {
  const { exit } = useApp();
  const [state, setState] = useState<State | null>(null);
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
    const loop = async () => {
      const s = await fetchState();
      if (!mounted) return;
      if (s) {
        setState(s);
        setError(null);
      } else {
        setError(`daemon not responding at ${BASE}`);
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

  if (!state) {
    return (
      <Box>
        <Text color="cyan">
          <Spinner type="dots" />
        </Text>
        <Text> connecting to sync daemon at {BASE}…</Text>
        {error ? <Text color="red"> {error}</Text> : null}
      </Box>
    );
  }

  const branchSet = [...new Set(state.sessions.map((s) => s.branch))];
  const cwdSet = [...new Set(state.sessions.map((s) => s.cwd))];

  return (
    <Box flexDirection="column">
      <Box borderStyle="double" borderColor="cyan" paddingX={1} flexDirection="column">
        <Box>
          <Text bold color="cyan">Sync Mesh </Text>
          <Text>· {state.sessions.length} sessions active</Text>
          <Text color="gray">  ·  branch{branchSet.length > 1 ? "es" : ""}: {branchSet.join(", ") || "—"}</Text>
          <Text color="gray">  ·  {cwdSet.length} repo{cwdSet.length === 1 ? "" : "s"}</Text>
          <Text color="gray">  ·  q to quit</Text>
        </Box>
      </Box>

      {state.sessions.length === 0 ? (
        <Box paddingX={1} marginTop={1}>
          <Text color="gray">No sessions registered yet. Start `claude` in a project where you've run `sync init`.</Text>
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
          state.events.slice(-12).map((e, i) => (
            <Box key={`${e.ts}-${i}-${e.type}`}>
              <Text color="gray">{fmtTime(e.ts)}  </Text>
              <Text color={eventColor(e)}>{eventLabel(e)}</Text>
            </Box>
          ))
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
