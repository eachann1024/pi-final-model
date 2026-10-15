import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ModelRef { provider: string; id: string }
export interface Config { enabled: boolean; model?: ModelRef; settingsOpened?: boolean; revision?: string }
export class ConfigConflict extends Error {}
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

export function configRevision(): string {
  try { return createHash("sha256").update(readFileSync(configPath())).digest("hex"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
}
export function readConfig(): Config {
  let raw: string;
  try { raw = readFileSync(configPath(), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { enabled: false, revision: "missing" };
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
  return { enabled: data.enabled, model, settingsOpened: data.settingsOpened === true, revision: createHash("sha256").update(raw).digest("hex") };
}

export function saveConfig(config: Config, expectedRevision = config.revision): Config {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  try { mkdirSync(lock); }
  catch {
    // Saves are synchronous and contain no network work; an old lock is from a crashed process.
    try {
      if (Date.now() - statSync(lock).mtimeMs < 30_000) throw new Error("busy");
      rmSync(lock, { recursive: true }); mkdirSync(lock);
    } catch { throw new ConfigConflict("另一会话正在保存设置，请稍后重新加载。"); }
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    if (expectedRevision !== undefined && configRevision() !== expectedRevision) throw new ConfigConflict("设置已被另一会话修改，请重新加载后再保存。");
    writeFileSync(temporary, `${JSON.stringify({ enabled: config.enabled, model: config.model && modelName(config.model), settingsOpened: config.settingsOpened === true }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
    return readConfig();
  } finally { rmSync(temporary, { force: true }); rmSync(lock, { recursive: true, force: true }); }
}
