# 待插话消息「立即处理 / 撤销 / 修改」(pending guide actions)

> 2026-11-17 修订：上游 3.18.2 把队列项编辑统一进 composer 编辑模式
> （beginQueueItemEdit：lockQueueItemEdit 加锁 + 编辑态 + 提交时删除生效），
> fork 旧版行内「撤回编辑」实现（handleEditQueueItem，点击即删+回填草稿）随之
> 移除，「修改」按钮改接 beginQueueItemEdit；同一 CLI deleteQueueItem 命令路径。
> `chat.queue.editDraftConflict` 文案已随旧行为删除。

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
4. 「编辑」点击语义 = 进入 composer 编辑模式（队列面板同款，上游 3.18.2 引入）：
   `lockQueueItemEdit { queueItemId, editorId }` 给队列项加编辑锁（editorId 先经身份
   确认，防多端/复制标签页串写），ACK accepted/duplicate 后 `enterEditScope` 把文本、
   附件、引用与提交时配置回填 composer 编辑态；用户改完点发送时才真正
   `deleteQueueItem`（删除生效）+ 新输入走正常 admission。不使用 `editQueueItem`
   原地改文。busy 时 toast `chat.composerEdit.busy` 并拒绝进入；锁失败按
   reserved/locked/generic 分类 toast `chat.composerEdit.lockFailed.*`；composer
   已有草稿时切换 edit scope（不拒绝，草稿由编辑态接管）。
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
- 「撤销」复用 SessionPane 既有 `handleDeleteQueueItem`（队列面板同源 handler,含
  sourceCommandId settle），CLI 侧零行为改动。
- 「修改」复用 composer 编辑模式 `composerEdit.beginQueueItemEdit`
  （`packages/ui/src/composer-edit-mode/useComposerEditMode.ts`）：加锁/编辑态/提交
  删除生效/切换释放锁都是编辑会话状态机的既有职责；新增协议命令 `lockQueueItemEdit`
  （上游 3.18.2），fork 沿用不另起炉灶。
- availability 沿用 `sessionActionAvailability.sendQueuedNow`(running/prewarming 允许,
  guide 行只存在于 running);删除/编辑与队列面板一致不做 availability 门禁,由 CLI
  revision CAS 与 reservation/editLock 兜底。
- UI 回调链(整包下发 `PendingGuideActions { steerNow, revoke, recallEdit }`,
  all-or-none 由单对象保证,`SessionPane.tsx` 构造 → `ConversationTimeline` →
`ConversationPendingGuideList → ConversationTurnRow → ConversationRowView →
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

用户点「编辑」(composer 编辑模式)
  → busy 检查(composer busy → toast 拒绝,中止)
  → ensureEditorIdentity → v4 lockQueueItemEdit { queueItemId, editorId }
  → ACK accepted/duplicate 后 enterEditScope:文本/附件/引用/配置回填 composer 编辑态
  → 用户改完点发送 = deleteQueueItem(提交时删除生效) + 新输入走正常 admission;
    取消编辑或切换 task 则 releaseLock 归还锁
锁失败(reserved/locked/generic)与 busy 均 toast 且行保留。
桌面 desktop-continuous 与手机 web-remote-replayable 看到同一投影序列,语义一致。
```

## 验收场景

1. running + 存在待插话:按钮按「立即处理/撤销/复制/编辑」顺序可见;点击「立即处理」后
   当前 turn 被 stop、该文本以 `user_steer` 立即启动、原待插话行消失。(CLI 回归测试:
   guide delivery 项走 sendQueuedNow 与 queue 项同路径,不进 steerTurn。)
2. 点击「撤销」:先弹 destructive 确认框;确认后待插话行消失,当前运行不受影响,后续
   drain 不再消费该文本;取消则行保留。
3. 点击「编辑」:composer 进入编辑态并载入该待插话内容,行上出现编辑锁投影;点发送后
   原行消失、新输入按正常 admission 生效;busy 时 toast 拒绝且行保留。
4. 手机远控浏览器:按钮常显可点;确认弹层走 RootShell 全局 ConfirmDialogHost。
5. 已处理消息行、无 guide 待插话时:三个按钮不渲染。
6. 命令被拒(如刚 ended):日志 warn,行保留,可重试。
