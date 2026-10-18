# Bot 忙判定：僵尸 running 快照的活查与缓存

## 背景

Bot 的忙判定（`getContextTaskBlockReason`）长期依赖两条事实：本进程内存集合 `runningTasks`，
以及任务持久化快照的 `meta.status`。2026-10-15 的修复让快照 `status==="running"` 优先于内存集合，
解决"桌面发起的任务补话不排队"。

但实测发现反例（2026-10-16）：后台命令的终态无人观察时，持久化快照会残留 `running`，而运行时
早已零活动。此时 Bot 回"当前任务正在运行"，并把后续所有补话拦下或排队，用户只能反复发 `/停止`。

## 方案

快照 `status==="running"` 不再是终点，改为向运行时要一次活的 busy 判定（CLI 权威快照）：

- 只有运行时明确进入终态相位（`completedSuccess` / `completedInterrupted` / `error`）才推翻快照，
  清理内存集合与 typing 状态并放行消息。
- `draft` / `prewarming` / `running` 一律维持原判定，不误放行真正在跑的任务。
- Bugfix（2026-10-18 审查补充）：终态相位与 `queue.items` / `pendingInteractions` 并存时
  （回合结束后 host 命令队列才 drain），折算成 `running` 维持排队——按终态放行会让新消息
  插到排队输入之前，重演"忙时直投"乱序。
- 查询失败、方法缺失或超预算，同样维持原判定（保守兜底，不改变既有行为）。
- Bugfix（2026-10-18 审查补充）：判定按 TTL 缓存，但放行投递会让任务真正跑起来；投递时
  作废该任务的缓存，避免 TTL 窗口内的下一条补话命中旧"已完成"结论被直投进运行中的回合。

判定与失败都按任务缓存 5 秒。这个 TTL 远小于前台命令队列的等待时间，不构成放行竞态；
失败也缓存是为了运行时离线时不让每条补话都等满一次预算。

## 接口与边界

- `IZCodeTaskService.getTaskRuntimeBusyState?` 为可选方法，返回 `true`（忙）/`false`
  （运行时确认空闲，可推翻僵尸 running）/`null`（查询失败或能力缺失，保守按忙）。
  可选方法缺失时调用会短路，不抛错，直接落到保守判定。
- 读取复用 `readBotGroupRuntimeSnapshot(agent, target, signal?)`。`signal` 由调用方提供：
  DM 补话路径是本进程注册过的本机任务（无 `remoteSessionId`）给 1 秒；注册但带
  `remoteSessionId` 的远端任务与未注册任务（多为桌面发起、可能落在远端）同样走远端链路，
  统一给 4 秒。只 `Promise.race` 而不中断读取，会让半死运行时下每条消息都留下一个
  活到 15 秒兜底的订阅。
- 过期订阅/监听器释放由 `observeRuntime` 收口：中止信号与 ACK 竞态、迟到 ACK 的释放沿用
  既有逻辑，本次只补上调用方传入 signal 这一条路径。
- 判定错误一律 `warn` 记录（含 workspace mismatch 这类路由错误），与"运行时半死"可在日志中区分。

## 验收

- 快照 `running` + 运行时终态 → 消息放行进 `sendPrompt`，不排队、不拒绝。
- 快照 `running` + 运行时 `running` → 仍然排队。
- 快照 `running` + 查询失败 → 仍然排队。
- 同一任务 TTL 内连续两条补话只探测一次运行时。
- 调用方中止探测（预算耗尽）时订阅与监听器立即释放。

## 未覆盖 / 刻意不做

- 不回写任务索引把快照从 `running` 纠正为终态：Bot 不是任务状态所有者，且 fake 与真实
  store 的返回值语义不一致，跨 store 纠正需要先与上游对齐接口。
- 判定虽以 `control.phase` 为主，但同时读取快照里的 `queue.items` 与 `pendingInteractions`：
  终态与排队输入/待交互短暂并存（host 队列在回合结束后才 drain）时按忙维持排队，
  否则新消息会插到排队输入之前。
