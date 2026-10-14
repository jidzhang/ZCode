import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCODE_RUNTIME_ENV_KEY } from "@zcode/shared";
import { createServiceLogger, setServiceLogLevel } from "../src/logger/serviceLogger.js";

describe("createServiceLogger", () => {
  const originalRuntimeEnv = process.env[ZCODE_RUNTIME_ENV_KEY];
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalRuntimeEnv == null) {
      delete process.env[ZCODE_RUNTIME_ENV_KEY];
    } else {
      process.env[ZCODE_RUNTIME_ENV_KEY] = originalRuntimeEnv;
    }
    if (originalNodeEnv == null) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("未声明 ZCODE_RUNTIME_ENV 时默认不输出 debug 日志", () => {
    delete process.env[ZCODE_RUNTIME_ENV_KEY];
    delete process.env.NODE_ENV;
    const sink = createSink();
    const logger = createServiceLogger("test", { sink });

    logger.debug(undefined, "hidden");
    logger.info(undefined, "visible");

    expect(sink.debug).not.toHaveBeenCalled();
    expect(sink.log).toHaveBeenCalledTimes(1);
  });

  it("只设置 NODE_ENV=development 时不输出 debug 日志", () => {
    delete process.env[ZCODE_RUNTIME_ENV_KEY];
    process.env.NODE_ENV = "development";
    const sink = createSink();
    const logger = createServiceLogger("test", { sink });

    logger.debug(undefined, "hidden");

    expect(sink.debug).not.toHaveBeenCalled();
  });

  it("显式 ZCODE_RUNTIME_ENV=development 时输出 debug 日志", () => {
    process.env[ZCODE_RUNTIME_ENV_KEY] = "development";
    // fork：settings.json 日志级别阈值（默认 info）会先拦掉 debug；
    // 开发态要看到 debug 必须显式把级别放到 debug，测试按同一入口设置。
    // try/finally 保证断言失败时级别也复位，不污染同文件后续用例。
    setServiceLogLevel("debug");
    try {
      const sink = createSink();
      const logger = createServiceLogger("test", { sink });

      logger.debug(undefined, "visible");

      expect(sink.debug).toHaveBeenCalledTimes(1);
    } finally {
      setServiceLogLevel("info");
    }
  });
});

function createSink() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
  };
}
