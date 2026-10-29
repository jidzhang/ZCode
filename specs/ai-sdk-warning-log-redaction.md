# AI SDK 警告日志脱敏与压缩

## 背景

`installZCodeProtocolAiSdkWarningLogger`（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/ai-sdk-warning-logger.ts`）
把 AI SDK 的每条 warning 原样写进 `cli/log/*.jsonl`。2026-10-28 实测：

- `model.sdk.warning` 每天 84 条，平均 **17.5 KB/条**、合计 1.44 MB/天，是单条最大的日志记录。
- 内容形如 `Non-OpenAI reasoning parts are not supported. Skipping reasoning part:
  {"type":"reasoning","text":"<模型完整思维链>","providerOptions":{...}}`。

即**模型完整 chain-of-thought 被写进日志**，还附带 providerOptions 里的签名。两个问题：

1. 隐私/合规：思维链可能包含用户代码、路径、凭据片段；日志会被导出进支持包
   （`docs/desktop/log-export-retention.md` 明确把 `cli/log/**` 纳入导出范围）。
2. 体积：单条 17.5 KB 让这一条事件吃掉整日日志的 7%，且是 warn 级别，提高默认级别也挡不住。

## 产品规则

1. 警告记录保留结构性事实：`type`、`feature`、`message` 前缀、`warningCount`、
   `model`、`provider`。这些足以判断"哪个 warning 在反复出现"。
2. **正文（`message` / `details` 中的内嵌载荷）必须脱敏压缩**：
   - 形如 `Skipping reasoning part: {json...}` 的载荷，只保留 `type` 字段与文本长度，
     丢弃 `text` 全文和 `providerOptions` 里的签名。
   - 通用做法：字符串中若出现 `{` 起始的内联 JSON，替换为
     `{"__elided__":true,"bytes":<原长度>}`；其余文本按单条上限截断。
3. 单条字符串上限 512 字符，超出截断并追加 `…(truncated, N chars)` 标记。整条
   `warnings` 数组上限 20 项，超出部分折叠为 `{type:"truncated", omitted:<n>}`。
4. 任何脱敏/压缩失败都不能抛错，也不能回退成写原文：捕获后写
   `{type:"log_format_failed"}`。这是 warning 记录，绝不能影响真实模型请求。
5. 不改 warning 的级别（仍为 `warn`）：它就是应该在默认 warn 阈值下可见，
   只是不该带正文。

## 验收场景

1. 传入 `message: "Skipping reasoning part: {\"type\":\"reasoning\",\"text\":\"<长文本>\"}"`：
   落盘记录中不含该长文本，含 `__elided__` 与原始字节数。
2. 传入 100 条 warning：落盘 `warnings` 长度 ≤ 21（20 条 + 1 条 truncated 折叠项）。
3. 传入 10 KB 普通纯文本 message：落盘长度 ≤ 512 + 截断标记。
4. 传入 `warnings` 非数组 / 元素非法：仍写一条 `model.sdk.warning`，不抛错。
5. 既有断言 `logEntries.some(entry => entry.event === "model.sdk.warning")` 继续通过。

## 状态所有者

无新增状态。`summarizeWarning` 是纯函数，输入 AI SDK warning，输出可落盘的
`LogContext`；`DefaultLogRedactor` 继续负责 key 级别的凭据脱敏（两级互补：
redactor 挡 key，本函数挡 value 正文）。
