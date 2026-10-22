#!/usr/bin/env node

import process from "node:process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stageLocalCuaHelperRuntime, overlayNodeReplHostServer } from "./local-cua-helper-runtime.mjs";
import { getTargetPlatform } from "./target-platform.mjs";

// safe-zcode fork：把本地 local-cua-helper（官方安装包的 tools/cua-helper 副本，gitignore）
// 原样暂存进 bundled-tools，供 electron-builder 映射进安装包。目录不存在时静默跳过。
// 背景见 local-cua-helper-runtime.mjs 头注释。

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopPackageRoot = resolve(scriptDir, "..");

const targetPlatform = getTargetPlatform();
if (targetPlatform.os !== "win32") {
  console.log("[prepare-local-cua-helper] skip unsupported platform");
  process.exit(0);
}

const desktopPackage = JSON.parse(
  await readFile(resolve(desktopPackageRoot, "package.json"), "utf8"),
);
const result = await stageLocalCuaHelperRuntime({
  desktopPackageRoot,
  outputRoot: resolve(desktopPackageRoot, "bundled-tools"),
  targetPlatform,
  electronVersion: desktopPackage.devDependencies.electron,
});
if (result.status === "skipped") {
  console.log(`[prepare-local-cua-helper] stage skip (${result.reason})`);
}
// 覆盖 staged glm 的 node-repl-host server（真实 CUA 客户端）；须在 prepare:agent-bundle 之后。
const overlay = overlayNodeReplHostServer({
  desktopPackageRoot,
  platformKey: targetPlatform.key,
});
if (overlay.status === "skipped") {
  console.log(`[prepare-local-cua-helper] overlay skip (${overlay.reason})`);
}
