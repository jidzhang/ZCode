import assert from "node:assert/strict";
import test from "node:test";
import { buildReplyCard } from "../src/domain/cardBuilder.js";
import {
  finalTextOf,
  renderAssistantReply,
  type RenderMessage,
} from "../src/domain/replyFormatter.js";

function conversation(): RenderMessage[] {
  return [
    { role: "user", parts: [{ type: "text", text: "审查规范" }] },
    {
      role: "assistant",
      parts: [
        { type: "text", text: "开始审查。" },
        { type: "tool", tool: "web_search", status: "completed" },
        { type: "tool", tool: "web_reader", status: "running" },
        { type: "text", text: "结论：GB 50016 有效。" },
      ],
    },
  ];
}

test("stream 模式隐藏工具调用，只渲染文本", () => {
  const result = renderAssistantReply({ messages: conversation(), mode: "stream", running: true });
  assert.equal(result.text, "开始审查。结论：GB 50016 有效。");
  assert.equal(result.toolLines.length, 0);
  assert.equal(result.statusLine, "⏳ 运行中…");
});

test("verbose 模式包含工具调用行", () => {
  const result = renderAssistantReply({
    messages: conversation(),
    mode: "verbose",
    running: false,
  });
  assert.equal(result.toolLines.length, 2);
  assert.match(result.toolLines[0] ?? "", /✅ web_search/);
  assert.match(result.toolLines[1] ?? "", /⏳ web_reader/);
  assert.equal(result.statusLine, "");
});

test("synthetic/ignored 文本部件不参与渲染", () => {
  const messages: RenderMessage[] = [
    {
      role: "assistant",
      parts: [
        { type: "text", text: "系统注入", synthetic: true },
        { type: "text", text: "真实输出" },
      ],
    },
  ];
  const result = renderAssistantReply({ messages, mode: "final", running: false });
  assert.equal(result.text, "真实输出");
});

test("final 模式空输出有占位", () => {
  const result = renderAssistantReply({
    messages: [{ role: "assistant", parts: [] }],
    mode: "final",
    running: false,
  });
  assert.equal(finalTextOf(result), "（无输出）");
});

test("卡片构建：stream 无工具区块，verbose 有；输入超长被截断", () => {
  const base = renderAssistantReply({ messages: conversation(), mode: "stream", running: true });
  const streamCard = buildReplyCard(base, { mode: "stream" });
  const streamJson = JSON.stringify(streamCard);
  assert.ok(!streamJson.includes("web_search"));

  const verbose = renderAssistantReply({
    messages: conversation(),
    mode: "verbose",
    running: true,
  });
  const verboseCard = JSON.stringify(buildReplyCard(verbose, { mode: "verbose" }));
  assert.ok(verboseCard.includes("web_search"));

  const longToolLines = Array.from({ length: 50 }, (_, i) => `⏳ tool_${i}（running）`);
  const truncatedCard = JSON.stringify(
    buildReplyCard({ text: "ok", toolLines: longToolLines, statusLine: "" }, { mode: "verbose" }),
  );
  assert.ok(truncatedCard.length < 40_000);
  assert.ok(truncatedCard.includes("tool_49"));
});
