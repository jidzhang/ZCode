## What's new

- Synced with upstream ZCode 3.18.2 (bundled Office plugins, settings search, composer-based message editing, per-host unread badges, worktree support).
- Restored "Fix typos" in the edit bar: one auxiliary call fixes obvious typos, `Ctrl+Z` reverts.
- Press and hold the left mouse button in the input area to talk (Qoder-style); release inside to insert, release outside to cancel. Quick clicks, text selection and double-clicks keep working as before.
- Log level is back in Settings → General (next to Data directory).
- The phone remote-control page no longer polls marketing content — removes a recurring "Unknown channel: marketing-touch" error in logs.
- Runtime now reports its real version in memory diagnostics (was 0.0.0-dev); expected startup-outage log noise is downgraded to debug.

---

## 本次更新

- 同步上游 ZCode 3.18.2（内置 Office 插件族、设置搜索、消息编辑移入底部输入框、按主机未读角标、worktree 支持）。
- 编辑状态条恢复「纠错」：一次辅助调用纠正明显错别字，`Ctrl+Z` 一步撤销。
- 输入区按住鼠标左键即可说话（仿 Qoder）：区域内松开写入文字、移出松开取消；快速点击、拖选、双击等原有操作不受影响。
- 找回设置 → 常规中的日志级别选项（与数据目录同组）。
- 手机远控页不再拉取营销内容——消除日志中周期性的 "Unknown channel: marketing-touch" 报错。
- 运行时在内存诊断中上报真实版本（此前为 0.0.0-dev）；预期的出站拦截日志降为 debug。

---


## 本次更新

- 任务运行中发送的消息现在秒级送达模型：运行超过 10 秒的前台长命令会在消息到达时自动转入后台——进程不中断，跑完后结果自动汇报。
- 修复设置文件单个非法键导致整份设置被重置的问题（此前升级后代理设置丢失即此因）。
- 流式思考默认展开为多行正文（原地增长），回合结束后自动收起。
- 侧栏项目/任务列表文字、思考与工具卡文字提亮，更易读。
- 常驻 CLI 会话空闲内存占用降低。

---

> 适用于 macOS 12（Monterey）。macOS 13 及以上请使用通用版 Release；正在用通用版的设备不要安装本版。本版无自动更新，升级请回到本 Release 手动下载；未签名，首开被拦请右键「打开」或执行 `xattr -d com.apple.quarantine /Applications/ZCode.app`。
