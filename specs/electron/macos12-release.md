# macOS 12 专用安装包的独立 Release 发布

## 背景

main 跟随上游使用 Electron 44（Chromium 152，要求 macOS 13），macOS 12 设备无法安装。
`macos12` 分支把 Electron 钉在 43.x 后可以正常打包（见 [macos12 分支约定](../../docs/electron/macos12-branch.md)），
但该分支的产物长期只能在本机手动构建、手动分发，普通用户拿不到。

本 spec 定义：macos12 分支自动产出一个 **只含 mac x64 dmg** 的独立 Release，与 main 的通用版 Release
互不干扰。

## 为什么必须独立、且必须是 pre-release

1. **不能和通用版同 Release**：两分支的 `artifactName` 模板相同，同版本号下 x64 dmg 文件名完全一致，
   上传会互相覆盖（`--clobber`）。
2. **不能参与 latest 竞争**：electron-updater 的 GitHub provider 只读 `/releases/latest`
   （`electron-updater/out/providers/GitHubProvider.js` 的 `getLatestTagName`）。若本 Release 成为仓库 latest，
   所有客户端都查不到正确的通用版更新。
   → 用 `gh release create --prerelease` 创建，GitHub 不会把它设为 latest。
3. **不能携带 channel yml**：本 Release 绝不上传 `latest-mac.yml`。理由同上——yml 一旦被读到，
   Electron 43 的包会被推给 macOS 13+ / Windows 用户。发布脚本
   `publish-github-release-asset.mjs` 必然上传 yml，因此本通道**不复用它**，只直传 dmg。

## 行为

新增 `.github/workflows/macos12-release.yml`（仅存在于 macos12 分支）：

- **触发**：`workflow_dispatch`（不接 tag 推送）。
- **拓扑**：单 job，`macos-15` runner，只跑
  `node packages/desktop/scripts/bundle.mjs --os mac --arch x64`，`ZCODE_PUBLISH=never`。
- **身份**：`ZCODE_ENV=production`、`ZCODE_PREVIEW_IDENTITY=0`、`ZCODE_UPDATE_CHANNEL=github`、
  `ZCODE_UPDATE_GITHUB_REPO=jidzhang/ZCode`，与通用版一致（app 名 `ZCode.app`、appId `dev.zcode.app`）。
- **发布**：构建成功后执行

  ```sh
  gh release create "macos12-v<version>" --prerelease \
    --title "macOS 12 专用版 <version>" --notes-file .scratch/release-notes.md \
    packages/desktop/dist/ZCode-<version>-mac-x64.dmg
  ```

- **Tag 命名**：`macos12-v<version>`。`semver.valid()` 无法解析该形状，因此即使被访问也会被
  electron-updater 的 tag 过滤跳过，是双保险。

## 边界

- 只用本分支自己的 workflow，不改 main 的 `release.yml`。
- 不写 GitHub Release 的 latest 标记，不上传 `.zip` / `.blockmap` / 任何 `.yml`。
- 打包无签名（与通用版一致）。Release notes 必须包含：仅 macOS 12、需手动下载、
  无自动更新、未签名需右键打开或 `xattr -d com.apple.quarantine`、
  装过 Electron 44（main 通用版）的设备不要安装（降级未验证）。

## 验收

1. workflow 可手动触发并成功产出 `ZCode-<version>-mac-x64.dmg`。
2. Release `macos12-v<version>` 为 Pre-release 状态，`gh release view --json isPrerelease,isLatest` 返回
   `isPrerelease=true`、`isLatest=false`。
3. 该 Release 的资产列表**只有**那一个 dmg，没有任何 yml。
4. 通用版 Release 的 latest 身份与资产不受影响。
