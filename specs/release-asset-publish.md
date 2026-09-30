# Spec: 桌面端发布资产上传（GitHub Release 直传）

## 背景

`one-click-release-asset.bat/.sh <os> <arch>` 用于向**已存在**的 GitHub Release 补发一个平台/架构的桌面安装包。
原实现把 `--publish always` 透传给 electron-builder 的 GitHub publisher，存在两个已确认缺陷：

1. **静默漏传**：electron-builder 默认以 draft 语义发布；当目标 tag 的 Release 已是 published 状态时，
   类型不兼容导致所有资产（安装包、blockmap、channel yml）被跳过，进程仍以退出码 0 结束，
   入口脚本误报 DONE（v3.14.3-safe.1 的 win-arm64 首次发布即踩中）。
2. **多架构 channel yml 互相覆盖**：Windows 所有架构共用 `latest.yml`，macOS 共用 `latest-mac.yml`；
   按架构分别构建时，后发的架构会用单架构 yml 覆盖先发架构的条目，
   导致客户端 updater（electron-updater 6.8.3）按 `process.arch` 在 files[] 里找不到匹配，
   静默回退到第一个条目，下载到错误架构的安装包。
   （linux 无此问题：updater 按架构找 `latest-linux.yml` / `latest-linux-arm64.yml`，文件名天然隔离。）

## 行为

`bundle.mjs --publish always` 的新语义：

1. 构建阶段完全复用现有链路，但 electron-builder 以 `--publish never` 运行——构建过程零 GitHub 外联
   （不需要 GH_TOKEN/代理；客户端 app-update.yml 仍由 electron-builder.config.js 的 publish 配置在打包期写入，不受影响）。
2. 构建校验（runtime deps、体积审计）通过后，调用 `publish-github-release-asset.mjs --os <os> --arch <arch>`
   完成 GitHub 上传。

`publish-github-release-asset.mjs`（唯一所有者）职责与顺序：

1. **预检（fail fast）**：`ZCODE_UPDATE_CHANNEL=github` 且 `ZCODE_UPDATE_GITHUB_REPO=owner/repo` 已配置
   （复用 `desktop-update-channel.mjs` 的解析）；`gh` 可用且已认证（GH_TOKEN 或 `gh auth token`）；
   `packages/desktop/package.json` 的 version 构造 tag `v{version}`（可用 `ZCODE_RELEASE_TAG` 覆盖）；
   当前 HEAD 必须精确位于该 tag（`git describe --tags --exact-match`，可用 `ZCODE_ALLOW_UNTAGGED=1` 跳过）；
   dist 中存在该 os/arch 的构建产物。
2. **定位 Release**：`gh api repos/{owner}/{repo}/releases/tags/{tag}`；不存在则 `gh release create`
   创建**已发布**（非 draft）的 Release（全自动语义：无人值守时不能依赖人工把 draft 点成 publish）。
3. **channel yml 合并**：
   - 文件名：win→`latest.yml`；mac→`latest-mac.yml`；linux x64→`latest-linux.yml`，linux arm64→`latest-linux-arm64.yml`。
   - 目标 Release 已有同名 yml 时下载并解析：version 必须与本次一致（否则硬失败）；
     files[] 中相同 url 的条目被本次替换，其他架构条目原样保留；顶层 path/sha512/releaseDate 仅在指向本次
     产物时更新。无同名 yml 时以本次产物新建（顶层指向本次 updater 产物）。
   - files[] 条目字段：`url`（产物文件名）、`sha512`（base64，本地计算）、`size`、`arch`。
     electron-updater 6.8.3 的 `findFile` 按 URL 是否包含 `process.arch` 选择条目，找不到才回退第一个；
     因此**每个架构一个条目、命名含架构**是合并方案成立的硬约束。
4. **上传**：安装包、对应 `.blockmap`、平台其他安装器（mac dmg / linux deb、rpm）、合并后的 channel yml，
   一次性 `gh release upload --clobber`。gh 走标准 `HTTPS_PROXY/HTTP_PROXY` 环境变量。
5. **上传后校验（DONE 的唯一依据）**：`gh release view --json assets` 确认每个预期资产**名称与字节数**精确匹配；
   并从 Release 重新下载 channel yml，解析后确认本次架构条目的 url 与 sha512 正确。
   任一失败 → 非零退出，不输出 DONE。
6. `--dry-run`：完整走预检/发现/合并逻辑并打印计划与 yml 内容，不产生任何 GitHub 写操作。

## 所有权与边界

- **上传/合并/校验唯一所有者**：`publish-github-release-asset.mjs`（IO 编排）+
  `release-asset-publish-core.mjs`（纯函数：channel 文件名、yml 生成/合并、资产校验计划）。electron-builder
  不再承担发布职责；`one-click-release-asset.bat/.sh` 只做环境预检（gh 认证、pnpm 可用性）与调用。
- 纯函数禁止 IO；gh 调用只出现在 glue 层。
- YAML 解析/序列化使用工作区内已有的 js-yaml（electron-updater 的传递依赖，经 createRequire 解析），
  dump 必须 `lineWidth: -1` 防止 base64 sha512 被折叠。

## 失败语义与幂等性

- 任何一步失败立即非零退出；重跑整个流程是幂等的（`--clobber` 覆盖同名资产、yml 按 url 替换合并、
  校验以最终状态为准）。对同一 tag 重复发布同一架构是安全操作。
- 上传后校验失败不会自动回滚已上传资产（GitHub 资产无事务），由人工按错误清单处置；
  脚本输出缺失/不匹配资产的确切清单。

## 迁移边界

- `bundle.mjs --publish never` / 不传 publish 的行为不变（只构建）。
- linux 的 arm64 yml 命名规则与 electron-updater/electron-builder 现状一致，不引入新约定。
- 测试：`release-asset-publish-core.test.mjs`（node:test，零新增依赖）覆盖文件名解析、yml 生成/合并、
  资产校验，并用工作区内 electron-updater 的真实 `parseUpdateInfo/resolveFiles/findFile` 做跨模块回归
  （多架构 yml 必须让 x64/arm64 各自解析到正确安装包与校验和）。
