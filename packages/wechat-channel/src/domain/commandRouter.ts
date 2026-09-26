import { isReplyMode, type ReplyMode } from "../contract.js";

/** 通道命令：整行匹配的斜杠命令；其余文本视为引擎输入。 */
export type ChannelCommand =
  | { kind: "help" }
  | { kind: "mode"; mode: ReplyMode }
  | { kind: "modeList" }
  | { kind: "stop" }
  | { kind: "new" }
  | { kind: "none"; text: string };

const COMMAND_PATTERN = /^\/([a-zA-Z]+)(?:\s+(.*?))?\s*$/u;

/**
 * 解析一条微信文本。只认整行斜杠命令（与飞书通道同一命令面）；
 * 非命令文本原样透传给引擎，不做任何静默改写。
 */
export function parseChannelCommand(raw: string): ChannelCommand {
  const text = raw.trim();
  const match = COMMAND_PATTERN.exec(text);
  if (!match) return { kind: "none", text };
  const name = match[1];
  const arg = match[2] ?? "";
  if (!name) return { kind: "none", text };
  switch (name.toLowerCase()) {
    case "help":
      return { kind: "help" };
    case "mode":
      return parseModeArg(arg);
    case "stop":
      return { kind: "stop" };
    case "new":
      return { kind: "new" };
    default:
      // 未识别命令按普通文本透传，交给引擎内建命令体系处理。
      return { kind: "none", text };
  }
}

function parseModeArg(value: string): ChannelCommand {
  const normalized = value.trim().toLowerCase();
  if (!normalized || !isReplyMode(normalized)) return { kind: "modeList" };
  return { kind: "mode", mode: normalized };
}

export function modeListText(): string {
  return [
    "可用模式：final | stream | verbose",
    "  final=仅最终文本",
    "  stream=运行中显示输入状态（微信不支持流式卡片，仅终态文本）",
    "  verbose=终态文本附工具调用行",
    "用法：/mode <模式>",
  ].join("\n");
}

export function helpText(currentMode: ReplyMode): string {
  return [
    "ZCode 微信通道（自建版）",
    `- 当前回复模式：${currentMode}`,
    "/mode final|stream|verbose — 切换回复模式",
    "/stop — 停止当前生成（排队中的输入保留）",
    "/new — 开始新会话",
    "/help — 显示本帮助",
    "其余文本直接发送给引擎；生成期间的输入会自动排队，不会丢失。",
  ].join("\n");
}
