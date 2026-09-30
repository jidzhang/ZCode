// 发布资产上传纯函数的回归测试，运行方式：node --test packages/desktop/scripts/
// 关键用例用工作区内 electron-updater 的真实 parseUpdateInfo/resolveFiles/findFile 做跨模块校验：
// 多架构合并后的 channel yml 必须让 x64/arm64 客户端各自解析到正确安装包与校验和
//（v3.14.3-safe.1 发布时 arm64 曾因单架构 latest.yml 静默回退下载 x64 安装包）。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

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

const requireFromHere = createRequire(import.meta.url);
const updaterProvider = requireFromHere("electron-updater/out/providers/Provider.js");

function resolveUpdateFileForArch(info, arch) {
  // process.arch 是 updater 内部直接读取的全局量，测试里按目标架构覆写后再还原。
  const originalArch = process.arch;
  Object.defineProperty(process, "arch", { value: arch, configurable: true });
  try {
    const baseUrl = new URL(
      "https://github.com/jidzhang/ZCode/releases/download/v1.0.0/latest.yml",
    );
    const resolved = updaterProvider.resolveFiles(info, baseUrl);
    return updaterProvider.findFile(resolved, "exe");
  } finally {
    Object.defineProperty(process, "arch", { value: originalArch, configurable: true });
  }
}

test("channel yml 文件名与 electron-updater 的平台/架构规则一致", () => {
  assert.equal(resolveChannelFileName("win", "x64"), "latest.yml");
  assert.equal(resolveChannelFileName("win", "arm64"), "latest.yml");
  assert.equal(resolveChannelFileName("mac", "x64"), "latest-mac.yml");
  assert.equal(resolveChannelFileName("mac", "arm64"), "latest-mac.yml");
  assert.equal(resolveChannelFileName("linux", "x64"), "latest-linux.yml");
  // linux 架构间天然隔离：arm64 客户端只找 -arm64 后缀文件，不存在互相覆盖。
  assert.equal(resolveChannelFileName("linux", "arm64"), "latest-linux-arm64.yml");
  assert.throws(() => resolveChannelFileName("android", "x64"));
});

test("updater 安装包扩展名覆盖三种平台", () => {
  assert.equal(resolveUpdaterArtifactExtension("win"), ".exe");
  assert.equal(resolveUpdaterArtifactExtension("mac"), ".zip");
  assert.equal(resolveUpdaterArtifactExtension("linux"), ".AppImage");
});

test("单架构 yml 生成后可被 electron-updater 解析", () => {
  const info = buildUpdateInfoFile({
    version: "1.0.0",
    arch: "arm64",
    artifactName: "App-1.0.0-win-arm64.exe",
    sha512: "AAAAabcdefgh/+123456789==",
    size: 123,
  });
  const parsed = parseUpdateInfoFile(serializeUpdateInfoFile(info));
  assert.equal(parsed.version, "1.0.0");
  assert.equal(parsed.files.length, 1);
  // 序列化不能折行：base64 sha512 被 YAML 折行后 updater 会解析出错误校验和。
  assert.ok(
    serializeUpdateInfoFile(info).includes("sha512: AAAAabcdefgh/+123456789==\n"),
    "sha512 必须完整保留在单行内",
  );
});

test("合并: 第二个架构追加条目且两个架构各自解析正确（electron-updater 真实代码）", () => {
  const x64Entry = buildUpdateInfoEntry({
    artifactName: "App-1.0.0-win-x64.exe",
    sha512: "QVJNNjR0eDVYNjRTYXbl==",
    size: 100,
    arch: "x64",
  });
  const arm64Entry = buildUpdateInfoEntry({
    artifactName: "App-1.0.0-win-arm64.exe",
    sha512: "QVJNNjRiYXNlNjRTYXbl==",
    size: 200,
    arch: "arm64",
  });
  const x64Info = buildUpdateInfoFile({
    version: "1.0.0",

    arch: "x64",
    artifactName: x64Entry.url,
    sha512: x64Entry.sha512,
    size: x64Entry.size,
  });
  const merged = mergeUpdateInfoFile(x64Info, arm64Entry, {
    version: "1.0.0",
    artifactName: arm64Entry.url,
    sha512: arm64Entry.sha512,
  });

  assert.equal(merged.files.length, 2);
  assert.equal(merged.path, "App-1.0.0-win-x64.exe", "另一架构的顶层默认解析必须保持不变");
  const parsed = parseUpdateInfoFile(serializeUpdateInfoFile(merged));
  assert.equal(resolveUpdateFileForArch(parsed, "x64").info.sha512, x64Entry.sha512);
  assert.equal(resolveUpdateFileForArch(parsed, "arm64").info.sha512, arm64Entry.sha512);
});

test("合并: 同架构重发替换条目且幂等", () => {
  const original = buildUpdateInfoFile({
    version: "1.0.0",

    arch: "arm64",
    artifactName: "App-1.0.0-win-arm64.exe",
    sha512: "b2xkLXNoYTUxMg==",
    size: 200,
  });
  const replacement = buildUpdateInfoEntry({
    artifactName: "App-1.0.0-win-arm64.exe",
    sha512: "bmV3LXNoYTUxMg==",
    size: 210,
    arch: "arm64",
  });
  const mergedOnce = mergeUpdateInfoFile(original, replacement, {
    version: "1.0.0",
    artifactName: replacement.url,
    sha512: replacement.sha512,
  });
  const mergedTwice = mergeUpdateInfoFile(mergedOnce, replacement, {
    version: "1.0.0",
    artifactName: replacement.url,
    sha512: replacement.sha512,
  });

  assert.equal(mergedOnce.files.length, 1);
  assert.deepEqual(mergedTwice, mergedOnce, "同架构重复发布必须幂等");
  assert.equal(mergedTwice.sha512, replacement.sha512, "顶层指向本次产物时跟随更新");
});

test("合并: 版本不一致直接失败", () => {
  const existing = buildUpdateInfoFile({
    version: "1.0.0",

    arch: "x64",
    artifactName: "App-1.0.0-win-x64.exe",
    sha512: "eHg=",
    size: 1,
  });
  assert.throws(
    () =>
      mergeUpdateInfoFile(
        existing,
        buildUpdateInfoEntry({ artifactName: "b.exe", sha512: "eHn=", size: 2, arch: "arm64" }),
        { version: "2.0.0", artifactName: "b.exe", sha512: "eHn=" },
      ),
    /版本不一致/,
  );
});

test("上传后校验: 名称与字节数必须精确匹配", () => {
  const releaseAssets = [
    { name: "App-1.0.0-win-arm64.exe", size: 200 },
    { name: "latest.yml", size: 999 },
  ];
  const planned = planReleaseAssets({
    channelFileName: "latest.yml",
    channelYmlLocalPath: "/tmp/latest.yml",
    artifactFiles: [
      { localPath: "/d/App-1.0.0-win-arm64.exe", assetName: "App-1.0.0-win-arm64.exe", size: 200 },
    ],
  });
  assert.deepEqual(findReleaseAssetMismatches(releaseAssets, planned), []);

  const missing = findReleaseAssetMismatches(
    [{ name: "latest.yml", size: 999 }],
    planned,
  );
  assert.equal(missing.length, 1);
  assert.match(missing[0], /缺少资产/);

  const wrongSize = findReleaseAssetMismatches(
    [
      { name: "App-1.0.0-win-arm64.exe", size: 12345 },
      { name: "latest.yml", size: 999 },
    ],
    planned,
  );
  assert.equal(wrongSize.length, 1);
  assert.match(wrongSize[0], /体积不一致/);
});
