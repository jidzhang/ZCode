import type { RenderResult } from "./replyFormatter.js";

/**
 * 构造飞书交互卡片 JSON（update_multi 允许原地 PATCH 更新）。
 * stream 模式：状态行 + 正文；verbose 模式追加工具调用行。
 * 纯函数：同一输入产生同一卡片，可安全重复 PATCH。
 */
export function buildReplyCard(
  result: RenderResult,
  opts: { mode: "stream" | "verbose" },
): Record<string, unknown> {
  const sections: string[] = [];
  if (result.statusLine) sections.push(result.statusLine);
  sections.push(result.text || "…");
  const elements: Record<string, unknown>[] = [
    { tag: "div", text: { tag: "lark_md", content: sections.join("\n\n") } },
  ];
  if (opts.mode === "verbose" && result.toolLines.length > 0) {
    // 工具行放独立区块，正文超长截断时也不影响阅读主线。
    elements.push({ tag: "hr" });
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: truncateLines(result.toolLines).join("\n") },
    });
  }
  return {
    config: { update_multi: true, wide_screen_mode: true },
    elements,
  };
}

const MAX_CARD_CHARS = 28_000;
const MAX_TOOL_LINES = 30;

function truncateLines(lines: string[]): string[] {
  const kept = lines.slice(-MAX_TOOL_LINES);
  const dropped = lines.length - kept.length;
  const prefix = dropped > 0 ? [`…（前 ${dropped} 条工具调用已省略）`] : [];
  const merged = [...prefix, ...kept];
  let total = merged.reduce((sum, line) => sum + line.length + 1, 0);
  while (total > MAX_CARD_CHARS && merged.length > 1) {
    const removed = merged.shift();
    total -= (removed?.length ?? 0) + 1;
  }
  return merged;
}
