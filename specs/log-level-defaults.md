# 日志级别默认值与设置入口

## 背景

2026-10-29 实测 `~/.zcode` 日均产生约 30 MB 日志（`v2/logs` 3.5–24 MB + `cli/log` 11–22 MB），
14 天 `v2/logs` 累计 169 MB、7 天 `cli/log` 累计 147 MB。按级别拆 10-28：info 占两侧字节
91.6% / 91.8%，其中 `v2/logs` 的 info 有 37.8% 是 `[rpc:call] xxx OK (x ms)` 成功调用、
9.6% 是内存心跳、6.2% 是 `rpc:listen`。

fork 早已引入 `settings.json` 的 `logLevel` 阈值（`packages/desktop/src/main/logger.ts`
`configuredMainLogLevel`），但存在三个缺口：

1. 默认值 `info`，与"默认安静、需要时再放大"的运维直觉相反。
2. 只作用于 desktop main / renderer / host 中继日志（`v2/logs`）。Agent 进程写
   `cli/log/*.jsonl`，其级别由 `createNodeLoggerFactory` 的
   `getDefaultMinLevel()` 决定，只区分 development/production，**完全不受设置影响**；
   `logging.level` 配置键读进了 ConfigStore，但没有任何调用方把它交给
   `loggerFactory.setLevel()`，是死配置。
3. 设置页没有入口，只能手改 `~/.zcode/v2/setting.json`。

## 产品规则

1. `appSettingsSchema.logLevel` 默认值改为 `warn`。新装/未显式设置的用户默认只记录
   warn/error。
2. 日志级别必须在两侧同时生效：
   - desktop main / renderer / host 中继日志（`v2/logs`）沿用既有
     `applyLogSettingsFromSettings`，启动时套用、改动重启生效。
   - Agent 进程日志（`cli/log/*.jsonl`）通过 spawn env 的 `ZCODE_LOG_LEVEL` 下发，由
     `createNodeLoggerFactory` 的 `getDefaultMinLevel()` 读取。Host 的
     `resolveSpawnEnv` 是 Agent 子进程 env 的唯一出口，级别按 `settingService.get()`
     现值注入；设置变更后下一个新起的 Agent 进程生效（既有 spawn 语义，不做热更）。
   - `ZCODE_LOG_LEVEL` 只在 `ZCODE_RUNTIME_ENV` 非 development 时生效：开发态仍记录
     debug，避免本地开发被默认 warn 静音。
3. 设置页「通用」分组新增「日志级别」下拉，三个选项 `info` / `warn` / `error`，默认选中
   `warn`。变更写入 `settingService.update({ logLevel })`，与 `v2/logs` 阈值同源。
   文案说明"修改后需重启应用生效"。
4. 选项不提供 `debug`：`debug` 是开发态专用，正式安装包恒为 production 构建，
   `createServiceLogger` 与 main logger 均对 debug 做 development 门控；列出会误导用户。
5. 不允许出现多条写入路径：`logLevel` 的唯一所有者仍是 `settings.json`（Host 的
   `settingService`）。UI 只调用 `settingService.update`，不写 CLI 侧
   `config.json` 的 `logging.level`。
6. CLI 侧 `logging.level` 保持现状（死配置不新增接线），避免出现两套配置源。
   Agent 进程的级别只认 spawn env。
7. E2E 依赖 info 级日志做断言，必须与默认值同步：三个用例在启动前
   `seedSettings({ logLevel: "info" })`，否则读到空日志直接失败。

## 验收场景

1. 全新配置（`setting.json` 无 `logLevel`）启动：`v2/logs` 当天文件只有 warn/error 行；
   `cli/log` 当天 jsonl 只有 warn/error 行。
2. 设置页把级别改为 `info` 并重启：两侧重新出现 info 行。
3. 设置页改为 `error`：两侧只剩 error 行，Unknown channel 这类 error 仍在。
4. 开发态（`ZCODE_RUNTIME_ENV=development`）：即使 spawn env 带
   `ZCODE_LOG_LEVEL=warn`，Agent 仍写 debug 行（既有单测
   `ignores ZCODE_LOG_LEVEL so development mode keeps debug logging` 保持通过）。
5. `windows-agent-metric-probe-absence`、`conversation-session-assistant-preview-cards`、
   `conversation-session-background-bash-output` 三个 E2E 仍能读到所需 info 行。

## 状态所有者

| 事实 | 所有者 | 消费者 |
| --- | --- | --- |
| 用户选择的日志级别 | `~/.zcode/v2/setting.json` 的 `logLevel`（Host `settingService`） | main logger、host 中继 logger、`resolveSpawnEnv` |
| 进程内的生效阈值 | `configuredMainLogLevel` / `configuredServiceLogLevel` / `createNodeLoggerFactory.currentLevel` | 各自 logger 的 write 路径 |
| Agent 子进程级别 | spawn env `ZCODE_LOG_LEVEL` | `getDefaultMinLevel()` |

事件顺序：设置变更 → `settingService.onDidUpdate` → services 侧 `setServiceLogLevel` 即时生效
（`packages/services/src/node.ts`）→ main 侧下次启动生效 → 新起 Agent 进程继承新
`ZCODE_LOG_LEVEL`。
