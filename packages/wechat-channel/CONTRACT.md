# CONTRACT: wechat-channel

## 公开入口

- `src/contract.ts`：`startWechatChannel(options)` / `WechatChannelOptions` / `ReplyMode`。
- `src/cli.ts`：环境变量驱动的可执行入口（`zcode-wechat`）。
- `scripts/wechat-login.mjs`：扫码登录，凭证写入 `.env.local`。

## 模块边界

- `domain/`：纯函数（命令路由、回复渲染、iLink 协议体构造与响应解析），
  无 IO、无 await，可独立 `node:test` 单测。
- `app/`：`WechatChannelCoordinator`（userId→task 映射、模式、去重、typing 节流、
  最近 context_token）+ `ports.ts` 端口接口。
- `adapters/`：`EngineClient`（@zcode/client → zcode --web 后端）、
  `WeixinClient`（iLink getupdates 长轮询 + sendmessage/typing）、
  `weixinLogin`（扫码登录轮询）。

## 依赖方向

`cli/module → app → domain`；`adapters → domain`（实现 app 端口）；跨包仅经
`@zcode/client`、`@zcode/services`、`@zcode/shared`、`@zcode/rpc` 公开入口。
iLink 的 fetch、header、游标管理只允许出现在 `adapters/`；
`domain/weixinProtocol.ts` 只做纯构造/解析，不依赖任何 node 内置模块。

## 行为要点（详见 SPEC.md）

- 仅私聊；`message_type=2` 的自发回显跳过；回复必须携带最近入站的 `context_token`。
- 工具调用默认不回显（仅 `verbose` 终态附工具行）；`stream` 在纯文本媒介上
  降级为 typing 指示 + 终态文本，无中间内容更新。
- 引擎忙时输入入队（`enqueueTaskCommand`），不丢弃。
- 终态渲染以 `readSessionMessages` 全量重读为唯一数据源。
- 引擎断连期间的入站消息明确回执「未接受」，不静默丢弃。
- getupdates 游标透传；长轮询失败指数退避重试，不自动退出。
