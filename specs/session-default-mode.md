# 新对话默认模式改为 guarded（自主模式）

## 背景

Claude Code（2026-08-14 起新会话默认 auto）与 Codex CLI（默认 auto + OS 沙箱）已将交互会话默认切换为"自治执行、风险才问"；Gemini CLI 与 opencode（本仓库血统）仍为逐动作询问默认。本 fork 决定跟进前者方向：新对话默认 `guarded`，同时配套网兜加密（见 `guarded-safety-net.md`，同版本发布）。

存量用户不受影响：composer Recent 继承优先于默认值（`newTaskDraft.ts`），用户新近用过的模式继续作为新草稿初值。

## 默认值的三处独立来源（全部改 guarded）

| 来源 | 位置 | 生效场景 |
| --- | --- | --- |
| composer 草稿默认 | `packages/ui/src/v4/composer/{newTaskDraft,draftWorkspaceDefaults,useDraftConfigControl,V4ComposerModeControls,composerSubmissionConfig,composerDraftStore}.ts(x)` | Desktop/Web 新任务草稿初值；plan 冻结/持久化重映射目标 |
| CLI 配置默认 | `apps/zcode-cli/packages/contracts/src/config/index.ts` `DefaultRuntimeConfig.permission.mode` | standalone CLI 无 `--mode`、配置文件未写 `permission.mode`、项目无持久化模式时 |
| automation/off-peak 表单默认 | `packages/ui/src/settings/automationAgentConfigOptions.ts` `AUTOMATION_DEFAULT_MODE` | 新建/编辑自动化与闲时任务的表单初值（存量记录保持已存值） |

另有单点默认跟随：`packages/shared/src/execution-state.ts` `resolveExecutionState` 默认 `current.mode`（接纳边界旧发送端无 mode、runtime 构造、fork 无历史兜底）；CLI core/cli 侧 `config.mode ?? "build"` 防御性读兜底同步改为 guarded（`config.mode` 构造时必有值，纯语义对齐）。

## 排除面（不动）

- `normalizeAvailableZCodeMode` 未知历史值→"build"：投影兼容层，语义是"历史值归一"不是"默认"。
- `input-intent-persistence.ts` bot 群任务授权固定 build：群消息安全边界。
- provider native `"default"` 模式（`mode.label.glm.default`）：另一语义的档位文案。
- headless `--prompt` 默认 yolo（`run.ts` `DEFAULT_HEADLESS_PROMPT_MODE`）：无人值守场景独立决策。

## 验收场景

1. Desktop 新建会话（无 Recent）→ composer 模式显示「自主模式」；发送后 CLI 会话 mode=guarded。
2. 手动切到「变更前确认」并发送 → 再新建会话 → Recent 继承仍优先（不回退 guarded）。
3. automation 新建表单初值 = 自主模式；存量自动化执行模式不变。
4. standalone CLI 不带 `--mode` 启动 → 初始模式 guarded；`--mode build` 显式指定仍生效。
5. 项目持久化模式（曾显式切换过）优先于新默认。

## 上游合并热点

上游默认仍为 build。合并冲突时以下位置**必须保 guarded**（同插话默认 guide 的保法）：`contracts` `DefaultRuntimeConfig.permission.mode`、`shared/execution-state.ts` 默认 current、`ui/v4/composer/*` 六处兜底、`AUTOMATION_DEFAULT_MODE`，及其测试断言、docs 中默认值描述段落。
