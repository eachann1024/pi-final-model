import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Spacer, Text, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { convertToLlm, estimateTokens, SettingsManager, VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { errorKind, logPath, writeLog } from "./log.ts";
import { clampThinking, configRevision, DEFAULT_PROMPTS, FIXED_PROMPTS, modelName, readConfig, sameModel, saveConfig, supportedThinking, type Config, type Language, type Thinking } from "./config.ts";
import { createSettings } from "./settings.ts";
import { applied, CLAIM, CLAIM_END, contentHash, durableBranch, isLegacyMark, isReceipt, LEGACY_MARK, PREPARED, textHash, verified, verifiedHashes, type Receipt } from "./receipt.ts";
import { isNewerVersion, PACKAGE_VERSION, renderUpdateBanner } from "./update-banner.ts";

const STATUS = "pi-final-model";
const sparkle = "\x1b[38;2;236;196;227m✦\x1b[38;2;185;220;243m✦\x1b[38;2;201;185;240m✦\x1b[0m";
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const REDRAW = "pi-final-model/redraw";
const UPDATE_BANNER_WIDGET = "pi-final-model/update-banner";
const locksKey = Symbol.for("pi-final-model.requests.v3");
const globals = globalThis as unknown as Record<symbol, Map<string, symbol>>;
const locks = globals[locksKey] ??= new Map();
const attemptsKey = Symbol.for("pi-final-model.attempts.v3");
const attempts = globals[attemptsKey] ??= new Map();
const bannerCheckedKey = Symbol.for("pi-final-model.banner-checked.v1");
const bannerGlobals = globalThis as unknown as Record<symbol, boolean | undefined>;

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
function clip(text: string, max: number) {
  const clean = text.trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1))}…`;
}
function summarizeTurnTools(turnMessages: ReturnType<typeof convertToLlm>, lang: Language) {
  const calls = new Map<string, string>();
  for (const msg of turnMessages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type !== "toolCall") continue;
      const args = (part.arguments ?? {}) as Record<string, unknown>;
      const hint = [args.path, args.command, args.pattern, args.query, args.url].find(v => typeof v === "string" && v.trim()) as string | undefined;
      if (hint) calls.set(part.id, clip(hint.replace(/\s+/g, " "), 60));
    }
  }
  const lines: string[] = [];
  let total = 0;
  for (const msg of turnMessages) {
    if (msg.role !== "toolResult") continue;
    const hint = calls.get(msg.toolCallId);
    const firstLine = (Array.isArray(msg.content) ? msg.content : [])
      .filter(part => part.type === "text")
      .map(part => part.text ?? "")
      .join("\n")
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(Boolean) ?? "";
    const status = lang === "en" ? (msg.isError ? "failed" : "ok") : (msg.isError ? "失败" : "成功");
    const line = `- ${msg.toolName}${hint ? `(${hint})` : ""}: ${status}${firstLine ? ` — ${clip(firstLine, 100)}` : ""}`;
    if (total + line.length > 1500 || lines.length >= 12) {
      lines.push(lang === "en" ? "- … (remaining tool results omitted)" : "- …（其余工具结果已省略）");
      break;
    }
    lines.push(line);
    total += line.length;
  }
  return lines.join("\n");
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
  let activeUpdateBanner: { sessionId: string; version: string; collapsed: boolean } | undefined;
  let removeBannerMount: (() => void) | undefined;
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
        redraw(ctx);
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
  // The answer was drawn and cached before its receipt landed; invalidate once so the markdown transformer runs again.
  function redraw(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.setWidget(REDRAW, tui => { tui.invalidate(); return { render: () => [], invalidate() {} }; }, { placement: "belowEditor" });
      ctx.ui.setWidget(REDRAW, undefined);
    } catch { /* Rendering is cosmetic. */ }
  }
  function reset(ctx: ExtensionContext) {
    active?.controller.abort(); release(); generation++; armed = false; current = ctx; accounted.clear(); reported.clear();
    removeBannerMount?.(); removeBannerMount = undefined;
    settings.close(); load(ctx); settle(ctx);
    log(ctx, "loaded");
  }
  function mountUpdateBanner(ctx: ExtensionContext) {
    removeBannerMount?.();
    removeBannerMount = undefined;
    if (!activeUpdateBanner || !ctx.hasUI || ctx.mode !== "tui") return;
    const sessionId = ctx.sessionManager.getSessionId();
    if (activeUpdateBanner.sessionId !== sessionId) return;
    try {
      ctx.ui.setWidget(UPDATE_BANNER_WIDGET, (tui, theme) => {
        const doc = (tui as unknown as { children?: Array<{ children?: Array<{ children?: Component[]; invalidate?: () => void }> }> }).children?.[0];
        const chat = doc?.children?.[2];
        if (chat && Array.isArray(chat.children)) {
          let lastHeaderRows = 3;
          let lastTotalRows = 0;
          let lastWidth = 0;
          const spacer = new Spacer(1);
          const bannerComp: Component = {
            invalidate() {},
            handleMouse(event: TuiMouseEvent) {
              if (!activeUpdateBanner || event.button !== "left" || event.shift || event.ctrl || event.alt || (event.clickCount ?? 1) !== 1) return;
              const inHeader = event.y >= 0 && event.y < lastHeaderRows;
              const inFooter = lastTotalRows > lastHeaderRows && event.y >= lastTotalRows - 3 && event.y < lastTotalRows;
              if ((inHeader || inFooter) && event.x >= 0 && event.x < lastWidth) {
                if (event.type === "press") return { handled: true };
                if (event.type === "click") {
                  activeUpdateBanner.collapsed = !activeUpdateBanner.collapsed;
                  chat.invalidate?.();
                  tui.requestRender();
                  return { handled: true, render: true };
                }
              }
            },
            render(width: number): string[] {
              if (!activeUpdateBanner || activeUpdateBanner.sessionId !== ctx.sessionManager.getSessionId()) return [];
              const rendered = renderUpdateBanner(theme, width, {
                version: activeUpdateBanner.version,
                language: config.language ?? "zh-CN",
                collapsed: activeUpdateBanner.collapsed,
              });
              lastHeaderRows = rendered.headerRows;
              lastTotalRows = rendered.rows.length;
              lastWidth = width;
              return rendered.rows;
            },
          };
          chat.children.unshift(spacer, bannerComp);
          chat.invalidate?.();
          removeBannerMount = () => {
            const idx = chat.children!.indexOf(bannerComp);
            if (idx !== -1) chat.children!.splice(idx, 1);
            const sIdx = chat.children!.indexOf(spacer);
            if (sIdx !== -1) chat.children!.splice(sIdx, 1);
            chat.invalidate?.();
          };
        }
        return { render: () => [], invalidate() {} };
      }, { placement: "belowEditor" });
      ctx.ui.setWidget(UPDATE_BANNER_WIDGET, undefined);
    } catch { /* Rendering is cosmetic. */ }
  }
  function checkUpdateBanner(ctx: ExtensionContext) {
    const sessionId = ctx.sessionManager.getSessionId();
    if (bannerGlobals[bannerCheckedKey]) {
      activeUpdateBanner = undefined;
      if (config.lastSeenVersion !== PACKAGE_VERSION) {
        config = { ...config, lastSeenVersion: PACKAGE_VERSION };
      }
      return;
    }
    bannerGlobals[bannerCheckedKey] = true;
    const exists = config.revision !== "missing";
    const prevVersion = config.lastSeenVersion;
    const versionChanged = isNewerVersion(PACKAGE_VERSION, prevVersion);
    if (prevVersion !== PACKAGE_VERSION) {
      config = { ...config, lastSeenVersion: PACKAGE_VERSION };
      if (exists) {
        try { config = saveConfig(config); }
        catch { /* Non-fatal if another session is writing simultaneously. */ }
      }
    }
    const hasMessages = ctx.sessionManager.getBranch().some(entry => entry.type === "message");
    if (exists && versionChanged && ctx.mode === "tui" && ctx.hasUI && !hasMessages) {
      activeUpdateBanner = { sessionId, version: PACKAGE_VERSION, collapsed: false };
      mountUpdateBanner(ctx);
    }
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
  pi.on("session_start", async (_event, ctx) => { reset(ctx); checkUpdateBanner(ctx); await settings.start(ctx); });
  pi.on("session_tree", (_event, ctx) => reset(ctx));
  pi.on("session_shutdown", (_event, ctx) => { active?.controller.abort(); release(); generation++; removeBannerMount?.(); removeBannerMount = undefined; settings.close(); log(ctx, "shutdown"); });
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
    const thinking = config.thinking;
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
      const rawMessages = event.context.contextMessages.filter(message => !isLegacyMark(message));
      let turnStart = -1;
      for (let i = rawMessages.length - 1; i >= 0; i--) {
        if (rawMessages[i]?.role === "user") { turnStart = i; break; }
      }
      const turnMessages = convertToLlm(turnStart >= 0 ? rawMessages.slice(turnStart) : rawMessages.slice(-1));
      const latestUser = turnMessages.find(message => message.role === "user");
      const latestUserRaw = typeof latestUser?.content === "string" ? latestUser.content : latestUser?.content.filter(part => part.type === "text").map(part => part.text).join("\n") ?? "";
      const latestUserText = clip(latestUserRaw, 4000);
      const answer = source.messages.find(message => message.role === "assistant");
      const answerText = answer && Array.isArray(answer.content) ? answer.content.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
      const lang: Language = config.language ?? (/\p{Script=Han}/u.test(latestUserText || answerText) ? "zh-CN" : "en");
      const INSTRUCTION = `${(config.prompt ?? DEFAULT_PROMPTS[lang]).trim()}\n${FIXED_PROMPTS[lang]}`;
      const toolDigest = summarizeTurnTools(turnMessages, lang);
      const messages = lang === "en" ? [
        { role: "system" as const, content: `Rewrite only the final answer for this turn. Do not call tools.\n${INSTRUCTION}`, toolsAdded: [], timestamp: Date.now() },
        { role: "user" as const, content: `${INSTRUCTION}\nLatest user request:\n${latestUserText}${toolDigest ? `\n\nThis turn's tool summary:\n${toolDigest}` : ""}\n\nDraft answer to rewrite:\n${answerText}\n\nRewrite only the answer above. When the user requires a verbatim reply, fixed string, JSON, or code format, preserve that exact format.`, timestamp: Date.now() },
      ] : [
        { role: "system" as const, content: `本轮只整理最终答复，禁止调用工具。\n${INSTRUCTION}`, toolsAdded: [], timestamp: Date.now() },
        { role: "user" as const, content: `${INSTRUCTION}\n最新用户要求：\n${latestUserText}${toolDigest ? `\n\n本轮工具执行摘要：\n${toolDigest}` : ""}\n\n本轮待整理答复：\n${answerText}\n\n只整理上面这条答复。用户指定原样回复、固定字符串、JSON 或代码格式时，必须原样保留满足格式的答复。`, timestamp: Date.now() },
      ];
      const maxTokens = Math.min(target.maxTokens || 8192, 16384);
      const required = messages.reduce((total, message) => total + estimateTokens(message), 0);
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
      const reasoning = clampThinking(supportedThinking(target), (thinking ?? pi.getThinkingLevel()) as Thinking);
      const logContext = { requestId, sourceId, model: modelName(target), reasoning, thinkingSource: thinking ? "final_model" : "working_model", customPrompt: config.prompt !== undefined };
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
