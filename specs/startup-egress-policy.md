# 启动期出站请求治理（灰度重试与 community 探测）

## 背景

2026-10-30 两轮干净测试（重启 + 空白对话一条 hi + 退出；代理只放行 bigmodel.cn、拦截
zcode.z.ai）实测：启动窗口内自动发出的出站请求与灰度 warn 需要分开看——

**真实出站（Host 侧，不被 enableStartupOutbound 覆盖）**，全部保留：

| 请求 | 承载能力 | 重试行为 | 决策 |
| --- | --- | --- | --- |
| marketing-touch.query | 免费领取套餐推送（`claim_zcode_plan`）+ 活动横幅 | 10min 可见轮询；失败 30s×2ⁿ 退避封顶 10min | 保留 |
| coding-plan getBillingDiscount | StartPlan 余额/额度折扣显示（聊天工具栏） | 挂载即取，无循环 | 保留 |
| 动态工作流灰度 | 动态工作流模式开关（fail-closed） | 启动 2 次，无循环 | 保留 |
| client-scenes.list | 空会话建议词 + 自动化模板 | 渲染时 1 次 | 保留 |
| highspeed-card.prepareTurn | 抽卡；白名单只认 4 个 Coding Plan builtin 身份，其余 0.2ms 本地短路零出站 | 每轮 1 次 | 保留（无需改） |

**本地灰度（main 侧，已被 enableStartupOutbound 默认关罩住=零出站）**，问题是日志噪音：

| 请求 | 机制 | 噪音表现 | 决策 |
| --- | --- | --- | --- |
| renderer-action-trace | `singleFeatureRollout` + 60s setInterval | 开关关闭/网络失败时**每分钟一条 warn**（fetcher 抛错后 TTL 不生效） | 失败设 TTL |
| desktop-context-prompt | 同一 `singleFeatureRollout`，无定时器（Host spawn 时触发） | 启动多条重复 warn（多调用方各打各的） | 失败设 TTL；**且改为 fail-open**（见下） |

**desktop-context-prompt 的 fail-open 修正（2026-10-30 补）**：该开关门控的不是遥测，
而是桌面呈现能力的系统提示教学段——Gen UI 输出目录与渲染说明、`::code-comment` 行内
评论、文件/URL 链接格式（`context/sections/desktop.ts`）。上游 fail-closed 语义叠加
fork 的 enableStartupOutbound 默认关，会让 fork 用户**整体失去 Gen UI 与行内评论**。
已把默认值与服务端未下发（缺席）语义都改为开启：服务端仍可显式 `enabled:false` 关闭。
| community 可见性探测 | `CanOpenCommunity` IPC，App 挂载即触发 | 每次**启动必现一条误导性 warn**（开关抛错被当成 fetch 失败记日志） | 探测改本地 |

## 产品规则

1. **灰度配置失败退避**：`singleFeatureRollout`（action-trace / context-prompt 共用）在
   fetch 失败后（含 enableStartupOutbound 开关抛错），同样进入缓存窗口
   （`failureCacheTtlMs`，默认 10 分钟）。窗口内后续 `refresh()` 直接返回快照，不再调
   fetcher、不再记 warn。成功 TTL 仍为 1 小时不变。
   - 修前行为：action-trace 的 60 秒定时器每分钟触发一次 fetcher 抛错 → 每分钟一条
     warn 刷屏（默认开关关闭时也如此）；context-prompt 的多个启动调用方各打各的。
   - 修后行为：首次失败后 10 分钟内静默，之后重试。
2. **community 入口可见性探测不出网也不走开关**：`CanOpenCommunity` IPC 只读本地内置
   配置（`remote: false`）判断社区入口是否展示，消除启动必现的误导性 warn；远端覆盖
   只在用户真正点击社区入口（openCommunity，保持远端+本地合并解析）时生效。代价：若
   服务端下线某语言的社区且本地仍有 URL，入口可见但点击后打不开（warn 日志），可接受。
3. Host 侧五类真实出站请求（marketing-touch、billing、灰度、client-scenes、highspeed）
   全部保留原语义，本 spec 不改它们的触发时机与轮询。
4. 插件市场已确认启动零出站（打开市场页才拉取），无需改动。

## 验收场景

1. `enableStartupOutbound` 关闭（默认）启动：action-trace 首次 refresh 抛错记一条 warn
   后，10 分钟内的 60s 定时器触发不再产生新 warn、不再调 fetcher。
2. context-prompt 启动期多个调用方（首 Host 裁决 + Host 创建顺带刷新）在首次失败后共享
   退避窗口，只有第一条 warn。
3. 开关打开且网络阻断：真实 fetch 失败同样进入 10 分钟退避（不再每分钟打网络）；网络恢复
   后最迟 10 分钟自愈拿到新配置。
4. 启动日志不再出现 `[community] failed to fetch remote config`；点击社区入口仍能打开
   正确 URL（远端优先、本地兜底）。
5. 成功路径回归：TTL 1 小时内 refresh 不重复发请求（既有测试保持通过）。

## 状态所有者与事件顺序

- 灰度快照唯一所有者仍是 `singleFeatureRollout` 的模块级闭包状态
  （`snapshot` / `snapshotExpiresAt` / `inFlight`）。失败 TTL 只是让 `snapshotExpiresAt`
  在 catch 分支也被赋值，不引入新状态。
- 社区 URL 解析唯一所有者是 `resolveCommunityUrl`；探测路径新增 `remote: false` 入参，
  不复制解析逻辑。
