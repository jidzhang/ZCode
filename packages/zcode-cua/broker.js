import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BROKER_SOCKET_ENV = "ZCODE_CUA_PERMISSION_BROKER_SOCKET";
export const BROKER_UNAVAILABLE_ENV = "ZCODE_CUA_PERMISSION_BROKER_UNAVAILABLE";

// 与 producer（闭源真实包）一致的 win32 命名管道命名空间。真实 CUA 客户端对 socket 路径
// 有硬校验 `/^\\\\.\\pipe\\zcode-cua-helper-(?:[0-9a-f]{8,}|default)$/`：不在该命名空间
// 会被拒绝（untrusted_socket），且拒绝发生在懒启动 helper 之前 —— 表现为永久
// "permission broker socket is not accepting connections yet"。
// safe-zcode（2026-10-22）：占位包此前按 POSIX 临时文件路径 mint，导致宿主注入的
// ZCODE_CUA_PERMISSION_BROKER_SOCKET 必然非法（实机报告 cua-helper-diagnostic 的现象），
// 这里按 producer 口径生成 <16 hex> / default。
const WIN32_HELPER_PIPE_PREFIX = "\\\\.\\pipe\\zcode-cua-helper-";

export class BrokerError extends Error {
  constructor(message, options = {}) {
    super(message ?? "Computer Use broker is unavailable.");
    this.name = "BrokerError";
    this.code = options.code ?? "unavailable";
    if (options.details !== undefined) this.details = options.details;
  }
}

export class CuaHelperError extends Error {
  constructor(message, options = {}) {
    super(message ?? "Computer Use Helper is unavailable.");
    this.name = "CuaHelperError";
    this.code = options.code ?? "helper_unavailable";
  }
}

export function isCuaHelperError(value) {
  return value instanceof CuaHelperError;
}

const brokerErrorFactory = (code) => (message, details) =>
  new BrokerError(message ?? code, { code, details });

export const notAuthorized = brokerErrorFactory("not_authorized");
export const notSelectable = brokerErrorFactory("not_selectable");
export const notSettable = brokerErrorFactory("not_settable");
export const elementUnavailable = brokerErrorFactory("element_unavailable");
export const actionUnavailable = brokerErrorFactory("action_unavailable");
export const foregroundRequired = brokerErrorFactory("foreground_required");

export async function callBrokerMethod(_args) {
  throw new BrokerError("Computer Use is not available in this build.");
}

export async function probeHelperHealth(_socketPath, _options) {
  return { bundleId: null, pid: null };
}

export function mintBrokerSocketPath(options = {}) {
  if (process.platform === "win32") {
    // 16 hex chars，与 producer 的 mint 长度一致。
    return `${WIN32_HELPER_PIPE_PREFIX}${randomBytes(8).toString("hex")}`;
  }
  const dir = typeof options.dir === "string" ? options.dir : tmpdir();
  return join(dir, `zcode-cua-broker-${randomUUID()}.sock`);
}

export function resolveBrokerSocketPath(options = {}) {
  const env = options.env ?? process.env;
  const fromEnv = env[BROKER_SOCKET_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv;
  if (process.platform === "win32") return `${WIN32_HELPER_PIPE_PREFIX}default`;
  return mintBrokerSocketPath(options);
}

export function parseRequestLine(_line) {
  return undefined;
}

export function okResponse(result) {
  return { ok: true, result };
}

export function errorResponse(message, options = {}) {
  return {
    ok: false,
    error: { message, ...(options.code ? { code: options.code } : {}) },
  };
}

export function errorResponseFromException(error) {
  return errorResponse(error instanceof Error ? error.message : String(error));
}

export function serializeResponse(response) {
  return `${JSON.stringify(response)}\n`;
}

export async function dispatchRequest(_backend, _request) {
  throw new CuaHelperError("Computer Use is not available in this build.");
}

export async function handleRequestLine(_backend, _line) {
  throw new CuaHelperError("Computer Use is not available in this build.");
}

export function isBrokerMethod(_method) {
  return false;
}

export function isReadOnlyBrokerMethod(_method) {
  return false;
}
