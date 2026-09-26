import type { ReplyMode } from "../contract.js";

/**
 * 渲染输入的消息部件。结构性收窄自 @zcode/shared 的 ZCodeMessagePart，
 * 与飞书通道的 replyFormatter 同构；adapters 负责映射。
 */
export interface RenderPart {
  type: string;
  text?: string;
  tool?: string;
  status?: string;
  synthetic?: boolean;
  ignored?: boolean;
}

export interface RenderMessage {
  role?: string;
  parts: readonly RenderPart[];
}

export interface RenderRequest {
  messages: readonly RenderMessage[];
  mode: ReplyMode;
  /** 回合是否进行中（final 模式下不参与；微信无中间渲染，仅终态使用）。 */
  running: boolean;
}

export interface RenderResult {
  /** 助手正文（纯文本）；无内容时为空串。 */
  text: string;
  /** 工具调用行（仅 verbose 模式非空）。 */
  toolLines: string[];
  /** 状态行；微信为纯文本媒介，不单独渲染状态行，仅由 coordinator 做 typing 指示。 */
  statusLine: string;
}

const MAX_TEXT_LENGTH = 20_000;

/**
 * 从最近一条助手消息渲染通道回复。全量重读 + 幂等渲染：
 * 同一份消息多次渲染结果一致。
 */
export function renderAssistantReply(request: RenderRequest): RenderResult {
  const assistant = lastAssistant(request.messages);
  const parts = assistant?.parts ?? [];
  const text = parts
    .filter((part) => part.type === "text" && !part.synthetic && !part.ignored)
    .map((part) => part.text ?? "")
    .join("")
    .trim();
  const toolLines =
    request.mode === "verbose"
      ? parts
          .filter((part) => part.type === "tool")
          .map((part) => formatToolLine(part))
          .filter(Boolean)
      : [];
  const truncated =
    text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}\n…（已截断）` : text;
  return {
    text: truncated,
    toolLines,
    statusLine: request.running ? "⏳ 运行中…" : "",
  };
}

function lastAssistant(messages: readonly RenderMessage[]): RenderMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function formatToolLine(part: RenderPart): string {
  if (!part.tool) return "";
  const status = part.status?.trim();
  const mark =
    status === "completed" || status === "success"
      ? "✅"
      : status === "failed" || status === "error"
        ? "❌"
        : "⏳";
  return `${mark} ${part.tool}${status ? `（${status}）` : ""}`;
}

/** 终态文本：final/stream 仅正文；verbose 正文后附工具行；正文为空时给出占位。 */
export function finalTextOf(result: RenderResult, mode: ReplyMode = "final"): string {
  const body =
    result.text || (result.toolLines.length > 0 ? "（回合完成，无文本输出）" : "（无输出）");
  if (mode === "verbose" && result.toolLines.length > 0) {
    return `${body}\n\n工具调用：\n${result.toolLines.join("\n")}`;
  }
  return body;
}
