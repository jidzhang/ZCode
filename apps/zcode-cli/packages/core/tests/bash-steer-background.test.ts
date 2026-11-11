import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createSessionId,
  createToolCallId,
  type BashOutput,
  type ExecutionPort,
  type ExecutionRequest,
  type ExecutionRunOptions,
} from "@zcode/contracts";
// 复用 bash-run-conformance.test.ts 的跨包相对导入：真 NodeExecutionAdapter 驱动真实子进程，
// 验证 on_steer 生命周期「进程不杀、原地转后台」的适配器事实，而非只测 fake 端口。
import { NodeExecutionAdapter } from "../../adapters/src/exec/index.js";
import { bashHandler, bashToolEntry } from "../src/tool/handlers/bash.js";
import type { BashBackgroundLifecycleExecutionPort } from "../src/tool/handlers/bash-background-lifecycle.js";
import { PermissionService } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ToolExecutionContext, ToolEntry } from "../src/tool/types.js";

const testRoot = process.platform === "win32" ? process.env.TEMP ?? "C:\\temp" : "/tmp";

function createContext(
  executionPort: ExecutionPort,
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    toolCallId: "toolu_bash_steer_probe",
    traceId: "trace_bash_steer" as never,
    abortSignal: new AbortController().signal,
    executionPort,
    workingDirectory: testRoot,
    workspaceRoot: testRoot,
    runtimeScope: "main",
    sessionId: "sess_bash_steer" as never,
    turnId: "turn_bash_steer" as never,
    ...overrides,
  };
}

// argv 模式直接 spawn node（跨平台、不依赖 POSIX shell）：只验证 on_steer 生命周期状态机
// 与进程存活的机理，命令本身不需要是 bash 文法。
function nodeRequest(script: string, timeoutMs: number, cwd: string): ExecutionRequest {
  return {
    command: { mode: "argv", file: process.execPath, args: ["-e", script] },
    cwd,
    timeoutMs,
    outputLimit: { maxInlineBytes: 30_000, persistOutput: "on_truncate" },
    trace: {
      sessionId: "probe",
      attributes: { toolCallId: "steer-probe" },
    } as ExecutionRequest["trace"],
  };
}

describe("Bash steer-to-background（guide 准入触发转后台）", () => {
  // 用例1：on_steer 模式，进程运行中 abort steerToBackgroundSignal → kind "backgrounded"、
  // taskId 登记进 backgroundTasks、进程未被杀（真实子进程存活）。
  it("moves a running on_steer command to background without killing the process", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bash-steer-"));
    const adapter = new NodeExecutionAdapter({ outputRootDir: root });
    const steerController = new AbortController();
    let resolveStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });

    try {
      const outcome = adapter.runBashWithBackgroundLifecycle(
        nodeRequest(
          "process.stdout.write('started'); setInterval(() => undefined, 50);",
          60_000,
          root,
        ),
        { mode: "on_steer" },
        {
          steerToBackgroundSignal: steerController.signal,
          onEvent: (event) => {
            if (event.type === "started") resolveStarted();
          },
        },
      );
      await started;
      steerController.abort();
      const settled = await outcome;

      expect(settled.kind).toBe("backgrounded");
      if (settled.kind !== "backgrounded") return;
      expect(settled.trigger).toBe("steer");
      expect(settled.task.taskId).toMatch(/^exec_/u);
      // taskId 已登记且进程仍在跑：steer abort 语义是转后台而不是杀（LOCAL-PLAN-BUSY-INPUT-DELIVERY.md §3）。
      await expect(adapter.getBackgroundTask(settled.task.taskId)).resolves.toMatchObject({
        status: "running",
      });
      await new Promise((sleep) => setTimeout(sleep, 200));
      await expect(adapter.getBackgroundTask(settled.task.taskId)).resolves.toMatchObject({
        status: "running",
      });
      // 收尾：取消后台任务并等待进程退出，不留孤儿。
      await adapter.cancelBackgroundTask(settled.task.taskId);
      await expect(adapter.waitForBackgroundTask(settled.task.taskId)).resolves.toMatchObject({
        status: "cancelled",
      });
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  // 用例1b：on_steer 不改变「前台超时=杀进程」的原语义（sleep 等不合格自动转后台的命令）。
  it("keeps the foreground timeout kill semantics for on_steer commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bash-steer-timeout-"));
    const adapter = new NodeExecutionAdapter({ outputRootDir: root });

    try {
      const outcome = await adapter.runBashWithBackgroundLifecycle(
        nodeRequest("setInterval(() => undefined, 50);", 200, root),
        { mode: "on_steer" },
      );

      expect(outcome.kind).toBe("foreground");
      if (outcome.kind !== "foreground") return;
      expect(outcome.result.timedOut).toBe(true);
      expect(outcome.result.status).toBe("timed_out");
      expect(outcome.result.error?.type).toBe("timeout");
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  // 用例1c：steer 触发的转后台不是超时——auto_on_timeout 的合格命令被 steer 提前转后台时，
  // 不能误报 timedOutAfterMs（该字段只描述「超时触发」的转后台）。
  it("does not report timedOutAfterMs when an eligible command is steered to background", async () => {
    const steerController = new AbortController();
    let lifecycleEntered = false;
    const executionPort: BashBackgroundLifecycleExecutionPort = {
      async run() {
        throw new Error("run should not be called");
      },
      async runBashWithBackgroundLifecycle(_request, lifecycle, options) {
        expect(lifecycle.mode).toBe("auto_on_timeout");
        lifecycleEntered = true;
        await new Promise<void>((resolve) => {
          if (options?.steerToBackgroundSignal?.aborted) {
            resolve();
            return;
          }
          options?.steerToBackgroundSignal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        return {
          kind: "backgrounded" as const,
          trigger: "steer" as const,
          task: {
            taskId: "exec_steer_eligible",
            status: "running" as const,
            startedAt: new Date(),
          },
        };
      },
    };

    const handlerPromise = bashHandler(
      { command: "npm test", timeout: 10_000 },
      createContext(executionPort, { steerBackgroundSignal: steerController.signal }),
    );
    await vi.waitFor(() => expect(lifecycleEntered).toBe(true));
    steerController.abort();
    const output = (await handlerPromise) as BashOutput;

    expect(output.status).toBe("backgrounded");
    expect(output.backgroundTaskId).toBe("exec_steer_eligible");
    expect(output.timedOutAfterMs).toBeUndefined();
  });

  // 用例1d：路由——有 lifecycle 端口时前台 Bash 一律走 lifecycle；sleep 等不合格「自动转后台」
  // 的命令改走 on_steer，并把 steer 信号透传给端口。
  it("routes ineligible foreground commands through the on_steer lifecycle with the steer signal", async () => {
    const observations: Array<{ mode: string; hasSteerSignal: boolean }> = [];
    const executionPort: BashBackgroundLifecycleExecutionPort = {
      async run() {
        throw new Error("run should not be called");
      },
      async runBashWithBackgroundLifecycle(_request, lifecycle, options) {
        observations.push({
          mode: lifecycle.mode,
          hasSteerSignal: options?.steerToBackgroundSignal !== undefined,
        });
        return {
          kind: "foreground" as const,
          result: {
            cancelled: false,
            durationMs: 1,
            exitCode: 0,
            startedAt: new Date(),
            status: "completed" as const,
            stderr: { bytes: 0, text: "", truncated: false },
            stdout: { bytes: 0, text: "", truncated: false },
            timedOut: false,
          },
        };
      },
    };
    const steerSignal = new AbortController().signal;

    await bashHandler(
      { command: "sleep 999", timeout: 10_000 },
      createContext(executionPort, { steerBackgroundSignal: steerSignal }),
    );
    await bashHandler(
      { command: "npm test", timeout: 10_000 },
      createContext(executionPort, { steerBackgroundSignal: steerSignal }),
    );

    expect(observations).toEqual([
      // sleep 排除仅适用于「超时自动转后台」；steer 是用户显式跟进，允许转后台（on_steer）。
      { mode: "on_steer", hasSteerSignal: true },
      // 合格命令保持 auto_on_timeout 不变，同样携带 steer 信号（提前转后台能力）。
      { mode: "auto_on_timeout", hasSteerSignal: true },
    ]);
  });

  // 用例2：requestSteerBackground 只触发 Bash 注册项——非 Bash 工具不登记、不受影响；
  // 触发后注册表清空，二次调用返回 0。
  it("requestSteerBackground triggers only registered Bash tool calls", async () => {
    const registry = createToolRegistry();
    registry.register(bashToolEntry);
    let resolveIdle: (() => void) | undefined;
    const idleDone = new Promise<void>((resolve) => {
      resolveIdle = resolve;
    });
    let idleSteerSignal: AbortSignal | undefined;
    let idleStarted = false;
    // 非 Bash 工具：复用 bashToolEntry 的合法结构，仅换名与 handler，验证注册表按工具名过滤。
    const idleEntry: ToolEntry = {
      ...bashToolEntry,
      metadata: { ...bashToolEntry.metadata, name: "IdleProbe" },
      handler: async (_input: unknown, context: ToolExecutionContext) => {
        idleStarted = true;
        idleSteerSignal = context.steerBackgroundSignal;
        await idleDone;
        return {
          stdout: "",
          stderr: "",
          interrupted: false,
          isImage: false,
          noOutputExpected: false,
          status: "completed",
        };
      },
    };
    registry.register(idleEntry);

    let capturedLifecycleMode: string | undefined;
    const executionPort: BashBackgroundLifecycleExecutionPort = {
      async run() {
        throw new Error("run should not be called");
      },
      async runBashWithBackgroundLifecycle(
        _request: ExecutionRequest,
        lifecycle: { mode: string },
        options?: ExecutionRunOptions,
      ) {
        capturedLifecycleMode = lifecycle.mode;
        await new Promise<void>((resolve) => {
          if (options?.steerToBackgroundSignal?.aborted) {
            resolve();
            return;
          }
          options?.steerToBackgroundSignal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        return {
          kind: "backgrounded" as const,
          trigger: "steer" as const,
          task: {
            taskId: "exec_steer_registry",
            status: "running" as const,
            startedAt: new Date(),
          },
        };
      },
    };

    const executor = createToolExecutor({
      registry,
      permissionService: new PermissionService(),
      permissionBroker: {
        requestPermission: async () => ({ decision: "allow" as const, resolvedAt: new Date() }),
      },
      executionPort,
      mode: "yolo",
      workingDirectory: testRoot,
      workspaceRoot: testRoot,
      sessionId: createSessionId("bash-steer-registry"),
      emitEvent: async () => undefined,
    });

    const bashExecution = executor.execute({
      id: createToolCallId("bash-steer-call"),
      name: "Bash",
      input: { command: "sleep 999" },
    });
    await vi.waitFor(() => expect(capturedLifecycleMode).toBe("on_steer"));
    const idleExecution = executor.execute({
      id: createToolCallId("idle-steer-call"),
      name: "IdleProbe",
      input: { command: "idle probe" },
    });
    await vi.waitFor(() => expect(idleStarted).toBe(true));

    // guide 准入触发：只有 Bash 的 steer controller 被 abort（返回 1），IdleProbe 不受影响。
    expect(executor.requestSteerBackground?.()).toBe(1);

    const bashResult = await bashExecution;
    expect(bashResult.success).toBe(true);
    expect(bashResult.output).toMatchObject({
      status: "backgrounded",
      backgroundTaskId: "exec_steer_registry",
    });
    // 非 Bash 工具的 context 不携带 steer 信号（未登记）。
    expect(idleSteerSignal).toBeUndefined();
    resolveIdle?.();
    await expect(idleExecution).resolves.toMatchObject({ success: true });
    // 注册表已清空 + Bash 调用结束后摘除登记：再次触发为 0。
    expect(executor.requestSteerBackground?.()).toBe(0);
  }, 15_000);
});
