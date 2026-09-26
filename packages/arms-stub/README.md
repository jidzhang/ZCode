# @arms/rum-electron（safe-zcode 空实现）

阿里云 ARMS RUM Electron SDK 的本地替身：**API 兼容、零网络出站**。

## 为什么存在

上游 ZCode 约有 30 个文件直接依赖 `@arms/rum-electron` 做产品遥测。逐文件删除会导致
每次上游同步大面积冲突；本包把「移除依赖」变成「替换实现」：

- 上游遥测采集文件保持原样，上游改动可直接合并；
- SDK 的 `init / sendCustom / sendEvent / setConfig / getConfig / client.useReporter`
  全部为空操作，事件在本进程内被丢弃，不出网；
- 阿里云 SDK 代码不进入 `node_modules`，运行时连接归零。

## 使用方式

`packages/desktop/package.json` 中依赖写为 `"@arms/rum-electron": "workspace:*"`，
pnpm 在 workspace 内按包名解析到本目录。

上游若用到此处未覆盖的 API，typecheck 会报错，在 `index.d.ts` / `index.js`
补一个空函数即可。
