// 发布资产上传的纯函数层：channel yml 命名、update info 生成/合并、资产校验计划。
// 禁止任何 IO；gh 调用与文件读写只允许出现在 publish-github-release-asset.mjs。
// 依赖约束：YAML 解析用工作区内 electron-updater 的传递依赖 js-yaml（createRequire 解析），
// dump 必须 lineWidth: -1，否则 base64 sha512 会被折行，updater 校验和解析直接失败。
import { createRequire } from "node:module";
import { gt } from "semver";

const requireFromHere = createRequire(import.meta.url);
const jsYaml = requireFromHere("js-yaml");

// 与 electron-updater 6.x 的 getChannelFilePrefix 保持同口径：
// win 历史上不带平台前缀；mac 固定 -mac；linux 额外按架构区分（x64 无后缀）。
const channelFileBaseNames = {
  win: "latest.yml",
  mac: "latest-mac.yml",
  linux: "latest-linux.yml",
};

// updater 实际下载并校验的安装包扩展名；其余安装器只作为 Release 资产存在。
const updaterArtifactExtensions = {
  win: ".exe",
  mac: ".zip",
  linux: ".AppImage",
};

export function resolveChannelFileName(os, arch) {
  const baseName = channelFileBaseNames[os];
  if (!baseName) {
    throw new Error(`不支持的目标操作系统: ${os}`);
  }
  if (os === "linux" && arch === "arm64") {
    return "latest-linux-arm64.yml";
  }
  return baseName;
}

export function resolveUpdaterArtifactExtension(os) {
  const extension = updaterArtifactExtensions[os];
  if (!extension) {
    throw new Error(`不支持的目标操作系统: ${os}`);
  }
  return extension;
}

// 生成单架构的 update info。sha512 由调用方按本地文件计算（base64）后传入，保持本模块无 IO。
export function buildUpdateInfoFile({ version, arch, artifactName, sha512, size, releaseDate }) {
  const entry = buildUpdateInfoEntry({ artifactName, sha512, size, arch });
  return {
    version,
    files: [entry],
    path: entry.url,
    sha512: entry.sha512,
    releaseDate: releaseDate ?? new Date().toISOString(),
  };
}

export function buildUpdateInfoEntry({ artifactName, sha512, size, arch }) {
  if (!sha512 || !Number.isFinite(size)) {
    throw new Error(`构建 update info 条目缺少校验和或体积: ${artifactName}`);
  }
  return {
    url: artifactName,
    sha512,
    size,
    arch,
  };
}

// 多架构共写同一 channel yml（win/mac）时的合并规则：
// - version 不一致说明发布目标错乱（例如往旧 tag 上传新版本产物），必须硬失败；
// - files[] 按 url 替换本次架构的条目，其余架构条目原样保留——
//   electron-updater 6.8.3 findFile 按 URL 包含 process.arch 选条目、找不到才回退第一个，
//   所以丢掉任何已有架构条目都会把那个架构的自动更新打坏；
// - 顶层 path/sha512/releaseDate 仅在原本就指向本次产物时跟随更新，避免改变另一架构的默认解析结果。
export function mergeUpdateInfoFile(existingInfo, incomingEntry, { version, artifactName, sha512 }) {
  if (existingInfo?.version !== version) {
    throw new Error(
      `channel yml 版本不一致: 现有 ${existingInfo?.version} vs 本次 ${version}，拒绝合并到错误的 Release`,
    );
  }

  const mergedFiles = existingInfo.files?.some((file) => file.url === artifactName)
    ? existingInfo.files.map((file) => (file.url === artifactName ? incomingEntry : file))
    : [...(existingInfo.files ?? []), incomingEntry];

  const topLevelPointsToIncoming = existingInfo.path === artifactName;
  return {
    ...existingInfo,
    files: mergedFiles,
    path: topLevelPointsToIncoming ? artifactName : existingInfo.path,
    sha512: topLevelPointsToIncoming ? sha512 : existingInfo.sha512,
  };
}

// 组装本次要上传的 channel yml：Release 上已有同名 yml 时合并，否则以本次产物新建。
// builtInfo 是 dist 中构建期生成的同名 yml（覆盖写之前由 glue 层读出），os 用于平台约束。
//
// Bugfix: 新建分支只写 version/files/path/sha512/releaseDate，合并分支只继承 Release 上已有的字段，
// bundle.mjs 盖在构建期 yml 上的 minimumSystemVersion 两条路都带不过来——v3.17.1-safe.1 与
// v3.17.2-safe.2 的 latest-mac.yml 均缺该字段，electron-updater 便把 Electron 44（要求 macOS 13）
// 的安装包推给 macOS 12，装完无法启动。修复：从同版本构建期 yml 搬运下限，与现有 yml 取更严格者；
// mac 最终没有下限就拒绝发布。数值的唯一所有者是 macos-update-manifest.mjs，这里只搬运不定义。
export function composeChannelUpdateInfo({
  os,
  existingInfo,
  builtInfo,
  version,
  arch,
  artifactName,
  sha512,
  size,
}) {
  const info = existingInfo
    ? mergeUpdateInfoFile(
        existingInfo,
        buildUpdateInfoEntry({ artifactName, sha512, size, arch }),
        { version, artifactName, sha512 },
      )
    : buildUpdateInfoFile({ version, arch, artifactName, sha512, size });
  // 版本不同的构建期 yml 是 dist 残留，不能作为本次发布的下限来源。
  const builtMinimum = builtInfo?.version === version ? builtInfo.minimumSystemVersion : undefined;
  const minimumSystemVersion = strictestSystemVersion([info.minimumSystemVersion, builtMinimum]);
  if (os === "mac" && !minimumSystemVersion) {
    throw new Error(
      `latest-mac.yml 缺少 minimumSystemVersion：dist 中没有 ${version} 的构建期 yml 或其未盖章，` +
        "拒绝发布（否则低版本 macOS 会被推送无法启动的安装包）",
    );
  }
  return minimumSystemVersion ? { ...info, minimumSystemVersion } : info;
}

// 只升不降：多个来源同时声明下限时取更严格（更高）的 Darwin 版本。
function strictestSystemVersion(candidates) {
  const declared = candidates.filter((value) => typeof value === "string" && value.length > 0);
  return declared.reduce((strictest, value) => (gt(value, strictest) ? value : strictest), declared[0]);
}

export function serializeUpdateInfoFile(info) {
  // lineWidth: -1 禁止折行；base64 sha512 被默认 80 列折叠后 updater 会解析出错误的校验和。
  return jsYaml.dump(info, { lineWidth: -1 });
}

export function parseUpdateInfoFile(rawYaml) {
  return jsYaml.load(rawYaml);
}

// 上传计划 = 安装包 + blockmap + 平台其他安装器 + channel yml。
// artifactFiles 由 glue 层从 dist 发现后传入（含绝对路径与字节数），这里只做计划编排。
export function planReleaseAssets({ channelFileName, channelYmlLocalPath, artifactFiles }) {
  if (artifactFiles.length === 0) {
    throw new Error("没有可上传的安装包产物");
  }
  return [
    ...artifactFiles.map((file) => ({
      localPath: file.localPath,
      assetName: file.assetName,
      size: file.size,
    })),
    {
      localPath: channelYmlLocalPath,
      assetName: channelFileName,
      size: null,
    },
  ];
}

// 上传后校验：预期资产必须逐个存在且字节数精确一致（channel yml 体积随合并变化，只查存在性）。
// 这是脚本允许输出 DONE 的唯一依据；electron-builder 静默跳过上传的缺陷必须在这里被拦下。
export function findReleaseAssetMismatches(releaseAssets, plannedAssets) {
  const assetsByName = new Map(releaseAssets.map((asset) => [asset.name, asset]));
  const mismatches = [];
  for (const planned of plannedAssets) {
    const asset = assetsByName.get(planned.assetName);
    if (!asset) {
      mismatches.push(`缺少资产: ${planned.assetName}`);
      continue;
    }
    if (planned.size != null && asset.size !== planned.size) {
      mismatches.push(`体积不一致: ${planned.assetName} 预期 ${planned.size} 实际 ${asset.size}`);
    }
  }
  return mismatches;
}
