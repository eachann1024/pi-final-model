import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ModelRef { provider: string; id: string }
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = typeof THINKING_LEVELS[number];
export const LANGUAGES = ["en", "zh-CN"] as const;
export type Language = typeof LANGUAGES[number];
export interface Config { enabled: boolean; model?: ModelRef; thinking?: Thinking; prompt?: string; language?: Language; settingsOpened?: boolean; lastSeenVersion?: string; revision?: string }
/** The editable part of the rewrite instruction; fixed constraints are always appended. */
export const DEFAULT_PROMPT = "请根据用户需求、实际执行过程和工具结果，重写上一条助手最终答复，直接回答原始用户任务。遵循用户要求的语言、长度和格式，保留必要的确认问题；区分已完成、未验证和受阻事项，不虚构验证、提交或发布结果。";
export const DEFAULT_PROMPT_EN = "Rewrite the assistant's previous final answer to directly address the user's task based on the user's request and tool execution summary. Follow the user's requested language, length, and format, keep necessary clarifying questions, clearly distinguish completed, unverified, and blocked items, and never fabricate verification, commits, or releases.";
export const FIXED_PROMPT = "不要继续执行任务、调用工具、询问下一项任务、提及换模型或添加模型标记。";
export const FIXED_PROMPT_EN = "Do not continue executing tasks, call tools, ask for the next task, mention switching models, or add model markers.";
export const DEFAULT_PROMPTS: Record<Language, string> = { "zh-CN": DEFAULT_PROMPT, en: DEFAULT_PROMPT_EN };
export const FIXED_PROMPTS: Record<Language, string> = { "zh-CN": FIXED_PROMPT, en: FIXED_PROMPT_EN };
export const PROMPT_LIMIT = 4000;
export const isThinking = (value: unknown): value is Thinking => typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
export const isLanguage = (value: unknown): value is Language => typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
export const validPrompt = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= PROMPT_LIMIT;
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
  if (data.thinking !== undefined && !isThinking(data.thinking)) throw new Error("final-model.json 的 thinking 无效。");
  if (data.prompt !== undefined && !validPrompt(data.prompt)) throw new Error(`final-model.json 的 prompt 必须是 1–${PROMPT_LIMIT} 字的字符串。`);
  if (data.language !== undefined && !isLanguage(data.language)) throw new Error("final-model.json 的 language 无效。");
  const lastSeenVersion = typeof data.lastSeenVersion === "string" && /^\d+\.\d+\.\d+$/.test(data.lastSeenVersion) ? data.lastSeenVersion : undefined;
  return { enabled: data.enabled, model, thinking: data.thinking as Thinking | undefined, prompt: data.prompt as string | undefined, language: data.language as Language | undefined, settingsOpened: data.settingsOpened === true, lastSeenVersion, revision: createHash("sha256").update(raw).digest("hex") };
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
    writeFileSync(temporary, `${JSON.stringify({ enabled: config.enabled, model: config.model && modelName(config.model), thinking: config.thinking, prompt: config.prompt, language: config.language, settingsOpened: config.settingsOpened === true, lastSeenVersion: config.lastSeenVersion }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
    return readConfig();
  } finally { rmSync(temporary, { force: true }); rmSync(lock, { recursive: true, force: true }); }
}

/** Mirrors Pi's per-model thinking support: non-reasoning models only take "off"; xhigh/max need an explicit mapping. */
export function supportedThinking(model: { reasoning?: boolean; thinkingLevelMap?: Partial<Record<string, string | null>> }): Thinking[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter(level => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level === "xhigh" || level === "max" ? mapped !== undefined : true;
  });
}
export function clampThinking(levels: Thinking[], level: Thinking): Thinking {
  if (levels.includes(level)) return level;
  const index = THINKING_LEVELS.indexOf(level);
  return THINKING_LEVELS.slice(index).find(item => levels.includes(item)) ?? [...THINKING_LEVELS.slice(0, index)].reverse().find(item => levels.includes(item)) ?? "off";
}
