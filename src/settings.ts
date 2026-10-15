import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ConfigConflict, modelName, parseModel, readConfig, saveConfig, type Config } from "./config.ts";
import { SettingsError, startSettingsWeb } from "./settings-web.ts";

interface SettingsHost {
  config: () => Config;
  apply: (config: Config, ctx: ExtensionContext, clearError: boolean) => void;
  error: () => string | undefined;
  needsRecovery: () => boolean;
  recover: (ctx: ExtensionContext) => Promise<boolean>;
  catalog: () => { refreshedAt: number | null; error: string | null };
  refresh: (ctx: ExtensionContext) => Promise<void>;
}

export function createSettings(pi: ExtensionAPI, host: SettingsHost) {
  let bridge: Awaited<ReturnType<typeof startSettingsWeb>> | undefined;
  let opening: Promise<void> | undefined;
  let generation = 0;
  const close = () => { generation++; bridge?.close(); bridge = undefined; opening = undefined; };

  const open = async (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui" || !ctx.hasUI) {
      const message = "请在交互式 Pi 中打开设置。";
      if (ctx.hasUI) ctx.ui.notify(message, "info"); else process.stderr.write(`[pi-final-model] ${message}\n`);
      return;
    }
    if (opening) return opening;
    const currentGeneration = generation;
    opening = (async () => {
      try {
        if (!bridge || bridge.closed) {
          const snapshot = () => {
            let config = host.config();
            let configError: string | null = null;
            try { config = readConfig(); host.apply(config, ctx, false); }
            catch { configError = "配置文件无效，请先修复配置文件。"; }
            return {
              revision: config.revision, catalog: host.catalog(),
              enabled: config.enabled, model: config.model ? modelName(config.model) : null,
              workingModel: ctx.model?.name || ctx.model?.id || "当前模型",
              busy: !ctx.isIdle(), recovery: host.needsRecovery(), error: configError || host.error() || null,
              models: ctx.modelRegistry.getAll()
                .filter(model => model.api !== "pi-virtual" && !model.id.startsWith("group/") && ctx.modelRegistry.hasConfiguredAuth(model))
                .map(model => ({ value: modelName(model), name: model.name || model.id, provider: model.provider, id: model.id, contextWindow: model.contextWindow }))
                .sort((a, b) =>
                  Number(b.provider === config.model?.provider) - Number(a.provider === config.model?.provider) ||
                  a.provider.localeCompare(b.provider) ||
                  Number(b.id === config.model?.id) - Number(a.id === config.model?.id) || a.name.localeCompare(b.name)),
            };
          };
          const server = await startSettingsWeb(snapshot, async value => {
            if (generation !== currentGeneration) throw new SettingsError("会话已切换，请重新打开设置。", 410);
            if (!ctx.isIdle()) throw new SettingsError("任务正在进行，结束后即可保存。", 409);
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new SettingsError("设置格式无效。");
            const input = value as Record<string, unknown>;
            if (input.action === "refresh" && Object.keys(input).length === 1) { await host.refresh(ctx); return; }
            if (input.action === "recover" && Object.keys(input).length === 1) {
              if (!(await host.recover(ctx))) throw new SettingsError("暂时无法恢复最终整理状态，请稍后重试。", 409);
              return;
            }
            if (Object.keys(input).some(key => key !== "enabled" && key !== "model" && key !== "revision") || typeof input.revision !== "string" || typeof input.enabled !== "boolean" || (input.model !== null && typeof input.model !== "string")) {
              throw new SettingsError("设置格式无效。");
            }
            let model;
            try { model = input.model ? parseModel(input.model as string) : undefined; }
            catch { throw new SettingsError("请选择具体模型。"); }
            // Turning off must still work if a previously configured model disappeared.
            const old = readConfig();
            if (model && (input.enabled || !old.model || modelName(old.model) !== modelName(model))) {
              const target = ctx.modelRegistry.find(model.provider, model.id);
              if (!target || target.api === "pi-virtual" || !ctx.modelRegistry.hasConfiguredAuth(target)) throw new SettingsError("模型已不可用，请重新选择。");
            }
            if (input.enabled && !model) throw new SettingsError("请先选择最终答复模型。");
            if (host.needsRecovery() && !(await host.recover(ctx))) throw new SettingsError("请先恢复最终整理状态，再保存设置。", 409);
            if (generation !== currentGeneration || !ctx.isIdle()) throw new SettingsError("会话状态已变化，请重试。", 409);
            const next: Config = { enabled: input.enabled, model, settingsOpened: true };
            try { host.apply(saveConfig(next, input.revision as string), ctx, true); }
            catch (error) { if (error instanceof ConfigConflict) throw new SettingsError(error.message, 409); throw error; }
          });
          if (generation !== currentGeneration) { server.close(); return; }
          bridge = server;
        }
        bridge.touch();
        const url = bridge.url;
        const result = process.platform === "darwin" ? await pi.exec("open", [url], { timeout: 10_000 })
          : process.platform === "win32" ? await pi.exec("rundll32.exe", ["url.dll,FileProtocolHandler", url], { timeout: 10_000 })
          : await pi.exec("xdg-open", [url], { timeout: 10_000 });
        if (generation !== currentGeneration) return;
        if (result.code !== 0) { ctx.ui.notify(`请在浏览器打开设置：${url}`, "warning"); return; }
        // Mark only successful launches, preserving settings written by another session.
        let latest = readConfig();
        if (!latest.settingsOpened) latest = saveConfig({ ...latest, settingsOpened: true });
        host.apply(latest, ctx, false);
      } catch (error) {
        if (generation === currentGeneration) ctx.ui.notify(`无法打开设置：${error instanceof Error ? error.message : String(error)}${bridge ? `\n${bridge.url}` : ""}`, "error");
      }
    })().finally(() => { if (generation === currentGeneration) opening = undefined; });
    return opening;
  };
  return {
    open, close,
    async start(ctx: ExtensionContext) {
      if (!host.config().settingsOpened && ctx.mode === "tui" && ctx.hasUI) await open(ctx);
    },
  };
}
