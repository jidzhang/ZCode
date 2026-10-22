import { describe, expect, it } from "vitest";
import { createComputerUseRuntime } from "../index.js";
import {
  callBrokerMethod,
  mintBrokerSocketPath,
  resolveBrokerSocketPath,
} from "../broker.js";

describe("Computer Use placeholder", () => {
  it("执行入口明确报告不可用，且不触发真实 broker 准备", async () => {
    let prepared = false;
    const runtime = createComputerUseRuntime({
      ensureBrokerAvailable: async () => {
        prepared = true;
      },
    });
    await expect(
      runtime.execute({
        toolName: "computer_use",
        arguments: {},
        context: { sessionId: "example", runtimeScope: "main", workspaceKey: "example" },
      }),
    ).resolves.toMatchObject({ isError: true });
    expect(prepared).toBe(false);
    await runtime.dispose();
  });

  it("broker 方法拒绝执行真实系统能力", async () => {
    await expect(
      callBrokerMethod({ method: "example", socketPath: "unused" }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it.runIf(process.platform === "win32")(
    "win32 socket 路径落在 zcode-cua-helper 命名空间（真实客户端硬校验）",
    () => {
      // 真实 CUA 客户端只接受 \\.\pipe\zcode-cua-helper-(8+ hex|default)；
      // 曾按 POSIX 临时路径 mint 导致 helper 永不拉起（not accepting 永久重试）。
      const pattern = /^\\\\.\\pipe\\zcode-cua-helper-(?:[0-9a-f]{8,}|default)$/;
      expect(mintBrokerSocketPath()).toMatch(pattern);
      expect(resolveBrokerSocketPath({ env: {} })).toMatch(pattern);
      expect(resolveBrokerSocketPath({ env: {} })).toBe("\\\\.\\pipe\\zcode-cua-helper-default");
    },
  );
});
