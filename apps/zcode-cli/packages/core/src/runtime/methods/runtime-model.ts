import {
  CoreErrorType,
  createCoreError,
  getCurrentModelInvocationContext,
  runWithModelInvocationContext,
  type Model,
  type ModelEvent,
  type ModelInvocationContext,
  type ModelRequest,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeModelFactoryInput } from "../types.js";
import { resolveModelRetryBudgetFromTaskType } from "./model-request-session-type.js";
import { isReasoningLevelRejected } from "./reasoning-degrade.js";

export function createRuntimeModel(
  runtime: AgentRuntimeInternal,
  input: Omit<RuntimeModelFactoryInput, "selection"> & {
    selection: RuntimeModelFactoryInput["selection"] | undefined;
  },
): Model {
  // 未绑定 Session 可恢复历史；仅在执行入口拒绝缺失选择，Factory 契约仍严格。
  if (!input.selection) {
    throw createCoreError(CoreErrorType.ConfigurationError, "Select a model before continuing", {
      recoverable: true,
    });
  }
  return withRuntimeInvocationLayer(
    runtime,
    runtime.modelFactory({ ...input, selection: input.selection }),
  );
}

/**
 * runtime 层调用上下文。
 *
 * 准入端口与重试预算回答的是「谁在调」（这个 runtime 归哪个治理器管、允许多少次重试），不是
 * 「为什么调」（agent step / web_search / compact / title）。设计缺口：它们若只在 turn step
 * 的调用上下文里注入，WebSearch / WebFetch 处理 / 压缩 / 标题 sidecar 等九处只设「为什么调」的
 * 调用点全部绕过了闸门——实测场景下治理器看不见三分之二的 429。现在这两个字段在句柄
 * 工厂绑定一次；`withModelInvocationContext` 的合并顺序让本层压过调用层，没有逐调用退出口：
 * 想不受闸门约束的 runtime 本来就不带准入端口。
 */
function withRuntimeInvocationLayer(runtime: AgentRuntimeInternal, model: Model): Model {
  const layer: ModelInvocationContext = {
    modelRetryBudget: resolveModelRetryBudgetFromTaskType(runtime.config.taskType),
    ...(runtime.modelRequestAdmission === undefined
      ? {}
      : { modelRequestAdmission: runtime.modelRequestAdmission }),
  };
  return withReasoningRejectReport(
    runtime,
    withModelInvocationContext(model, () => layer),
  );
}

/**
 * 上游拒绝 reasoning 档位时，把"哪个档位坏了"写进错误再上抛，不静默降档。
 * 落在本层（而非 adapter/各调用点），一处覆盖主 turn 与全部辅助调用。
 * 用户看到档位名后手动删除坏档；探针（D）逐档验证时同样经此报错逐档收集。
 */
function withReasoningRejectReport(runtime: AgentRuntimeInternal, model: Model): Model {
  const wrapped: Model = {
    providerId: model.providerId,
    modelId: model.modelId,
    displayName: model.displayName,
    properties: model.properties,
    optionSpecs: model.optionSpecs,
    options: model.options,
    bind(options) {
      return withReasoningRejectReport(runtime, model.bind(options));
    },
    generateText(request) {
      return model.generateText(request).catch((error) => {
        throw reportRejectedReasoningLevel(runtime, model, error);
      });
    },
    streamText(request) {
      return (async function* () {
        // 内容产出后的失败是流中断，与档位无关；start 等合成事件不算内容。
        let contentCommitted = false;
        try {
          for await (const event of model.streamText(request)) {
            if (!contentCommitted) {
              if (commitsStreamContent(event)) {
                contentCommitted = true;
              } else if (event.type === "error") {
                // 流式失败经常以 error 事件而非异常交付（探针即按此消费）；
                // 首内容前的档位被拒同样要换上档位名，否则本层对主 turn 流式失效。
                yield {
                  type: "error" as const,
                  error: reportRejectedReasoningLevel(runtime, model, event.error),
                };
                continue;
              }
            }
            yield event;
          }
          return;
        } catch (error) {
          if (contentCommitted) throw error;
          throw reportRejectedReasoningLevel(runtime, model, error);
        }
      })();
    },
  };
  return Object.freeze(wrapped);
}

export function withModelInvocationContext(
  model: Model,
  createContext: (request: ModelRequest) => ModelInvocationContext,
): Model {
  const wrapped: Model = {
    providerId: model.providerId,
    modelId: model.modelId,
    displayName: model.displayName,
    properties: model.properties,
    optionSpecs: model.optionSpecs,
    options: model.options,
    bind(options) {
      return withModelInvocationContext(model.bind(options), createContext);
    },
    generateText(request) {
      return runWithModelInvocationContext(
        { ...getCurrentModelInvocationContext(), ...createContext(request) },
        () => model.generateText(request),
      );
    },
    streamText(request) {
      return runWithModelInvocationContext(
        { ...getCurrentModelInvocationContext(), ...createContext(request) },
        () => model.streamText(request),
      );
    },
  };
  return Object.freeze(wrapped);
}

/**
 * 是否为携带内容的事件：一旦出现，后续失败按流中断处理，不再换算档位错误。
 * 对 ModelStreamEvent 全量枚举（无 default），新增事件变体时编译器强制归类。
 */
function commitsStreamContent(event: ModelEvent): boolean {
  switch (event.type) {
    case "text_delta":
    case "reasoning_delta":
    case "tool_input_start":
    case "tool_input_delta":
    case "tool_call":
      return true;
    case "start":
    case "compact_stream_boundary":
    case "text_start":
    case "text_end":
    case "reasoning_start":
    case "reasoning_end":
    case "tool_input_end":
    case "finish":
    case "error":
      return false;
  }
}

/**
 * 上游拒绝 reasoning 档位时，把坏档位名写进错误再上抛。非档位错误原样返回。
 */
function reportRejectedReasoningLevel(
  runtime: AgentRuntimeInternal,
  model: Model,
  error: unknown,
): unknown {
  if (!isReasoningLevelRejected(error)) return error;
  const level = model.options.reasoningLevel ?? "(未选择)";
  runtime.logger?.warn("Model reasoning level rejected by provider", {
    event: "model.reasoning.rejected",
    level,
    modelId: String(model.modelId),
    module: "core.runtime",
    providerId: String(model.providerId),
  });
  const cause = error instanceof Error ? error : new Error(String(error));
  return new Error(
    `模型 reasoning 档位 "${level}" 被上游拒绝，请在模型配置中删除该档位后再试。` +
      `（原始错误：${cause.message}）`,
    { cause },
  );
}
