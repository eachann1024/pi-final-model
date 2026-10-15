import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const logPath = () => join(getAgentDir(), "logs", "final-model.jsonl");

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
    try { if (statSync(path).size >= 5 * 1024 * 1024) renameSync(path, `${path}.1`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    appendFileSync(path, `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...data })}\n`, { mode: 0o600 });
  } catch (error) {
    // Diagnostics must never prevent returning the original answer.
    process.stderr.write(`[pi-final-model] 无法写入诊断日志：${errorText(error)}\n`);
  }
}
