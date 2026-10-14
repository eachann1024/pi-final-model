import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelName, readConfig, sameModel, type Config, type ModelRef } from "./config.ts";
import { createSettings } from "./settings.ts";

type Thinking = ReturnType<ExtensionAPI["getThinkingLevel"]>;
interface Recovery {
  version: 1;
  token: string;
  original: ModelRef;
  target: ModelRef;
  thinking: Thinking;
  tools: string[];
  sourceId: string;
}
interface Active extends Recovery {
  prompt: string;
  started: boolean;
  toolsChanged: boolean;
  switched: boolean;
}
const STATE = "pi-final-model/recovery";
const CLAIM = "pi-final-model/claim";
const TOOLS = "pi-final-model/restored-tools";
const STATUS = "pi-final-model";
const FINAL_INSTRUCTION = "请根据上面的用户需求、实际执行过程和工具结果，直接输出给用户的最终答复。遵循用户要求的语言、长度和格式；区分已完成、未验证和受阻事项，不虚构验证、提交或发布结果。若仍需用户决定或提供信息，保留必要问题。不要继续执行任务、调用工具、提及内部换模型过程，也不要声称整个任务一定已完成。";

function isRecovery(value: unknown): value is Recovery {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<Recovery>;
  return v.version === 1 && typeof v.token === "string" && typeof v.sourceId === "string" &&
    !!v.original && typeof v.original.provider === "string" && typeof v.original.id === "string" &&
    !!v.target && typeof v.target.provider === "string" && typeof v.target.id === "string" &&
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(v.thinking ?? "") &&
    Array.isArray(v.tools) && v.tools.every((tool) => typeof tool === "string");
}

export default function finalModel(pi: ExtensionAPI) {
  // Child agents own their model and final output contract.
  if (process.env.PI_SUBAGENT_CHILD === "1") return;
  let config: Config = { enabled: false };
  let active: Active | undefined;
  let armed = false;
  let switching = false;
  let restoring: Promise<boolean> | undefined;
  let lastError: string | undefined;
  let outcome: "completed" | "aborted" | "error" | undefined;
  let externalSelection = false;
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
    if (ctx.hasUI) ctx.ui.setStatus(STATUS, active?.started ? `最终输出 · ${modelName(active.target)}` :
      config.enabled && config.model ? `最终模型 · ${modelName(config.model)}` : undefined);
  }
  function report(ctx: ExtensionContext, message: string) {
    lastError = message;
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
    pi.appendEntry(STATE, state && {
      version: state.version, token: state.token, original: state.original,
      target: state.target, thinking: state.thinking, tools: state.tools, sourceId: state.sourceId,
    });
  }

  async function restore(ctx: ExtensionContext): Promise<boolean> {
    if (restoring) return restoring;
    const state = active;
    if (!state) return true;
    restoring = (async () => {
      try {
        // A manual model change takes precedence over the saved selection.
        if (state.switched && !externalSelection && sameModel(ctx.model, state.target)) {
          const original = ctx.modelRegistry.find(state.original.provider, state.original.id);
          if (!original) throw new Error(`原模型已不在目录中：${modelName(state.original)}`);
          switching = true;
          try {
            if (!(await pi.setModel(original))) throw new Error(`原模型认证不可用：${modelName(state.original)}`);
            pi.setThinkingLevel(state.thinking);
          } finally { switching = false; }
        }
        if (state.toolsChanged) {
          pi.setActiveTools(state.tools);
          pi.appendEntry(TOOLS, state.tools);
        }
        saveRecovery(null);
        active = undefined;
        externalSelection = false;
        return true;
      } catch (error) {
        report(ctx, `恢复模型失败，已暂停自动最终输出；请打开设置恢复工作模型。${String(error)}`);
        return false;
      } finally {
        if (state.toolsChanged) pi.setActiveTools(state.tools);
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
    externalSelection = false;
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
    if (recovery) {
      active = { ...recovery, prompt: "", started: true, switched: true, toolsChanged: true };
      await restore(ctx);
    }
    loadConfig(ctx);
  }
  pi.on("session_start", async (_event, ctx) => { settings.close(); await recoverBranch(ctx); await settings.start(ctx); });
  pi.on("session_tree", async (_event, ctx) => { settings.close(); await recoverBranch(ctx); });
  pi.on("session_shutdown", async (_event, ctx) => { settings.close(); armed = false; await restore(ctx); });

  pi.on("model_select", () => {
    if (active && !switching) externalSelection = true;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    outcome = undefined;
    const state = active;
    const isOwnPrompt = event.messageType === "user" && state && !state.started && event.prompt === state.prompt;
    if (isOwnPrompt) {
      armed = false;
      const target = ctx.modelRegistry.find(state.target.provider, state.target.id);
      try {
        if (!target) throw new Error(`找不到模型 ${modelName(state.target)}`);
        // Journal before mutating anything: reload/crash recovery is branch-relative.
        saveRecovery(state);
        switching = true;
        try {
          if (!(await pi.setModel(target))) throw new Error(`模型认证不可用：${modelName(state.target)}`);
          state.switched = true;
        } finally { switching = false; }
        state.started = true;
        state.toolsChanged = true;
        pi.setActiveTools([]);
        status(ctx);
        return;
      } catch (error) {
        report(ctx, `最终输出未启动：${String(error)}`);
        await restore(ctx);
        // Lifecycle handler exceptions are swallowed by Pi; explicitly abort.
        ctx.abort();
        return;
      }
    }
    if (active && !(await restore(ctx))) { ctx.abort(); return; }
    loadConfig(ctx);
    armed = event.messageType === "user" && !event.prompt.startsWith("[[FINAL]]");
  });

  // A new user message can be consumed inside the same low-level loop without
  // another before_agent_start. Restore before that next provider request.
  pi.on("message_start", async (event, ctx) => {
    if (event.message.role !== "user" || !active) return;
    const text = typeof event.message.content === "string" ? event.message.content :
      event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (text === active.prompt) return;
    if (!(await restore(ctx))) { ctx.abort(); return; }
    armed = true;
    outcome = undefined;
  });

  // Request-local prompt: a queued real user message immediately gets the work
  // prompt again after restoration, even without another before_agent_start.
  pi.on("context_with_system", (event, ctx) => {
    if (!active?.started) return;
    return { messages: [
      { role: "system" as const, content: `${ctx.getSystemPrompt()}\n\n本轮仅整理最终答复，禁止调用任何工具或开始新的工作。${FINAL_INSTRUCTION}`, toolsAdded: [], timestamp: Date.now() },
      ...event.messages.filter((message) => message.role !== "system"),
    ] };
  });

  pi.on("tool_call", () => {
    if (active?.started) return { block: true, reason: "最终输出阶段只能整理答复，不能调用工具。" };
  });
  pi.on("agent_before_settle", (event) => { outcome = event.outcome; });

  pi.on("agent_settled", async (event, ctx) => {
    if (active) {
      armed = false;
      await restore(ctx);
      return;
    }
    const shouldFinalize = armed;
    armed = false;
    if (!shouldFinalize || event.aborted || outcome !== "completed" || !config.enabled || !config.model || !ctx.model || ctx.hasPendingMessages()) return;
    const branch = ctx.sessionManager.getBranch();
    const last = [...branch].reverse().find((entry) => entry.type === "message" && entry.message.role === "assistant");
    if (!last || last.type !== "message" || last.message.role !== "assistant" || last.message.stopReason !== "stop" || claimed.has(last.id)) return;
    const target = ctx.modelRegistry.find(config.model.provider, config.model.id);
    if (!target) { report(ctx, `找不到最终模型 ${modelName(config.model)}，保留原答复。`); return; }
    if (target.api === "pi-virtual") { report(ctx, "最终模型不能使用虚拟路由模型，保留原答复。"); return; }
    if (sameModel(ctx.model, target)) return;
    if (!ctx.modelRegistry.hasConfiguredAuth(target)) { report(ctx, `最终模型认证未配置：${modelName(target)}，保留原答复。`); return; }
    const usage = ctx.getContextUsage();
    // Never drop task evidence silently. Leave compaction to Pi/user and retain A's answer.
    const required = usage?.tokens;
    const reserve = Math.min(target.maxTokens || 8192, 16384) + 2048;
    if (!target.contextWindow || required == null || required + reserve >= target.contextWindow) {
      report(ctx, "无法确认最终模型能容纳当前上下文，已跳过；请压缩后继续，或选择更大上下文的模型。");
      return;
    }
    const token = randomUUID();
    active = {
      version: 1, token, original: { provider: ctx.model.provider, id: ctx.model.id },
      target: { provider: target.provider, id: target.id }, thinking: pi.getThinkingLevel(),
      tools: pi.getActiveTools(), sourceId: last.id,
      prompt: `[[FINAL]] ${token}\n${FINAL_INSTRUCTION}`,
      started: false, toolsChanged: false, switched: false,
    };
    claimed.add(last.id);
    pi.appendEntry(CLAIM, last.id);
    // pi 1.2 defers this action until all settled handlers finish. The actual
    // switch occurs in before_agent_start so an intercepted message changes nothing.
    pi.sendUserMessage(active.prompt, { deliverAs: "followUp", expandPromptTemplates: false });
  });

  pi.registerCommand("final-model", {
    description: "设置",
    handler: async (_args, ctx) => { loadConfig(ctx); await settings.open(ctx); },
  });
}
