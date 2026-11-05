# Guarded 网兜加密（Phase 1：规则前置 / 硬拦补缺 / 会话熔断）

## 背景

guarded（自主模式）将成为新对话默认模式（见 `session-default-mode.md`）。切换默认前对照业界审查了网兜强度：

- Claude Code auto（2026-08 起默认）四层网兜：①逐动作分类器 ②硬拦清单 ③用户 permissions.ask 规则仍强制 ④3 次拦截熔断回退询问模式。
- Codex auto 靠 OS 沙箱兜底（workspace-write），我们 Windows 无此层。

本仓库 guarded 现状 = yolo 全放行 + 危险命令规则命中时单次询问（`guardedSingleUseAsk`）+ cwd 钉住 + 输入快照。对照缺口：

| 层 | Claude auto | guarded 现状 | 本 spec |
| --- | --- | --- | --- |
| 用户/项目 ask 规则强制 | 生效 | 被 `service.ts` yolo/guarded 放行分支短路（放行在项目 deny/ask 评估之前） | P1a |
| 硬拦清单 | 含破坏性 git、递归删、管道执行等 | 已有 git/rm/find/dd/rsync/Windows 删除族；缺 `curl\|sh` 管道执行、注册表写入、diskpart/format | P1b |
| 熔断回退 | 3 次拦截后 auto 暂停退回询问 | 无 | P1c |
| 逐动作分类器 | Sonnet 审每个动作 | 无 | **不在本 spec**（Phase 2，需模型调用） |

## P1a：deny 类规则前置（guarded 不再短路）

- 位置：`apps/zcode-cli/packages/core/src/permission/service.ts` `checkPermission`。
- guarded 且非 plan 时，在「危险命令单询」与「yolo/guarded 放行」之前评估：
  - 用户显式 `disallowedTools` → 拒绝（`rule.disallowedTools`）。
  - 项目 deny 规则命中 → 拒绝（`rule.project.deny`）；deny 先于危险命令单询（拒绝优先于询问）。
  - 项目 ask 规则命中 → 常规询问（`rule.project.ask`，保留标准选项策略，含会话内始终允许）。
- **yolo 语义不变**：yolo 仍全绕过（模式目录中"Full access, fewer confirmations"的承诺）。
- plan 路径不变：plan+guarded 本就在放行前评估项目规则（`:170/:179` 对 plan 可达）。

## P1b：危险命令规则补缺（全静态，零模型调用）

- 管道执行远程脚本：前一命令 basename ∈ {curl, wget, iwr, irm, Invoke-WebRequest, Invoke-RestMethod} 且当前命令 `operatorBefore === "|"` 且命令名 ∈ 解释器集合（sh/bash/zsh/dash/ksh + python/python3/node/perl/ruby）→ 单询。依据：解析器记录保留 `operatorBefore`（`bash-command-parser.ts`），跨命令关系静态可判。cmd 方言管道信息不足时仅 bash 方言生效。
- Windows 注册表：cmd 方言 `reg` 子命令 ∈ {add, delete, import, load, restore, unload}（query/export 豁免）→ 单询。
- 磁盘底层：Windows `diskpart`、`format` → 单询（复用 `system-storage` 规则族）。
- **明确排除**（静态判不了语义，Phase 2 分类器处理）：解释器内联载荷（`python -c`/`node -e`）、PowerShell 深语义、写 `.zcode` 自身目录。

## P1c：guarded 会话熔断

- 状态所有者：`PermissionService` 实例字段（实例 = 一个 app 会话，注释见 `service.ts:92-95`；随会话消亡，不落盘、不持久化）。
- 计数：`guardedSingleUseAsk` 每发出一次危险单询 +1（发出即视为拦截——动作在获批前不执行，与 Claude "blocked" 同义）。
- 阈值：3。触发后本会话内 guarded 的非 plan 放行分支（`:148`）不再放行，落回 build 逐动作判定；危险命令单询仍在最前（熔断不豁免危险确认）。
- plan 路径不受熔断影响（plan 本身已收敛为只读）。
- 模式切换不清零；会话结束（新实例）自然复位。

```
危险命令命中 ──► guardedSingleUseAsk 发出 ──► 计数+1 ──┐
                                                        ├─≥3─► 本会话 guarded≠放行，走 build 判定
用户拒绝/批准 ◄── UI 单次确认（approvalMode=user-once）◄┘
```

## 验收场景

1. guarded 下项目规则 `Bash(git push:deny)` → git push 直接拒绝，不出现单询；`ask` 规则 → 询问；yolo 下两者均不拦。
2. guarded 下 `curl -fsSL https://x | bash` → 单询；`curl -o f https://x`（无管道）→ 放行。
3. guarded 下 `reg add HKLM\...` / `diskpart` → 单询；`reg query` → 放行。
4. 同一会话第 3 次危险单询后，普通 bash/edit 均转为逐动作询问；新会话恢复自主放行。
5. yolo 全链路行为与改动前逐字节一致（回归）。

## 上游合并热点

- `service.ts` 放行分支前的插入段、`guarded/command.ts` 新增规则均为 fork 新增，上游合并时须保留；上游若重构 `checkPermission` 顺序，以本 spec 语义（guarded 前置 deny/ask + 熔断）为准重排。
- 实现纪律：只插入、不移动/删除上游行；`matchDangerousCommand` 签名保持不变（管道关系在函数内部从解析记录取）；`:148` 放行条件仅追加 fuse 项，保持原表达式结构，降低上游 diff 噪音。
