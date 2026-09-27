# LOCAL-CHANGES — safe-zcode 本地优化清单

> 用途：记录本项目相对上游 zai-org/ZCode 的全部偏离，供日后维护和上游合并时对照。
> 每笔优化都写明"上游实现后的处置"，上游做了同样的事，对应提交直接 drop 即可。

## 1. 项目定位

safe-zcode = **zai-org/ZCode 开源快照 + 个人优化**（Edge 之于 Chrome 的模式）。
上游是快照式投放（整版本一次提交，不提供细粒度历史），同步以"上游新 tag 的子树 diff"为单位，不做逐 commit merge。

- origin = https://github.com/jidzhang/ZCode （个人 fork，main 直接推送）
- upstream = https://github.com/zai-org/ZCode （同步基准，只 fetch 不 push）
- 基线 tag：v3.14.3（29628c9，2026-09-23）

当前栈（自下而上）：v3.14.3 → ecc4cbc → a62caf1 → 7847d57 → 1771466 → 19052e1 → e6d54a4 → 遥测对齐修订 → 登录推送门控（均 2026-09-27，后两笔见 2.x 末尾）。

## 2. 已提交优化（按提交）

### ecc4cbc — 飞书 tenant token 自愈 + 流式卡片熔断可恢复（2026-09-25）

- **背景**：实机事故。tenant_access_token 在声明有效期内被飞书服务端提前作废（19:40 create 成功，19:43 update 即报 99991663）。旧代码硬编码缓存 90 分钟、无视 expire 字段、失效不驱逐；退避重试复用坏 token 三连败后熔断永久打开且无复位路径，最终回复被静默丢弃（用户侧卡片永远"运行中"，只能重启）。
- **方案**：TTL 改为 min(90min, expire−5min)、下限 1 分钟；99991661/63/64 识别为无效 token，驱逐缓存换新重试且不计熔断；熔断改 60 秒冷却半开、成功即完全复位；错误对象携带 feishuCode 供上层判定。
- **文件**：`packages/services/src/bots/providers/feishuProvider.ts`、`packages/services/src/bots/botsService.ts`、新增 `packages/services/test/feishuTokenSelfHeal.test.ts`
- **上游处置**：若上游 feishuProvider 已读 expire + 失效驱逐 + 熔断冷却，drop 本笔。

### a62caf1 — turn 运行中插话改为排队（2026-09-25）

- **背景**：任务运行中发消息被 taskRunning 直接拒绝，无法补充信息，只能干等或 /停止。
- **方案**：忙时纯文本先归一化附件，再入 host 的 per-task 命令队列（enqueueTaskCommand send_prompt，与 channel 包既有语义一致），回执"已排队+条数"；排队输入被 drain 执行时用 queuedPromptRuns 计数重建流订阅，避免 drain 回复黑洞。管理命令（/task、/workspace 等）仍要求空闲。
- **文件**：`packages/services/src/bots/botsService.ts`、`packages/services/src/bots/messages.ts`
- **上游处置**：若上游 handleMessage 忙时入队而非拒绝，drop 本笔。

### 7847d57 — 帮助文案列出全部命令别名（2026-09-26）

- **背景**：commandParser 本就不分语言（new/clear/新建 同组等价别名一直可用），但中文帮助 9 行里 8 行只列中文命令；唯一列别名的行还漏了 /new（写成"/新建 或 /clear"）。用户无从知道英文命令可直接输入。
- **方案**：中文帮助每行列全部别名，中文在前、"或"连接（如 `/新建 或 /new 或 /clear`、`/模型 或 /model`）；英文文案维持原样（/new or /clear）。
- **文件**：`packages/services/src/bots/messages.ts`
- **上游处置**：若上游帮助文案已列出别名，drop 本笔（或按新文案重新对齐）。

### 1771466 — build-zcode 支持 Windows（2026-09-26）

- **背景**：上游仅 macOS/Linux 开发，脚本在 Windows 两处必挂：①`spawnSync("pnpm")` 不带 shell 解析不了 pnpm.CMD（CreateProcess 只认可执行映像，新版 Node 对 .cmd 直接 EINVAL）；②GNU tar 把 `D:\...` 盘符冒号解释成远程主机名。
- **方案**：run() 与 tar 调用在 win32 下分别加 `shell: true` 守卫与 `--force-local`；非 win32 行为不变。
- **文件**：`scripts/build-zcode.mjs`
- **上游处置**：上游修复则 drop；即便上游不修，本笔冲突风险极低，长期保留无害。
- **实测**：产物 dist/zcode/releases/3.14.3/zcode-3.14.3.tar.gz（86.5MB，14990 项，sha256 落盘）。

### 19052e1 — 独立飞书/微信通道包（2026-09-26）

- **内容**：bot 通道能力从主进程解耦为独立进程包：`packages/feishu-channel`（@larksuiteoapi/node-sdk 直连，domain/app/adapters 三层，2 个测试）、`packages/wechat-channel`（同构 + weixinProtocol 协议层 + 扫码登录脚本，3 个测试；iLink token 存凭据库现读、无进程内缓存）。architecture-policy.yaml 注册两模块（managed），根 package.json typecheck 纳入。
- **上游处置**：上游无对应物，长期保留；上游合并的机械冲突点 = architecture-policy.yaml 模块注册 + 根 package.json typecheck 行。

### e6d54a4 — 严格 opt-in 遥测 + ARMS 桩包；分享发布默认关闭（2026-09-26）

- **内容**：①CLI 模型遥测在 bootstrap.ts 加 `isTelemetryExplicitlyEnabled`（仅 `ZCODE_TELEMETRY=on` 放行 OTLP 端点解析）；②telemetryCore.ts sendReport 同语义门控；③`@arms/rum-electron` 从外部依赖+pnpm patch 改为本地 arms-stub 桩包（workspace:\*）；④ConversationShareMenu.tsx 分享发布默认关闭。
- **2026-09-27 修订（已作为独立提交落地）**：①②两个门控 hunk **撤回**，两文件恢复 upstream/main 原样；改为在 `packages/desktop/src/main/desktopRuntimeEnv.ts` 打包分支追加上游自带开关默认值 `ZCODE_MODEL_TELEMETRY_ENABLED: "false"`（纯增量一行）。
  - 依据（三方审计，详见 D:\work\github\zcode-debug\3.14.3.7762-official\REPORT.md）：官方 3.14.3.7762 二进制同样认 `ZCODE_MODEL_TELEMETRY_ENABLED`（opt-out：0/false/off/disabled 均关，未设即开）；ARMS 端点不在上游仓库源码里（`proj-xtrace` 零匹配），是官方 CI 经 `__ZCODE_ENV__` 构建注入的，上游设计即"端点不内嵌、缺端点不上报"，fork 自构建产物天然无端点；上游 `upstream/main` 仍与基线 29628c9 重合，无新版语义可跟。
  - 语义对照：CLI 默认关，与原 hunk 等价（默认值压得住环境残留 OTEL\_\*——开关看值、不看端点是否存在）；services 上报上游本就 `!ZCODE_TELEMETRY_REPORT_ENDPOINT → return`，fork 构建从不注入该端点，默认死；唯一行为差异是"用户显式配 REPORT_ENDPOINT"场景从"仍被 =on 锁死"变为"视为显式 opt-in 放行"，与 CLI 开关语义对齐。main 进程 local-ttft（5s 间隔指标导出）与 renderer-action traces（服务端 rollout 可远程开启，审计本机实测已 enabled:true/ttft-2026-09-18）**没有本地禁用开关**，出站仅取决于 OTEL 端点是否存在——fork 产物无端点故默认死。
  - 合并收益：bootstrap.ts / telemetryCore.ts 回到 pristine，上游活跃遥测文件的冲突点消失；遥测域仅剩 desktopRuntimeEnv.ts 一处纯增量默认值。
  - ARMS 桩包与分享门控**不动**。
- **上游处置**：上游若默认关闭 OTLP、或给 renderer-action/TTFT 加本地禁用开关，重新评估这行默认值是否可删；端点注入机制如上游改为仓库内配置，同步时检查 desktopRuntimeEnv 打包分支。

### 登录推送门控 — 全屏登录页仅限用户主动触发（2026-09-27）

- **背景**：上游把账号登录做成强推送：①启动守卫在"未登录且无可用 provider 或从未绑定账号域"时全屏拦截（`startup-provider-required`，且阻塞 workspace 恢复）；②上游未实现 refresh token（`oauthService.refreshToken` 直接抛"请重新登录"），OAuth token 隔夜过期后 `session-expired` 全屏重登页反复出现。用户要求登录"不明显但可用"（3.11.2 体验），登录调研结论（见记忆/出站加固）为保留链路、只隐藏推送。
- **方案**：WelcomeScreen 全部主动打开路径收敛于 `Root.tsx` 的 `setWelcomeScreenOpenReason`（5 值枚举）。新增 `packages/ui/src/lib/localUiOverrides.ts` 白名单谓词：放行用户主动三类（manual-login / provider-request / logout-provider-required），吞掉上游强推两类（startup-provider-required / session-expired）；白名单外的新 reason 默认吞掉。`Root.tsx` 仅改 state 初始化块一处（包装 setter，其余读写点零改动；白名单外的开屏请求保持当前状态而非折叠 null，避免吞掉用户已手动打开的登录页）。被动入口（侧栏账号区、/login、设置 API key 表单）不经此 setter，不受影响；登录链路本体（OAuth/凭据/套餐）不动。测试 `packages/ui/test/loginPromptGate.test.ts`。
- **代价（已接受）**：token 过期不再全屏拦截，账号型模型（Coding Plan/Start Plan/off-peak）请求 401 报错，重登走侧栏手动入口；未配模型可进工作区，发消息时模型层报错——与 codex/claude CLI 的"报错后自行换 key"体验一致。
- **上游处置**：上游若新增**不走 setWelcomeScreenOpenReason** 的推送面（独立引导弹窗/新 onboarding 组件），本门控不会自动覆盖，同步时 grep `setWelcomeScreenOpenReason` 与 WelcomeScreen 挂载点复查；上游若给推送加官方开关或实现 refresh token，评估删除本笔。

## 3. 未提交的本地工作（2026-09-27 更新）

无。channel 两包已随 19052e1 入库；`异常流量.jpg` 为本地审计截图，不入库。

## 4. 验证链（合并/改动后必跑）

```bash
pnpm run typecheck                                # 13 个 tsconfig 项目，全绿为准
pnpm exec tsx --test packages/services/test/*.test.ts
# 注意：node --experimental-strip-types 直跑解析不了源码里的 .js 后缀 TS 导入，必须用 tsx
node scripts/build-zcode.mjs --base-url http://localhost/zcode/
# 或临时跳过重建：--skip-build；产物在 dist/zcode/releases/<版本>/，含 sha256.txt
```

### 桌面端打包（Windows 实测已通，2026-09-26）

```bash
node packages/desktop/scripts/bundle.mjs --os win --arch x64
# 产物：packages/desktop/dist/ZCode Preview-<版本>-win-x64_TEST.exe（NSIS 安装包）
# 全量构建约 8-12 分钟；已 build 过可加 --skip-build 只跑 electron-builder 阶段
```

Windows 打包两个必须处理的环境点（否则必失败）：

1. **火绒按进程拦截 app-builder.exe 出站**（WinError 10013）：node_modules 里的
   `app-builder-bin\win\x64\app-builder.exe` 是无签名 Go 二进制，负责下载 Electron
   发行包/NSIS/winCodeSign。须在火绒白名单放行（curl/node 被放行但会被它拦，
   不要误判为网络问题——10013 签名）。镜像走 bundle.mjs 内置的 npmmirror 链
   （ZCODE_ELECTRON_RUNTIME_MIRROR → config electronDownload.mirror），无需手动设。
2. **winCodeSign 解压符号链接失败**（"客户端没有所需的特权"）：winCodeSign-2.6.0
   含 macOS dylib 符号链接，非管理员 Windows 解不了。手动补缓存：
   ```bash
   CACHE="$LOCALAPPDATA/electron-builder/Cache/winCodeSign"
   mkdir -p "$CACHE/winCodeSign-2.6.0"
   node_modules/7zip-bin/win/x64/7za.exe x -y "$CACHE/<任一已下载>.7z" -o"$CACHE/winCodeSign-2.6.0"
   # exit=2（符号链接报错）可忽略；核验 windows-10/x64/signtool.exe 与 rcedit-x64.exe 存在
   ```
   之后 electron-builder 看到最终目录已存在即跳过解压。

工具链钉子：node 24.14（本机 24.21 可用）、pnpm 10.33.2（无 mise，本机直装）。

## 5. 上游同步流程

```bash
git fetch upstream --tags
git log --oneline HEAD..upstream/main                      # 上游新快照
git diff HEAD upstream/main -- packages/services/src/bots  # 判断是否触及优化区
git rebase upstream/main                                   # 或 merge，二选一保持一贯
# 逐笔对照第 2 节"上游处置"：上游已实现的 drop，未实现的保留并解冲突
# 解冲突后完整跑第 4 节验证链，再 push origin main
```

要点：

- 优化全部集中在 `packages/services/src/bots/`（4 文件 + 1 测试，约 +200 行），同步面窄；上游主力在桌面端/CLI/agent 运行时，bots 是边缘模块。
- 每笔提交的代码内均有"修复原因（日期）"注释块，解释背景与动机，解冲突时先读注释。
- 上游若重构 bots 目录结构，按"功能语义"重新落笔，不要硬搬 diff。
- 本地 main 始终保持 = 上游某快照 + 独立优化栈，不与上游历史交叉污染。
