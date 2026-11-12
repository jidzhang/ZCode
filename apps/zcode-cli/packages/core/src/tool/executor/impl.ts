import type { TraceContext, TurnId } from "@zcode/contracts";
import { createRootTraceContext } from "@zcode/contracts";
import { createDenyPermissionBroker } from "../../permission/broker.js";
import type { ToolSchedule } from "../scheduler.js";
import type {
  ExecutableToolCall,
  ToolBatchEvent,
  ToolEntry,
  ToolExecutionResult,
} from "../types.js";
import { BackgroundTaskTracker } from "./background-tasks.js";
import { executeToolBatch, executeToolSchedule } from "./batch-runner.js";
import { executeToolCall } from "./call-runner.js";
import { runPreToolUseHooks } from "./hook-flow.js";
import { areReadsDeniedWithoutPrompt, resolveToolPermission } from "./permission-flow.js";
import type {
  SteerBackgroundRegistration,
  ToolBatchExecuteOptions,
  ToolExecuteOptions,
  ToolExecutor,
  ToolExecutorDeps,
  ToolExecutorOptions,
} from "./types.js";
import { validateInput } from "./validation.js";

/** steer 转后台的默认运行时长门槛：只压已运行 ≥10s 的前台 Bash，短命令自然跑完。 */
const DEFAULT_STEER_BACKGROUND_MIN_ELAPSED_MS = 10_000;

export class ToolExecutorImpl implements ToolExecutor {
  private readonly deps: ToolExecutorDeps;
  private readonly backgroundTasks: BackgroundTaskTracker;
  /** 一个 runtime 一个执行器，序号在同一 assistant 内可比；删除、清空读取状态不影响它。 */
  private readFileStateSnapshotCount = 0;
  /**
   * 正在前台运行的 Bash 调用的 steer 注册表（key = toolCallId，含开始时间）：
   * call-runner 登记/摘除，requestSteerBackground 只触发已运行超过门槛的注册项
   * （LOCAL-PLAN-BUSY-INPUT-DELIVERY.md §3）。挂在 deps 上让 call-runner 与本方法共用同一份。
   */
  private readonly steerBackgroundControllers = new Map<string, SteerBackgroundRegistration>();

  constructor(options: ToolExecutorOptions) {
    this.deps = {
      agentTelemetry: options.agentTelemetry,
      agentTelemetryActorKind: options.agentTelemetryActorKind,
      registry: options.registry,
      permissionService: options.permissionService,
      permissionBroker: options.permissionBroker ?? createDenyPermissionBroker(),
      emitEvent: options.emitEvent,
      steerBackgroundControllers: this.steerBackgroundControllers,
      steerBackgroundMinElapsedMs: options.steerBackgroundMinElapsedMs,
      enqueueBackgroundTaskNotification: options.enqueueBackgroundTaskNotification,
      shouldEnqueueBackgroundTaskNotification: options.shouldEnqueueBackgroundTaskNotification,
      registerResidencyBlockingWork: options.registerResidencyBlockingWork,
      sessionId: options.sessionId,
      turnId: options.turnId,
      defaultTimeoutMs: options.defaultTimeoutMs ?? 300000,
      permissionTimeoutMs: options.permissionTimeoutMs,
      logger: options.logger,
      backgroundTaskControlPort: options.backgroundTaskControlPort,
      executionPort: options.executionPort,
      browserControlPort: options.browserControlPort,
      browserDocumentationRoot: options.browserDocumentationRoot,
      fileSystemPort: options.fileSystemPort,
      httpClientPort: options.httpClientPort,
      imageProcessorPort: options.imageProcessorPort,
      pdfDocumentPort: options.pdfDocumentPort,
      model: options.model,
      embeddedSearchBackend: options.embeddedSearchBackend,
      nativeSearchEnhancementsEnabled: options.nativeSearchEnhancementsEnabled,
      skillPort: options.skillPort,
      subagentPort: options.subagentPort,
      coordinatorResponsePort: options.coordinatorResponsePort,
      workflowSubmitPort: options.workflowSubmitPort,
      workflowEscalatePort: options.workflowEscalatePort,
      artifactStore: options.artifactStore,
      automationPort: options.automationPort,
      offPeakPort: options.offPeakPort,
      topicResourcePort: options.topicResourcePort,
      sessionStore: options.sessionStore,
      sessionModePort: options.sessionModePort,
      workflowPort: options.workflowPort,
      dynamicWorkflowRunPort: options.dynamicWorkflowRunPort,
      dynamicWorkflowSnippetPort: options.dynamicWorkflowSnippetPort,
      modelCatalogPort: options.modelCatalogPort,
      runtimeTaskRegistry: options.runtimeTaskRegistry,
      readFileState: options.readFileState ?? new Map(),
      nextReadFileStateSnapshotIndex: () => this.readFileStateSnapshotCount++,
      hasLoadedSkill: options.hasLoadedSkill,
      subagentBackgroundBashMaxMs: options.subagentBackgroundBashMaxMs,
      bashShellSelection: options.bashShellSelection,
      getBashShellSelection: options.getBashShellSelection,
      getWorkingDirectory: options.getWorkingDirectory ?? (() => options.workingDirectory ?? "."),
      setWorkingDirectory: options.setWorkingDirectory,
      getWorkspaceRoot:
        options.getWorkspaceRoot ??
        (() =>
          options.workspaceRoot ??
          options.getWorkingDirectory?.() ??
          options.workingDirectory ??
          "."),
      workspaceIdentity: options.workspaceIdentity,
      remoteSessionId: options.remoteSessionId,
      clientMode: options.clientMode,
      deliveryKind: options.deliveryKind,
      getMemoryRoot: options.getMemoryRoot,
      runtimeScope: options.runtimeScope ?? "main",
      traceContext: options.traceContext,
      getMode: options.getMode ?? (() => options.mode ?? "guarded"),
      maxConcurrency: options.maxConcurrency ?? 10,
      hookRunner: options.hookRunner,
    };
    this.backgroundTasks = new BackgroundTaskTracker(this.deps);
  }

  async authorizeAppTool(
    toolCall: ExecutableToolCall,
    entry: ToolEntry,
    options?: ToolExecuteOptions,
  ): Promise<unknown> {
    options?.signal?.throwIfAborted();
    const trace =
      options?.traceContext ??
      this.deps.traceContext ??
      createRootTraceContext({ sessionId: this.deps.sessionId });
    const mode = this.deps.getMode();
    const invalid = validateInput(toolCall.input, entry);
    if (invalid) throw new Error(invalid.message);
    const hooks = await runPreToolUseHooks(
      this.deps,
      toolCall,
      toolCall.input,
      entry,
      mode,
      trace,
      options?.signal,
    );
    if (hooks.preventContinuation || hooks.permissionBehavior === "deny")
      throw new Error(hooks.stopReason ?? "Tool denied by host hook");
    const input = hooks.updatedInput ?? toolCall.input;
    const updatedInvalid = validateInput(input, entry);
    if (updatedInvalid) throw new Error(updatedInvalid.message);
    const decision = await resolveToolPermission(
      this.deps,
      toolCall,
      entry,
      input,
      hooks,
      mode,
      trace,
      options?.signal,
    );
    options?.signal?.throwIfAborted();
    if (!decision.allowed)
      throw new Error(decision.result.error?.message ?? "Tool denied by host policy");
    return decision.executionInput;
  }

  areReadsDeniedWithoutPrompt(
    filePaths: readonly string[],
    traceContext: TraceContext,
  ): Promise<boolean[]> {
    return areReadsDeniedWithoutPrompt(this.deps, filePaths, traceContext);
  }

  execute(
    toolCall: ExecutableToolCall,
    options?: ToolExecuteOptions,
  ): Promise<ToolExecutionResult> {
    return executeToolCall(this.deps, this.backgroundTasks, toolCall, options);
  }

  requestSteerBackground(): number {
    // guide 准入成功（steerTurn push pendingInputs）后触发：只把已运行 ≥ 门槛（默认 10s）
    // 的前台 Bash 原地转后台（进程不杀），当前 tool batch 随即 settle、guide 在下一个
    // 边界被模型看到。门槛由用户实测反馈加入（2026-11-12）：秒级短命令（git status /
    // rg 等）撞上 guide 会被误压成"已移入后台"，模型拿不到真实结果还要处理迟到的
    // 后台通知——短命令等它自然跑完即可，边界只剩几秒。
    // 不足门槛的注册项保留：guide 再到时它可能已过门槛；调用结束由 call-runner 的
    // finally 摘除，不泄漏。返回实际触发数供诊断。
    const minElapsedMs =
      this.deps.steerBackgroundMinElapsedMs ?? DEFAULT_STEER_BACKGROUND_MIN_ELAPSED_MS;
    const now = Date.now();
    let triggered = 0;
    for (const [toolCallId, registration] of this.steerBackgroundControllers) {
      if (registration.controller.signal.aborted) {
        this.steerBackgroundControllers.delete(toolCallId);
        continue;
      }
      if (now - registration.startedAt < minElapsedMs) continue;
      registration.controller.abort(new Error("steer background"));
      this.steerBackgroundControllers.delete(toolCallId);
      triggered += 1;
    }
    return triggered;
  }

  trackExternalBackgroundTask(
    toolCall: ExecutableToolCall,
    output: Record<string, unknown>,
    traceContext: TraceContext,
    turnId?: TurnId,
  ): Promise<void> {
    // 与 submit 路径同一个 tracker 实例、同一条 trackBackgroundTask：resume 重臂的行为
    // 按构造等于工具启动路径的行为，两条路径不可能漂移（见 ToolExecutor 接口注释）。
    return this.backgroundTasks.trackBackgroundTask(toolCall, output, traceContext, turnId);
  }

  executeBatch(
    toolCalls: ExecutableToolCall[],
    options?: ToolBatchExecuteOptions,
  ): Promise<ToolExecutionResult[]> {
    return executeToolBatch(
      this.deps,
      (toolCall, executeOptions) => {
        return this.execute(toolCall, executeOptions);
      },
      toolCalls,
      options,
    );
  }

  async *executeSchedule(
    toolCalls: ExecutableToolCall[],
    schedule: ToolSchedule,
    options?: ToolBatchExecuteOptions,
  ): AsyncGenerator<ToolBatchEvent, ToolExecutionResult[], void> {
    return yield* executeToolSchedule(
      this.deps,
      (batchToolCalls, batchOptions) => this.executeBatch(batchToolCalls, batchOptions),
      toolCalls,
      schedule,
      options,
    );
  }
}

export function createToolExecutor(options: ToolExecutorOptions): ToolExecutor {
  return new ToolExecutorImpl(options);
}
