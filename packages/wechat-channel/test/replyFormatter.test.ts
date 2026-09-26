import assert from "node:assert/strict";
import test from "node:test";
import {
  finalTextOf,
  renderAssistantReply,
  type RenderMessage,
} from "../src/domain/replyFormatter.js";

function messagesWith(parts: RenderMessage[number]["parts"]): readonly RenderMessage[] {
  return [{ role: "assistant", parts }];
}

test("final/verbose 终态仅正文，不含工具行", () => {
  const messages = messagesWith([
    { type: "tool", tool: "read_file", status: "completed" },
    { type: "text", text: "结论：OK" },
  ]);
  const rendered = renderAssistantReply({ messages, mode: "final", running: false });
  assert.equal(finalTextOf(rendered, "final"), "结论：OK");
});

test("verbose 终态正文后附工具行", () => {
  const messages = messagesWith([
    { type: "tool", tool: "read_file", status: "completed" },
    { type: "tool", tool: "run_tests", status: "failed" },
    { type: "text", text: "结论：有问题" },
  ]);
  const rendered = renderAssistantReply({ messages, mode: "verbose", running: false });
  const text = finalTextOf(rendered, "verbose");
  assert.match(text, /结论：有问题/);
  assert.match(text, /✅ read_file（completed）/);
  assert.match(text, /❌ run_tests（failed）/);
});

test("synthetic/ignored 文本部件被排除", () => {
  const messages = messagesWith([
    { type: "text", text: "真实输出" },
    { type: "text", text: "系统注入", synthetic: true },
    { type: "text", text: "已忽略", ignored: true },
  ]);
  const rendered = renderAssistantReply({ messages, mode: "final", running: false });
  assert.equal(finalTextOf(rendered), "真实输出");
});

test("空回复给出占位，不发出空消息", () => {
  const rendered = renderAssistantReply({ messages: [], mode: "final", running: false });
  assert.equal(finalTextOf(rendered), "（无输出）");
  const toolOnly = renderAssistantReply({
    messages: messagesWith([{ type: "tool", tool: "read_file", status: "completed" }]),
    mode: "verbose",
    running: false,
  });
  assert.match(finalTextOf(toolOnly, "verbose"), /回合完成，无文本输出/);
});

test("超长正文被截断并标注", () => {
  const messages = messagesWith([{ type: "text", text: "x".repeat(25_000) }]);
  const rendered = renderAssistantReply({ messages, mode: "final", running: false });
  assert.ok(rendered.text.length < 25_000);
  assert.match(rendered.text, /已截断/);
});
