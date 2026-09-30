# 桌面端发版步骤（GitHub Release 通道）

> 行为与设计依据见 [specs/release-asset-publish.md](../specs/release-asset-publish.md)、
> [specs/ci-release-workflow.md](../specs/ci-release-workflow.md)。
> 本文档描述操作流程；脚本自动处理的部分标注了"自动"。

## 方式一：GitHub Actions 自动发布（推荐）

`.github/workflows/release.yml`（公开仓库 runner 免费）：

1. **bump 版本并提交**：版本唯一来源是根 `package.json`。
2. **打 tag 并推送**：
   ```bat
   git tag -a v3.14.4 -m "safe-zcode self release v3.14.4"
   git push origin main
   git push origin v3.14.4
   ```
   push `v*` tag 即触发：预建 Release → windows/linux/mac 三平台并行构建
   （win job 内串行 x64/arm64）→ 自动上传资产并合并 channel yml → 上传后回读校验。
3. **确认 Actions 全绿**，到 Release 页面核对资产；失败平台可只重跑该 job，
   或用方式二本地补发该平台（幂等）。
- **不发布的构建演练**：Actions 页面手动运行（`workflow_dispatch`，默认不勾 publish），
  三平台只构建并把安装包作为 workflow artifacts 上传（保留 7 天）供装机验证，不写 Release。
- 日常提交想跑 lint/typecheck 的话另行添加 CI workflow，本 workflow 只在 tag/手动触发时运行。

## 方式二：本机手动发布（CI 兜底/补发平台）

### 一次性准备（每台发布机）

1. **gh 登录**：`gh auth login`（选 GitHub.com → HTTPS → 浏览器设备码登录）。
   国内网络需要在同一个命令行窗口先设代理：
   ```bat
   set HTTPS_PROXY=http://<代理地址>:<端口>
   set HTTP_PROXY=http://<代理地址>:<端口>
   ```
2. **pnpm 可用性自检**：`pnpm --version` 必须能输出版本号。
   如果命令静默退出无输出，说明全局 pnpm 原生 exe 损坏，重装仓库钉住版本：
   ```
   npm i -g pnpm@10.33.2
   ```
3. **仓库根目录的 `.npmrc`** 使用 `node-linker=hoisted` 与腾讯/npmmirror 镜像，勿改动。

### 每个版本的发布步骤

以下假设版本号为 `v3.14.4`，Windows 发布机；mac/linux 见第 4 步替换。

1. **提交并推送代码**（发布 tag 必须包含发布脚本本身）。
2. **打 tag 并推送**：
   ```bat
   git tag v3.14.4
   git push origin v3.14.4
   ```
3. **在发布机检出该 tag 并安装依赖**（依赖无变化时 install 可跳过）：
   ```bat
   git fetch origin tag v3.14.4
   git checkout v3.14.4
   pnpm install
   ```
4. **设置代理并逐平台执行**（构建阶段不联网，仅上传走代理；**第一个执行的平台会自动创建
   正式状态的 Release**，后续平台自动补充资产并合并 channel yml）：
   ```bat
   set HTTPS_PROXY=http://<代理地址>:<端口>
   set HTTP_PROXY=http://<代理地址>:<端口>
   one-click-release-asset.bat win x64
   one-click-release-asset.bat win arm64
   ```
   - macOS 发布机：`./one-click-release-asset.sh mac arm64`（或 `mac x64`）
   - Linux 发布机：`./one-click-release-asset.sh linux arm64`（或 `linux x64`）
5. **确认输出**：脚本输出 `DONE` 表示该平台资产已上传并通过"名称 + 字节数"逐项校验、
   channel yml 已正确合并。任何失败都会列出确切原因，修复后重跑同一条命令即可
   （重跑幂等：`--clobber` 覆盖同名资产，yml 按架构条目合并）。
6. **（可选）上线前离线演练**：构建完成后、真实上传前，可先跑：
   ```bat
   node packages/desktop/scripts/publish-github-release-asset.mjs --os win --arch arm64 --dry-run
   ```
   它会打印将上传的文件清单与合并后的 `latest.yml` 内容，不做任何 GitHub 写操作。

## 脚本自动处理的部分（无需人工干预）

- Release 不存在时自动创建**已发布**状态（不会产生需要人工点击发布的 draft）。
- 多架构 channel yml 合并：Windows 所有架构共用 `latest.yml`、macOS 共用 `latest-mac.yml`，
  每个架构一个 `files[]` 条目，后发架构不会覆盖先发架构；linux 按架构使用
  `latest-linux.yml` / `latest-linux-arm64.yml`，天然隔离。
- 上传后回读 Release 资产逐项校验（electron-builder 原发布器"静默跳过仍报成功"的缺陷由这一步兜底）。
- 环境预检：gh 认证、pnpm 可用、HEAD 精确位于发布 tag（`ZCODE_ALLOW_UNTAGGED=1` 可显式跳过）、
  通道配置（`ZCODE_UPDATE_CHANNEL=github` + `ZCODE_UPDATE_GITHUB_REPO`）。

## 常见失败与处置

| 现象 | 原因与处置 |
| --- | --- |
| `pnpm is not usable` / `pnpm --version` 无输出 | 全局 pnpm 原生 exe 损坏：`npm i -g pnpm@10.33.2` |
| `gh is not logged in` | 在同一窗口 `gh auth login`（需要代理时先 set 代理） |
| `HEAD 不在发布 tag 上` | 检出错版本，或 HEAD 上有未打 tag 的提交；确认后重检 tag |
| `channel yml 版本不一致` | 往旧 tag 上传新版本产物，检查 tag 与工作区 |
| `上传后校验失败: 缺少资产/体积不一致` | 网络中断导致部分上传失败，直接重跑该平台命令 |
| 构建阶段卡在下载 | 构建不连 GitHub；检查 npm/Electron 镜像配置而非代理 |
