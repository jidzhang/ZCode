# guide 准入触发前台 Bash 原地转后台（steer-background）

## 背景

guide（插话）在 CLI 只有两个消费边界：tool batch settle 后与 text-only 收口。单个长前台
Bash（bash-timeout-policy 上限 600s，`timeout:{kind:"none"}` 无上限）阻塞期间，用户跟进
消息只能等分钟级。三家源码调研（pi / OpenCode / Codex，2026-11-11）结论：

- 没有任何一家把"发送即打断"当默认；消息一律普通 user 身份、边界注入、模型自决。
- 唯一解"长工具阻塞"的是 OpenCode：steer 触发阻塞 shell/子代理**原地转后台**继续跑，
  工具立即收尾，模型下一步读到消息，后台结果完成后回流
  （app/src/session/requests/steer-background.ts："A steer moves the run's blocking
  shells and subagents to the background, so the agent reads it at its next step"）。

本 fork 采用同语义，全部复用既有后台基建（`bash-background-lifecycle` /
`BackgroundTaskTracker` / 完成通知），不新增协议命令、UI、设置项或默认值。

## 产品规则

1. guide 准入成功（`steerTurn` push pendingInput 之后）且投递为 guide 时，通知 executor
   把**正在前台执行的 Bash** 转后台；queue 投递的消息不触发（本就等 turn 结束）。
2. 转后台语义 = 进程树**不杀**：登记 `BackgroundTaskTracker` 获得 taskId，工具调用立即以
   `status:"backgrounded"` + `backgroundTaskId` 结构化结果收尾；tool batch 随即 settle，
   guide 经既有边界 drain 进入下一次模型请求；后台命令结束后经既有后台通知回流模型。
2a. **运行时长门槛（2026-11-12 用户实测反馈加入）**：只压已运行 ≥10s（默认，
   `steerBackgroundMinElapsedMs` 可注入）的前台 Bash；秒级短命令（git status / rg 等）
   不压、自然跑完——模型拿到真实结果，避免"已移入后台"噪音与迟到的后台通知。
   不足门槛的注册项保留在表里（下次 guide 到达时可能已过门槛），调用结束由
   call-runner finally 摘除。
3. 参与面仅 Bash 族；其余工具等自然结束（与 pi/Codex 护栏一致）。
4. 前台超时语义不变：`auto_on_timeout` 命令维持"到点自动转后台"；`on_steer`（sleep 等
   原排除自动转后台的命令）保留"原 timeoutMs 到点杀进程"的保底——run 层内部 timer 在
   转后台后由 `bashLifecycle.isBackgrounded()` 守卫跳过，结果文案与超时值保真。
5. steer 监听同时覆盖 `auto_on_timeout` 与 `on_steer`：合格命令的转后台时刻由"超时到点"
   提前为"guide 到达"，无 steer 时行为与改动前完全一致。
6. 转后台失败（进程已收尾/无在跑 Bash）静默忽略，绝不阻塞 guide 消费。

## 状态所有者与接口

- 触发信号：`ExecutionRunOptions.steerToBackgroundSignal?: AbortSignal`（abort = 转后台，
  与 `signal` 的取消语义互斥独立）。
- 注册表唯一所有者：`ToolExecutorImpl.steerBackgroundControllers`（toolCallId → controller）；
  `call-runner` 仅对 Bash 登记/finally 摘除；`requestSteerBackground()` 是唯一触发入口，
  返回触发数（诊断用），触发后清空防重复。
- 适配器：`node-execution-adapter-lifecycle.runBashWithBackgroundLifecycle` 增加
  `mode:"on_steer"` 与 steer 监听（进入 foreground 后挂、commit/settle/onExit 摘除）；
  `commitBackground(trigger)` 原子提交（脱离 parent abort、登记 task、resolve outcome）。
- 后台任务生命周期唯一所有者不变：BackgroundTaskTracker / backgroundTasks 记录。

## 事件顺序

```
用户发消息（guide 准入）
  → steerTurn push pendingInputs → TurnSteerQueued
  → executor.requestSteerBackground() → steer controller.abort()
  → 适配器 commitBackground("steer")：进程不杀，登记 backgroundTasks(taskId)
  → 工具结果 backgrounded 收尾 → tool batch settle
  → 既有边界 drain 消费 guide → 下一次模型请求（模型自决继续/调整/放弃）
  → 后台命令结束 → 既有后台通知回流模型
```

## 验收场景

1. 长 bash（如 `sleep 300` timeout 600000）运行 15s 后发消息：≤10s 模型回应消息；
   进程未死（任务管理器/后台面板可见）；300s 后模型收到后台完成结果。
2. 模型自主衔接，无"重新开始"；半截输出与历史上下文连贯。
3. 无 steer 时：合格命令到点自动转后台、sleep 类到点杀进程——行为与改动前一致
   （bash-run-conformance 回归）。
4. 非 Bash 工具运行中发消息：等自然结束（不转后台）。
5. 回归：core 16/16、CLI turbo typecheck、lint、architecture 全绿。
