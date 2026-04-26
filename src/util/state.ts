import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const SYNC_HOME = join(homedir(), ".sync");
export const SYNC_STATE_PATH = join(SYNC_HOME, "state.json");

export type SyncState = {
  enabled: boolean;
};

const DEFAULT_STATE: SyncState = { enabled: true };

export function readSyncState(): SyncState {
  if (!existsSync(SYNC_STATE_PATH)) return DEFAULT_STATE;
  try {
    const obj = JSON.parse(readFileSync(SYNC_STATE_PATH, "utf8"));
    return { enabled: Boolean(obj.enabled ?? true) };
  } catch {
    return DEFAULT_STATE;
  }
}

export function writeSyncState(s: SyncState): void {
  mkdirSync(dirname(SYNC_STATE_PATH), { recursive: true });
  writeFileSync(SYNC_STATE_PATH, JSON.stringify(s, null, 2), "utf8");
}
