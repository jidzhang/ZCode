# macos12 分支：为 macOS 12 保留 Electron 43

## 目的

main 跟随上游使用 Electron 44（Chromium 152，要求 macOS 13）。本分支把 Electron 钉在 43.x
（Chromium 150，最后一个支持 macOS 12 的版本线），只用于给 macOS 12 设备本地构建 mac 安装包。
main 不承担 macOS 12 兼容，所有代价都留在本分支；不再需要时冻结本分支即可，main 无需清理。

## 与 main 的差异

同步 main 时只应在下列位置出现冲突；新增差异必须登记到本表。

| 位置 | main | macos12 |
| --- | --- | --- |
| `packages/desktop/package.json` 的 `devDependencies.electron` | 44.7.0 | 43.8.7 |
| `pnpm-lock.yaml` | electron 44.7.0 | electron 43.8.7 |
| `packages/desktop/electron-builder.config.js` 的 `mac.minimumSystemVersion` | 13.0.0 | 12.0.0 |
| `packages/desktop/scripts/macos-update-manifest.mjs` 的 `MINIMUM_DARWIN_VERSION` | 22.0.0 | 21.0.0（Darwin 21 = macOS 12） |
| `packages/desktop/src/main/pluginSandbox/host.ts` 复制图片 | 异步 `clipboard.write` + `ClipboardItem`（44 起的接口） | 同步 `clipboard.writeImage`，Windows 先经 `createFromBitmap` 重建位图（与 44 之前一致） |
| `packages/desktop/src/main/pluginSandbox/CONTRACT.md` | 44 写法说明 | 43 写法说明 |
| `packages/desktop/test/e2e/preview-pane-image-copy.test.ts` 读剪贴板图片 | 异步 `clipboard.read()` | 同步 `clipboard.readImage()` |
| `packages/desktop/test/electronBuilderSecurity.test.ts`、`macosUpdateManifest.test.ts` | 锁 44.7.0、13.0.0 / 22.0.0 | 锁 43.8.7、12.0.0 / 21.0.0 |
| `.github/workflows/release.yml` | tag 触发全平台发布 | 只能手动触发，固定不发布 |
| `.github/workflows/macos12-release.yml` | 不存在 | 独立 mac x64 通道：dispatch 手动触发，产出单一 dmg 到 `macos12-v*` pre-release |

## 规则

1. **单向同步**：只把 main 合入本分支（`git merge main`），永不把本分支合回 main。
2. **不发布通用版**：本分支不打 `v*` tag，也从不写 main 的通用版 Release。
   本分支的安装包只走 `.github/workflows/macos12-release.yml` 的独立 pre-release
   （`macos12-v<version>`，不带任何 channel yml），详见 [macOS 12 独立发布 spec](../../specs/electron/macos12-release.md)。
   原因：GitHub Release 与自动更新通道和 main 共用，分支产物一旦进入通用通道，会被推给 macOS 13+ 与 Windows 用户。
3. **同步后检查**：上游若开始使用 Electron 44 及以后才有的接口（典型：异步 clipboard 与
   `ClipboardItem`、`windowStatePersistence`、`protocol.registerSource`、`WebContents` 的 zoomMode），
   在 Electron 43 类型下会报类型错误；按 43 写法改回，并登记到上表。根 `pnpm typecheck` 用
   `tsc -b` 增量构建，没改源码的子项目不会因 Electron 类型变化重查，同步后必须强制重查 desktop：
   `tsc -b packages/desktop/tsconfig.main.json packages/desktop/tsconfig.host.json packages/desktop/tsconfig.e2e.json --force`。
4. **版本号跟随 main**：不单独改版本号。v3.17.1-safe.1、v3.17.2-safe.2 发布的 `latest-mac.yml`
   缺少系统下限，分支版本不低于它们，就不会被这两个版本误升级。

## 在 macOS 12 设备上构建

```sh
git fetch origin && git checkout macos12 && git pull
pnpm install --frozen-lockfile
ZCODE_UPDATE_CHANNEL=github ZCODE_UPDATE_GITHUB_REPO=jidzhang/ZCode \
  node packages/desktop/scripts/bundle.mjs --os mac --arch x64   # Apple Silicon 用 arm64
```

产物在 `packages/desktop/dist/`，手动安装 dmg。必须带 github 通道：缺省的 official 通道会查官方
更新服务，可能推送要求 macOS 13 的官方版本。走 github 通道时，main 发布的 `latest-mac.yml` 带
`minimumSystemVersion: 22.0.0`（eb93a06f 起），electron-updater 在 macOS 12 上会跳过这些更新。

## 已知限制

- Electron 43 的安全支持到 2027-01-05（官方暂定），之后不再有 Chromium 安全修复。
- 本分支不用于 Windows/Linux 打包：本地 CUA helper 的清单绑定 Electron 44.7.0，Windows 打包会被校验拦下。
- E2E 的 chromedriver 映射（electron-to-chromium 1.5.452）不含 43.8.x，本分支不跑 wdio E2E。
- 真实 Electron 夹具脚本 `scripts/gen-ui-fixture/`、`scripts/mcp-apps-host-fixture/` 仍是 44 的剪贴板写法，
  不在任何 tsconfig 与打包产物内，本分支不运行。
- 跑过 Electron 44 的设备不要装本分支产物：上游实测 44 直接降到 41 时 IndexedDB 会被重建，
  44 降到 43 未验证。

## 退出条件

满足任一条即冻结本分支，停止同步：

- Electron 43 停止安全更新后，出现严重的 Chromium 漏洞；
- 上游大量使用 Electron 44 以后才有的接口，一次同步要改很多处；
- macOS 12 设备退役或升级系统。
