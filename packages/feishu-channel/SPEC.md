# SPEC: feishu-channel（飞书通道，无工具摘要回显、忙时排队）

## 目标

为自建部署提供一个飞书 bot 通道，作为 `@zcode/server`（`zcode --web` 后端）的 WS 客户端，
复用引擎会话/队列/权限管理，同时修正官方闭源 bot 层的三个问题：

1. **工具摘要不回显**：默认回复模式只渲染助手文本；工具调用仅在 `verbose` 模式出现，可随时切换/隐藏。
2. **忙时不丢消息**：turn 进行中的新输入经引擎 `enqueueTaskCommand` 排队（`followupMode=queue` 语义），
   引擎自动消化；通道层不丢弃任何消息。
3. **零遥测（严格禁用）**：本通道不产生任何上报；safe-zcode 全链路（引擎 OTLP /
   桌面 ARMS / 数仓上报）默认禁用，只有显式 `ZCODE_TELEMETRY=on` 才允许出站，
   运行时无需配置任何"关闭"变量。

## 行为

- 每个飞书 chat 绑定一个引擎 task（懒创建，首条消息时创建）。
  任务协作模式默认 **yolo**（`FEISHU_TASK_MODE` 可覆盖），与官方飞书 bot 行为一致：
  不产生权限询问，也就不需要权限转发链路。
- 消息去重：按飞书 `message_id` 幂等，重复投递只处理一次。
- 命令（消息文本整行匹配）：
  - `/help` 帮助；`/mode <final|stream|verbose>` 切换回复模式；`/stop` 停止当前生成（队列保留）；
    `/new` 新建 task（旧 task 不删除，仅解绑）。
  - 非命令文本 → `sendPrompt`；task 忙时 → `enqueueTaskCommand` 入队，回执「已排队」。
- 回复模式：
  - `final`：回合结束后一条纯文本（无中间卡片）。
  - `stream`（默认）：创建交互卡片，节流 PATCH 更新助手文本 + 运行状态；**不包含工具调用行**。
  - `verbose`：同 `stream`，但包含工具调用行（每次工具调用一行：工具名 + 状态）。
- 渲染数据源：事件仅作触发信号；每次渲染用 `readSessionMessages` 全量重读最后一条助手消息
  （消息部件含 text/tool），保证幂等、乱序安全、重连后可恢复。

## V1 范围外（明确不做）

- **权限请求转发**：官方 bot 即以 yolo 模式运行、从不询问；本通道默认同样以 yolo
  建任务，权限链路天然不触发。若用户显式选择非 yolo 模式（`FEISHU_TASK_MODE`），
  权限请求暂无飞书侧交互入口（卡片化 `resolveInteraction` 为后续工作项），
  此类回合会在卡片中停驻直到在引擎侧处理。
- **工具实时状态**：`verbose` 的工具行来自回合内消息部件重读，粒度到"部件状态"，
  不含流式过程中的实时子状态（后续可经 `onDynamicStreamEvent` 事件映射增强）。

## 凭证来源

- 首选：`node scripts/reuse-official-credential.mjs` 复用官方桌面端已保存的飞书
  bot 凭证（`enc:v1` 信封与官方实现一致，可本机解密），直接写入 `.env.local`。
- 官方凭证格式为 `enc:v1:` + base64url(iv).authTag.ciphertext 的 AES-256-GCM 信封，
  密钥取 `ZCODE_CREDENTIAL_SECRET`，未设置时为
  `zcode-credential-fallback:{platform}:{homedir}:{username}` 派生。
- **同 app 分流**：飞书长连接模式下同一 app 的多条连接会分流事件，
  启动本通道前应停用官方桌面端的 bot，避免消息一半进官方一半进通道。
- 连接拓扑：飞书 ↔ 本机为官方 SDK 长连接（出站 WSS 到 open.feishu.cn），
  引擎在本机（zcode --web），**全链路不经过 zcode.z.ai**。

## 状态所有者

```
飞书 WSS 事件 ──► feishuClient(adapters) ──► coordinator(app) ──► engineClient(adapters) ──► 引擎
                     │                        │                                          │
                传输/卡片 API      chat→task 映射、模式、去重、节流              会话/回合/队列(唯一所有者)
                     ▲                        │                                          │
                     └──── replyFormatter(domain 纯函数) ◄── readSessionMessages ◄─────┘
```

- 引擎拥有会话、回合与输入队列；通道层不持有第二份队列或回合状态。
- coordinator 只拥有：chatId→taskId 映射、每 chat 的 ReplyMode、去重 LRU、节流定时器、卡片 messageId。
- domain 层纯函数（无 IO、无 await），可独立单测。

## 失败语义

- 引擎 WS 断开：coordinator 指数退避重连；期间飞书消息回执「引擎未连接，消息未被接受」（不静默丢弃）。
- 引擎创建/发送失败：回执错误文本（去除内部地址后）。
- 飞书发送失败：记 warn，不重试风暴（单次重试后放弃）。
- 进程退出：`handle.stop()` 关闭 WS 客户端与飞书长连接。

## 迁移边界

- 不修改引擎协议与 `packages/shared` 类型；引擎能力缺失时在 adapters 内降级。
- 飞书 SDK 仅出现在 adapters 层；替换通道（如企业微信）只需换 adapters。
