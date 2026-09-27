import assert from "node:assert/strict";
import test from "node:test";
import {
  filterWelcomeScreenOpenReason,
  isWelcomeScreenOpenReasonAllowed,
} from "../src/lib/localUiOverrides.js";

test("登录推送白名单：用户主动触发的 reason 放行", () => {
  assert.equal(isWelcomeScreenOpenReasonAllowed("manual-login"), true);
  assert.equal(isWelcomeScreenOpenReasonAllowed("provider-request"), true);
  assert.equal(isWelcomeScreenOpenReasonAllowed("logout-provider-required"), true);
});

test("登录推送白名单：上游主动推送的 reason 吞掉", () => {
  // 启动守卫强推（未登录且无可用 provider / 从未绑定账号域）。
  assert.equal(isWelcomeScreenOpenReasonAllowed("startup-provider-required"), false);
  // token 过期全屏重登（上游无 refresh token，隔夜必触发）。
  assert.equal(isWelcomeScreenOpenReasonAllowed("session-expired"), false);
});

test("登录推送白名单：未知 reason 默认吞掉（上游未来新增推送面默认静默）", () => {
  assert.equal(isWelcomeScreenOpenReasonAllowed("some-future-onboarding-nudge"), false);
});

test("filter：null 关闭请求原样放行，白名单外折叠为 null", () => {
  assert.equal(filterWelcomeScreenOpenReason(null), null);
  assert.equal(filterWelcomeScreenOpenReason("manual-login"), "manual-login");
  assert.equal(filterWelcomeScreenOpenReason("session-expired"), null);
});
