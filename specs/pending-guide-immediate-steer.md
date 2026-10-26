# 待插话消息「立即处理 / 撤销 / 修改」(pending guide actions)

## 背景

guide(插话)输入在 CLI 只有两个消费边界:整个 tool batch settle 后(`turn-tools.ts` drain)与
text-only step 收口。单个长工具(如 `sleep 430`)期间没有任何注入点,用户只能干等;等不住按
Stop 后,已发送的待插话被降级为 held queue,还要再手动发一次(用户日志实测:5 天 50 次
Stop、24 次杀正在跑的 Bash)。Claude Code 2.1 / Codex CLI 的即时性均来自「打断当前工具 +
消息立刻生效」这一等公民操作。

2026-10-25 实机验证「立即处理」通过后,用户提出对称缺口:待插话消息尚未生效,应支持
「撤销」(不要了)与「修改」(改完再等/再发);正在被模型处理的消息不可撤销合理,等待中的
消息不该只有复制。两条能力协议层早已存在(`deleteQueueItem` / 队列面板的撤回编辑),
本次只是把入口补到消息行。

## 产品规则

1. 显示 `chat.message.turnSteer.pending` 状态("Waiting to steer the current run…")的
   待插话消息行,操作行按钮顺序(用户定稿 2026-10-26):「立即处理」「撤销」「复制」「编辑」。
2. 「立即处理」点击语义 = 中断当前运行 + 该消息作为新输入立即生效(会话继续、被打断的
   工具以 cancelled 结果留在历史,模型可见)。
3. 「撤销」点击语义 = 二次确认后从队列删除该待插话(`deleteQueueItem`),消息行消失。
   确认走全局 ConfirmDialog(destructive 变体,RootShell 挂载、桌面与手机远控同源),
   标题含消息摘要(单行、60 字截断),描述说明不可恢复并指路「编辑」;取消则不动。
4. 「编辑」点击语义 = 撤回到输入框重新编辑(队列面板同款「撤回编辑」):`deleteQueueItem`
   删除队列项 + 文本回填 composer 草稿;用户改完重新发送成为新输入,无确认(内容回到
   输入框不算丢失)。不使用 `editQueueItem` 原地改文(需气泡内编辑态,且与队列面板既有
   语义不一致)。输入框有草稿或 busy 时沿用 `chat.queue.editDraftConflict` 提示并拒绝撤回。
5. 已处理消息(复制+编辑)与普通 queue 项不出现这三个按钮;queue 项沿用队列面板的
   「立即发送/编辑/移除」。按钮只经 `ConversationPendingGuideList` 注入,普通行不传回调
   即不渲染。待插话行不注入 onEdit,编辑位由 onRecallEditQueued 占据,两族按钮天然互斥。
6. 桌面 hover 显示、手机远控常显(沿用该操作行既有显隐规则),一次改动两端生效。
7. 失败语义与队列面板一致:命令被 CLI 拒绝(如 turn 刚结束、availability 变化)仅日志
   warn,消息原样保留,无额外 UI 状态。

## 状态所有者与接口

- 唯一所有者不变:CLI CommandInbox/core `pendingInputs`(queue 与 guide 同一 id 空间,
  `queueItemId ≡ pendingInputId`)。UI 只读投影 `snapshot.queue` 中
  `delivery.admitted === "guide"` 的项,不复制状态。
- 「立即处理」复用 v4 `sendQueuedNow` 命令,不新增命令:reserve(同时挡住边界 drain 竞态)→
  preempt 当前 turn → markPromoting → `startPromptTurn`(preempted 时
  `inputPresentation: "user_steer"`)→ remove(reason `promoted`)。CLI 侧零行为改动。
- 「撤销」「修改」复用 SessionPane 既有 `handleDeleteQueueItem` / `handleEditQueueItem`
  (队列面板同源 handler,含 sourceCommandId settle 与撤回编辑的 composer 恢复链),
  CLI 侧零行为改动。
- availability 沿用 `sessionActionAvailability.sendQueuedNow`(running/prewarming 允许,
  guide 行只存在于 running);删除/撤回与队列面板一致不做 availability 门禁,由 CLI
  revision CAS 与 reservation 兜底。
- UI 回调链(可选回调,逐层透传,不进协议):
  `SessionPane.handleSendQueuedNow / handleDeleteQueueItem / handleEditQueueItem →
ConversationTimeline.onSteerNow / onRevokeQueued / onRecallEditQueued →
ConversationPendingGuideList → ConversationTurnRow → ConversationRowView →
SingleUserInputRowView`(MessageActions 内渲染,test id `v4-pending-guide-steer-now` /
  `v4-pending-guide-revoke` / `v4-pending-guide-recall-edit`)。

## 事件顺序

```
用户点「立即处理」(renderer)
  → v4 sendQueuedNow { queueItemId } (CommandInbox 串行 admission, revision CAS)
  → core: reservePendingInputById(边界 drain 从此跳过该项)
  → stopActiveForegroundExecution(reason=preempt) → 工具 ToolCancelled 配对入历史
  → (fallbackPendingGuidesToQueue 可能先把该项改投 queue lane;promote 随后移除,无害)
  → markPendingInputPromoting → startPromptTurn(text, user_steer)
  → removePendingInputById(reason=promoted) → 投影移除待插话行

用户点「撤销」
  → ConfirmDialog(destructive,标题含 60 字摘要;取消即中止,不下发命令)
  → 确认后 v4 deleteQueueItem { queueItemId } → removePendingInputById(reason=deleted)
  → 投影移除待插话行;pendingCommandRegistry settle 乐观行

用户点「编辑」(撤回编辑)
  → 草稿冲突检查(composer 有内容/busy → toast,中止)
  → v4 deleteQueueItem → ACK accepted 后文本回填 composer 草稿
  → 用户编辑重发 = 全新 sendText 走正常 admission
桌面 desktop-continuous 与手机 web-remote-replayable 看到同一投影序列,语义一致。
```

## 验收场景

1. running + 存在待插话:按钮按「立即处理/撤销/复制/编辑」顺序可见;点击「立即处理」后
   当前 turn 被 stop、该文本以 `user_steer` 立即启动、原待插话行消失。(CLI 回归测试:
   guide delivery 项走 sendQueuedNow 与 queue 项同路径,不进 steerTurn。)
2. 点击「撤销」:先弹 destructive 确认框;确认后待插话行消失,当前运行不受影响,后续
   drain 不再消费该文本;取消则行保留。
3. 点击「编辑」:待插话行消失,文本出现在输入框;改完重发成为新输入。输入框已有草稿时
   toast 提示且行保留。
4. 手机远控浏览器:按钮常显可点;确认弹层走 RootShell 全局 ConfirmDialogHost。
5. 已处理消息行、无 guide 待插话时:三个按钮不渲染。
6. 命令被拒(如刚 ended):日志 warn,行保留,可重试。
