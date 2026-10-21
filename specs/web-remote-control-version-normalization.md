# Web 远程控制版本号路由归一化 spec

## 背景

手机远控页面由 `zcode.z.ai/remote/v4` 服务：服务端按 `app_version` 查询参数路由
版本化资源。实测（2026-10-21）：带 prerelease/渠道后缀的值（`3.15.1-safe.3`、
`3.16.2-beta.1` 等）一律 HTTP 404；干净 semver（`3.15.1`、`3.15.2`、`3.16.2`，
服务端不认识的也行）或缺省返回 200。

fork 桌面版本号是 `3.15.1-safe.N`，导致两层故障：

1. 二维码 `app_version` 参数带后缀 → 扫码直接 404（用户看到的 "Not found"）。
2. 配对成功后，手机页版本守卫
   （`packages/web/src/webRemoteControlVersion.ts`）把 URL 中 `app_version`
   与 bootstrap 回报的 `desktopAppVersion` 比对，不一致就重写 URL 并跳转；
   桌面回报带后缀版本 → 干净链接被重定向回带后缀 URL → 再次 404。

配对链路本身（旧 relay `wss://zcode.z.ai/ws` + hash/t 二维码格式）实测完好，
本 spec 只处理版本号路由问题，不改配对协议。

## 规则

用于手机页路由的桌面版本号必须剥离本地渠道后缀，仅保留数字版本核：

- 入口：`normalizeWebRemoteControlRouteAppVersion`（`packages/shared/src/web-remote-control.ts`）。
- 规则：取首个 `-` 之前的部分，仅当该部分是纯数字段（`^\d+(\.\d+)*$`）时返回它，
  否则原样返回。
  - `3.15.1-safe.3` → `3.15.1`；`3.16.2-beta.1` → `3.16.2`。
  - 干净 semver（`3.16.2`）、官方四段式（`3.15.3.8237`）、空串、非数字基础
    （`dev-build-1`）原样保留——不影响官方行为。
- 应用点（`packages/desktop/src/main/webRemoteControlManager.ts`，两处均为
  `dependencies.appVersion` 的透传点）：
  1. `createQrUrl` → `buildWebRemoteControlExternalQrUrl({ appVersion })`，
     决定二维码 `app_version` 参数；
  2. `buildBootstrapResult` → `desktopAppVersion`，决定手机页版本守卫的比对源。
- 不应用点：transport 注册 meta 里的 `version`（设备列表展示信息，保留真实
  fork 版本便于区分构建）；桌面其他 UI/日志仍用完整版本。

归一化后手机页路由到 `/remote/v4/<基线版本>/` 资源，与 fork 基线正好匹配；
fork 升级基线（如 3.16.x）后规则不变。

## 上游合并注意

上游 3.15.1→3.16.x 已重构远控（relay 迁 `/api/v1/remote/ws2`、二维码去掉
hash/t 且新 parser 见 hash/t 即拒、手机页要 JWT 登录、transport 删除重写）。
该重构部署到手机页后，旧二维码将无法配对，届时随上游同步并保留本归一化
（新版 `buildWebRemoteControlExternalQrUrl` 仍会写 `app_version` 参数，
守卫仍比对 `desktopAppVersion`，两处归一化继续有效）。

## 验收

1. `appVersion=3.15.1-safe.3` 时：二维码 URL 含 `app_version=3.15.1` 且不含
   `safe.3`；bootstrap-response 的 `desktopAppVersion === "3.15.1"`。
2. 干净版本（如 `1.5.0`）：行为与之前完全一致。
3. 手机实测：扫码进入页面、配对成功、不再被重定向到 Not Found。
