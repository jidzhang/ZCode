import assert from "node:assert/strict";
import test from "node:test";
import {
  getFeishuErrorCode,
  isInvalidFeishuTokenCode,
  resolveFeishuTokenCacheTtlMs,
  type FeishuApiError,
} from "../src/bots/providers/feishuProvider.js";

// 修复背景（2026-09-25 实机事故）：装机版飞书 bot 的 tenant_access_token 在声明的
// 有效期内被服务端作废（code=99991663），而 token 缓存既不驱逐也不读 expire，
// 退避重试复用坏 token 三连败后熔断无复位，最终回复被静默丢弃。
// 本组测试锁定自愈决策的纯函数部分。

test("resolveFeishuTokenCacheTtlMs 尊重 expire 并保留安全余量", () => {
  // expire 缺失/非法：保持旧行为 90 分钟
  assert.equal(resolveFeishuTokenCacheTtlMs(undefined), 90 * 60_000);
  assert.equal(resolveFeishuTokenCacheTtlMs(Number.NaN), 90 * 60_000);
  // 飞书标准 2h：被 90min 上限封顶，与旧实现一致
  assert.equal(resolveFeishuTokenCacheTtlMs(7_200), 90 * 60_000);
  // 服务端短有效期：expire - 5min
  assert.equal(resolveFeishuTokenCacheTtlMs(1_800), 25 * 60_000);
  // 过短时保底 1min，避免 0/负 TTL 造成每个请求都重新取 token
  assert.equal(resolveFeishuTokenCacheTtlMs(350), 60_000);
});

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
