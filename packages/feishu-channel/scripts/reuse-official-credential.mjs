#!/usr/bin/env node
// 复用官方 ZCode 桌面端已配置的飞书 bot 凭证，免去手工建应用/找 secret。
//
// 原理（与开源仓库 packages/services/src/credential/providers/credentialCipherProvider.ts
// 同一实现）：credentials.json 里 `enc:v1:` 信封 = AES-256-GCM，
// 密钥 = SHA-256(ZCODE_CREDENTIAL_SECRET || "zcode-credential-fallback:{platform}:{homedir}:{username}")。
//
// 用法：node scripts/reuse-official-credential.mjs [v2目录]
//   v2目录缺省 %USERPROFILE%\.zcode\v2
// 输出：把 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_TASK_MODE 写入本包 .env.local（已 gitignore）。
// 安全：解密结果只写文件，不打印密钥本体；输出仅含 app id（非密）与长度等元数据。

import { createDecipheriv, createHash } from "node:crypto";
import { homedir, platform, userInfo } from "node:os";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

const ENV_LOCAL_PATH = join(import.meta.dirname, "..", ".env.local");

function fallbackSecret() {
  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    // 与官方实现一致：拿不到用户名时退回占位值。
  }
  return `zcode-credential-fallback:${platform()}:${homedir()}:${username}`;
}

function decrypt(encrypted) {
  if (!encrypted.startsWith("enc:v1:")) return encrypted;
  const [ivRaw, tagRaw, dataRaw] = encrypted.slice("enc:v1:".length).split(".");
  if (!ivRaw || !tagRaw || !dataRaw) throw new Error("密文格式非法");
  const key = createHash("sha256")
    .update(process.env.ZCODE_CREDENTIAL_SECRET || fallbackSecret())
    .digest();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataRaw, "base64url")),
    decipher.final(),
  ]).toString("utf-8");
}

function extractSecret(plain) {
  try {
    const parsed = JSON.parse(plain);
    const candidate =
      parsed?.appSecret ?? parsed?.secret ?? parsed?.app_secret ?? parsed?.appSecretText;
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    // 官方可能存任意 JSON 结构；找不到已知字段时如实失败，避免写错值。
    return null;
  } catch {
    const trimmed = plain.trim();
    return trimmed ? trimmed : null;
  }
}

async function main() {
  const v2Dir = process.argv[2] || join(homedir(), ".zcode", "v2");
  const botConfig = JSON.parse(await readFile(join(v2Dir, "bot-config.v3.json"), "utf-8"));
  const bots = (botConfig?.bots ?? []).filter((b) => b?.provider === "feishu" && b?.enabled);
  if (bots.length === 0) {
    console.error("v2 目录里没有启用中的飞书 bot，无法复用凭证。");
    process.exitCode = 2;
    return;
  }
  if (bots.length > 1) {
    console.warn(`发现 ${bots.length} 个飞书 bot，使用第一个：${bots[0]?.name ?? bots[0]?.id}`);
  }
  const bot = bots[0];
  const credentials = JSON.parse(await readFile(join(v2Dir, "credentials.json"), "utf-8"));
  const encrypted = credentials?.[bot.credentialRef];
  if (typeof encrypted !== "string") {
    console.error(`credentials.json 中找不到 ${bot.credentialRef}，官方端可能尚未保存凭证。`);
    process.exitCode = 2;
    return;
  }
  let plain;
  try {
    plain = decrypt(encrypted);
  } catch (error) {
    console.error(
      `解密失败（${error?.message ?? error}）。若官方端配置时设置了 ZCODE_CREDENTIAL_SECRET，请以同一值重试。`,
    );
    process.exitCode = 2;
    return;
  }
  const secret = extractSecret(plain);
  if (!secret) {
    console.error("凭证已解密但未找到 appSecret 字段；请检查凭证 JSON 结构后手工填写 .env.local。");
    process.exitCode = 2;
    return;
  }
  const lines = [
    "# 由 scripts/reuse-official-credential.mjs 生成；已被 gitignore，勿提交、勿贴入对话。",
    `FEISHU_APP_ID=${bot.feishuAppId ?? ""}`,
    `FEISHU_APP_SECRET=${secret}`,
    "FEISHU_TASK_MODE=yolo",
    "# 按需修改引擎工作区（必填）：",
    "# ZCODE_WORKSPACE=D:\\path\\to\\workspace",
  ];
  await writeFile(ENV_LOCAL_PATH, `${lines.join("\n")}\n`, "utf-8");
  console.log(`已写入 ${ENV_LOCAL_PATH}`);
  console.log(`  bot: ${bot.name ?? bot.id}`);
  console.log(`  appId: ${bot.feishuAppId ?? "(bot 配置缺失)"}`);
  console.log(`  appSecret: 已写入（长度 ${secret.length}，不回显）`);
  console.log(
    "提醒：同一飞书 app 的长连接事件会在多条连接间分流，请停用官方桌面端 bot 后再启动本通道。",
  );
}

main().catch((error) => {
  console.error(`执行失败：${error?.message ?? error}`);
  process.exitCode = 1;
});
