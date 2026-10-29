import type { LogContext, Logger } from "@zcode/contracts";

interface AiSdkWarningLoggerOptions {
  model?: unknown;
  provider?: unknown;
  warnings?: unknown;
}

type AiSdkWarningLogger = (options: AiSdkWarningLoggerOptions) => void;

type AiSdkWarningGlobal = typeof globalThis & {
  AI_SDK_LOG_WARNINGS?: false | AiSdkWarningLogger;
};

// AI SDK 的 warning 常把整段内联载荷塞进 message：实测 reasoning 载荷单条 17.5 KB，
// 里面是模型完整思维链，而 cli/log 会随支持包导出。落盘前只保留结构，正文一律剪掉。
const MAX_WARNING_STRING_CHARS = 512;
const MAX_WARNING_ITEMS = 20;

export function installZCodeProtocolAiSdkWarningLogger(logger: Logger): void {
  // AI SDK 默认 warning logger 第一次会用 console.info 写 stdout；
  // app-server --stdio 的 stdout 是 ZCode Protocol NDJSON 帧通道，任何普通文本都会让宿主解析失败。
  (globalThis as AiSdkWarningGlobal).AI_SDK_LOG_WARNINGS = (
    options: AiSdkWarningLoggerOptions,
  ) => {
    try {
      const warnings = Array.isArray(options.warnings) ? options.warnings : [];
      logger.warn("AI SDK model warning", {
        event: "model.sdk.warning",
        module: "bootstrap.zcode_protocol",
        status: "completed",
        model: stringValue(options.model),
        provider: stringValue(options.provider),
        warningCount: warnings.length,
        warnings: summarizeWarnings(warnings),
      });
    } catch {
      // warning 记录不能影响真实模型请求；stdout 纯净性由不调用 console.* 保证。
    }
  };
}

function summarizeWarnings(warnings: unknown[]): LogContext[] {
  const summarized = warnings.slice(0, MAX_WARNING_ITEMS).map(summarizeWarning);
  if (warnings.length > MAX_WARNING_ITEMS) {
    summarized.push({ type: "truncated", omitted: warnings.length - MAX_WARNING_ITEMS });
  }
  return summarized;
}

function summarizeWarning(warning: unknown): LogContext {
  try {
    if (!warning || typeof warning !== "object") {
      return { value: redactText(warning) };
    }
    const record = warning as Record<string, unknown>;
    return {
      type: stringValue(record.type),
      feature: stringValue(record.feature),
      message: redactText(record.message),
      details: redactText(record.details),
    };
  } catch {
    // 剪裁失败时绝不回退成原文：只报格式失败，避免正文漏进日志。
    return { type: "log_format_failed" };
  }
}

/**
 * 把字符串里的内联 JSON 载荷替换成尺寸占位，其余文本按上限截断。
 *
 * AI SDK warning 形如 `Non-OpenAI reasoning parts are not supported. Skipping reasoning
 * part: {"type":"reasoning","text":"<整段思维链>"}`，正文在花括号之后。这里不解析 JSON
 * （残缺 JSON 也必须能处理），只按括号配平扫描并保留原始字节数。
 */
export function redactText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return truncate(elideEmbeddedJson(value));
}

function elideEmbeddedJson(text: string): string {
  let result = "";
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("{", index);
    if (open === -1) {
      result += text.slice(index);
      break;
    }
    result += text.slice(index, open);
    const close = findBalancedJsonEnd(text, open);
    if (close === -1) {
      // 未配平：丢弃花括号之后的全部内容，交给截断兜底，绝不原样保留。
      result += `{"__elided__":true,"bytes":${text.length - open}}`;
      break;
    }
    result += `{"__elided__":true,"bytes":${close - open + 1}}`;
    index = close + 1;
  }
  return result;
}

function findBalancedJsonEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function truncate(text: string): string {
  if (text.length <= MAX_WARNING_STRING_CHARS) {
    return text;
  }
  const removed = text.length - MAX_WARNING_STRING_CHARS;
  return `${text.slice(0, MAX_WARNING_STRING_CHARS)}…(truncated, ${removed} chars)`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
