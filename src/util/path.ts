import { homedir } from "node:os";

export function abbreviatePath(absolutePath: string): string {
  const home = homedir();
  let p = absolutePath.startsWith(home) ? "~" + absolutePath.slice(home.length) : absolutePath;
  if (p.length <= 50) return p;
  const parts = p.split("/");
  if (parts.length > 3) {
    return "…/" + parts.slice(-3).join("/");
  }
  return p;
}

export function formatUptime(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}
