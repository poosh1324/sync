import { z } from "zod";

export const IntentSchema = z.object({
  summary: z.string().default(""),
  will_modify: z.array(z.string()).default([]),
  will_create: z.array(z.string()).default([]),
  depends_on: z.array(z.string()).default([]),
});
export type Intent = z.infer<typeof IntentSchema>;

export type SessionStatus = "idle" | "thinking" | "editing" | "waiting";

export type Session = {
  id: string;
  pid: number | null;
  cwd: string;
  branch: string;
  started_at: number;
  last_heartbeat: number;
  current_intent: Intent | null;
  status: SessionStatus;
};

export type Lock = {
  path: string;
  session_id: string;
  acquired_at: number;
  ttl_ms: number;
};

export type Export = {
  session_id: string;
  file: string;
  symbols: string[];
  created_at: number;
};

export type Event =
  | { ts: number; type: "session_joined"; session: Session }
  | { ts: number; type: "session_left"; session_id: string }
  | { ts: number; type: "intent_announced"; session_id: string; intent: Intent }
  | { ts: number; type: "lock_acquired"; lock: Lock }
  | { ts: number; type: "lock_released"; path: string; session_id: string }
  | { ts: number; type: "lock_denied"; path: string; held_by: string; requester: string }
  | { ts: number; type: "export_created"; session_id: string; file: string; symbols: string[] };

export type StateSnapshot = {
  sessions: Session[];
  locks: Lock[];
  recent_exports: Export[];
  events: Event[];
};
