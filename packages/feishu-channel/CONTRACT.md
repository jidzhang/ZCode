# CONTRACT: feishu-channel

## 公开入口

- `src/contract.ts`：`startFeishuChannel(options)` / `FeishuChannelOptions` / `ReplyMode`。
- `src/cli.ts`：环境变量驱动的可执行入口（`zcode-feishu`）。

## 模块边界

- `domain/`：纯函数（命令路由、回复渲染、卡片构建），无 IO，可独立 `node:test` 单测。
- `app/`：`FeishuChannelCoordinator`（chat→task 映射、模式、去重、节流）+ `ports.ts` 端口接口。
- `adapters/`：`EngineClient`（@zcode/client → zcode --web 后端）与 `FeishuClient`（飞书官方 SDK 长连接）。

## 依赖方向

`cli/module → app → domain`；`adapters → domain`（实现 app 端口）；跨包仅经
`@zcode/client`、`@zcode/services`、`@zcode/shared`、`@zcode/rpc` 公开入口。
飞书 SDK 只允许出现在 `adapters/feishuClient.ts`。

## 行为要点（详见 SPEC.md）

- 工具调用默认不回显（仅 `verbose` 模式渲染工具行）。
- 引擎忙时输入入队（`enqueueTaskCommand`），不丢弃。
- 渲染以 `readSessionMessages` 全量重读为唯一数据源，幂等可重复 PATCH。
- 引擎断连期间的入站消息明确回执"未接受"，不静默丢弃。
