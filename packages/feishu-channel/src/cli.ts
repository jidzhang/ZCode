import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startFeishuChannel, type FeishuChannelOptions } from "./contract.js";

/**
 * 启动前加载本包目录下的 .env.local（已 gitignore，凭据不进命令行与对话）。
 * 已存在的进程环境变量优先，不被文件覆盖。
 */
function loadEnvLocal(): void {
  const path = join(import.meta.dirname, ".env.local");
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return;
  }
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * 自建飞书通道入口。配置全部来自环境变量，不在命令行/日志中回显密钥：
 *   FEISHU_APP_ID / FEISHU_APP_SECRET  飞书自建应用（必需）
 *   ZCODE_ENGINE_WS                    引擎 WS，默认 ws://127.0.0.1:3030/ws/host
 *   ZCODE_WORKSPACE                    引擎工作区绝对路径（必需）
 *   FEISHU_ALLOWED_CHAT_IDS            逗号分隔 chatId 白名单（可选）
 *   FEISHU_REPLY_MODE                  final|stream|verbose（默认 stream）
 *   FEISHU_TASK_MODE                   yolo|plan|edit|auto|autoEdit|build（默认 yolo，
 *                                      与官方飞书 bot 行为一致，不产生权限询问）
 *
 * 遥测：safe-zcode 全链路默认严格禁用（引擎 OTLP / 桌面 ARMS / 数仓上报均需
 * 显式 ZCODE_TELEMETRY=on 才允许出站），本进程自身不产生任何上报。
 */
async function main(): Promise<void> {
  loadEnvLocal();
  const appId = process.env.FEISHU_APP_ID?.trim();
  const appSecret = process.env.FEISHU_APP_SECRET?.trim();
  const workspacePath = process.env.ZCODE_WORKSPACE?.trim();
  if (!appId || !appSecret || !workspacePath) {
    console.error("缺少环境变量：FEISHU_APP_ID / FEISHU_APP_SECRET / ZCODE_WORKSPACE 均为必填。");
    process.exitCode = 2;
    return;
  }
  const options: FeishuChannelOptions = {
    engineWsUrl: process.env.ZCODE_ENGINE_WS?.trim() || "ws://127.0.0.1:3030/ws/host",
    workspacePath,
    appId,
    appSecret,
    defaultReplyMode: isMode(process.env.FEISHU_REPLY_MODE)
      ? process.env.FEISHU_REPLY_MODE
      : "stream",
    taskMode: isTaskMode(process.env.FEISHU_TASK_MODE) ? process.env.FEISHU_TASK_MODE : "yolo",
    allowedChatIds: splitList(process.env.FEISHU_ALLOWED_CHAT_IDS),
    streamThrottleMs: positiveInt(process.env.FEISHU_STREAM_THROTTLE_MS) ?? 800,
  };
  const handle = await startFeishuChannel(options);
  const shutdown = (): void => {
    void handle.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  console.info("feishu-channel running; Ctrl+C 退出。");
}

function isMode(value: string | undefined): value is "final" | "stream" | "verbose" {
  return value === "final" || value === "stream" || value === "verbose";
}

function isTaskMode(
  value: string | undefined,
): value is "yolo" | "plan" | "edit" | "auto" | "autoEdit" | "build" {
  return (
    value === "yolo" ||
    value === "plan" ||
    value === "edit" ||
    value === "auto" ||
    value === "autoEdit" ||
    value === "build"
  );
}

function splitList(value: string | undefined): string[] | undefined {
  const items = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function positiveInt(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

void main().catch((error: unknown) => {
  console.error(`feishu-channel 启动失败：${String(error)}`);
  process.exitCode = 1;
});
