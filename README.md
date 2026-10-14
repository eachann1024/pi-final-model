# pi-final-model

让 Pi 用工作模型 A 执行任务，在任务停止自动续跑后，由指定模型 B 整理最终答复，再恢复 A、思考强度和工具。支持 Magpie 路由组作为 A，B 必须是已登记的具体模型。

## 安装

要求 Node.js 22.19+、Pi 1.2.0（此版本已核对事件与模型接口）。

```bash
pi install /path/to/pi-final-model
```

已有 Pi 会话执行 `/reload`；新会话自动加载。插件初次安装默认关闭，需配置 B；不会修改 `models.json`、认证或全局默认工作模型。

```text
/final-model set magpie-groups/codex/gpt-6-luna
/final-model status
```

模型必须存在于 Pi 的 `/model` 目录，且供应商已配置认证。模型 ID 中的 `/` 会完整保留。`set` 同时启用插件，并写入 `~/.pi/agent/final-model.json`（遵循 `PI_CODING_AGENT_DIR`）：

```json
{
  "enabled": true,
  "model": "magpie-groups/codex/gpt-6-luna"
}
```

一次启动指定模型，或临时关闭：

```bash
pi -e /path/to/pi-final-model/src/index.ts --final-model magpie-groups/codex/gpt-6-luna --model magpie-groups/group/smart
pi --no-final-model
```

`--final-model` 优先于配置文件；`--no-final-model` 在加载时优先于两者。会话内命令随后可以修改当前配置；命令修改会持久化，但 CLI 参数本身不落盘。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/final-model status` | 查看开关、模型、阶段、配置位置和最近提示 |
| `/final-model set provider/model-id` | 设置 B 并启用 |
| `/final-model on` | 启用已配置的 B |
| `/final-model off` | 关闭自动最终输出 |
| `/final-model recover` | 原模型认证或目录修复后，重试恢复 |

除查看状态外，在会话空闲时操作。配置文件修改后执行 `/reload`。

## 执行过程

1. 用户任务照常由当前模型处理；工具调用、自动重试、压缩和排队消息由 Pi 管理。
2. `agent_before_settle` 记录最终运行结果；`agent_settled` 仅在正常结束且最后一条助手消息为 `stop` 时追加一次带随机标识的 `[[FINAL]]` 用户消息。
3. Pi 1.2.0 将这条消息延后至全部 settled 回调结束后处理；插件在它的 `before_agent_start` 中切到 B，保存恢复记录，并清空工具声明。这样不会在原任务仍有其他收尾处理时提前改变模型。
4. B 接收现有上下文，按用户语言和格式整理结果；所有工具调用另有执行拦截。输出结束、出错或中断后恢复 A、原思考强度和工具。

恢复记录和已经处理的助手消息 ID 保存在会话分支的 custom entries 中，不发送给模型。重载、续接和树导航从当前分支重建状态；异常退出留下的 B 会在下次启动时恢复，正常结束后恢复的工具也会跨续接保留。插件尊重用户在最终输出期间手动选择的新模型。最终输出期间收到真实用户消息时，在该消息被消费后恢复工作模型与工具，再继续处理。

## 边界与降级

- 这实现的是“追加 B 的最终答复”：TUI 和 JSON 历史仍保留 A 已经输出的文本与 `[[FINAL]]` 用户消息；不会撤回 A 的流式输出。CLI print 模式正常完成时输出最后一条 B 答复。它不是预先识别 A 的最后一次请求。
- 每次正常用户轮次最多追加一次，不以文字猜测“任务是否完成”；需要澄清时，B 应保留必要问题。仅由其他扩展 custom message 启动的轮次不会主动触发最终整理。
- A 与 B 相同时不追加；工作阶段中断、报错、输出截断、无助手答复或工具终止时不追加。
- B 未登记、未认证、上下文容量未知或剩余容量不足时保留 A 答复并提示。插件不截断工具证据，不额外调用摘要模型；可先 `/compact` 再继续，或换更大上下文的 B。容量检查使用 Pi 的 token 估算并留出输出预算，服务端仍可能因实际限制而拒绝请求。
- B 请求错误或中断后不自动再次发起最终整理，恢复工作配置；其自动网络重试仍由 Pi 自身设置控制。
- 拒绝 `group/` Magpie 模型和 Pi 虚拟模型作为 B。对于自定义名称的网关路由别名，仍需在网关侧确保它直达指定模型。
- 如果其他扩展拦截、改写 `[[FINAL]]` 输入，或在最终阶段另行改写模型和上下文，可能阻止最终轮。没有真正进入最终轮时插件不会切换模型；下次正常输入、重载或 `/final-model recover` 会清除待启动状态。
- `agent_settled` 在 A 与 B 后各发出一次；外部 RPC/SDK 消费者不能把第一次 settled 当作 B 已完成。需要检查最后的助手模型或等待整个 prompt/idle 完成。

## 开发与卸载

```bash
npm install --ignore-scripts
npm run check
npm run pack:check
pi remove /path/to/pi-final-model
```

`check` 只做 TypeScript 静态检查；不包含测试用例。卸载建议在空闲、已恢复工作模型时执行。配置文件保留，便于重新安装。

原始需求采用 Pi 侧模型切换方案；Magpie 中间件、意图分类规则和额外代理属于备选方案，不需要部署，也不修改上游仓库。
