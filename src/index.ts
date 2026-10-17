import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Text } from "@earendil-works/pi-tui";
import { convertToLlm, estimateTokens, SettingsManager, VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { errorKind, logPath, writeLog } from "./log.ts";
import { configRevision, modelName, readConfig, sameModel, type Config } from "./config.ts";
import { createSettings } from "./settings.ts";
import { applied, CLAIM, CLAIM_END, contentHash, durableBranch, isLegacyMark, isReceipt, LEGACY_MARK, PREPARED, textHash, verified, verifiedHashes, type Receipt } from "./receipt.ts";

const STATUS = "pi-final-model";
const INSTRUCTION = "请根据用户需求、实际执行过程和工具结果，重写上一条助手最终答复，直接回答原始用户任务。遵循用户要求的语言、长度和格式，保留必要的确认问题；区分已完成、未验证和受阻事项，不虚构验证、提交或发布结果。不要继续执行任务、调用工具、询问下一项任务、提及换模型或添加模型标记。";
const sparkle = "\x1b[38;2;236;196;227m✦\x1b[38;2;185;220;243m✦\x1b[38;2;201;185;240m✦\x1b[0m";
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const locksKey = Symbol.for("pi-final-model.requests.v3");
const globals = globalThis as unknown as Record<symbol, Map<string, symbol>>;
const locks = globals[locksKey] ??= new Map();
const attemptsKey = Symbol.for("pi-final-model.attempts.v3");
const attempts = globals[attemptsKey] ??= new Map();

function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Aborted"));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
function cleanText(content: { type: string; text?: string }[]) {
  // Only strip decorative leading marks, preserving legitimate AI headings in the answer.
  const text = content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/^(?:[\s\u200b]*(?:🤖|✦+|✨)[ \t]*(?:\n|$))+/, "").trim();
  return text && !/^(?:AI|🤖|✦+|✨)$/i.test(text) ? [{ type: "text" as const, text }] : [];
}

export default function finalModel(pi: ExtensionAPI) {
  if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_FINAL_MODEL_DISABLED === "1") return;
  if (typeof pi.registerEntryRenderer !== "function" || Number(VERSION.split(".")[0]) < 1 || (VERSION.startsWith("1.") && Number(VERSION.split(".")[1]) < 2)) {
    process.stderr.write("[pi-final-model] 需要 Pi 1.2.0 或更新版本，插件已停用。\n"); return;
  }
  const owner = Symbol();
  let config: Config = { enabled: false };
  let seenConfig = false;
  let armed = false;
  let generation = 0;
  let current: ExtensionContext | undefined;
  let active: { model: string; controller: AbortController; key: string } | undefined;
  let lastError: string | undefined;
  let refreshed = 0;
  let catalogError: string | undefined;
  const reported = new Set<string>();
  const accounted = new Set<string>();

  function log(ctx: ExtensionContext, event: string, data: Record<string, unknown> = {}) {
    writeLog(event, { extensionVersion: manifest.version, sourceCommit: manifest.piRelease?.source, piVersion: VERSION, sessionId: ctx.sessionManager.getSessionId(), ...data });
  }
  function status(ctx: ExtensionContext) {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS, active ? `最终整理中 · ${active.model}` : lastError ? "最终模型 · 需处理（/pi-final-model）" : config.enabled && config.model ? `最终模型 · ${modelName(config.model)}` : undefined);
  }
  function report(ctx: ExtensionContext, reason: string, message: string) {
    lastError = message;
    log(ctx, "warning", { reason });
    if (!reported.has(reason + message)) {
      reported.add(reason + message);
      if (ctx.hasUI) ctx.ui.notify(`最终模型：${message}`, "warning");
      else process.stderr.write(`[pi-final-model] ${message}\n`);
    }
    status(ctx);
  }
  function load(ctx: ExtensionContext) {
    try {
      const next = readConfig();
      if (next.revision === "missing" && seenConfig) report(ctx, "config_missing", "配置文件已丢失，本轮保留原答复；请打开设置重新配置。");
      if (next.revision !== "missing") seenConfig = true;
      config = next;
    } catch {
      config = { ...config, enabled: false };
      report(ctx, "config_invalid", "配置无法读取或格式无效，已停用；原文件未覆盖，请修复后重新打开设置。");
    }
    status(ctx);
  }
  function release() {
    if (active && locks.get(active.key) === owner) locks.delete(active.key);
    active = undefined;
  }
  function settle(ctx: ExtensionContext) {
    try {
      const branch = durableBranch(ctx);
      for (const entry of branch) {
        if (entry.type !== "custom" || entry.customType !== PREPARED || !isReceipt(entry.data)) continue;
        const receipt = entry.data;
        if (accounted.has(receipt.requestId)) continue;
        if (!applied(receipt, branch)) {
          accounted.add(receipt.requestId);
          log(ctx, "not_applied", { requestId: receipt.requestId, sourceId: receipt.sourceId, reason: "edit_missing_or_superseded" });
          continue;
        }
        if (!branch.some(entry => entry.type === "custom" && entry.customType === CLAIM && isReceipt(entry.data) && entry.data.requestId === receipt.requestId)) pi.appendEntry(CLAIM, receipt);
        if (!verified(receipt, durableBranch(ctx))) throw new Error("Receipt not durable");
        accounted.add(receipt.requestId);
        log(ctx, "applied", { requestId: receipt.requestId, sourceId: receipt.sourceId, model: receipt.model });
        pi.events.emit("pi-final-model:applied", receipt);
        lastError = undefined;
      }
    } catch { report(ctx, "persistence", "无法确认整理结果已保存，暂不显示成功标记；请检查会话文件权限和磁盘空间。"); }
    finally { release(); status(ctx); }
  }
  const settings = createSettings(pi, {
    config: () => config,
    apply: (next, ctx, clearError) => { config = next; if (clearError) { lastError = undefined; reported.clear(); } status(ctx); },
    error: () => lastError,
    needsRecovery: () => false,
    recover: async ctx => { settle(ctx); return !lastError; },
    catalog: () => ({ refreshedAt: refreshed || null, error: catalogError ?? null }),
    refresh: async ctx => refresh(ctx, config.model?.provider),
  });
  async function refresh(ctx: ExtensionContext, provider?: string) {
    if (process.env.PI_OFFLINE === "1") return;
    const signal = AbortSignal.any([AbortSignal.timeout(10_000), ...(ctx.signal ? [ctx.signal] : [])]);
    refreshed = Date.now();
    try {
      const result = await bounded(ctx.modelRegistry.refresh({ allowNetwork: true, force: true, providers: provider ? [provider] : undefined, signal }), signal);
      catalogError = result.errors.size || result.aborted ? "模型目录刷新失败，请稍后重试。" : undefined;
      log(ctx, "catalog_refresh", { reason: catalogError ? "failed" : "completed" });
    } catch { catalogError = "模型目录刷新失败，请稍后重试。"; log(ctx, "catalog_refresh", { reason: "timeout_or_error" }); }
  }
  function reset(ctx: ExtensionContext) {
    active?.controller.abort(); release(); generation++; armed = false; current = ctx; accounted.clear(); reported.clear();
    settings.close(); load(ctx); settle(ctx);
    log(ctx, "loaded");
  }
  const sparkleRenderer: Parameters<ExtensionAPI["registerEntryRenderer"]>[1] = entry => {
    if (!current || !isReceipt(entry.data)) return undefined;
    const receipt = entry.data;
    return {
      invalidate() {},
      render(width: number) {
        try { return current && verified(receipt, durableBranch(current)) ? new Text(sparkle, 0, 0).render(width) : []; }
        catch { return []; }
      },
    };
  };
  pi.registerEntryRenderer<Receipt>(CLAIM, sparkleRenderer);
  // Custom entries are always appended after the answer; the lead-in sparkle is drawn by the markdown transformer below.
  pi.registerEntryRenderer<Receipt>(CLAIM_END, () => new Text("", 0, 0));
  // Only a durable, verified rewrite gets the lead-in mark, and it is matched by the exact answer text.
  pi.registerMarkdownTransformer((markdown, context) => {
    if (context.messageType !== "assistant" || context.isStreaming || !current || !markdown.trim()) return markdown;
    try { return verifiedHashes(current).has(textHash(markdown.trim())) ? `${sparkle}\n\n${markdown}` : markdown; }
    catch { return markdown; }
  });
  // Never render legacy markers without trustworthy source/hash evidence.
  pi.registerMessageRenderer(LEGACY_MARK, () => new Text("", 0, 0));
  pi.on("context", event => ({ messages: event.messages.filter(message => !isLegacyMark(message)) }));
  pi.on("session_before_compact", event => {
    event.preparation.messagesToSummarize = event.preparation.messagesToSummarize.filter(message => !isLegacyMark(message));
    event.preparation.turnPrefixMessages = event.preparation.turnPrefixMessages.filter(message => !isLegacyMark(message));
  });
  pi.on("session_before_tree", event => {
    event.preparation.entriesToSummarize = event.preparation.entriesToSummarize.filter(entry => !(entry.type === "custom_message" && entry.customType === LEGACY_MARK));
  });
  pi.on("session_start", async (_event, ctx) => { reset(ctx); await settings.start(ctx); });
  pi.on("session_tree", (_event, ctx) => reset(ctx));
  pi.on("session_shutdown", (_event, ctx) => { active?.controller.abort(); release(); generation++; settings.close(); log(ctx, "shutdown"); });
  pi.on("before_agent_start", (event, ctx) => { current = ctx; settle(ctx); load(ctx); armed = event.messageType === "user"; });
  pi.on("message_start", event => { if (event.message.role === "user") armed = true; });
  pi.on("agent_settled", (_event, ctx) => settle(ctx));

  pi.on("agent_before_settle", async (event, ctx) => {
    current = ctx;
    const prior = event.entries;
    const legacy = event.context.contextEntries.filter(entry => entry.sourceEntry.type === "custom_message" && entry.sourceEntry.customType === LEGACY_MARK && entry.messages.length)
      .map(entry => ({ type: "context_edit" as const, targetId: entry.sourceEntry.id, replacement: null }));
    const baseline = [...prior, ...legacy];
    const source = [...event.context.contextEntries].reverse().find(entry => entry.sourceEntry.type === "message" && entry.sourceEntry.message.role === "assistant");
    const sourceId = source?.sourceEntry.id;
    const skip = (reason: string, message?: string) => {
      log(ctx, "skip", { reason, sourceId });
      if (message) report(ctx, reason, message);
      return baseline.length !== prior.length ? { entries: baseline } : undefined;
    };
    if (!source || source.sourceEntry.type !== "message" || source.sourceEntry.message.role !== "assistant") return skip("no_assistant");
    if (!armed) return skip("custom_turn");
    if (event.outcome !== "completed" || source.sourceEntry.message.stopReason !== "stop") return skip("incomplete_turn");
    load(ctx);
    if (!config.enabled || !config.model) return skip("disabled");
    if (!ctx.model) return skip("working_model_missing");
    if (ctx.hasPendingMessages() || event.continue) return skip("pending_messages");
    if (prior.some(entry => entry.type === "context_edit" && entry.targetId === sourceId)) return skip("edit_conflict");
    const branch = ctx.sessionManager.getBranch();
    if (branch.some(entry => entry.type === "custom" && ((entry.customType === CLAIM && entry.data === sourceId) || (entry.customType === PREPARED && isReceipt(entry.data) && entry.data.sourceId === sourceId)))) return skip("already_attempted");
    const key = `${ctx.sessionManager.getSessionId()}:${sourceId}`;
    if (locks.has(key) || attempts.has(key) || prior.some(entry => entry.type === "custom" && entry.customType === PREPARED && isReceipt(entry.data) && entry.data.sourceId === sourceId)) return skip("duplicate_instance");
    const selected = { ...config.model };
    const revision = config.revision;
    const runGeneration = generation;
    let leaf = ctx.sessionManager.getLeafId();
    const sessionId = ctx.sessionManager.getSessionId();
    const controller = new AbortController();
    locks.set(key, owner);
    active = { key, model: modelName(selected), controller };
    status(ctx);
    let handedOff = false;
    let requestId: string | undefined;
    const started = Date.now();
    try {
      let target = ctx.modelRegistry.find(selected.provider, selected.id);
      if (!target && Date.now() - refreshed > 60_000) { await refresh(ctx, selected.provider); target = ctx.modelRegistry.find(selected.provider, selected.id); }
      if (!target) return skip("model_missing", `找不到 ${modelName(selected)}，已保留原答复；请在 /pi-final-model 重新选择或刷新目录。`);
      if (target.api === "pi-virtual" || target.id.startsWith("group/")) return skip("virtual_model", "请在设置中选择具体模型。");
      if (sameModel(ctx.model, target)) return skip("same_model");
      if (!ctx.modelRegistry.hasConfiguredAuth(target)) return skip("auth_missing", "最终模型未配置认证，请使用 /login 后重试。");
      const transcript = convertToLlm(event.context.contextMessages.filter(message => !isLegacyMark(message)));
      const latestUser = [...transcript].reverse().find(message => message.role === "user");
      const latestUserText = typeof latestUser?.content === "string" ? latestUser.content : latestUser?.content.filter(part => part.type === "text").map(part => part.text).join("\n") ?? "";
      const answer = source.messages.find(message => message.role === "assistant");
      const answerText = answer && Array.isArray(answer.content) ? answer.content.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
      const messages = [
        { role: "system" as const, content: `${ctx.getSystemPrompt()}\n\n本轮只整理最终答复，禁止调用工具。${INSTRUCTION}`, toolsAdded: [], timestamp: Date.now() },
        ...transcript.filter(message => message.role !== "system"),
        { role: "user" as const, content: `${INSTRUCTION}\n最新用户要求（优先于历史任务）：\n${latestUserText}\n\n本轮待整理答复：\n${answerText}\n\n只整理上面这条答复。用户指定原样回复、固定字符串、JSON 或代码格式时，必须原样保留满足格式的答复，不要回到历史任务。`, timestamp: Date.now() },
      ];
      if (!target.input.includes("image") && messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "image"))) return skip("image_unsupported", "当前上下文包含图片，最终模型不支持图片；已保留原答复，请选择支持图片的模型。");
      const maxTokens = Math.min(target.maxTokens || 8192, 16384);
      const estimated = messages.reduce((total, message) => total + estimateTokens(message), 0);
      const required = Math.max(estimated, ctx.getContextUsage()?.tokens ?? 0);
      if (!Number.isFinite(target.contextWindow) || target.contextWindow <= 0 || required + maxTokens + 4096 >= target.contextWindow) return skip("context_capacity", "最终模型上下文不足或容量未知，已保留原答复；请先压缩或选择更大模型。");
      const preferences = SettingsManager.inMemory(pi.getSettings());
      const retry = preferences.getProviderRetrySettings();
      const timeoutMs = Math.min(300_000, Math.max(1000, retry.timeoutMs ?? (preferences.getHttpIdleTimeoutMs() || 120_000)));
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs), ...(ctx.signal ? [ctx.signal] : [])]);
      const valid = () => !signal.aborted && generation === runGeneration && ctx.sessionManager.getSessionId() === sessionId && ctx.sessionManager.getLeafId() === leaf && !ctx.hasPendingMessages() && configRevision() === revision;
      if (!valid()) return skip("stale_before_request");
      requestId = randomUUID();
      attempts.set(key, owner);
      if (attempts.size > 2000) attempts.delete(attempts.keys().next().value!);
      const reasoning = pi.getThinkingLevel();
      const logContext = { requestId, sourceId, model: modelName(target), reasoning };
      log(ctx, "request", { ...logContext, contextTokens: required, messageCount: messages.length, timeoutMs, maxTokens, maxRetries: Math.min(retry.maxRetries ?? 1, 2) });
      const result = await bounded(ctx.modelRegistry.streamSimple(target, { messages, tools: [] }, {
        signal, maxTokens, timeoutMs, maxRetries: Math.max(0, Math.min(retry.maxRetries ?? 1, 2)), maxRetryDelayMs: Math.min(retry.maxRetryDelayMs || 10000, 10000),
        ...(reasoning === "off" ? {} : { reasoning }),
      }).result(), signal);
      const content = cleanText(result.content);
      const accepted = result.stopReason === "stop" && content.length > 0 && !result.content.some(part => part.type !== "text" && part.type !== "thinking");
      log(ctx, "response_received", { ...logContext, durationMs: Date.now() - started, stopReason: result.stopReason, responseId: result.responseId, responseModel: result.responseModel, accepted, usage: result.usage, reason: result.errorMessage ? errorKind(result.errorMessage) : undefined });
      const contextStillValid = valid();
      if (generation === runGeneration && ctx.sessionManager.getSessionId() === sessionId) {
        pi.appendEntry("pi-final-model/usage", { ...logContext, usage: result.usage });
        leaf = ctx.sessionManager.getLeafId();
      }
      pi.events.emit("pi-final-model:usage", { ...logContext, usage: result.usage });
      if (!contextStillValid) return skip(signal.aborted ? "cancelled_or_timeout" : "stale_after_response");
      if (!accepted) {
        const reason = result.errorMessage ? errorKind(result.errorMessage) : "invalid_response";
        const action = reason === "authentication" ? "请使用 /login 更新认证。" : reason === "permission" ? "请确认账号拥有该模型权限，或重新选择模型。" : reason === "quota" ? "请检查供应商余额和额度。" : "详情见诊断日志。";
        return skip(reason, `最终整理未得到完整有效正文，已保留原答复。${action}`);
      }
      if (result.responseModel && result.responseModel !== target.id) log(ctx, "model_identity", { ...logContext, responseModel: result.responseModel, reason: "response_name_differs" });
      if (!valid()) return skip(signal.aborted ? "cancelled_or_timeout" : "stale_after_response");
      const receipt: Receipt = { version: 3, requestId, sourceId: source.sourceEntry.id, sessionId, model: modelName(target), responseModel: result.responseModel, responseId: result.responseId, hash: contentHash(content), usage: result.usage };
      // Persist the receipt before the edit; show the custom entry only when both survive validation and disk writes.
      handedOff = true;
      return { entries: [...baseline,
        { type: "custom" as const, customType: PREPARED, data: receipt },
        { type: "context_edit" as const, targetId: receipt.sourceId, replacement: { content } },
        { type: "custom" as const, customType: CLAIM, data: receipt },
      ] };
    } catch (error) {
      const reason = ctx.signal?.aborted || controller.signal.aborted ? "cancelled" : errorKind(error);
      log(ctx, "failed", { requestId, sourceId, reason, durationMs: Date.now() - started });
      if (reason !== "cancelled") report(ctx, reason, `整理失败（${reason}），已保留原答复。日志：${logPath()}${requestId ? `；请求：${requestId}` : ""}`);
      return baseline.length !== prior.length ? { entries: baseline } : undefined;
    } finally { if (!handedOff) release(); status(ctx); }
  });
  pi.registerCommand("pi-final-model", { description: "设置", handler: async (_args, ctx) => { load(ctx); await settings.open(ctx); } });
}
