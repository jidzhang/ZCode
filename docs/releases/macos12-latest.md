## What's new

- Messages sent while a task is running now reach the model in seconds: long-running foreground shell commands (running for 10+ seconds) are moved to the background automatically when your message arrives — the process keeps running, results are reported back when done.
- A single invalid key in the settings file no longer resets all settings (fixes proxy settings being lost after upgrading).
- Streaming reasoning is now expanded by default (multi-line, grows in place); it auto-collapses when the turn ends.
- Sidebar project/task list text and streaming reasoning/tool-card text are brighter and easier to read.
- Lower idle memory usage for resident CLI sessions.

---

## 本次更新

- 任务运行中发送的消息现在秒级送达模型：运行超过 10 秒的前台长命令会在消息到达时自动转入后台——进程不中断，跑完后结果自动汇报。
- 修复设置文件单个非法键导致整份设置被重置的问题（此前升级后代理设置丢失即此因）。
- 流式思考默认展开为多行正文（原地增长），回合结束后自动收起。
- 侧栏项目/任务列表文字、思考与工具卡文字提亮，更易读。
- 常驻 CLI 会话空闲内存占用降低。

---

> 适用于 macOS 12（Monterey）。macOS 13 及以上请使用通用版 Release；正在用通用版的设备不要安装本版。本版无自动更新，升级请回到本 Release 手动下载；未签名，首开被拦请右键「打开」或执行 `xattr -d com.apple.quarantine /Applications/ZCode.app`。
