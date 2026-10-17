import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

export const CLAIM = "pi-final-model/claim";
// Retired: a lead-in mark can never render above the answer, because custom entries append at the tail.
export const CLAIM_END = "pi-final-model/claim-end";
export const PREPARED = "pi-final-model/prepared";
export const LEGACY_MARK = "pi-final-model/mark";
export interface Receipt {
  version: 3;
  requestId: string;
  sourceId: string;
  sessionId: string;
  model: string;
  responseModel?: string;
  responseId?: string;
  hash: string;
  usage?: unknown;
}
export const contentHash = (content: unknown) => createHash("sha256").update(JSON.stringify(content)).digest("hex");
export function isReceipt(value: unknown): value is Receipt {
  const r = value as Partial<Receipt> | null;
  return !!r && r.version === 3 && [r.requestId, r.sourceId, r.sessionId, r.model, r.hash].every(v => typeof v === "string" && v.length > 0);
}
// Use the active branch AND the persisted entries. SessionManager updates memory before writing disk.
const fileCache = new Map<string, { stamp: string; entries: Map<string, string> }>();
export function durableBranch(ctx: ExtensionContext): SessionEntry[] {
  const branch = ctx.sessionManager.getBranch();
  const file = ctx.sessionManager.getSessionFile();
  if (!file || !branch.some(entry => entry.type === "custom" && entry.customType === PREPARED)) return branch;
  const stat = statSync(file);
  const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  let cached = fileCache.get(file);
  if (cached?.stamp !== stamp) {
    const entries = new Map<string, string>();
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const entry = JSON.parse(line); if (entry.id) entries.set(entry.id, JSON.stringify(entry)); }
      catch { /* An incomplete trailing record is never proof of success. */ }
    }
    cached = { stamp, entries }; fileCache.set(file, cached);
    if (fileCache.size > 8) fileCache.delete(fileCache.keys().next().value!);
  }
  return branch.filter(entry => cached.entries.get(entry.id) === JSON.stringify(entry));
}
export function applied(receipt: Receipt, branch: SessionEntry[]): boolean {
  const source = branch.find(entry => entry.id === receipt.sourceId);
  if (source?.type !== "message" || source.message.role !== "assistant") return false;
  const prepared = branch.findIndex(entry => entry.type === "custom" && entry.customType === PREPARED && isReceipt(entry.data) && entry.data.requestId === receipt.requestId && entry.data.hash === receipt.hash);
  if (prepared < 0) return false;
  const edits = branch.filter(entry => entry.type === "context_edit" && entry.targetId === receipt.sourceId);
  const edit = edits.at(-1);
  return !!edit && branch.indexOf(edit) > prepared && edit.type === "context_edit" && edit.replacement !== null && contentHash(edit.replacement.content) === receipt.hash;
}
export function verified(receipt: Receipt, branch: SessionEntry[]): boolean {
  return applied(receipt, branch) && branch.some(entry => entry.type === "custom" && entry.customType === CLAIM && isReceipt(entry.data) && entry.data.requestId === receipt.requestId && entry.data.hash === receipt.hash);
}
export const textHash = (text: string) => contentHash([{ type: "text", text }]);
// Hashes of answers whose rewrite is durable. Memoised by session file stamp so transcript rendering stays cheap.
const hashCache = new Map<string, { stamp: string; hashes: Set<string> }>();
export function verifiedHashes(ctx: ExtensionContext): Set<string> {
  const branch = durableBranch(ctx);
  const file = ctx.sessionManager.getSessionFile() ?? "memory";
  let stamp = `${file}:${branch.length}`;
  try { const stat = statSync(file); stamp = `${file}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${branch.length}`; } catch { /* Keep the branch-only stamp. */ }
  const cached = hashCache.get(file);
  if (cached?.stamp === stamp) return cached.hashes;
  const hashes = new Set<string>();
  for (const entry of branch) if (entry.type === "custom" && entry.customType === CLAIM && isReceipt(entry.data) && verified(entry.data, branch)) hashes.add(entry.data.hash);
  hashCache.set(file, { stamp, hashes });
  if (hashCache.size > 8) hashCache.delete(hashCache.keys().next().value!);
  return hashes;
}
export function isLegacyMark(message: { role: string; customType?: string }): boolean {
  return message.role === "custom" && message.customType === LEGACY_MARK;
}
