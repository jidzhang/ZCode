import assert from "node:assert/strict";
import { test } from "vitest";
import {
  getFeishuErrorCode,
  isInvalidFeishuTokenCode,
  type FeishuApiError,
} from "../src/bots/providers/feishuProvider.js";

// 修复背景（2026-09-25 实机事故）：装机版飞书 bot 的 tenant_access_token 在声明的
// 有效期内被服务端作废（code=99991663），而 token 缓存既不驱逐也不读 expire，
// 退避重试复用坏 token 三连败后熔断无复位，最终回复被静默丢弃。
// 本组测试锁定自愈决策的纯函数部分。缓存 TTL 逻辑 3.15.1 起随上游实现
// （requestedAt + expire，无 token 即驱逐），fork 的 TTL 换算 helper 已删。

test("isInvalidFeishuTokenCode 只认无效 token 类错误码", () => {
  assert.equal(isInvalidFeishuTokenCode(99_991_663), true);
  assert.equal(isInvalidFeishuTokenCode(99_991_661), true);
  assert.equal(isInvalidFeishuTokenCode(99_991_664), true);
  assert.equal(isInvalidFeishuTokenCode(0), false);
  assert.equal(isInvalidFeishuTokenCode(99_991_672), false);
  assert.equal(isInvalidFeishuTokenCode(undefined), false);
});

test("getFeishuErrorCode 从错误对象读取业务码", () => {
  const error: FeishuApiError = new Error(
    "Feishu send interactive message failed: HTTP 400, code=99991663",
  );
  error.feishuCode = 99_991_663;
  assert.equal(getFeishuErrorCode(error), 99_991_663);
  assert.equal(getFeishuErrorCode(new Error("plain error")), undefined);
  assert.equal(getFeishuErrorCode("string error"), undefined);
  assert.equal(getFeishuErrorCode(null), undefined);
});
