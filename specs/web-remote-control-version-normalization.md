# Web 远程控制手机页版本路由与 V1 免登录配对 spec

## 背景

手机远控页面由 `zcode.z.ai/remote/v4` 服务：服务端按 `app_version` 查询参数路由
版本化资源。实测（2026-10-21）：带 prerelease/渠道后缀的值（`3.15.1-safe.3` 等）
一律 HTTP 404；干净 semver 或缺省返回 200。

上游 3.15.1→3.16.2 重构了远控：relay 迁 `/api/v1/remote/ws2`、设备注册改账号
JWT（`register`/`token` HTTP 端点都要求 `Authorization: Bearer <jwt>`）、二维码
去掉 hash/t、手机页要求两端登录同一账号。桌面端由此出现登录门禁：未登录智谱账号
时远控面板不再弹二维码，而是 "Sign in required" —— API-key 用户彻底无法使用。

fork 决策（2026-10-23，用户明确要求）：撤销账号门禁，恢复 3.15.1 的 V1 免登录
配对（二维码携带 `hash`/`t`，relay `wss://zcode.z.ai/ws` 匿名注册 + HMAC proof
挑战）。实测当日 V1 relay 端点与 3.15.1 手机页资源仍然在线可用。

关键证据（2026-10-23 实测）：

- `https://zcode.z.ai/remote/v4?...&app_version=3.15.1` 与 `app_version=3.16.2`
  返回的页面加载不同版本资源（`/remote/v4/3.15.1/assets/...` vs `3.16.2`）。
- 3.15.1 页面包含 `pass_hash`/`auth_challenge`（V1 协议，连 `wss://zcode.z.ai/ws`）；
  3.16.2 页面包不含任何 hash 配对逻辑，只连 `/api/v1/remote/ws2`。
- 用户 3.15.1 客户端前一天扫码配对成功（V1 服务端链路存活）。

## 规则

### 1. V1 免登录配对链路（fork 保留，撤销上游 V2 门禁）

- 桌面端 main 进程使用 3.15.1 的 `webRemoteControlManager` + `webRemoteControlTransport`
  + `webRemoteControlRelayAuthProvider/StorageProvider`（passHash 存凭据库、
  deviceSid 存 settings 的 `webRemoteControlExternalRelayDevice`）。
- relay URL 解析回到 `wss://zcode.z.ai/ws`（`resolveWebRemoteControlRelayWsUrl`）。
- 二维码为 V1 形态：`sid` + `hash` + `t` + `mid` + `name` + `app_version`
  （`buildWebRemoteControlExternalQrUrl`）。
- renderer→main 恢复 `refreshWebRemoteControlPairing`（重置配对材料）与
  `syncWebRemoteControlTasks`（手机首页任务索引）两个 platform 方法。
- 上游 V2 的协议库（`@zcode/shared/web-remote-relay`）与 packages/web 手机端
  V2 代码保留不回退（fork 不部署手机页，仅保编译与未来上游合并基线）。

### 2. 手机页路由版本固定（不再透传桌面版本）

用于手机页路由的版本号固定为
`WEB_REMOTE_CONTROL_V1_MOBILE_PAGE_APP_VERSION = "3.15.1"`
（`packages/shared/src/web-remote-control.ts`），应用于两处：

1. `createQrUrl` → 二维码 `app_version` 参数；
2. `buildBootstrapResult` → `desktopAppVersion`（手机页版本守卫的比对源，一致
   则不重写 URL）。

原因：手机页按 app_version 路由，`>=3.16.2` 的页面只有 JWT 配对、不处理 hash；
桌面真实版本（如 3.16.2-safe.N）会把手机引导到 V2 页面直接断链。固定到 3.15.1
即锁定"最后一个支持 hash 配对"的页面。**升级该常量前必须重新验证目标版本页面
资源仍包含 V1 hash 配对逻辑**（探测方法：拉取
`/remote/v4/<版本>/assets/` 页面包并 grep `pass_hash`）。

`normalizeWebRemoteControlRouteAppVersion`（剥 `-safe.N` 后缀）保留导出：历史
排障工具与未来"页面支持当前版本后恢复透传"的场景仍可能使用；两处应用点当前
不再调用它。

### 3. 不应用点

- transport 注册 meta 里的 `version`（设备列表展示信息，保留真实 fork 版本）。
- 桌面其他 UI/日志仍用完整版本。

## 上游合并注意

- 上游后续版本若继续 V2（JWT 配对）演进，合并时保持本 spec：桌面 V1 文件集
  （见 `architecture-policy.yaml` 的 `web-remote-control-v1-restore` 豁免清单）
  与两处版本固定点冲突须保 V1。
- `packages/web` 与 `packages/shared/web-remote-relay` 的 V2 代码随上游更新，
  冲突时保上游（它们不参与 fork 桌面运行时）。
- E2E `web-remote-control-session-events-fixture`（fake relay V2）与
  `manual-review/pending` 的 V2 用例只适用 V2 桌面端，在 fork 上运行会失败，
  不在门禁内；恢复 V2 时一并复活。

## 验收

1. `appVersion=3.16.2-safe.1` 时：二维码 URL 含 `app_version=3.15.1`；
   bootstrap-response 的 `desktopAppVersion === "3.15.1"`。
2. 未登录智谱账号：远控面板直接展示二维码（不出现 Sign in required）。
3. 手机扫码：进入 3.15.1 手机页、hash 配对成功、可查看任务列表并打开会话。
4. 单测：`webRemoteControlManagerExternalRelay.test.ts` 版本断言、
   `webRemoteControl.test.ts` V1 QR 构造/解析、`webRemoteControlV2Qr.test.ts`
   V2 独立命名函数。
