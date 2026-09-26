# SPEC: wechat-channel（微信通道，微信 iLink bot 协议、纯文本降级渲染）

## 目标

为自建部署提供一个微信 bot 通道，作为 `@zcode/server`（`zcode --web` 后端）的 WS 客户端，
复用引擎会话/队列/权限管理，与 `packages/feishu-channel` 同构。对齐官方闭源 bot 层的行为，
并修正 safe-zcode 的三个既有目标：

1. **零遥测（严格禁用）**：本通道不产生任何上报；safe-zcode 全链路默认禁用，
   只有显式 `ZCODE_TELEMETRY=on` 才允许出站。
2. **忙时不丢消息**：turn 进行中的新输入经引擎 `enqueueTaskCommand` 排队，通道层不丢弃。
3. **纯文本媒介的降级渲染**：微信 iLink 没有飞书那种可 PATCH 的交互卡片，
   `stream` 模式降级为「接受回执 + 运行期间 typing 指示 + 终态文本」。

## 协议事实（逆向自官方闭源 host 包）

来源：`D:\work\github\zcode_debug\host\__out__host__index.js`（`createWeixinBotProvider`、
`requestWeixinJson`、`getWeixinUpdates`、`beginWeixinRegistration`、`pollWeixinRegistration`）。
iLink 是微信私有接口，随微信版本可能变化；字段读取按闭源实现的宽容风格
（多候选字段名依次回退），不可验证处如实标注。

- **Base**：`https://ilinkai.weixin.qq.com`，路径前缀 `/ilink/bot`。
- **鉴权头**（POST 业务接口）：`content-type: application/json`、
  `AuthorizationType: ilink_bot_token`、`Authorization: Bearer <bot_token>`、
  `X-WECHAT-UIN: base64(random uint32 十进制字符串)`（闭源原样镜像，服务端大概率不校验取值）。
- **统一响应语义**：业务体可带 `base_info: {channel_version: "2.0.0"}`；
  `ret !== 0` 或 `errcode !== 0` 视为失败，错误文本取 `errmsg`/`message`；
  部分响应包一层 `data`，读取前先解包。
- **收消息**：`POST /getupdates`，体 `{get_updates_buf: <游标>}`，服务端长轮询约 90s。
  消息数组在解包后的 `msgs`（兼容 `messages/updates/items/list`）；
  下一游标在 `get_updates_buf`（兼容 `buf/next_buf/nextBuf/getUpdatesBuf/syncKey`），
  透传即可，首轮空串。
- **入站过滤**：`message_type === 2` 是机器人自发消息的回显，必须跳过（防自循环）；
  文本在 `item_list[].text_item.text` 或顶层 `text/content`；
  发送者在 `from_user_id`（兼容 `from/from_user/user/user_id/from.id` 等候选）；
  群聊消息带 `room/room_id/chat/chat_id` 任一字段——**官方明确 bots 不支持群聊**。
  `context_token` 在顶层或内层 `msg` 上，回复时必须原样回传（被动回复语义）。
- **发文本**：`POST /sendmessage`，
  `msg: {from_user_id, to_user_id, client_id, message_type: 2, message_state: 2,
context_token?, item_list: [{type: 1, text_item: {text}}]}`；
  `client_id` 为 `zcode-weixin-<uuid>` 幂等键；文本换行统一转 `\r\n`；
  `from_user_id` 传机器人自身 id（登录后未知则传空串，与闭源回退一致）。
- **typing**：`POST /getconfig`（体含 `ilink_user_id`、`context_token?`）→ 响应 `typing_ticket`
  → `POST /sendtyping`（体 `{ilink_user_id, typing_ticket, status: 1}`）。
- **登录**（GET，仅带头 `iLink-App-ClientVersion: 1`，无需 token）：
  1. `GET /get_bot_qrcode?bot_type=3` → `qrcode`（二维码内容串）、
     `qrcode_img_content`/`qrcode_url`（展示用）、`expires_in`（缺省 120s）。
  2. 每 3s `GET /get_qrcode_status?qrcode=<urlencoded>`；
     状态归一化：`0=pending, 1=scanned, 2=success, 3|4=expired`，字符串另有别名表。
  3. 成功响应取 `bot_token`（兼容 `token`）与 `ilink_bot_id`（兼容 `bot_id`）。
- **附件**（image/file/video/audio item + `aes_key`，AES-128-ECB 解密 CDN 下载）：
  V1 不做，字段读取器保留在协议层但通道不消费。

## 行为

- 每个微信用户（私聊）绑定一个引擎 task（懒创建，首条消息时创建）。
  任务协作模式默认 **yolo**（`WEIXIN_TASK_MODE` 可覆盖），与官方 bot 一致。
- **仅私聊**：带群字段的消息回执一次「仅支持私聊」后忽略（与官方提示语一致）；
  回执失败静默（群上下文的 `context_token` 是否可用未验证）。
- 消息去重：优先 `message_id`（多候选字段）；缺失时以
  `synthetic:userId:时序或context_token:text` 复合幂等键（纯字符串，domain 不依赖哈希；
  闭源对缺失 id 不去重，这里更保守）。
- 命令（消息文本整行匹配，与飞书通道一致）：
  `/help`、`/mode <final|stream|verbose>`、`/stop`、`/new`；
  非命令文本 → `sendPrompt`；task 忙时 → `enqueueTaskCommand` 入队，回执「已排队」。
- 回复模式（纯文本降级语义）：
  - `final`：回合结束后一条纯文本。
  - `stream`（默认）：接受时回执占位提示，运行期间按节流刷新 typing 指示，
    回合结束发送终态文本。**没有中间内容更新**（媒介不支持）。
  - `verbose`：同 `stream`，终态文本附加工具调用行（工具名 + 状态标记）。
- 渲染数据源：终态用 `readSessionMessages` 全量重读最后一条助手消息，
  幂等、乱序安全；流式中间态不渲染（无媒介），事件仅作 typing 触发信号。

## 凭证来源

- `node scripts/wechat-login.mjs`：扫码登录，轮询成功后把 `WEIXIN_BOT_TOKEN` /
  `WEIXIN_BOT_ID` 写入本包 `.env.local`（已 gitignore）。
- 登录接口无需鉴权头；`bot_token` 即后续全部业务调用的 Bearer 凭证。
- 官方桌面端保存的微信凭证是 `enc:v1` 信封，格式与飞书同类；V1 不做复用解密
  （`reuse-official-credential.mjs` 仅覆盖飞书），需要时另行扩展。

## 状态所有者

```
微信 getupdates 长轮询 ──► weixinClient(adapters) ──► coordinator(app) ──► engineClient(adapters) ──► 引擎
        │                        │                        │                                          │
   HTTP+游标/重试           传输/sendmessage/typing   userId→task 映射、模式、去重、            会话/回合/队列(唯一所有者)
                                                      typing 节流、最近 context_token                    │
                            ▲                        │                                                  │
                            └──── replyFormatter / weixinProtocol(domain 纯函数) ◄── readSessionMessages ──┘
```

- 引擎拥有会话、回合与输入队列；通道层不持有第二份队列或回合状态。
- coordinator 只拥有：userId→taskId 映射、每用户 ReplyMode、去重 LRU、
  typing 节流定时器、每个会话最近的 `context_token`。
- `context_token` 属于「最近一条入站消息」的会话属性，不与引擎 task 混存；
  发送终态文本时携带最近一次入站的 token（缺失则不带，与闭源一致）。
- domain 层纯函数（无 IO、无 await），可独立 `node:test` 单测。

## 失败语义

- getupdates 网络错误/超时：游标保留，指数退避（1/2/5/10/30s 封顶）后继续长轮询；
  连续失败只在日志累计提示「token 可能失效，请重新扫码」，**不自动退出**
  （iLink 错误码语义未公开，无法可靠区分鉴权失败与网络抖动，宁可保守重试）。
- 引擎 WS 断开：coordinator 指数退避重连；期间微信消息回执「引擎未连接，消息未被接受」。
- 引擎创建/发送失败：回执错误文本（去除内部地址后，截断 160 字符）。
- 微信发送失败：warn + 单次重试后放弃，不做重试风暴。
- typing 失败：静默降级（warn 一次），绝不影响主回复链路。
- 进程退出：`handle.stop()` 中止长轮询（AbortController）并断开引擎 WS。

## V1 范围外（明确不做）

- **附件收发**：协议层保留字段读取器；下载/解密/上传进引擎为后续工作项。
- **群聊**：官方不支持，回执提示后忽略。
- **权限请求转发**：默认 yolo 建任务，权限链路天然不触发；非 yolo 模式下
  权限请求无微信侧交互入口（与飞书通道 V1 同一决策）。
- **工具实时流式状态**：媒介不支持；`verbose` 的工具行来自终态消息重读。
- **官方凭证信封复用**：仅实现扫码登录直取 token。

## 迁移边界

- 不修改引擎协议与 `packages/shared` 类型；引擎能力缺失时在 adapters 内降级。
- 全部 iLink 细节（fetch、header、游标）只出现在 adapters 层；
  domain 的 `weixinProtocol.ts` 只做无 IO 的请求体构造与响应解析。
- 与 feishu-channel 的 coordinator/engineClient 存在结构性重复：
  **有意的**——等两个通道行为稳定后，把 channel 无关部分（chat→task、去重、模式、
  节流）提升为共享的 channel-core，避免过早抽象锁死两个通道的差异。
  微信 SDK 无官方 Node SDK，不引入第三方依赖，transport 用全局 fetch。
