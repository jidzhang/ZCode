import { formatLogPrefix, type TraceId } from "@zcode/shared";
import { isEffectiveDevelopmentNodeEnv } from "#src/runtime-tools/nodeEnv.js";

interface ServiceLogSink {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

export interface ServiceLogger {
  debug: (traceId: TraceId | undefined, ...args: unknown[]) => void;
  info: (traceId: TraceId | undefined, ...args: unknown[]) => void;
  warn: (traceId: TraceId | undefined, ...args: unknown[]) => void;
  error: (traceId: TraceId | undefined, ...args: unknown[]) => void;
}

/** settings.json 日志级别在 services 侧的投影；Host 启动后由 node.ts 按设置刷新，默认 info。 */
export type ServiceLogLevelSetting = "error" | "warn" | "info";

const SERVICE_LOG_SEVERITY: Record<"debug" | "info" | "warn" | "error", number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let configuredServiceLogLevel: ServiceLogLevelSetting = "info";

export function normalizeServiceLogLevel(value: unknown): ServiceLogLevelSetting {
  return value === "error" || value === "warn" || value === "info" ? value : "info";
}

export function setServiceLogLevel(level: ServiceLogLevelSetting): void {
  configuredServiceLogLevel = level;
}

export function createServiceLogger(
  scope: string,
  options?: {
    pid?: number;
    sink?: ServiceLogSink;
    // debug 日志默认只在本地开发运行时打印；测试/正式安装包都使用 production 构建，避免高频日志落盘。
    isDebugEnabled?: boolean | (() => boolean);
  },
): ServiceLogger {
  const pid = options?.pid ?? process.pid;
  const sink = options?.sink ?? console;
  const debugOption = options?.isDebugEnabled;
  const resolveDebugEnabled: () => boolean =
    typeof debugOption === "function"
      ? debugOption
      : typeof debugOption === "boolean"
        ? () => debugOption
        : () => isEffectiveDevelopmentNodeEnv();

  function write(
    level: "debug" | "info" | "warn" | "error",
    traceId: TraceId | undefined,
    ...args: unknown[]
  ): void {
    // 服务层日志过去常被复用到 ZCode Agent 命名 logger，导致新 ZCode 路径继续依赖 ZCode Agent 目录。
    // 这里把通用分级日志抽到独立模块，后续删除 ZCode Agent runtime 时不会牵连非 ZCode Agent 服务。
    if (level === "debug" && !resolveDebugEnabled()) {
      return;
    }
    // 本地（2026-09-29）：settings.json logLevel 阈值；Host 启动后由 node.ts 刷新。
    if (SERVICE_LOG_SEVERITY[level] < SERVICE_LOG_SEVERITY[configuredServiceLogLevel]) {
      return;
    }
    const source = traceId ? `${scope}][trace:${traceId}` : scope;
    const consoleFn =
      level === "error"
        ? sink.error
        : level === "warn"
          ? sink.warn
          : level === "debug"
            ? (sink.debug ?? sink.log)
            : sink.log;
    consoleFn(formatLogPrefix(source, pid), ...args);
  }

  return {
    debug: (traceId, ...args) => write("debug", traceId, ...args),
    info: (traceId, ...args) => write("info", traceId, ...args),
    warn: (traceId, ...args) => write("warn", traceId, ...args),
    error: (traceId, ...args) => write("error", traceId, ...args),
  };
}
