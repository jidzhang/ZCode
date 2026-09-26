// 微信 iLink bot 扫码登录脚本：获取二维码 → 轮询状态 → 成功后把 token 写入 .env.local。
// 协议事实见 ../src/domain/weixinProtocol.ts 头注释与 SPEC.md；本脚本独立于 TS 源码，
// 用全局 fetch 即可运行：`pnpm --filter @zcode/wechat-channel login`。
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const API_BASE = "https://ilinkai.weixin.qq.com";
const BOT_PATH = "/ilink/bot";
const POLL_INTERVAL_MS = 3000;
const ENV_PATH = join(fileURLToPath(new URL(".", import.meta.url)), "..", ".env.local");

function loginHeaders() {
  return { "iLink-App-ClientVersion": "1" };
}

function unwrapData(payload) {
  if (payload && typeof payload === "object" && payload.data && typeof payload.data === "object") {
    return { ...payload, ...payload.data };
  }
  return payload && typeof payload === "object" ? payload : {};
}

function assertApiOk(path, payload) {
  const data = payload && typeof payload === "object" ? payload : {};
  const ret = typeof data.ret === "number" ? data.ret : null;
  const errcode = typeof data.errcode === "number" ? data.errcode : null;
  if ((ret !== null && ret !== 0) || (errcode !== null && errcode !== 0)) {
    const message =
      (typeof data.errmsg === "string" && data.errmsg) ||
      (typeof data.message === "string" && data.message) ||
      `ret=${ret ?? ""} errcode=${errcode ?? ""}`.trim();
    throw new Error(`Weixin iLink ${path} failed: ${message}`);
  }
}

async function getJson(pathAndQuery) {
  const response = await fetch(`${API_BASE}${BOT_PATH}${pathAndQuery}`, {
    method: "GET",
    headers: loginHeaders(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Weixin login ${pathAndQuery.split("?")[0]} failed: HTTP ${response.status}`);
  }
  return response.json();
}

function readString(record, key) {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

function normalizeQrStatus(value) {
  if (typeof value === "number") {
    if (value === 0) return "pending";
    if (value === 1) return "scanned";
    if (value === 2) return "success";
    if (value === 3 || value === 4) return "expired";
    return "pending";
  }
  if (typeof value !== "string") return "pending";
  const normalized = value.toLowerCase();
  if (["confirmed", "confirm", "authorized", "success", "ok"].includes(normalized))
    return "success";
  if (["scaned", "scanned", "scan", "confirmed_wait"].includes(normalized)) return "scanned";
  if (["expired", "timeout", "cancel", "cancelled", "canceled"].includes(normalized))
    return "expired";
  if (["error", "failed", "fail"].includes(normalized)) return "error";
  return "pending";
}

/** 更新 .env.local 中的单个键；文件不存在则创建（含注释头）。 */
function upsertEnvLocal(key, value) {
  let lines = [];
  try {
    lines = readFileSync(ENV_PATH, "utf-8").split(/\r?\n/u);
  } catch {
    lines = ["# wechat-channel 本地凭据（勿提交）"];
  }
  let replaced = false;
  const updated = lines.map((line) => {
    if (!replaced && line.startsWith(`${key}=`)) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!replaced) updated.push(`${key}=${value}`);
  writeFileSync(ENV_PATH, `${updated.join("\n").replace(/\n+$/u, "")}\n`, "utf-8");
}

async function main() {
  const qrcodeResponse = await getJson("/get_bot_qrcode?bot_type=3");
  assertApiOk("/get_bot_qrcode", qrcodeResponse);
  const qrcode = unwrapData(qrcodeResponse);
  const qrCode = readString(qrcode, "qrcode") || readString(qrcode, "qr_code");
  const qrUrl =
    readString(qrcode, "qrcode_img_content") || readString(qrcode, "qrcode_url") || qrCode;
  if (!qrCode) {
    throw new Error("Weixin login did not return a QR code.");
  }
  const expiresInSeconds = typeof qrcode.expires_in === "number" ? qrcode.expires_in : 120;
  console.log("请用微信扫描以下二维码内容对应的二维码完成登录：");
  console.log(`  二维码内容串：${qrCode}`);
  console.log(`  展示地址/图片：${qrUrl}`);
  console.log(`（${expiresInSeconds}s 内有效，每 ${POLL_INTERVAL_MS / 1000}s 轮询一次扫码状态）`);

  const deadline = Date.now() + expiresInSeconds * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    let payload;
    try {
      payload = await getJson(`/get_qrcode_status?qrcode=${encodeURIComponent(qrCode)}`);
    } catch (error) {
      console.warn(`轮询暂时失败，继续：${String(error)}`);
      continue;
    }
    assertApiOk("/get_qrcode_status", payload);
    const status = normalizeQrStatus(unwrapData(payload).status);
    if (status === "scanned") {
      console.log("已扫码，请在手机上确认登录…");
      continue;
    }
    if (status === "expired") {
      console.error("二维码已过期，请重新运行本脚本。");
      process.exitCode = 1;
      return;
    }
    if (status === "error") {
      console.error("Weixin login failed.");
      process.exitCode = 1;
      return;
    }
    if (status === "success") {
      const data = unwrapData(payload);
      const botToken = readString(data, "bot_token") || readString(data, "token");
      if (!botToken) {
        throw new Error("Weixin login succeeded but did not return bot_token.");
      }
      const botId = readString(data, "ilink_bot_id") || readString(data, "bot_id");
      upsertEnvLocal("WEIXIN_BOT_TOKEN", botToken);
      if (botId) upsertEnvLocal("WEIXIN_BOT_ID", botId);
      console.log(
        `登录成功${botId ? `（bot: ${botId}）` : ""}，WEIXIN_BOT_TOKEN 已写入 .env.local。`,
      );
      console.log(
        "启动通道：pnpm --filter @zcode/wechat-channel start（需先设置 ZCODE_WORKSPACE）",
      );
      return;
    }
  }
  console.error("等待扫码超时，请重新运行本脚本。");
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`wechat-login 失败：${String(error)}`);
  process.exitCode = 1;
});
