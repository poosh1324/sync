import { IntentSchema, type Intent } from "../daemon/types";

const TAG_RE = /<sync-intent>([\s\S]*?)<\/sync-intent>/i;

export function parseIntentFromText(text: string): Intent | null {
  if (!text) return null;
  const m = TAG_RE.exec(text);
  if (!m) return null;
  const raw = m[1].trim();
  try {
    const obj = JSON.parse(raw);
    const parsed = IntentSchema.safeParse(obj);
    if (!parsed.success) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

const EXPORT_RE = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:class|function|const|let|var|type|interface|enum)\s+(\w+)/gm;

export function detectExports(source: string): string[] {
  if (!source) return [];
  const symbols = new Set<string>();
  let m: RegExpExecArray | null;
  EXPORT_RE.lastIndex = 0;
  while ((m = EXPORT_RE.exec(source)) !== null) {
    symbols.add(m[1]);
  }
  // export { A, B as C }
  const reExport = /export\s*\{([^}]+)\}/g;
  while ((m = reExport.exec(source)) !== null) {
    const parts = m[1].split(",");
    for (const p of parts) {
      const name = p.trim().split(/\s+as\s+/i).pop();
      if (name && /^\w+$/.test(name)) symbols.add(name);
    }
  }
  return [...symbols];
}
