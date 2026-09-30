#!/usr/bin/env node
// 桌面端 GitHub Release 资产上传的唯一所有者（发布动作编排层，纯函数见 release-asset-publish-core.mjs）。
//
// 为什么不用 electron-builder --publish always（修复依据见 specs/release-asset-publish.md）：
// 1. electron-builder 的 GitHub publisher 以 draft 语义发布，目标 Release 已是 published 时
//    会静默跳过全部资产但进程退出码为 0，入口脚本误报 DONE（v3.14.3-safe.1 win-arm64 踩中）。
// 2. Windows/macOS 多架构共用同一 channel yml（latest.yml / latest-mac.yml），按架构分别构建时
//    互相覆盖，electron-updater 按 process.arch 在 files[] 选不到条目就回退第一个，
//    arm 客户端会下载 x64 安装包。这里按“每个架构一个 files[] 条目”合并后再上传。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import process from "node:process";
import { join, resolve } from "node:path";

import {
  buildUpdateInfoEntry,
  buildUpdateInfoFile,
  findReleaseAssetMismatches,
  mergeUpdateInfoFile,
  parseUpdateInfoFile,
  planReleaseAssets,
  resolveChannelFileName,
  resolveUpdaterArtifactExtension,
  serializeUpdateInfoFile,
} from "./release-asset-publish-core.mjs";
import {
  resolveDesktopUpdateChannel,
  resolveDesktopUpdateGithubRepo,
} from "./desktop-update-channel.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");
const desktopDistRoot = resolve(desktopRoot, process.env.ZCODE_DESKTOP_DIST_DIR || "dist");

// 与 bundle.mjs 的 osAliasMap/archAliasMap/artifactExtensionsByOs 同口径。
// 不直接 import bundle.mjs：它模块顶层会解析 @electron/asar 等副作用，不适合当库引用。
const osAliasMap = new Map([
  ["mac", "mac"],
  ["macos", "mac"],
  ["darwin", "mac"],
  ["osx", "mac"],
  ["win", "win"],
  ["windows", "win"],
  ["win32", "win"],
  ["linux", "linux"],
]);
const archAliasMap = new Map([
  ["x64", "x64"],
  ["amd64", "x64"],
  ["x86_64", "x64"],
  ["arm64", "arm64"],
  ["aarch64", "arm64"],
]);
const artifactExtensionsByOs = {
  mac: [".dmg", ".zip"],
  win: [".exe"],
  linux: [".AppImage", ".deb", ".rpm", ".pkg.tar.zst"],
};
const archHintsByArch = {
  x64: ["x64", "x86_64", "amd64"],
  arm64: ["arm64", "aarch64"],
};

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 与 bundle.mjs artifactNameMatchesArch 同口径：架构后允许 _ . - 分隔符。
function artifactNameMatchesArch(fileName, archHint) {
  return new RegExp(`-${escapeRegExp(archHint.toLowerCase())}(?:[._-])`, "i").test(fileName);
}

function fail(message) {
  console.error(`[publish-asset] ${message}`);
  process.exit(1);
}

function runGh(args, { allowFailure = false } = {}) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    if (allowFailure) {
      return null;
    }
    fail(`gh ${args.join(" ")} 失败: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`);
  }
  return result.stdout;
}

function parseArgs(argv) {
  let os = process.env.ZCODE_TARGET_OS ?? null;
  let arch = process.env.ZCODE_TARGET_ARCH ?? null;
  let dryRun = false;
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      console.log(
        "用法: publish-github-release-asset.mjs [--os mac|win|linux] [--arch x64|arm64] [--dry-run]",
      );
      process.exit(0);
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--os" || arg === "-o") {
      os = argv[(index += 1)] ?? null;
      continue;
    }
    if (arg === "--arch" || arg === "-a") {
      arch = argv[(index += 1)] ?? null;
      continue;
    }
    if (arg.startsWith("--os=")) {
      os = arg.slice("--os=".length);
      continue;
    }
    if (arg.startsWith("--arch=")) {
      arch = arg.slice("--arch=".length);
      continue;
    }
    positionals.push(arg);
  }
  const normalizedOs = osAliasMap.get((os ?? positionals[0] ?? "").toLowerCase());
  const normalizedArch = archAliasMap.get((arch ?? positionals[1] ?? "").toLowerCase());
  if (!normalizedOs || !normalizedArch) {
    fail(`缺少或非法的 os/arch: ${os} ${arch}`);
  }
  return { os: normalizedOs, arch: normalizedArch, dryRun };
}

function preflight() {
  if (resolveDesktopUpdateChannel(process.env) !== "github") {
    fail("ZCODE_UPDATE_CHANNEL 必须是 github；official 通道不走 GitHub Release 资产上传");
  }
  const repo = resolveDesktopUpdateGithubRepo(process.env);
  if (!repo) {
    fail("ZCODE_UPDATE_CHANNEL=github 需要 ZCODE_UPDATE_GITHUB_REPO=owner/repo");
  }

  runGh(["--version"]);
  const ghToken = process.env.GH_TOKEN?.trim() || runGh(["auth", "token"], { allowFailure: true })?.trim();
  if (!ghToken) {
    fail("无法获取 GitHub 凭据：请先 gh auth login 或设置 GH_TOKEN");
  }

  // electron-builder 的 appInfo.version 优先取 desktop package.json，缺省回退仓库根 package.json
  //（desktop 的 package.json 没有 version 字段，实际版本 3.14.3-safe.1 即来自根），tag 必须同源。
  const appVersion =
    JSON.parse(readFileSync(resolve(desktopRoot, "package.json"), "utf8")).version ??
    JSON.parse(readFileSync(resolve(desktopRoot, "../../package.json"), "utf8")).version;
  if (!appVersion) {
    fail("无法确定应用版本：desktop 与仓库根 package.json 均无 version 字段");
  }
  const tag = process.env.ZCODE_RELEASE_TAG?.trim() || `v${appVersion}`;
  if (process.env.ZCODE_ALLOW_UNTAGGED !== "1") {
    // 入口约定“构建树必须检出在发布 tag 上”，这里机械校验，防止把本地产物传到错误版本。
    const described = spawnSync("git", ["describe", "--tags", "--exact-match"], {
      encoding: "utf8",
      cwd: desktopRoot,
      windowsHide: true,
    });
    if (described.status !== 0 || described.stdout.trim() !== tag) {
      fail(
        `HEAD 不在发布 tag 上: git describe=${described.stdout.trim() || "(失败)"} 期望 ${tag}；` +
          "如确需跳过请设置 ZCODE_ALLOW_UNTAGGED=1",
      );
    }
  }
  return { owner: repo.owner, repo: repo.repo, tag };
}

// 从 dist 发现该 os/arch 的安装包；同扩展名取最新（防历史构建残留），架构按文件名 hint 过滤。
function discoverArtifacts({ os, arch }) {
  const extensions = artifactExtensionsByOs[os];
  const archHints = archHintsByArch[arch];
  const newestByExtension = new Map();
  for (const entry of readdirSync(desktopDistRoot, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const lowerName = entry.name.toLowerCase();
    const extension = extensions.find((candidate) => lowerName.endsWith(candidate));
    if (!extension || !archHints.some((hint) => artifactNameMatchesArch(lowerName, hint))) {
      continue;
    }
    const localPath = join(desktopDistRoot, entry.name);
    const mtimeMs = statSync(localPath).mtimeMs;
    const current = newestByExtension.get(extension);
    if (!current || mtimeMs > current.mtimeMs) {
      newestByExtension.set(extension, { localPath, assetName: entry.name, size: statSync(localPath).size, mtimeMs });
    }
  }
  const artifacts = [...newestByExtension.values()].map(({ localPath, assetName, size }) => ({
    localPath,
    assetName,
    size,
  }));
  const updaterExtension = resolveUpdaterArtifactExtension(os);
  const updaterArtifact = artifacts.find((file) => file.assetName.toLowerCase().endsWith(updaterExtension));
  if (!updaterArtifact) {
    fail(`dist 中未找到 ${os}/${arch} 的 updater 安装包 (${updaterExtension})，请先完成打包`);
  }
  const blockmaps = artifacts
    .map((file) => `${file.localPath}.blockmap`)
    .filter(existsSync)
    .map((localPath) => ({ localPath, assetName: localPath.slice(desktopDistRoot.length + 1), size: statSync(localPath).size }));
  return { artifacts, updaterArtifact, blockmaps };
}

function fetchRelease({ owner, repo, tag }) {
  const stdout = runGh(["api", `repos/${owner}/${repo}/releases/tags/${tag}`], { allowFailure: true });
  if (!stdout) {
    return null;
  }
  return JSON.parse(stdout);
}

function createRelease({ owner, repo, tag }) {
  // 全自动语义：Release 不存在时创建“已发布”状态的 Release；draft 需要人工点击发布，无人值守会卡住。
  runGh([
    "release",
    "create",
    tag,
    "--repo",
    `${owner}/${repo}`,
    "--title",
    tag,
    "--notes",
    `ZCode Desktop ${tag}`,
  ]);
}

function downloadReleaseFile({ owner, repo, tag, assetName, outputPath }) {
  const result = spawnSync(
    "gh",
    ["release", "download", tag, "--repo", `${owner}/${repo}`, "--pattern", assetName, "--output", outputPath, "--clobber"],
    { encoding: "utf8", windowsHide: true },
  );
  return result.status === 0;
}

function computeSha512Base64(filePath) {
  return createHash("sha512").update(readFileSync(filePath)).digest("base64");
}

async function main() {
  const { os, arch, dryRun } = parseArgs(process.argv.slice(2));
  const context = preflight();
  const { owner, repo, tag } = context;
  console.log(`[publish-asset] target=${os}/${arch} repo=${owner}/${repo} tag=${tag} dryRun=${dryRun}`);

  const channelFileName = resolveChannelFileName(os, arch);
  const { artifacts, updaterArtifact, blockmaps } = discoverArtifacts({ os, arch });
  const updaterSha512 = computeSha512Base64(updaterArtifact.localPath);

  const release = dryRun ? { assets: [] } : fetchRelease(context);
  const existingChannelAsset = release?.assets?.find((asset) => asset.name === channelFileName);
  let infoFile;
  if (existingChannelAsset) {
    const localCopy = join(desktopDistRoot, `${channelFileName}.existing`);
    if (!downloadReleaseFile({ owner, repo, tag, assetName: channelFileName, outputPath: localCopy })) {
      fail(`下载现有 ${channelFileName} 失败`);
    }
    const existingInfo = parseUpdateInfoFile(readFileSync(localCopy, "utf8"));
    infoFile = mergeUpdateInfoFile(existingInfo, buildUpdateInfoEntry({
      artifactName: updaterArtifact.assetName,
      sha512: updaterSha512,
      size: updaterArtifact.size,
      arch,
    }), { version: appVersionOf(tag), artifactName: updaterArtifact.assetName, sha512: updaterSha512 });
  } else {
    infoFile = buildUpdateInfoFile({
      version: appVersionOf(tag),
      arch,
      artifactName: updaterArtifact.assetName,
      sha512: updaterSha512,
      size: updaterArtifact.size,
    });
  }

  const channelYmlLocalPath = join(desktopDistRoot, channelFileName);
  const channelYmlContent = serializeUpdateInfoFile(infoFile);
  writeFileSync(channelYmlLocalPath, channelYmlContent);

  const plannedAssets = planReleaseAssets({
    channelFileName,
    channelYmlLocalPath,
    artifactFiles: [...artifacts, ...blockmaps],
  });
  console.log(`[publish-asset] 计划上传:`);
  for (const planned of plannedAssets) {
    console.log(`  - ${planned.assetName}${planned.size != null ? ` (${planned.size} bytes)` : ""}`);
  }
  console.log(`[publish-asset] ${channelFileName} 内容:\n${channelYmlContent}`);
  if (dryRun) {
    console.log("[publish-asset] dry-run 结束，未产生任何 GitHub 写操作");
    return;
  }

  if (!release) {
    console.log(`[publish-asset] Release ${tag} 不存在，创建已发布状态的 Release`);
    createRelease(context);
  }

  runGh([
    "release",
    "upload",
    tag,
    "--repo",
    `${owner}/${repo}`,
    "--clobber",
    ...plannedAssets.map((planned) => planned.localPath),
  ]);

  // 上传后校验是输出 DONE 的唯一依据：electron-builder 的静默跳过必须在这里被拦下。
  // channel yml 在计划里是存在性检查，这里补上写入后的实际体积做严格校验。
  const releaseAfterUpload = fetchRelease(context);
  const verificationPlan = plannedAssets.map((planned) =>
    planned.assetName === channelFileName
      ? { ...planned, size: statSync(channelYmlLocalPath).size }
      : planned,
  );
  const mismatches = findReleaseAssetMismatches(releaseAfterUpload?.assets ?? [], verificationPlan);
  if (mismatches.length > 0) {
    fail(`上传后校验失败:\n- ${mismatches.join("\n- ")}`);
  }
  const verifyLocalPath = join(desktopDistRoot, `${channelFileName}.verify`);
  if (!downloadReleaseFile({ owner, repo, tag, assetName: channelFileName, outputPath: verifyLocalPath })) {
    fail(`上传后无法回读 ${channelFileName}`);
  }
  const verifiedInfo = parseUpdateInfoFile(readFileSync(verifyLocalPath, "utf8"));
  const verifiedEntry = verifiedInfo.files?.find((file) => file.url === updaterArtifact.assetName);
  if (!verifiedEntry || verifiedEntry.sha512 !== updaterSha512) {
    fail(`Release 上的 ${channelFileName} 未包含 ${updaterArtifact.assetName} 的正确校验和`);
  }
  console.log(
    `[publish-asset] DONE. ${tag} 已包含 ${os}/${arch} 资产与合并后的 ${channelFileName}（files=${verifiedInfo.files.length} 条）`,
  );
}

// tag 形如 v3.14.3-safe.1，与 electron-builder 的 appInfo.version（desktop package.json）同源。
function appVersionOf(tag) {
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  if (!version) {
    fail(`无法从 tag 推导版本号: ${tag}`);
  }
  return version;
}

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.stack ?? error.message : String(error));
}
