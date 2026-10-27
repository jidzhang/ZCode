# 会话标题手动重生成（右键菜单「自动命名」）

## 背景与目标

自动标题生成只在 turn 0 尝试一次；Stop 掉首轮、模型空响应或复述原文后，标题永久停留在
first_input 兜底（首条消息原文截断）。用户需要一个显式补救入口：任务右键菜单在「重命名任务」
旁新增「自动命名」，读取会话已有对话（不止首条）重新生成标题。

设计参考（2026-10-26 考察）：opencode `/rename` 无参=重新生成（Original request + Recent
conversation 两档素材）；Codex thread_title（最近 8 条实质消息）。本 spec 只做手动入口，
不改任何自动触发行为（自动重触发方案已被否决，见 LOCAL-PLAN-SESSION-TITLE.md）。

## 命令链路与所有权

```
UI 右键菜单「自动命名」
  → task-mutation mutateProjectTask({kind:"regenerate-title"})
  → [desktop] windowHostControllerService.mutateTask case → taskService.regenerateTaskTitle
  → zcodeTaskServiceAdapter.regenerateTaskTitle
  → agentService.sendConversationCommandV4({type:"regenerateSessionTitle"})
  → CLI v4 gateway CommandInbox admission（历史会话触发冷恢复，与 renameSession 同名单）
  → bootstrap session-mgmt handler → runtime.regenerateSessionTitle
  → core：素材拼装 → generateTitleCandidate → updateSession → SessionTitleUpdated
  → product-projection meta 更新 → host task index syncer → 广播 task_list_changed → 三端列表
```

- 标题唯一 owner 仍是 CLI session store（title/titleSource）；UI 与 task-index 只投影。
- ACK 同步等待生成完成（单次小模型请求，timeoutMs 默认 60s；v4 命令通道无客户端超时）。
  成功 status=accepted（不新增 result variant，标题经事件流更新列表）；失败 status=failed
  → adapter 抛错 → UI toast。
- 幂等性：命令带独立 commandId；重复点击=再次生成，last-write-wins，可接受。

## core 语义（runtime.regenerateSessionTitle）

守卫（与自动生成的差异用 **粗体**）：
- 会话必须存在、非 child（parentSessionId）、taskType=interactive；否则 fault 拒绝。
- **不检查** turnNumber / sessionTitleGenerationAttempted / titleSource=custom（显式动作，
  允许覆盖 custom 与已生成标题）。
- 无可见真实用户消息（synthetic / model-only / 空）→ fault `session_title_no_input`。

素材拼装（opencode 两档式）：
- Original request = 首条可见真实用户消息文本，截 2000 字符。
- Recent conversation = 其余可见 user 消息 + assistant 消息的 text parts（排除
  reasoning/tool/synthetic/ignored），每条截 600，整体保尾截断到 6000。
- 拼装后作为 generateTitleCandidate 输入（sidecar 输入上限放宽到 8000，默认路径 1200 不变）。
- 只有首条时退化为单条素材（等价现状自动生成，但不受 turn 0 限制）。

写回：
- `expectedTitleSources: ["default","first_input","generated","custom"]`（存储层允许覆盖
  custom；并发下被用户改名抢先则乐观锁拒绝，不覆盖）。
- titleSource=generated，不写 titleMessageID（素材非单消息）。
- SessionTitleUpdated 事件 payload 增加可选 `reason:"manual_regenerate"`：product-projection
  的 custom 粘性（`prev.titleSource==="custom" && source==="generated"` 吞事件）对该 reason
  放行；其余路径行为不变。

## 验收场景

1. Stop 掉首轮的会话：右键「自动命名」→ 标题更新为多轮素材生成的新标题，titleSource=generated。
2. 已手动重命名（custom）的会话：点「自动命名」→ 标题被生成结果覆盖，列表投影同步更新。
3. 无用户消息的空会话：命令 failed（fault session_title_no_input），UI toast，标题不变。
4. 生成失败（模型错误/超时）：命令 failed，标题不变。
5. 运行中的任务点「自动命名」：允许（标题 sidecar 独立请求，不打断 turn）。
6. 手机远控（web-remote-replayable）同一命令链路可用。
7. 既有自动生成行为零变化：turn 0 一次性触发、custom 粘性（自动路径）不变。

## 明确不做

- 自动重触发/结果导向守卫（被否方案 P1）。
- 生成失败自动重试、生成后相似度拒收（P2/P3）——手动入口天然给了用户重试点。
- 专用标题小模型降档（P4）。
