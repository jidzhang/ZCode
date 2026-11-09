# macOS 12 本地正式身份打包

## 行为

`scripts/one-click-build-mac-local.sh` 是 macos12 分支的本机安装包入口。它与
`one-click-build-github-local.bat` / GitHub release workflow 使用同一产品身份约定：

```sh
ZCODE_ENV=production
ZCODE_PREVIEW_IDENTITY=0
ZCODE_UPDATE_CHANNEL=github
ZCODE_UPDATE_GITHUB_REPO=jidzhang/ZCode
```

脚本必须在调用 `packages/desktop/scripts/bundle.mjs` 前显式导出以上变量，不能继承当前
shell 里的测试环境。产物必须使用正式身份 `ZCode` / `dev.zcode.app`，文件名不携带
`Preview` 或 `_TEST`。

## 边界与事件顺序

1. 预热 electron-builder 工具件缓存；
2. `pnpm install --frozen-lockfile`；
3. 显式设置正式身份、GitHub 更新通道与镜像变量；
4. 调用 `bundle.mjs --os mac --arch x64 --skip-prepare`：desktop 的 `build` 生命周期会
   执行一次 runtime asset preparation；跳过 bundle 外层重复 prepare，不改变资产来源和校验。

脚本只负责本机网络缓存和环境编排，不复刻或绕过 `bundle.mjs` 的构建校验。

## 验收

1. `bash -n scripts/one-click-build-mac-local.sh` 通过；
2. 在 `ZCODE_ENV=test` 的外层 shell 中运行脚本，打包日志仍显示 production identity；
3. 产物为 `packages/desktop/dist/ZCode-<version>-mac-x64.dmg/.zip`，安装后 app 名称为
   `ZCode.app`、Bundle ID 为 `dev.zcode.app`，不是 `ZCode Preview.app` /
   `dev.zcode.app.preview`。
