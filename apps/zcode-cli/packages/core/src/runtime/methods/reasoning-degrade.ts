/** 上游拒绝 reasoning 档位的判定：只认 400/422 + param/message 结构化证据。 */
import { isPlainRecord, stringProperty } from "../helpers/index.js";

const REASONING_REJECTED_STATUS = new Set([400, 422]);

// param 按「精确名或带点前缀」匹配；reasoning.effort 由 "reasoning" 前缀覆盖，无需单列。
const REASONING_PARAM_MARKERS = ["reasoning_effort", "reasoning", "thinking", "effort"];

const REASONING_MESSAGE_MARKERS = [
  "reasoning effort",
  "reasoning_effort",
  "reasoning is not supported",
  "reasoning not supported",
  "unsupported reasoning",
  "not supported for model",
];

/**
 * 错误是否为上游拒绝 reasoning 档位。只认结构化证据链上的状态码 + param/message，
 * 不解析自然语言正文；cause 链最多下探 3 层（adapter 包装深度）。
 */
export function isReasoningLevelRejected(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!isPlainRecord(current)) return false;
    const record = current;
    // 先按状态码过滤：429/5xx/abort 等高频失败零字符串开销；匹配才读 param/message。
    const status = readStatusCode(record);
    if (status !== undefined && REASONING_REJECTED_STATUS.has(status)) {
      if (matchesParam(readParam(record)) || matchesMessage(readMessage(record))) {
        return true;
      }
    }
    const cause = record["cause"];
    if (cause === undefined || cause === current) return false;
    current = cause;
  }
  return false;
}

function recordContext(record: Record<string, unknown>): Record<string, unknown> {
  const context = record["context"];
  return isPlainRecord(context) ? context : {};
}

function readNumberProperty(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStatusCode(record: Record<string, unknown>): number | undefined {
  // statusCode 可能被部分 envelope 透传成字符串；逐个按类型判定，
  // 不能 `record.statusCode ?? record.status` 短路（字符串会挡住后面的数字 status）。
  return (
    readNumberProperty(recordContext(record), "statusCode") ??
    readNumberProperty(record, "statusCode") ??
    readNumberProperty(record, "status")
  );
}

function readParam(record: Record<string, unknown>): string | undefined {
  const param = stringProperty(recordContext(record), "param");
  if (param !== undefined) return param;
  // 上游 envelope 透传：body.error.param（如 opencode 400 的 reasoning.effort）。
  const body = record["body"];
  if (isPlainRecord(body)) {
    const error = body["error"];
    if (isPlainRecord(error)) {
      return stringProperty(error, "param");
    }
  }
  return stringProperty(record, "param");
}

function readMessage(record: Record<string, unknown>): string {
  return stringProperty(record, "message")?.toLowerCase() ?? "";
}

function matchesParam(param: string | undefined): boolean {
  if (!param) return false;
  const normalized = param.toLowerCase();
  // 精确名或带点前缀（reasoning.effort / thinking.budget_tokens）；
  // 裸子串会把含 effort/reasoning 字样的无关 400 误判成档位被拒。
  return REASONING_PARAM_MARKERS.some(
    (marker) => normalized === marker || normalized.startsWith(`${marker}.`),
  );
}

function matchesMessage(message: string): boolean {
  if (!message) return false;
  return REASONING_MESSAGE_MARKERS.some((marker) => message.includes(marker));
}
