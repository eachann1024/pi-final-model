import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ModelRef { provider: string; id: string }
export interface Config { enabled: boolean; model?: ModelRef; settingsOpened?: boolean }
export const configPath = () => join(getAgentDir(), "final-model.json");

export function parseModel(value: string): ModelRef {
  const separator = value.indexOf("/");
  if (separator < 1 || separator === value.length - 1 || /\s/.test(value)) {
    throw new Error("模型格式应为 provider/model-id，model-id 可以包含 /。");
  }
  const model = { provider: value.slice(0, separator), id: value.slice(separator + 1) };
  if (model.id.startsWith("group/")) throw new Error("最终模型不能使用 Magpie 路由组，请选择具体模型。");
  return model;
}
export const modelName = (model: ModelRef) => `${model.provider}/${model.id}`;
export const sameModel = (a: ModelRef | undefined, b: ModelRef | undefined) =>
  !!a && !!b && a.provider === b.provider && a.id === b.id;

export function readConfig(): Config {
  let raw: string;
  try { raw = readFileSync(configPath(), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { enabled: false };
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("final-model.json 必须是对象。");
  const data = value as Record<string, unknown>;
  if (typeof data.enabled !== "boolean") throw new Error("final-model.json 的 enabled 必须是布尔值。");
  let model: ModelRef | undefined;
  if (data.model !== undefined) {
    if (typeof data.model !== "string") throw new Error("final-model.json 的 model 必须是字符串。");
    model = parseModel(data.model);
  }
  if (data.enabled && !model) throw new Error("启用最终输出模型前必须配置 model。");
  if (data.settingsOpened !== undefined && typeof data.settingsOpened !== "boolean") throw new Error("final-model.json 的 settingsOpened 必须是布尔值。");
  return { enabled: data.enabled, model, settingsOpened: data.settingsOpened === true };
}

export function saveConfig(config: Config): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ enabled: config.enabled, model: config.model && modelName(config.model), settingsOpened: config.settingsOpened === true }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
