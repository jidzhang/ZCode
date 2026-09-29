import assert from "node:assert/strict";
import test from "node:test";
import {
  getCompactToolCallSummary,
  redactSecretsInDisplayText,
  redactTelemetryText,
} from "@zcode/shared";
import {
  formatBotPermissionRequestSummary,
  formatBotToolCallSummaryLine,
} from "../src/bots/replyFormatter.js";
import { formatStatusStreamToolProgress } from "../src/bots/statusFormatting.js";

// 修复背景：bot 通道把工具调用摘要原样发进第三方聊天，command/prompt 与错误文本里带的
// 凭据会直接泄漏。本组测试锁定显示层脱敏（只清凭据，不碰路径/URL/邮箱）与四个出口收口。
// 样例密钥均为假串，不得出现真实凭据。

test("redactSecretsInDisplayText 打码 Bearer 头并保留占位符口径", () => {
  const redacted = redactSecretsInDisplayText(
    'curl -H "Authorization: Bearer faketoken1234567890abcdef" https://example.com/api',
  );
  assert.ok(!redacted.includes("faketoken1234567890abcdef"));
  assert.ok(redacted.includes("{redacted}"));
  assert.ok(redacted.includes("https://example.com/api"));
});

test("redactSecretsInDisplayText 打码 JSON 里的 api_key", () => {
  const redacted = redactSecretsInDisplayText('{"api_key": "sk-test1234567890abcd"}');
  assert.ok(!redacted.includes("sk-test1234567890abcd"));
  assert.ok(redacted.includes("{redacted}"));
  assert.ok(redacted.includes("api_key"));
});

test("redactSecretsInDisplayText 只打码 URL query 参数值、保留 URL 与参数名", () => {
  const redacted = redactSecretsInDisplayText(
    "https://example.com/api?api_key=fakequerytoken123456&next=/path",
  );
  assert.ok(!redacted.includes("fakequerytoken123456"));
  assert.ok(redacted.includes("https://example.com/api"));
  assert.ok(redacted.includes("api_key="));
  assert.ok(redacted.includes("next=/path"));
});

test("redactSecretsInDisplayText 打码 st_ 长令牌与已知前缀令牌", () => {
  assert.equal(
    redactSecretsInDisplayText("session st_test1234567890abcdef1234 done"),
    "session {secret} done",
  );
  assert.ok(
    !redactSecretsInDisplayText("key ghp_test1234567890abcdefghij end").includes(
      "ghp_test1234567890abcdefghij",
    ),
  );
  assert.ok(
    !redactSecretsInDisplayText("key AKIAZZZZZZZZZZZZZZZZ end").includes(
      "AKIAZZZZZZZZZZZZZZZZ",
    ),
  );
});

test("redactSecretsInDisplayText 不打码普通路径、邮箱与普通命令", () => {
  const text =
    "git status --short C:\\Users\\tester\\project\\file.txt /Users/tester/project/file.txt dev@example.com";
  assert.equal(redactSecretsInDisplayText(text), text);
});

test("redactSecretsInDisplayText 空串与非字符串返回空串", () => {
  assert.equal(redactSecretsInDisplayText(""), "");
  assert.equal(redactSecretsInDisplayText(undefined), "");
  assert.equal(redactSecretsInDisplayText(null), "");
});

test("redactSecretsInDisplayText 不改变 redactTelemetryText 既有行为", () => {
  assert.equal(redactTelemetryText(undefined), "");
  assert.ok(redactTelemetryText("plain command git status").includes("git status"));
});

test("getCompactToolCallSummary 的 secondaryText 脱敏 command 凭据", () => {
  const summary = getCompactToolCallSummary({
    kind: "bash",
    input: {
      command: 'curl -H "Authorization: Bearer faketoken1234567890abcdef" https://example.com/api',
    },
  });
  assert.ok(summary.secondaryText);
  assert.ok(!summary.secondaryText.includes("faketoken1234567890abcdef"));
});

test("formatBotToolCallSummaryLine 的 failed error 文本脱敏", () => {
  const line = formatBotToolCallSummaryLine({
    toolId: "tool-1",
    title: "bash",
    kind: "bash",
    input: { command: "git status --short" },
    status: "failed",
    error: "request failed with Bearer faketoken1234567890abcdef",
  });
  assert.ok(!line.includes("faketoken1234567890abcdef"));
  assert.ok(line.includes("git status --short"));
});

test("formatBotPermissionRequestSummary 的 preview.command 脱敏", () => {
  const text = formatBotPermissionRequestSummary({
    title: "run command",
    description: "run command",
    kind: "command",
    raw: { input: { command: "deploy --token=fakeperm1234567890abcd" } },
  });
  assert.ok(!text.includes("fakeperm1234567890abcd"));
});

test("formatStatusStreamToolProgress 的 command 预览脱敏", () => {
  const text = formatStatusStreamToolProgress({
    type: "tool_call",
    taskId: "task-1",
    traceId: "trace-1",
    toolId: "tool-1",
    title: "bash",
    kind: "bash",
    input: { command: "curl https://example.com/api?token=fakestatustoken123456" },
    raw: {},
  });
  assert.ok(text);
  assert.ok(!text.includes("fakestatustoken123456"));
});
