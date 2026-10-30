import {
  SessionEventType,
  createChildTraceContext,
  runWithModelInvocationContext,
  traceContextToLogContext,
} from "../deps.js";
import type {
  Model,
  ModelInputMessage,
  ModelSelection,
  ModelRequest,
  ModelToolCall,
  ModelToolContract,
  ModelUsage,
  SessionEvent,
  TraceContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { recordModelUsageFact } from "./usage-observability.js";
import { createRuntimeModel } from "./runtime-model.js";
import { resolveNormalRequestMaxOutputTokens } from "./model-token-limits.js";
import { normalizeStreamError } from "../helpers/index.js";
import { auxiliaryModelOptions } from "../../model/auxiliary-model-options.js";
import { INPUT_PREDICTION_QUERY_SOURCE } from "./input-prediction-sidecar.js";

const WORKSPACE_GENERATE_TEXT_TIMEOUT_MS = 60_000;
// 探针预算沿用目标模型的有效 maxOutputTokens（用户填写值；留空时为内置/继承默认值）。
// 曾用 1 token 硬编码，落到 openai-responses wire 上为 max_output_tokens=1，
// 被要求 max_output_tokens>=16 的上游网关直接 400，导致"对话可用、测试必失败"。
// 探测请求使用固定最小 prompt，避免多余推理开销；不可改写角色、文本或混入会话历史。
const CONNECTIVITY_PROBE_SYSTEM = "You are ZCode connectivity probe.";
const CONNECTIVITY_PROBE_USER = "hi";
const GIT_COMMIT_MESSAGE_QUERY_SOURCE = "git_commit_message";
// 消息编辑窗「纠错」：一次独立的辅助请求，只回填编辑框，不进会话历史
// （specs/text-proofread-in-edit.md）。
export const TEXT_PROOFREAD_QUERY_SOURCE = "text_proofread";
/** 辅助请求统一绑定最低公开档位，与标题/提交信息生成同一约定。 */
const AUXILIARY_QUERY_SOURCES: ReadonlySet<string> = new Set([
  GIT_COMMIT_MESSAGE_QUERY_SOURCE,
  TEXT_PROOFREAD_QUERY_SOURCE,
  // 输入预测按键触发、要求低延迟，同样走最低档位（上游 3.17.1 纳入）。
  INPUT_PREDICTION_QUERY_SOURCE,
]);

export interface WorkspaceGenerateTextInput {
  selection: ModelSelection;
  prompt?: string;
  messages?: ModelInputMessage[];
  tools?: ModelToolContract[];
  querySource: string;
  maxOutputTokens?: number;
  /**
   * 显式档位覆盖：纠错的最低档被上游拒绝时，调用方改用会话当前档位重试一次。
   * 缺省按 AUXILIARY_QUERY_SOURCES 绑定最低公开档，其他 querySource 沿用选择自带档位。
   */
  reasoningLevel?: string;
}

export interface WorkspaceGenerateTextResult {
  text: string;
  selection: ModelSelection;
  finishReason: string;
  usage?: ModelUsage;
  toolCalls?: ModelToolCall[];
}

export interface ModelConnectivityTestInput {
  selection: ModelSelection;
}

export async function testModelConnectivity(
  this: AgentRuntimeInternal,
  input: ModelConnectivityTestInput,
  options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
): Promise<void> {
  const baseModel = createRuntimeModel(this, { selection: input.selection, scope: "workspace" });
  // 连接探测不需要生成正文，但预算必须沿用目标模型的有效 maxOutputTokens：
  // 用户填写值经 Registry 合并后已在 optionSpecs.maxOutputTokens.max 中，留空时为
  // 内置/继承默认值（如默认档 32000）；硬编码小预算会被上游最小值校验拒绝。
  // 不另设 16 下限：高于 spec.max 的 wire 值会被 bind 本地校验拒绝，虚报低于
  // spec.max 的配置也会掩盖"配置与网关不兼容"的事实，按原值发送、400 如实透出。
  const probeMaxOutputTokens = resolveNormalRequestMaxOutputTokens({
    modelMaxOutputTokens: baseModel.optionSpecs.maxOutputTokens.max,
  });
  // 逐档验证：values 每一档各打一枪最小探针，坏档当场暴露（如下游不支持 none），
  // 而不是等到对话中的辅助调用才以 400 爆出。见 specs/reasoning-degrade-retry.md。
  const levels = baseModel.optionSpecs.reasoningLevel.values;
  const failures: Array<{ level: string; message: string }> = [];
  for (const level of levels) {
    // 取消检查只在 catch 里会漏掉成功路径：用户取消后剩余档位不应继续打枪。
    if (options?.abortSignal?.aborted) throw new Error("模型连通性测试已取消");
    try {
      await probeConnectivityLevel.call(this, baseModel, level, probeMaxOutputTokens, options);
    } catch (error) {
      // 取消不是档位失败，先于记录判断，避免把中止记成坏档。
      if (options?.abortSignal?.aborted) throw error;
      failures.push({
        level,
        message: error instanceof Error ? error.message : String(error),
      });
      // 档位被拒是配置问题不是瞬态故障：C 的降档重试不适用于探针（探针要如实
      // 报告每档状态，不能用下一档的成功掩盖本档的失败），直接记下一档。
    }
  }
  if (failures.length > 0) {
    const detail = failures.map((item) => `${item.level}（${item.message}）`).join("；");
    throw new Error(
      `模型连通性测试 ${failures.length}/${levels.length} 个档位失败：${detail}`,
    );
  }
}

async function probeConnectivityLevel(
  this: AgentRuntimeInternal,
  baseModel: Model,
  level: string,
  maxOutputTokens: number,
  options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
): Promise<void> {
  const model = baseModel.bind({ reasoningLevel: level, maxOutputTokens });
  const traceContext = createChildTraceContext(options?.traceContext ?? this.rootTraceContext, {
    attributes: {
      providerId: String(model.providerId),
      modelId: String(model.modelId),
      querySource: "provider_settings_connectivity",
    },
  });
  const abortSignal =
    options?.abortSignal ?? AbortSignal.timeout(WORKSPACE_GENERATE_TEXT_TIMEOUT_MS);
  const request: ModelRequest = {
    abortSignal,
    messages: [
      { role: "system", content: CONNECTIVITY_PROBE_SYSTEM },
      { role: "user", content: CONNECTIVITY_PROBE_USER },
    ],
  };
  let finished = false;
  await runWithModelInvocationContext(
    {
      metadata: traceContextToLogContext(traceContext),
      modelCall: { operation: "workspace_generate_text" },
      statusSink: this.createModelStatusSink(traceContext, []),
      traceContext,
      refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(this, {
        abortSignal,
        model,
        traceContext,
      }),
    },
    async () => {
      for await (const event of model.streamText(request)) {
        if (event.type === "error") throw normalizeStreamError(event.error);
        if (event.type === "finish") finished = true;
      }
    },
  );
  if (!finished) throw new Error("模型连通性测试流在 finish 事件前结束");
}

export async function generateWorkspaceText(
  this: AgentRuntimeInternal,
  input: WorkspaceGenerateTextInput,
  options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
): Promise<WorkspaceGenerateTextResult> {
  assertWorkspaceModelInput(input);
  const querySource = input.querySource.trim() || "workspace_generate_text";
  const traceContext = options?.traceContext ?? this.rootTraceContext;
  const operationTelemetry = this.agentTelemetry.detached({
    executionKind: "foreground",
    operation:
      querySource === GIT_COMMIT_MESSAGE_QUERY_SOURCE
        ? "workspace_git_commit_message"
        : "workspace_generate_text",
    targetKind: "workspace",
    trigger: "user",
    traceContext,
  });
  return operationTelemetry.run(async () => {
    try {
      const result = await generateWorkspaceTextImpl.call(this, input, options);
      operationTelemetry.setResultType("text");
      operationTelemetry.finishCompleted();
      return result;
    } catch (error) {
      if (options?.abortSignal?.aborted) {
        operationTelemetry.finishCancelled("abort_signal");
      } else {
        operationTelemetry.finishFailed("execute", "unknown", error);
      }
      throw error;
    }
  });
}

async function generateWorkspaceTextImpl(
  this: AgentRuntimeInternal,
  input: WorkspaceGenerateTextInput,
  options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
): Promise<WorkspaceGenerateTextResult> {
  assertWorkspaceModelInput(input);
  const requestedSelection = input.selection;
  const querySource = input.querySource.trim() || "workspace_generate_text";
  const baseModel = createRuntimeModel(this, { selection: requestedSelection, scope: "workspace" });
  // 辅助请求需要的是最低公开档位，不是扫描 off/nothink 等名称后强制关闭；
  // 调用方显式指定档位时以显式值为准（纠错的最低档被上游拒绝时换会话档位重试一次）。
  const model = input.reasoningLevel
    ? baseModel.bind({ reasoningLevel: input.reasoningLevel })
    : AUXILIARY_QUERY_SOURCES.has(querySource)
      ? baseModel.bind(auxiliaryModelOptions(baseModel))
      : baseModel;
  const baseTraceContext = options?.traceContext ?? this.rootTraceContext;
  const modelTraceContext = createChildTraceContext(baseTraceContext, {
    attributes: {
      model: `${model.providerId}/${model.modelId}`,
      querySource,
    },
  });

  const events: SessionEvent[] = [];
  const messages: ModelInputMessage[] = input.messages
    ? input.messages.map((message) => ({ ...message }))
    : [{ role: "user", content: input.prompt!.trim() }];
  const tools = input.tools ?? [];
  const modelRequestEvent = this.createEvent(
    SessionEventType.ModelRequest,
    {
      messages,
      providerId: String(model.providerId),
      modelId: String(model.modelId),
      querySource,
      toolCount: tools.length,
    },
    modelTraceContext,
  );
  await this.appendEvent(modelRequestEvent, modelTraceContext);
  events.push(modelRequestEvent);

  const modelStartedAt = Date.now();
  const networkEventStartIndex = events.length;
  const abortSignal =
    options?.abortSignal ?? AbortSignal.timeout(WORKSPACE_GENERATE_TEXT_TIMEOUT_MS);
  // Git Commit 调用方曾传入固定 256，Core 又按 querySource 丢弃，形成虚假接口。
  // 通用生成入口只处理调用方真实提供的预算；Git 辅助调用不再由上游伪造固定上限。
  const requestMaxOutputTokens =
    querySource === GIT_COMMIT_MESSAGE_QUERY_SOURCE ? undefined : input.maxOutputTokens;

  const modelRequest = {
    abortSignal,
    messages,
    tools,
    ...(requestMaxOutputTokens === undefined
      ? {}
      : { options: { maxOutputTokens: requestMaxOutputTokens } }),
  };

  const result = await runWithModelInvocationContext(
    {
      metadata: traceContextToLogContext(modelTraceContext),
      modelCall: {
        operation:
          querySource === GIT_COMMIT_MESSAGE_QUERY_SOURCE
            ? "workspace_git_commit_message"
            : "workspace_generate_text",
        ...(AUXILIARY_QUERY_SOURCES.has(querySource) && model.options.reasoningLevel
          ? { reasoning: { requestedLevel: model.options.reasoningLevel } }
          : {}),
      },
      statusSink: this.createModelStatusSink(modelTraceContext, events),
      traceContext: modelTraceContext,
      refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(this, {
        abortSignal,
        model,
        traceContext: modelTraceContext,
      }),
    },
    () => model.generateText(modelRequest),
  ).catch(async (error: unknown) => {
    await recordModelUsageFact(this, {
      error,
      events,
      model,
      networkEventStartIndex,
      querySource,
      startedAt: modelStartedAt,
      status: "error",
      traceContext: modelTraceContext,
    });
    throw error;
  });

  const toolCalls = this.extractToolCallsFromResult(result);
  const modelCompleteEvent = this.createEvent(
    SessionEventType.ModelComplete,
    {
      content: result.text,
      querySource,
      stopReason: result.finishReason,
      toolCallCount: toolCalls.length,
      usage: result.usage,
    },
    modelTraceContext,
  );
  await this.appendEvent(modelCompleteEvent, modelTraceContext);
  events.push(modelCompleteEvent);
  await recordModelUsageFact(this, {
    events,
    model,
    networkEventStartIndex,
    querySource,
    result,
    startedAt: modelStartedAt,
    status: "completed",
    toolCallCount: toolCalls.length,
    traceContext: modelTraceContext,
  });

  return {
    text: result.text,
    selection: {
      providerId: requestedSelection.providerId,
      modelId: requestedSelection.modelId,
      ...(requestedSelection.options ? { options: { ...requestedSelection.options } } : {}),
    },
    finishReason: result.finishReason,
    usage: result.usage,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

function assertWorkspaceModelInput(input: WorkspaceGenerateTextInput): void {
  if (input.messages && input.messages.length > 0) return;
  if (input.prompt?.trim()) return;
  throw new Error("模型文本生成 prompt 或 messages 不能为空");
}
