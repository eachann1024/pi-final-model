# 验收记录

2026-10-14，在本机 Pi 1.2.0、Node.js 22.23.3、Magpie 网关上完成静态检查和真实会话验收，未编写或运行测试用例。

- `npm run check`：TypeScript 严格检查通过。
- `npm run pack:check`：Pi package 打包清单检查通过，扩展入口与所需源码完整。
- CLI 加载：`--final-model`、`--no-final-model` 出现在帮助中，无扩展加载错误。
- 真实短任务：A 为 `magpie-groups/group/smart`，调用 `read` 读取 `package.json` 后正常结束；只产生一条 `[[FINAL]]` 用户消息，B 为 `magpie-groups/codex/gpt-6-luna`，输出后恢复 A 和 `low` 思考强度，扩展错误为零。
- RPC 中断：在 B 的 assistant message 开始时发送 abort；最终状态为 `group/smart`、`low`、空闲、待处理消息 0，扩展错误为零。
- 续接与 print：重开上述会话，A 仍能调用 `read`；B 仍只追加一次，print 输出为 `pi-final-model`，结束后再次恢复 A。
- 本机安装：已通过 `pi install` 加入个人包列表，并通过 `/final-model set` 保存 Luna 为最终输出模型；工作默认模型仍为 `group/smart`。

真实会话记录位于 `/tmp/pi-final-model-acceptance/`，不随包分发。验证未覆盖所有第三方扩展组合、服务端上下文溢出、凭据到期或进程强制退出；对应路径已做类型检查与源码审阅。原始方案的 Magpie 中间件属于可选备选，此包采用 Pi 侧切模型，无需部署中间件。
