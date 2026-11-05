import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import type { Language } from "./config.ts";

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

interface ReleaseNote {
  highlights: string;
  features?: readonly string[];
  fixes?: readonly string[];
}

interface ReleaseEntry {
  version: string;
  date: string;
  notes: Record<Language, ReleaseNote>;
}

export const RELEASE_HISTORY: readonly ReleaseEntry[] = [
  {
    version: "0.2.7",
    date: "2026-11-05",
    notes: {
      "zh-CN": {
        highlights: "更新日志改为按天汇总，并自动跟随当前语言。",
        features: [
          "可为最终模型单独指定思考强度（自动匹配最近支持档位），支持最高 4000 字自定义改写提示词。",
          "改写请求精简为当前轮次需求与工具执行摘要，降低上下文占用。",
        ],
        fixes: ["升级横幅按升级前版本汇总所有未读更新，不再只显示最新版本。"],
      },
      en: {
        highlights: "Release notes are now grouped by day and follow your current language.",
        features: [
          "Set an independent thinking level for the final model (auto-clamped to supported levels) and a custom rewrite prompt up to 4,000 characters.",
          "Rewrite requests now carry only the current turn and a tool execution summary, reducing token usage.",
        ],
        fixes: ["The upgrade banner now lists every unseen update since your previous version, not just the latest."],
      },
    },
  },
  {
    version: "0.2.6",
    date: "2026-11-01",
    notes: {
      "zh-CN": {
        highlights: "设置页升级为圆角双栏布局。",
        features: ["支持中英双语与浅色/深色主题记忆，内置可交互的“执行原理”三路径动态演示。"],
      },
      en: {
        highlights: "Settings page redesigned with a rounded two-column layout.",
        features: ["English/Chinese toggle, light/dark theme persistence, and an interactive three-path execution walkthrough."],
      },
    },
  },
  {
    version: "0.2.5",
    date: "2026-10-17",
    notes: {
      "zh-CN": {
        highlights: "提升最终答复改写的稳定性。",
        fixes: ["修复改写回执在会话分支切换后可能无法识别的问题。"],
      },
      en: {
        highlights: "Improved reliability of final-answer rewriting.",
        fixes: ["Fixed rewrite receipts sometimes not being recognized after switching session branches."],
      },
    },
  },
  {
    version: "0.2.4",
    date: "2026-10-17",
    notes: {
      "zh-CN": {
        highlights: "完善最终模型的配置与刷新流程。",
        fixes: ["修复模型目录刷新失败时状态提示不准确的问题。"],
      },
      en: {
        highlights: "Refined final-model configuration and refresh flow.",
        fixes: ["Fixed inaccurate status messages when refreshing the model catalog failed."],
      },
    },
  },
];

export interface UpdateDay {
  date: string;
  versionLabel: string;
  highlights: string;
  features: string[];
  fixes: string[];
}

function compareVersions(a: string, b: string): number {
  return isNewerVersion(a, b) ? 1 : isNewerVersion(b, a) ? -1 : 0;
}

export function resolveUpdateDays(currentVersion: string, previousVersion?: string, language: Language = "zh-CN"): UpdateDay[] {
  const history = [...RELEASE_HISTORY].sort((x, y) => compareVersions(y.version, x.version));
  let picked = history.filter(
    entry => isNewerVersion(entry.version, previousVersion) && !isNewerVersion(entry.version, currentVersion),
  );
  if (!previousVersion || picked.length === 0) {
    const latest = history.reduce<string | undefined>((best, e) => (best === undefined || e.date > best ? e.date : best), undefined);
    picked = history.filter(entry => entry.date === latest);
  }
  const dates = [...new Set(picked.map(entry => entry.date))].sort((x, y) => (x < y ? 1 : x > y ? -1 : 0));
  return dates.map(date => {
    const entries = picked.filter(entry => entry.date === date).sort((x, y) => compareVersions(x.version, y.version));
    const first = entries[0].version;
    const last = entries[entries.length - 1].version;
    const notes = entries.map(entry => entry.notes[language] ?? entry.notes["zh-CN"]);
    const joiner = language === "en" ? " " : "";
    return {
      date,
      versionLabel: first === last ? `v${first}` : `v${first} – v${last}`,
      highlights: [...notes].reverse().map(n => n.highlights).join(joiner),
      features: [...new Set(notes.flatMap(n => n.features ?? []))],
      fixes: [...new Set(notes.flatMap(n => n.fixes ?? []))],
    };
  });
}

export function formatGitHubReleaseNotes(version: string = PACKAGE_VERSION, previousVersion?: string): string {
  const sections = (["zh-CN", "en"] as const).map(lang => {
    const en = lang === "en";
    const parts = resolveUpdateDays(version, previousVersion, lang).map(day => {
      const lines = [`### ${day.date} · ${day.versionLabel}`, "", `${en ? "🌈 Highlights" : "🌈 本次更新重点"}: ${day.highlights}`];
      if (day.features.length) lines.push("", en ? "**✨ New**" : "**✨ 新功能**", ...day.features.map(f => `- ${f}`));
      if (day.fixes.length) lines.push("", en ? "**🐛 Fixes**" : "**🐛 修复**", ...day.fixes.map(f => `- ${f}`));
      return lines.join("\n");
    });
    return `## ${en ? "English" : "简体中文"}\n\n${parts.join("\n\n")}`;
  });
  return sections.join("\n\n") + "\n";
}

function stripOsc8(text: string): string {
  return text.replace(/\x1b\]8;;[^\x07]*\x07/g, "");
}

function widthOf(text: string): number {
  return visibleWidth(stripOsc8(text));
}

export function renderUpdateBanner(
  theme: Pick<ExtensionContext["ui"]["theme"], "fg" | "bold">,
  width: number,
  options: { version?: string; previousVersion?: string; language?: Language; collapsed?: boolean } = {},
): { rows: string[]; headerRows: number } {
  if (width < 24) return { rows: [], headerRows: 0 };
  const version = options.version ?? PACKAGE_VERSION;
  const lang: Language = options.language ?? "zh-CN";
  const collapsed = options.collapsed ?? false;
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

  const leftHeader = theme.bold(theme.fg("accent", "pi-final-model v" + version));
  const rightHeader = theme.fg(
    "muted",
    collapsed ? (lang === "en" ? "[Expand]" : "[展开]") : (lang === "en" ? "[Collapse]" : "[收起]"),
  );

  const rows: string[] = [
    topBorder,
    boxLine(splitLine(leftHeader, rightHeader)),
  ];

  if (collapsed) {
    rows.push(bottomBorder);
    return { rows, headerRows: 3 };
  }

  const days = resolveUpdateDays(version, options.previousVersion, lang);
  const pushWrapped = (text: string) => {
    for (const line of wrapTextWithAnsi(text, innerWidth)) rows.push(boxLine(line));
  };
  days.forEach((day, idx) => {
    rows.push(idx === 0 ? boxLine("") : midBorder);
    rows.push(boxLine(theme.bold(theme.fg("text", day.date)) + "  " + theme.fg("muted", day.versionLabel)));
    pushWrapped(lang === "en" ? `🌈 Highlights: ${day.highlights}` : `🌈 本次更新重点：${day.highlights}`);
    if (day.features.length) {
      rows.push(boxLine(theme.bold(lang === "en" ? "✨ New" : "✨ 新功能")));
      for (const item of day.features) pushWrapped(`- ${item}`);
    }
    if (day.fixes.length) {
      rows.push(boxLine(theme.bold(lang === "en" ? "🐛 Fixes" : "🐛 修复")));
      for (const item of day.fixes) pushWrapped(`- ${item}`);
    }
  });

  rows.push(bottomBorder);
  return { rows, headerRows: 3 };
}
