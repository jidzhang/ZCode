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
  composeChannelUpdateInfo,
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
const { AppUpdater } = requireFromHere("electron-updater/out/AppUpdater.js");
const nodeOs = requireFromHere("node:os");

// electron-updater 6.8.10 的 checkIfUpdateSupported 内部直接读 os.release()（Darwin 内核版本），
// 测试里按目标系统临时替换后还原。
function isUpdateSupportedOnDarwin(info, darwinRelease) {
  const originalRelease = nodeOs.release;
  nodeOs.release = () => darwinRelease;
  try {
    const logger = { info() {}, warn() {} };
    return AppUpdater.prototype.checkIfUpdateSupported.call({ _logger: logger }, info);
  } finally {
    nodeOs.release = originalRelease;
  }
}

// dist 中 electron-builder 生成、bundle.mjs 盖章后的构建期 latest-mac.yml（只保留发布脚本会读的字段）。
function macBuiltInfo(version, minimumSystemVersion) {
  return minimumSystemVersion ? { version, files: [], minimumSystemVersion } : { version, files: [] };
}

function composeMac({ existingInfo = null, builtInfo, arch = "x64", sha512 = "eDY0LXppcA==" }) {
  return composeChannelUpdateInfo({
    os: "mac",
    existingInfo,
    builtInfo,
    version: "1.0.0",
    arch,
    artifactName: `App-1.0.0-mac-${arch}.zip`,
    sha512,
    size: arch === "x64" ? 100 : 200,
  });
}

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

test("mac 发布: x64 新建再 arm64 合并后，上传的 yml 保留构建期系统下限（v3.17.x 曾丢失）", () => {
  const x64 = composeMac({ builtInfo: macBuiltInfo("1.0.0", "22.0.0") });
  // Release 上存的是序列化文本，arm64 发布时下载回来再合并，这里按真实往返走一遍。
  const uploadedX64 = parseUpdateInfoFile(serializeUpdateInfoFile(x64));
  const merged = composeMac({
    existingInfo: uploadedX64,
    builtInfo: macBuiltInfo("1.0.0", "22.0.0"),
    arch: "arm64",
    sha512: "YXJtNjQtemlw",
  });
  const uploaded = parseUpdateInfoFile(serializeUpdateInfoFile(merged));

  assert.equal(uploaded.files.length, 2);
  assert.equal(uploaded.minimumSystemVersion, "22.0.0");
  assert.equal(isUpdateSupportedOnDarwin(uploaded, "21.6.0"), false, "macOS 12 不能收到 Electron 44 安装包");
  assert.equal(isUpdateSupportedOnDarwin(uploaded, "22.6.0"), true, "macOS 13 照常收到更新");
});

test("mac 合并: Release 上的旧 yml 缺下限时补回，已有更严格下限不被降低", () => {
  const legacy = buildUpdateInfoFile({
    version: "1.0.0",
    arch: "x64",
    artifactName: "App-1.0.0-mac-x64.zip",
    sha512: "eDY0LXppcA==",
    size: 100,
  });
  const repaired = composeMac({
    existingInfo: legacy,
    builtInfo: macBuiltInfo("1.0.0", "22.0.0"),
    arch: "arm64",
  });
  assert.equal(repaired.minimumSystemVersion, "22.0.0");

  const stricter = composeMac({
    existingInfo: { ...legacy, minimumSystemVersion: "23.0.0" },
    builtInfo: macBuiltInfo("1.0.0", "22.0.0"),
    arch: "arm64",
  });
  assert.equal(stricter.minimumSystemVersion, "23.0.0");
});

test("mac 拿不到同版本的构建期下限时拒绝发布", () => {
  // dist 里没有构建期 yml、残留旧版本 yml、或 yml 未盖章，都不能发布不带下限的 latest-mac.yml。
  for (const builtInfo of [null, macBuiltInfo("0.9.0", "22.0.0"), macBuiltInfo("1.0.0")]) {
    assert.throws(() => composeMac({ builtInfo }), /minimumSystemVersion/);
  }
});

test("win/linux 不要求系统下限，也不凭空添加", () => {
  for (const os of ["win", "linux"]) {
    const info = composeChannelUpdateInfo({
      os,
      existingInfo: null,
      builtInfo: null,
      version: "1.0.0",
      arch: "x64",
      artifactName: `App-1.0.0-${os}-x64.bin`,
      sha512: "eDY0",
      size: 100,
    });
    assert.equal("minimumSystemVersion" in info, false);
  }
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
