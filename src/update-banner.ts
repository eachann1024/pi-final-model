import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import type { Language } from "./config.ts";

export const UPDATE_RELEASE_DATE = "2026-11-04";
const MIN_BANNER_VERSION = "0.2.7";

export function isNewerVersion(current: string, previous?: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(current)) return false;
  if (!previous) return true;
  if (!/^\d+\.\d+\.\d+$/.test(previous)) return false;
  const curParts = current.split(".").map(Number);
  const prevParts = previous.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (curParts[i] !== prevParts[i]) return curParts[i] > prevParts[i];
  }
  return false;
}

function readPackageVersion(): string {
  try {
    const raw = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    if (typeof raw.version === "string" && /^\d+\.\d+\.\d+$/.test(raw.version)) {
      return isNewerVersion(raw.version, MIN_BANNER_VERSION) ? raw.version : MIN_BANNER_VERSION;
    }
  } catch {
    // Fallback to MIN_BANNER_VERSION when package.json cannot be read.
  }
  return MIN_BANNER_VERSION;
}

export const PACKAGE_VERSION: string = readPackageVersion();

interface UpdateNoteItem {
  title: string;
  desc: string;
}

const UPDATE_ITEMS: Record<Language, readonly UpdateNoteItem[]> = {
  "zh-CN": [
    {
      title: "独立思考强度与自定义改写提示词",
      desc: "可为最终模型单独指定思考强度（自动匹配最近支持档位），支持最高 4000 字自定义改写提示词，固定安全约束始终保留。",
    },
    {
      title: "双栏设置页重构与动态流程演示",
      desc: "设置页升级为圆角双栏布局，支持中英双语与浅色/深色主题记忆，内置可交互的“执行原理”三路径动态演示。",
    },
    {
      title: "轻量化本轮上下文与工具执行摘要",
      desc: "改写请求精简为当前轮次需求与工具执行摘要，大幅降低上下文占用并加快最终答复生成。",
    },
  ],
  en: [
    {
      title: "Dedicated Thinking Level & Custom Rewrite Prompt",
      desc: "Set an independent thinking level for the final model (auto-clamped to supported levels) and customize the rewrite prompt up to 4,000 characters.",
    },
    {
      title: "Two-Column Settings UI & Interactive Flow Demo",
      desc: "Redesigned settings page with English/Chinese toggle, light/dark theme persistence, and an interactive three-path execution walkthrough.",
    },
    {
      title: "Streamlined Turn Context & Tool Execution Summary",
      desc: "Sends a concise summary of the current turn's tool runs instead of full history, reducing token usage and speeding up rewrites.",
    },
  ],
};

function stripOsc8(text: string): string {
  return text.replace(/\x1b\]8;;[^\x07]*\x07/g, "");
}

function widthOf(text: string): number {
  return visibleWidth(stripOsc8(text));
}

export function renderUpdateBanner(
  theme: Pick<ExtensionContext["ui"]["theme"], "fg" | "bold">,
  width: number,
  options: { version?: string; language?: Language; collapsed?: boolean } = {},
): { rows: string[]; headerRows: number } {
  if (width < 24) return { rows: [], headerRows: 0 };
  const version = options.version ?? PACKAGE_VERSION;
  const lang: Language = options.language ?? "zh-CN";
  const collapsed = options.collapsed ?? false;
  const items = UPDATE_ITEMS[lang] ?? UPDATE_ITEMS["zh-CN"];
  const innerWidth = Math.max(1, width - 6);
  const borderV = theme.fg("dim", "│");
  const topBorder = theme.fg("dim", "╭" + "─".repeat(Math.max(0, width - 2)) + "╮");
  const midBorder = theme.fg("dim", "├" + "─".repeat(Math.max(0, width - 2)) + "┤");
  const bottomBorder = theme.fg("dim", "╰" + "─".repeat(Math.max(0, width - 2)) + "╯");

  const boxLine = (content: string): string => {
    const w = widthOf(content);
    const fitted = w > innerWidth ? truncateToWidth(stripOsc8(content), innerWidth, "…") : content;
    const pad = Math.max(0, innerWidth - widthOf(fitted));
    return `${borderV}  ${fitted}${" ".repeat(pad)}  ${borderV}`;
  };

  const splitLine = (left: string, right: string, rightHref?: string): string => {
    const lw = widthOf(left);
    const rw = widthOf(right);
    if (lw + 2 + rw <= innerWidth) {
      const gap = " ".repeat(innerWidth - lw - rw);
      const linkedRight = rightHref ? `\x1b]8;;${rightHref}\x07${right}\x1b]8;;\x07` : right;
      return `${left}${gap}${linkedRight}`;
    }
    if (rw + 4 <= innerWidth) {
      const truncatedLeft = truncateToWidth(stripOsc8(left), Math.max(1, innerWidth - rw - 2), "…");
      const gap = " ".repeat(Math.max(1, innerWidth - widthOf(truncatedLeft) - rw));
      const linkedRight = rightHref ? `\x1b]8;;${rightHref}\x07${right}\x1b]8;;\x07` : right;
      return `${truncatedLeft}${gap}${linkedRight}`;
    }
    return truncateToWidth(stripOsc8(left), innerWidth, "…");
  };

  const leftHeader = theme.bold(
    theme.fg("accent", lang === "en" ? `pi-final-model v${version} Release Notes` : `pi-final-model v${version} 更新摘要`),
  );
  const rightHeader = theme.fg(
    "muted",
    collapsed
      ? (lang === "en" ? `${UPDATE_RELEASE_DATE} · ${items.length} updates · [Expand]` : `${UPDATE_RELEASE_DATE} · ${items.length} 项更新 · [展开]`)
      : (lang === "en" ? `${UPDATE_RELEASE_DATE} · ${items.length} updates` : `${UPDATE_RELEASE_DATE} · ${items.length} 项更新`),
  );

  const rows: string[] = [
    topBorder,
    boxLine(splitLine(leftHeader, rightHeader)),
  ];

  if (collapsed) {
    rows.push(bottomBorder);
    return { rows, headerRows: 3 };
  }

  rows.push(boxLine(""));
  for (let idx = 0; idx < items.length; idx++) {
    if (idx > 0) rows.push(boxLine(""));
    const item = items[idx];
    rows.push(boxLine(theme.bold(theme.fg("text", `${idx + 1}. ${item.title}`))));
    const wrapped = wrapTextWithAnsi(theme.fg("muted", item.desc), innerWidth);
    for (const line of wrapped) {
      rows.push(boxLine(line));
    }
  }

  rows.push(midBorder);
  const leftFooter = theme.fg(
    "muted",
    lang === "en" ? "Scrolls up with chat · Click header to fold" : "发消息后自动随会话向上滚动 · 点击标题栏可随时折叠",
  );
  const rightFooter = theme.fg("accent", `GitHub Release v${version} ↗`);
  const releaseUrl = `https://github.com/eachann1024/pi-final-model/releases/tag/v${version}`;
  rows.push(boxLine(splitLine(leftFooter, rightFooter, releaseUrl)));
  rows.push(bottomBorder);

  return { rows, headerRows: 3 };
}
