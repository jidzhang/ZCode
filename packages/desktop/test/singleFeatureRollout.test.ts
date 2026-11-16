import { describe, expect, it, vi } from "vitest";
import { createSingleFeatureRollout } from "../src/main/singleFeatureRollout.js";

function gatedError(): Error & { code: string } {
  // 与 desktop main 的出站门控 throw 同形（index.ts 附带 code 标记）。
  return Object.assign(new Error("startup outbound disabled by setting"), {
    code: "STARTUP_OUTBOUND_DISABLED",
  });
}

function createHarness(options: {
  fetchConfig?: () => Promise<unknown>;
  withDebug?: boolean;
}) {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    ...(options.withDebug ? { debug: vi.fn() } : {}),
  };
  const fetchConfig =
    options.fetchConfig ?? (() => Promise.reject(gatedError()));
  const rollout = createSingleFeatureRollout({
    resolveConfig: (payload) =>
      payload && typeof payload === "object" ? { enabled: true } : null,
    defaultValue: { enabled: false },
    logTag: "test-rollout",
    fetchConfig,
    logger,
  });
  return { rollout, logger, fetchConfig };
}

describe("singleFeatureRollout 出站门控降噪", () => {
  it("门控拦截（code 标记）降为 debug，不再 warn", async () => {
    const { rollout, logger } = createHarness({ withDebug: true });

    const snapshot = await rollout.refresh();

    expect(snapshot).toEqual({ enabled: false });
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logger 未提供 debug 时回退 warn：预期失败也不会静默丢失", async () => {
    const { rollout, logger } = createHarness({ withDebug: false });

    await rollout.refresh();

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("真实网络故障（无 code 标记）保持 warn", async () => {
    const { rollout, logger } = createHarness({
      withDebug: true,
      fetchConfig: () => Promise.reject(new Error("socket hang up")),
    });

    await rollout.refresh();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("门控失败仍进入退避窗口：窗口内 refresh 不重发请求", async () => {
    const fetchConfig = vi.fn(() => Promise.reject(gatedError()));
    const { rollout } = createHarness({ withDebug: true, fetchConfig });

    await rollout.refresh();
    await rollout.refresh();

    expect(fetchConfig).toHaveBeenCalledTimes(1);
  });
});
