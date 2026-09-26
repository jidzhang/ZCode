import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startWechatChannel, type WechatChannelOptions } from "./contract.js";

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
 * 自建微信通道入口。配置全部来自环境变量，不在命令行/日志中回显密钥：
 *   WEIXIN_BOT_TOKEN      iLink bot token（先跑 pnpm login 扫码获取，必需）
 *   ZCODE_WORKSPACE       引擎工作区绝对路径（必需）
 *   ZCODE_ENGINE_WS       引擎 WS，默认 ws://127.0.0.1:3030/ws/host
 *   WEIXIN_ALLOWED_USER_IDS  逗号分隔 userId 白名单（可选）
 *   WEIXIN_REPLY_MODE     final|stream|verbose（默认 stream）
 *   WEIXIN_TASK_MODE      yolo|plan|edit|auto|autoEdit|build（默认 yolo，
 *                         与官方 bot 行为一致，不产生权限询问）
 *   WEIXIN_TYPING         on|off（默认 on；stream/verbose 模式的运行中指示）
 *   WEIXIN_STREAM_THROTTLE_MS  typing 刷新节流毫秒（默认 10000）
 *   WEIXIN_API_BASE       覆盖 iLink API base（本地 mock/测试用）
 *
 * 遥测：safe-zcode 全链路默认严格禁用（引擎 OTLP / 桌面 ARMS / 数仓上报均需
 * 显式 ZCODE_TELEMETRY=on 才允许出站），本进程自身不产生任何上报。
 */
async function main(): Promise<void> {
  loadEnvLocal();
  const botToken = process.env.WEIXIN_BOT_TOKEN?.trim();
  const workspacePath = process.env.ZCODE_WORKSPACE?.trim();
  if (!botToken || !workspacePath) {
    console.error(
      "缺少环境变量：WEIXIN_BOT_TOKEN / ZCODE_WORKSPACE 均为必填。" +
        "token 可先运行 `pnpm --filter @zcode/wechat-channel login` 扫码获取。",
    );
    process.exitCode = 2;
    return;
  }
  const options: WechatChannelOptions = {
    engineWsUrl: process.env.ZCODE_ENGINE_WS?.trim() || "ws://127.0.0.1:3030/ws/host",
    workspacePath,
    botToken,
    defaultReplyMode: isMode(process.env.WEIXIN_REPLY_MODE)
      ? process.env.WEIXIN_REPLY_MODE
      : "stream",
    taskMode: isTaskMode(process.env.WEIXIN_TASK_MODE) ? process.env.WEIXIN_TASK_MODE : "yolo",
    allowedUserIds: splitList(process.env.WEIXIN_ALLOWED_USER_IDS),
    typingEnabled: (process.env.WEIXIN_TYPING?.trim().toLowerCase() ?? "on") !== "off",
    typingThrottleMs: positiveInt(process.env.WEIXIN_STREAM_THROTTLE_MS) ?? 10_000,
    apiBaseUrl: process.env.WEIXIN_API_BASE?.trim() || undefined,
  };
  const handle = await startWechatChannel(options);
  const shutdown = (): void => {
    void handle.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  console.info("wechat-channel running; Ctrl+C 退出。");
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
  console.error(`wechat-channel 启动失败：${String(error)}`);
  process.exitCode = 1;
});
