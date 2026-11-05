---
name: Final Model settings
description: Rounded two-column settings interface for the Pi final-answer extension, light and dark.
colors:
  light: { background: "#eef1f5", card: "#ffffff", ink: "#18202b", muted: "#556070", accent: "#2b5fd9", line: "#dde2ea" }
  dark: { background: "#0f1217", card: "#181c23", ink: "#e8ecf2", muted: "#a0a8b6", accent: "#8fb2ff", line: "#2a303a" }
---

## Overview

顶栏（标识、保存状态、语言、配色）下方第一行是默认收起的“执行原理”，展开后播放动态流程。其下双栏：左栏“整理方式”（开关、模型分工、思考强度）与“提示词”，右栏“模型”（搜索、供应商导航、模型卡片）。

## Colors

浅色与深色共用一套 CSS 变量，`:root[data-theme=dark]` 覆盖；默认跟随系统，手动选择存 Cookie。蓝色只用于选中、开关与流程进行中；橙色只用于“保留原答复”路径。

## Typography

系统无衬线字体，正文 16px，说明不小于 14px；模型 ID 用等宽字体并允许换行。

## Shapes

卡片 20px 圆角，分段按钮 12px，模型卡片 16px，开关为胶囊形。焦点为 2px 蓝色轮廓。

## Do's and Don'ts

- 保留供应商、模型名称与 ID 原文；界面文字随语言切换。
- 流程动画只在展开且页面可见时播放；减少动态效果时不自动播放，按钮改为逐步前进。
- 思考强度只列出所选模型支持的档位；提示词默认只读，切到自定义才可编辑，固定约束不可删。
- 不加装饰性角标或序号。
