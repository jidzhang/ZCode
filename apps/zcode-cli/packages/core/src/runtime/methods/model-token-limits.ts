import { DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY as DEFAULT_BUDGET_STRATEGY } from "@zcode/shared";
import { getAutoCompactRequestMarginTokens } from "../../compact/policy.js";
import { traceContextToLogContext } from "../deps.js";
import type { TraceContext } from "../deps.js";

const DEFAULT_NORMAL_REQUEST_MAX_OUTPUT_TOKENS = 32_000;
// 单步请求的输出预算上限。模型声明 384k/64k 只代表能力上限，用它把剩余窗口填满
// 会把 prompt + max_tokens 顶到窗口边缘（2026-11-03 deepseek 在 ~999k 总量时被上游 abort）。
const MODEL_STEP_MAX_OUTPUT_TOKENS = 32_000;
// 输入已经吃掉安全余量时，不再回退到 baseline，只保留最小可发送输出。
const MIN_MODEL_STEP_MAX_OUTPUT_TOKENS = 1_024;

export function resolveNormalRequestMaxOutputTokens(input: {
  modelMaxOutputTokens: number | undefined;
}): number {
  // 32K 是模型未声明输出预算时的默认值，不是对模型级配置的全局上限。
  // 已解析到模型值时必须原样使用，否则 64K 模型的请求预算会被错误裁剪为 32K。
  return (
    positiveFlooredTokens(input.modelMaxOutputTokens) ?? DEFAULT_NORMAL_REQUEST_MAX_OUTPUT_TOKENS
  );
}

export function resolveModelStepMaxOutputTokens(input: {
  baselineMaxOutputTokens: number;
  contextWindow: number | undefined;
  estimatedCurrentUsage: number;
  modelContextBudgetStrategy: "legacy" | "preflight-v1" | undefined;
}): number {
  // legacy 仅为入参兼容；所有请求（含工具续轮）都按剩余窗口计算 preflight cap。
  if (
    input.contextWindow === undefined ||
    !Number.isFinite(input.contextWindow) ||
    input.contextWindow <= 0 ||
    !Number.isFinite(input.estimatedCurrentUsage) ||
    input.estimatedCurrentUsage < 0
  ) {
    return input.baselineMaxOutputTokens;
  }

  const estimatedAvailable = Math.floor(
    input.contextWindow -
      input.estimatedCurrentUsage -
      getAutoCompactRequestMarginTokens(input.contextWindow),
  );
  if (estimatedAvailable <= 0) {
    // 估算已吃掉安全余量：保留 baseline 会把请求总量重新顶到窗口边缘。
    // 只发最小输出；上游若仍拒绝，超窗错误会进入 reactive compact。
    return Math.min(input.baselineMaxOutputTokens, MIN_MODEL_STEP_MAX_OUTPUT_TOKENS);
  }
  const candidate = Math.min(
    input.baselineMaxOutputTokens,
    MODEL_STEP_MAX_OUTPUT_TOKENS,
    estimatedAvailable,
  );
  return candidate;
}

export function modelRequestTokenLimitLogContext(input: {
  contextWindow: number | undefined;
  maxOutputTokens: number | undefined;
  modelContextBudgetStrategy: "legacy" | "preflight-v1" | undefined;
  traceContext: TraceContext;
}) {
  return {
    ...traceContextToLogContext(input.traceContext),
    contextWindow: input.contextWindow,
    event: "model.request.token_limits",
    inputBudgetTokens: inputBudgetTokens(input.contextWindow, input.maxOutputTokens),
    maxOutputTokens: input.maxOutputTokens,
    modelContextBudgetStrategy: DEFAULT_BUDGET_STRATEGY,
    module: "core.runtime",
  };
}

function inputBudgetTokens(
  contextWindow: number | undefined,
  maxOutputTokens: number | undefined,
): number | undefined {
  if (
    contextWindow === undefined ||
    maxOutputTokens === undefined ||
    !Number.isFinite(contextWindow) ||
    !Number.isFinite(maxOutputTokens)
  ) {
    return undefined;
  }

  return Math.max(0, Math.floor(contextWindow) - Math.floor(maxOutputTokens));
}

function positiveFlooredTokens(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}
