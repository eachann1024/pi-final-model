import { randomUUID } from "node:crypto";
import { errorText, logPath, writeLog } from "./log.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelName, readConfig, sameModel, type Config, type ModelRef } from "./config.ts";
import { createSettings } from "./settings.ts";

type Thinking = ReturnType<ExtensionAPI["getThinkingLevel"]>;
interface Recovery {
  version: 2;
  sourceId: string;
}
const STATE = "pi-final-model/recovery";
const CLAIM = "pi-final-model/claim";
const TOOLS = "pi-final-model/restored-tools";
const STATUS = "pi-final-model";
const FINAL_INSTRUCTION = "请根据上面的用户需求、实际执行过程和工具结果，直接输出给用户的最终答复。遵循用户要求的语言、长度和格式；区分已完成、未验证和受阻事项，不虚构验证、提交或发布结果。若仍需用户决定或提供信息，保留必要问题。不要继续执行任务、调用工具、提及内部换模型过程，也不要声称整个任务一定已完成。不要在答复开头添加 AI、🤖 或任何模型标记。";
const AI_MARK = "\u200B🤖";

function markFinalAnswer<T extends { type: string; text?: string }>(content: T[]): T[] {
  const first = content.findIndex(part => part.type === "text" && part.text?.trim());
  if (first < 0) return content;
  return content.map((part, index) => {
    if (part.type !== "text" || part.text == null) return part;
    const text = part.text.replace(/(^|\n)[ \t]*(?:\u200B)?(?:🤖|AI)[ \t]*(?=\n|$)/g, "$1").replace(/^\s+/, "");
    return index === first ? { ...part, text: `${AI_MARK}\n${text}` } : { ...part, text };
  });
}

function isRecovery(value: unknown): value is Recovery {
  return !!value && typeof value === "object" && (value as Partial<Recovery>).version === 2 && typeof (value as Partial<Recovery>).sourceId === "string";
}

export default function finalModel(pi: ExtensionAPI) {
  // Child agents own their model and final output contract.
  if (process.env.PI_SUBAGENT_CHILD === "1") return;
  let config: Config = { enabled: false };
  let active: Recovery | undefined;
  let armed = false;
  let rewriting = false;
  let restoring: Promise<boolean> | undefined;
  let lastError: string | undefined;
  let outcome: "completed" | "aborted" | "error" | undefined;
  const claimed = new Set<string>();

  const settings = createSettings(pi, {
    config: () => config,
    apply: (next, ctx, clearError) => { config = next; if (clearError) lastError = undefined; status(ctx); },
    error: () => lastError,
    needsRecovery: () => !!active,
    recover: async ctx => {
      const restored = await restore(ctx);
      if (restored) lastError = undefined;
      return restored;
    },
  });

  function status(ctx: ExtensionContext) {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS, active ? `最终输出 · ${modelName(config.model!)}` :
      config.enabled && config.model ? `最终模型 · ${modelName(config.model)}` : undefined);
  }
  function report(ctx: ExtensionContext, message: string) {
    lastError = message;
    writeLog("warning", { sessionId: ctx.sessionManager.getSessionId(), message: errorText(message) });
    if (ctx.hasUI) ctx.ui.notify(`最终模型：${message}`, "warning");
    else process.stderr.write(`[pi-final-model] ${message}\n`);
  }
  function loadConfig(ctx: ExtensionContext) {
    try {
      config = readConfig();
    } catch (error) {
      config = { enabled: false };
      report(ctx, `配置无效，已停用：${String(error)}`);
    }
    status(ctx);
  }
  function saveRecovery(state: Recovery | null) {
    pi.appendEntry(STATE, state && { version: 2, sourceId: state.sourceId });
  }

  async function restore(ctx: ExtensionContext): Promise<boolean> {
    if (restoring) return restoring;
    const state = active;
    if (!state) return true;
    restoring = (async () => {
      try {
        // A manual model change takes precedence over the saved selection.
        saveRecovery(null);
        active = undefined;
        return true;
      } catch (error) {
        report(ctx, `恢复最终整理状态失败：${String(error)}`);
        return false;
      } finally {
        status(ctx);
      }
    })();
    try { return await restoring; }
    finally { restoring = undefined; }
  }

  async function recoverBranch(ctx: ExtensionContext) {
    active = undefined;
    armed = false;
    outcome = undefined;
    claimed.clear();
    let recovery: Recovery | undefined;
    let restoredTools: string[] | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "system") restoredTools = undefined;
      if (entry.type !== "custom") continue;
      if (entry.customType === TOOLS && Array.isArray(entry.data) && entry.data.every((name) => typeof name === "string")) restoredTools = entry.data;
      if (entry.customType === STATE) recovery = isRecovery(entry.data) ? entry.data : undefined;
      if (entry.customType === CLAIM && typeof entry.data === "string") claimed.add(entry.data);
    }
    if (restoredTools) pi.setActiveTools(restoredTools);
    if (recovery) { active = recovery; await restore(ctx); }
    loadConfig(ctx);
  }
  pi.on("session_start", async (_event, ctx) => { settings.close(); await recoverBranch(ctx); await settings.start(ctx); });
  pi.on("session_tree", async (_event, ctx) => { settings.close(); await recoverBranch(ctx); });
  pi.on("session_shutdown", async (_event, ctx) => { settings.close(); armed = false; await restore(ctx); });

  pi.on("before_agent_start", async (event, ctx) => {
    outcome = undefined;
    if (active && !(await restore(ctx))) { ctx.abort(); return; }
    loadConfig(ctx);
    armed = event.messageType === "user";
  });

  // A queued user message can start inside the same low-level loop.
  pi.on("message_start", async (event, ctx) => {
    if (event.message.role !== "user" || !active) return;
    if (!(await restore(ctx))) { ctx.abort(); return; }
    armed = true;
    outcome = undefined;
  });
  pi.on("agent_before_settle", (event) => { outcome = event.outcome; });

  // Rewrite only the finalized assistant message. No user message is added,
  // and the working model remains selected for the next task.
  pi.on("agent_before_settle", async (event, ctx) => {
    const source = [...event.context.contextEntries].reverse().find((entry) => entry.sourceEntry.type === "message" && entry.sourceEntry.message.role === "assistant");
    if (rewriting || !source || source.sourceEntry.type !== "message" || source.sourceEntry.message.role !== "assistant" || source.sourceEntry.message.stopReason !== "stop" || !armed || event.outcome !== "completed" ||
      !config.enabled || !config.model || !ctx.model || ctx.hasPendingMessages() || claimed.has(source.sourceEntry.id)) return;
    const target = ctx.modelRegistry.find(config.model.provider, config.model.id);
    if (!target) { report(ctx, `找不到最终模型 ${modelName(config.model)}，保留原答复。`); return; }
    if (target.api === "pi-virtual") { report(ctx, "最终模型不能使用虚拟路由模型，保留原答复。"); return; }
    if (sameModel(ctx.model, target)) return;
    if (!ctx.modelRegistry.hasConfiguredAuth(target)) { report(ctx, `最终模型认证未配置：${modelName(target)}，保留原答复。`); return; }
    const usage = ctx.getContextUsage();
    const required = usage?.tokens;
    const reserve = Math.min(target.maxTokens || 8192, 16384) + 2048;
    if (!target.contextWindow || required == null || required + reserve >= target.contextWindow) {
      report(ctx, "无法确认最终模型能容纳当前上下文，已跳过；请压缩后继续，或选择更大上下文的模型。");
      return;
    }
    const sourceId = source.sourceEntry.id;
    const state: Recovery = { version: 2, sourceId };
    active = state;
    saveRecovery(state);
    status(ctx);
    const transcript = event.context.llmMessages;
    let content: typeof source.sourceEntry.message.content | undefined;
    const reasoning = pi.getThinkingLevel();
    const streamOptions = reasoning === "off" ? { signal: ctx.signal } : { signal: ctx.signal, reasoning };
    rewriting = true;
    const requestId = randomUUID();
    const started = Date.now();
    const logContext = { requestId, sessionId: ctx.sessionManager.getSessionId(), sourceId, model: modelName(target), reasoning };
    writeLog("request", { ...logContext, contextTokens: required, messageCount: transcript.length });
    try {
      const stream = ctx.modelRegistry.streamSimple(target, {
        messages: [
          { role: "system", content: `${ctx.getSystemPrompt()}\n\n本轮仅整理最终答复，禁止调用任何工具或开始新的工作。${FINAL_INSTRUCTION}`, toolsAdded: [], timestamp: Date.now() },
          // Historical system messages carry toolsAdded; tools: [] does not remove them.
          // The effective prompt above replaces them while preserving all task evidence.
          ...transcript.filter(message => message.role !== "system"),
          // Request-local instruction: never appended to the user's session.
          { role: "user", content: `请现在重写上一条助手最终答复，作为对原始用户任务的回答。${FINAL_INSTRUCTION} 不要询问下一项任务。`, timestamp: Date.now() },
        ],
        tools: [],
      }, streamOptions);
      const result = await stream.result();
      const hasText = result.content.some(part => part.type === "text" && part.text.trim());
      writeLog("response", {
        ...logContext, durationMs: Date.now() - started, stopReason: result.stopReason,
        rawStopReason: result.rawStopReason, responseId: result.responseId, responseModel: result.responseModel,
        success: result.stopReason === "stop" && hasText, usage: result.usage,
        content: result.content.map(part => ({ type: part.type, characters: part.type === "text" ? part.text.length : part.type === "thinking" ? part.thinking.length : undefined, tool: part.type === "toolCall" ? part.name : undefined })),
        error: result.errorMessage ? errorText(result.errorMessage) : undefined,
      });
      if (result.stopReason !== "stop" || !hasText) {
        report(ctx, `最终模型未完成整理（${result.stopReason}${!hasText ? "，无正文" : ""}），已保留原答复。${result.errorMessage ? errorText(result.errorMessage) : ""} 日志：${logPath()}，请求：${requestId}`);
        return;
      }
      content = markFinalAnswer(result.content);
      lastError = undefined;
      claimed.add(sourceId);
    } catch (error) {
      writeLog("exception", { ...logContext, durationMs: Date.now() - started, aborted: ctx.signal?.aborted === true, error: errorText(error) });
      if (ctx.signal?.aborted) return;
      report(ctx, `最终整理失败，已保留原答复：${errorText(error)} 日志：${logPath()}，请求：${requestId}`);
    } finally {
      rewriting = false;
      await restore(ctx);
    }
    return content ? { entries: [{ type: "context_edit" as const, targetId: sourceId, replacement: { content } }, { type: "custom" as const, customType: CLAIM, data: sourceId }] } : undefined;
  });

  pi.registerCommand("pi-final-model", {
    description: "设置",
    handler: async (_args, ctx) => { loadConfig(ctx); await settings.open(ctx); },
  });
}
