# CLI 内存保守优化（会话驻留池收紧）

## 背景

LOCAL-PLAN-AGENT-QUALITY.md 内存专项（2026-09-29 实测）：Agent CLI×3 ~415MB（最大单进程
283MB），根因之一是 CLI 内会话驻留池偏大（target 8 / high water 16 / idle 10min），
驻留 session 的 MessageHistory + ProductProjection 双份全量常驻。

用户要求：不激进、不能把体验做坏；本次只收零风险项。

## 本次改动

`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-resident-pool.ts` 常量收紧：
target 8→4、high water 16→8、idle 10min→5min。deactivation 既有闸门（有订阅者/排队命令/
pending 交互/后台工作/operation lease 一律不回收）原样保留；只影响"无订阅者且持续空闲"
的会话更早去激活，重新打开该会话从持久层重新水化（与原 10min 路径相同，仅更早）。

## 明确不做（安全门未就绪）

- 聊天 CLI 进程级空闲回收（`idleTimeoutMs` 传 chat lane）：timer 只看 RPC 在飞数，不知道
  CLI 内部是否有 turn 在跑，长任务期间会被误杀；需先加 CLI busy 查询 RPC（30min 起步）
  再议。
- `--max-old-space-size`：经 NODE_OPTIONS 会传染用户 Bash 里跑的 node 进程；经 .cmd shim
  传参跨平台不稳。

## 验收

1. 多会话只用一个 tab：其余会话 5min 空闲后日志出现
   `zcode_protocol.session.resident_deactivated`（reason=idle_timeout），CLI 内存回落；
   点回旧会话正常恢复。
2. 正在运行/有排队输入/有弹窗的会话不回收（既有用例回归）。
