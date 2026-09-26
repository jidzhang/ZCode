import assert from "node:assert/strict";
import test from "node:test";
import { helpText, modeListText, parseChannelCommand } from "../src/domain/commandRouter.js";

test("非命令文本原样透传", () => {
  const command = parseChannelCommand("帮我审查这个 Excel 的规范条目");
  assert.deepEqual(command, { kind: "none", text: "帮我审查这个 Excel 的规范条目" });
});

test("未知斜杠命令按普通文本透传，不报错", () => {
  const command = parseChannelCommand("/status now");
  assert.equal(command.kind, "none");
});

test("识别 mode 命令并校验取值", () => {
  assert.deepEqual(parseChannelCommand("/mode final"), { kind: "mode", mode: "final" });
  assert.deepEqual(parseChannelCommand("/mode  verbose"), { kind: "mode", mode: "verbose" });
  assert.deepEqual(parseChannelCommand("/MODE stream"), { kind: "mode", mode: "stream" });
  assert.deepEqual(parseChannelCommand("/mode"), { kind: "modeList" });
  assert.deepEqual(parseChannelCommand("/mode bogus"), { kind: "modeList" });
});

test("识别 help/stop/new", () => {
  assert.equal(parseChannelCommand("/help").kind, "help");
  assert.equal(parseChannelCommand("/stop").kind, "stop");
  assert.equal(parseChannelCommand("/new").kind, "new");
});

test("helpText 包含当前模式与全部命令", () => {
  const text = helpText("stream");
  assert.match(text, /stream/);
  for (const name of ["/mode", "/stop", "/new", "/help"]) {
    assert.ok(text.includes(name), `missing ${name}`);
  }
  assert.ok(modeListText().includes("verbose"));
});
