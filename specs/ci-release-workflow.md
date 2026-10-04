# Spec: GitHub Actions 自动发布（tag 触发全平台构建直传 Release）

## 背景

- 手工发布（`docs/release.md` 的 bat/sh 流程）需逐平台占用发布机数小时，且 mac/linux 依赖对应系统机器。
- origin（`jidzhang/ZCode`）是公开仓库，GitHub 托管 runner 免费；`bundle.mjs` 与
  `publish-github-release-asset.mjs` 已具备 CI 所需的全部能力（下载重试、镜像覆盖、
  产物机械校验、gh 直传与上传后回读校验）。workflow 只做编排，不复制任何构建/发布逻辑。

## 行为

`.github/workflows/release.yml`：

- **触发**：
  - `push` tag `v*` → 自动全平台构建并发布（PUBLISH=true）。
  - `workflow_dispatch`：默认只构建，产物以 workflow artifacts 上传（保留 7 天）供装机验证，
    不产生任何 GitHub 写操作；勾选 `publish` 且以发布 tag 作为 ref 运行时等同自动发布。
- **拓扑**：`create-release` → 三个平台 job 并行：
  - `build-windows`（windows-latest）：win x64 → win arm64，job 内串行；
  - `build-linux`（ubuntu-24.04）：linux x64 → linux arm64（x64 runner 交叉构建），job 内串行；
  - `build-mac`（macos-15）：mac x64（arm64 runner 交叉构建，与本地跨 arch 打包同一链路）→ mac arm64，job 内串行。
  - 架构矩阵与官方 zcode.z.ai 发布对齐：win/mac x64+arm64、linux x64+arm64（deb/rpm/AppImage 等）。
  - 新增架构 = 在对应 job 里加一行 bundle 调用（保持同一 OS 内串行）。
- **竞态规避（硬约束）**：
  - win/mac 全架构共用 channel yml（`latest.yml` / `latest-mac.yml`），发布脚本对 yml 是
    "下载-合并-上传（--clobber）"，无锁；同一 OS 的多架构必须同一 job 内串行。
  - linux yml 按架构分文件，天然隔离，但保持相同串行结构。
  - Release "查无则建" 存在跨 job 竞态：由前置 `create-release` job 按 `v{package.json version}`
    统一预建（已存在则跳过）；平台 job 内的发布脚本仍保留"不存在则建"兜底，两层不冲突。
- **环境**：node 24.14.0 / pnpm 10.33.2（与 `mise.toml`、`packageManager` 一致）；`ZCODE_ENV=production`、
  `ZCODE_PREVIEW_IDENTITY=0`、`ZCODE_UPDATE_CHANNEL=github`、`ZCODE_UPDATE_GITHUB_REPO=jidzhang/ZCode`
  （与 bat/sh 同口径）；runner 在海外，将 Electron runtime 与 electron-builder binaries 双镜像
  覆盖为 GitHub 官方源（覆盖点由 `bundle.mjs` 的 `resolveElectronMirror` /
  `resolveElectronBuilderBinariesMirror` 既有环境变量路径提供，不改代码）。
- **凭据**：`secrets.GITHUB_TOKEN`（`permissions: contents: write`），无需配置任何 secret。
- **发布开关**：workflow 级环境变量 `ZCODE_PUBLISH`（`bundle.mjs` 既有入参），发布=`always`、
  只构建=`never`，始终显式给值，不在各 step 里重复拼 `--publish` 参数。**必须显式的硬原因**：
  electron-builder 26 在 `CI=true` 且缺省 `--publish` 时默认 `onTagOrDraft`
  （`app-builder-lib/publish/PublishManager.js` 的 "Implicit publishing triggered by CI detection"），
  手动构建演练若 ref 恰好选在发布 tag 上，会触发 electron-builder 自家 GitHub publisher 的
  缺陷路径（draft 语义静默跳过、channel yml 单架构覆盖，见 release-asset-publish.md 背景）。

## 所有权与边界

- workflow 是纯编排层：构建、校验、上传、yml 合并的唯一所有者仍是
  `bundle.mjs` + `publish-github-release-asset.mjs`（语义见 [release-asset-publish.md](release-asset-publish.md)）。
- `one-click-*.bat/.sh` 保留，作为 CI 失败/不可用时的本地补发与发布机路径，语义不变。
- tag/版本纪律不变：版本唯一来源是根 `package.json`，tag=`v{version}`；发布脚本的
  HEAD-on-tag 预检（`git describe --tags --exact-match`）在 CI 同样生效（tag 事件 checkout
  恰好位于 tag 上；`fetch-depth: 0`，仓库为快照式历史，体积代价可忽略）。
- `concurrency: release-{ref}` 且不自动取消：同一 tag 重推/重跑不并发互踩，进行中的发布绝不中断。
- bat 的 Windows 专属坑（ANSI 编码、`CALL pnpm`、全局 pnpm 损坏）在 CI 不存在；三个平台统一
  `node packages/desktop/scripts/bundle.mjs ...`。

## 失败语义

- 任一平台 job 失败不影响其他平台（资产各自独立上传，`--clobber` 幂等）；
  重跑失败 job，或按 `docs/release.md` 用 bat/sh 本地补发该平台，均可收敛。
- build-only 运行（dispatch 默认）不写 GitHub（Release/资产/yml 均不动）。
- `create-release` 预建失败不阻断后续（发布脚本会兜底创建），只影响竞态规避强度。

## 验收场景

1. push tag `vX` → workflow 全绿：Release `vX` 含 win x64/arm64、linux x64/arm64、mac x64/arm64
   全部资产与 4 份 channel yml（latest.yml / latest-mac.yml / latest-linux.yml / latest-linux-arm64.yml），
   上传后"名称+字节数"校验通过。
2. workflow_dispatch 默认参数在 main 运行 → 三平台构建通过、产物出现在 artifacts，Release 无任何变化。
3. workflow_dispatch 勾选 publish 且 ref 选 tag `vX` → 与场景 1 等价。
4. 同一 tag 重跑 → 幂等（`--clobber` 覆盖同名资产、yml 按架构条目合并）。
5. 平台 job 失败后仅重跑该 job → Release 补齐缺失平台资产，其余平台不受影响。
