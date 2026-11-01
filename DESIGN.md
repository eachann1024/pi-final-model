---
name: Final Model settings
description: Existing single-column settings interface for the Pi final-answer extension.
colors:
  background: "#fff"
  focus: "#7052b1"
  ink: "#1e1e1e"
  muted: "#68656e"
  line: "#dad7df"
  tint: "#f3eff9"
  success: "#307653"
  error: "#9b294b"
---

## Overview

设置页沿用现有云雾背景、白底面板、黑色直角边框与系统字体。以完成设置为目标，语言切换不改变模型配置。

## Colors

深色用于正文与当前选项，淡紫色标示模型选择区域；绿色表示保存成功，莓红色表示错误。状态同时通过文字表达。

## Typography

正文使用系统无衬线字体，默认 16px；说明与模型 ID 使用至少 14px。模型 ID 使用等宽字体并允许换行。标题随视口缩放。

## Layout

内容面板最大宽度 816px，居中单列。640px 以下收紧内边距；右上角语言按钮可随顶栏换行，英文与中文均不能产生横向滚动。

## Elevation & Depth

保留现有面板的黑色偏移阴影与品牌标识的磨砂背景，不扩展到其他组件。

## Shapes

沿用直角按钮、细边框与方形开关滑块。焦点使用清晰的紫色轮廓。

## Components

语言按钮始终显示 English / 中文，并用 aria-pressed 表达当前语言。模型选择器保留搜索、供应商分组与单选行为。保存与连接状态显示在页脚，错误区域提供相应重试操作。

## Do's and Don'ts

- 保留供应商、模型名称与 ID 原文；界面标签、状态和辅助功能名称随语言切换。
- 说明工作模型执行任务、最终答复模型只改写答复。
- 默认英文；语言偏好与模型配置分开保存。
- 不添加装饰性角标或序号；不因切换语言清空搜索或未保存的选择。
