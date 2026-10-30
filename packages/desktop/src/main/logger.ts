import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { formatTimestamp } from "@zcode/shared";
import { cleanupExpiredLogFiles, LOG_RETENTION_DAYS } from "./logRetention.js";
import { getAppConfigDir, maybeThrowInjectedFsFault } from "@zcode/services/node";

function getLogDir() {
  const e2eLogDir =
    process.env.ZCODE_ENV === "test" ? process.env.ZCODE_E2E_RUNTIME_LOG_DIR?.trim() : undefined;
  if (e2eLogDir) {
    return e2eLogDir;
  }
  return join(getAppConfigDir(), "logs");
}

// 启动时确保日志目录存在
const LOG_DIR = getLogDir();
mkdirSync(LOG_DIR, { recursive: true });

const logRetentionResult = cleanupExpiredLogFiles(LOG_DIR);
if (logRetentionResult.failedFiles.length > 0) {
  safeConsoleWrite(
    "warn",
    `[log-retention] failed to delete expired logs from ${LOG_DIR}:`,
    logRetentionResult.failedFiles,
    `retentionDays=${LOG_RETENTION_DAYS}`,
  );
}

type LogLevel = "debug" | "info" | "warn" | "error";

/** settings.json 日志级别；main/渲染器/Host 中继日志共用本阈值，默认 info。 */
export type MainLogLevelSetting = "error" | "warn" | "info" | "off";

// off=4 在 Error 之上：任何 level<4 都被过滤，即完全不写日志。
const MAIN_LOG_SEVERITY: Record<LogLevel | "off", number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  off: 4,
};

let configuredMainLogLevel: MainLogLevelSetting = "info";

function isBrokenPipeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EPIPE"
  );
}

function ignoreBrokenPipeStreamError(error: Error): void {
  // WDIO / dev runner 结束后可能先关闭 stdout/stderr 管道，随后主进程日志还在刷新。
  // stream error 是异步事件，try/catch 包 console.log 不一定兜得住；这里统一吞掉 EPIPE。
  if (!isBrokenPipeError(error)) {
    throw error;
  }
}

process.stdout.on("error", ignoreBrokenPipeStreamError);
process.stderr.on("error", ignoreBrokenPipeStreamError);

function safeConsoleWrite(level: LogLevel, ...args: unknown[]): void {
  const consoleFn =
    level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  try {
    consoleFn(...args);
  } catch (error) {
    // dev 脚本或父终端退出后，Electron main 的 stdout/stderr 管道可能已关闭。
    // 这时 console.* 会抛 EPIPE，不能让日志输出反过来杀掉主进程；文件日志仍会继续写入。
    if (!isBrokenPipeError(error)) {
      throw error;
    }
  }
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function write(level: LogLevel, source: string, ...args: unknown[]) {
  // 本地（2026-09-29）：settings.json logLevel 阈值；低于阈值的文件与 console 记录都跳过。
  if (MAIN_LOG_SEVERITY[level] < MAIN_LOG_SEVERITY[configuredMainLogLevel]) {
    return;
  }
  const now = new Date();
  const ts = formatTimestamp(now);
  const pid = process.pid;
  const message = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  const line = `[${ts}] [${level}] [pid:${pid}] [${source}] ${message}\n`;
  const logDir = getLogDir();
  mkdirSync(logDir, { recursive: true });
  const filePath = join(logDir, `${formatDate(now)}.log`);

  // 同时保留 console 输出，方便开发调试；console 也加时间戳和 PID，与文件格式对齐
  safeConsoleWrite(level, `[${ts}] [pid:${pid}] [${source}]`, ...args);

  try {
    maybeThrowInjectedFsFault({ operation: "appendFile", path: filePath });
    appendFileSync(filePath, line);
  } catch {
    // 日志写入失败不应影响应用运行
  }
}

function writeDedicated(filePrefix: string, level: LogLevel, source: string, ...args: unknown[]) {
  const now = new Date();
  const ts = formatTimestamp(now);
  const pid = process.pid;
  const message = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  const line = `[${ts}] [${level}] [pid:${pid}] [${source}] ${message}\n`;
  const logDir = getLogDir();
  mkdirSync(logDir, { recursive: true });
  // Bugfix: 远控 relay trace 与主日志混放时，目录内文件会快速增多，人工排查不直观。
  // 这里把高频 trace 分流到 logs 子目录，避免影响主日志浏览与导出定位。
  const dedicatedDir = join(logDir, "web-remote-control");
  mkdirSync(dedicatedDir, { recursive: true });
  const filePath = join(dedicatedDir, `${filePrefix}-${formatDate(now)}.log`);

  try {
    maybeThrowInjectedFsFault({ operation: "appendFile", path: filePath });
    appendFileSync(filePath, line);
  } catch {
    // 日志写入失败不应影响应用运行
  }
}

/**
 * main 进程日志，默认写入 ~/.zcode/v2/logs/YYYY-MM-DD.log；E2E 测试使用 worker 专属目录。
 * 同时保留 console 输出方便开发调试
 */
export const logger = {
  // 高频 browser/CDP 等协议细节只在本地开发记录，避免生产日志量与命令流同数量级。
  debug: (...args: unknown[]) => {
    if (process.env.NODE_ENV !== "production") {
      write("debug", "main", ...args);
    }
  },
  info: (...args: unknown[]) => write("info", "main", ...args),
  warn: (...args: unknown[]) => write("warn", "main", ...args),
  error: (...args: unknown[]) => write("error", "main", ...args),

  /** renderer 日志通过 IPC 传入后调用此方法写入同一文件 */
  fromRenderer: (level: LogLevel, args: unknown[]) => write(level, "renderer", ...args),
};

function normalizeLogRetentionDays(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value)) {
    return Math.min(Math.max(value, 0), 365);
  }
  return LOG_RETENTION_DAYS;
}

/**
 * 本地（2026-09-29）：settings.json 日志控制生效入口。
 * main 启动读到设置后调用一次；改动重启生效。非法值回落到默认，不抛错。
 * 上游若新增官方日志级别开关，本函数及调用方可直接 drop。
 */
export function applyLogSettingsFromSettings(settings: {
  logLevel?: unknown;
  logRetentionDays?: unknown;
}): void {
  if (
    settings.logLevel === "error" ||
    settings.logLevel === "warn" ||
    settings.logLevel === "info" ||
    settings.logLevel === "off"
  ) {
    configuredMainLogLevel = settings.logLevel;
  }
  const retentionDays = normalizeLogRetentionDays(settings.logRetentionDays);
  const result = cleanupExpiredLogFiles(getLogDir(), { retentionDays });
  if (result.failedFiles.length > 0) {
    safeConsoleWrite(
      "warn",
      `[log-retention] failed to delete expired logs from ${getLogDir()}:`,
      result.failedFiles,
      `retentionDays=${retentionDays}`,
    );
  }
}

/**
 * Web remote control relay message trace 专用日志。
 * 仅用于高频链路排障，独立落盘避免淹没主日志文件。
 */
export const webRemoteControlRelayLogger = {
  info: (...args: unknown[]) =>
    writeDedicated("web-remote-control-relay", "info", "web-remote-control-relay", ...args),
  warn: (...args: unknown[]) =>
    writeDedicated("web-remote-control-relay", "warn", "web-remote-control-relay", ...args),
  error: (...args: unknown[]) =>
    writeDedicated("web-remote-control-relay", "error", "web-remote-control-relay", ...args),
};
