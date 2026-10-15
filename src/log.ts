import { appendFileSync, mkdirSync, renameSync, statSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const logPath = () => join(getAgentDir(), "logs", "final-model.jsonl");

export function errorKind(error: unknown): string {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/timeout|timed out/i.test(text)) return "timeout";
  if (/abort|cancel/i.test(text)) return "cancelled";
  if (/401|unauthorized|invalid.*key|expired.*token/i.test(text)) return "authentication";
  if (/402|quota|credit|balance|billing/i.test(text)) return "quota";
  if (/403|forbidden|permission/i.test(text)) return "permission";
  if (/429|rate.?limit/i.test(text)) return "rate_limit";
  if (/context|too many tokens/i.test(text)) return "context_capacity";
  if (/404|model.*not found/i.test(text)) return "model_missing";
  if (/ECONN|ENOTFOUND|fetch failed|network|50[0234]/i.test(text)) return "network_or_server";
  return "provider_or_storage_error";
}

export function errorText(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(sk-[\w-]+|AIza[\w-]+)\b/g, "[redacted]")
    .replace(/((?:api[_-]?key|token|authorization|secret)\s*[=:]\s*["']?)[^\s"',;&}]+/gi, "$1[redacted]")
    .slice(0, 4096);
}

// Log metadata only: never prompts, response text, tool arguments, or credentials.
export function writeLog(event: string, data: Record<string, unknown>): void {
  try {
    const path = logPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const lock = `${path}.rotate-lock`;
    let acquired = false;
    try {
      try { mkdirSync(lock); acquired = true; } catch { /* Another process owns rotation; append remains available. */ }
      if (acquired && statSync(path).size >= 5 * 1024 * 1024) renameSync(path, `${path}.1`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    finally { if (acquired) rmSync(lock, { recursive: true, force: true }); }
    appendFileSync(path, `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...data })}\n`, { mode: 0o600 });
  } catch (error) {
    // Diagnostics must never prevent returning the original answer.
    process.stderr.write(`[pi-final-model] 无法写入诊断日志：${errorKind(error)}\n`);
  }
}
