import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { cp, lstat, readFile, readdir, rm } from "node:fs/promises";
import { env } from "node:process";
import { isAbsolute, join, resolve } from "node:path";

/**
 * safe-zcode fork：把官方闭源安装包里的 Windows cua-helper 运行时（已构建产物）注入本地构建。
 *
 * 背景：开源树的 @zcode/zcode-cua 是 fail-closed 占位包，真实 helper 二进制只随官方安装包分发；
 * 但产品侧的解析/校验/拉起链路全部开源（packages/services/src/cua-permission-broker/windowsCuaDevRuntime.ts，
 * 读 resources/tools/cua-helper + runtime-manifest.json，复核 sha256 与 electron 版本后经
 * ELECTRON_RUN_AS_NODE 拉起）。因此只要把官方安装包的 tools/cua-helper 目录原样带进
 * bundled-tools/<target>/cua-helper，electron-builder 就会照常映射进安装包，运行时全部校验可通过。
 *
 * 但只带 helper 还不够（2026-10-22 两台实机验证无效后逆向定案）：agent 侧的 CUA 客户端
 * runtime（createComputerUseRuntime，工具实现 + broker 协议）同样只存在于官方编译产物里。
 * 逆向结论（D:\\work\\github\\zcode-debug\\3.16.2-official）：官方与本 fork 的
 * node-repl-host dist **只差 dist/mcp/server.js 一个文件**（其余字节一致；本 fork 未改过
 * 该包源码），差异内容就是内联的真实 @zcode/zcode-cua 客户端 vs 占位桩。host 侧装配、
 * socket/权限注入、helper 拉起配方（ZCODE_CUA_WIN_HELPER_RECIPE）全部是开源代码
 * （packages/services/src/node.ts resolveSpawnEnv）。
 *
 * 因此本地注入共两件，都放在 gitignore 的 local-cua-helper/ 目录（或用环境变量指向别处）：
 * 1. `local-cua-helper/`          = 官方安装包 resources/tools/cua-helper 的整目录副本；
 * 2. `local-cua-helper/node-repl-host-server.js`
 *    = 官方安装包 resources/glm/packages/node-repl-host/dist/mcp/server.js 的副本，
 *      打包时覆盖 staged glm 的同名文件。
 * 目录不存在时一切行为与上游一致（CI 零影响）。闭源产物绝不入库。
 */

const RUNTIME_MANIFEST = "runtime-manifest.json";
const NRH_SERVER_OVERRIDE_BASENAME = "node-repl-host-server.js";
const EXPECTED_PACKAGE_NAME = "@zcode/zcode-cua";
const MANIFEST_KEYS = [
  "schemaVersion",
  "packageName",
  "packageVersion",
  "platform",
  "arch",
  "electronVersion",
  "entry",
  "addon",
  "sha256",
];

/**
 * 解析本地 helper 产物目录；不存在则返回 undefined（构建静默跳过，等价上游开源行为）。
 */
export function resolveLocalCuaHelperRuntimeDir({ desktopPackageRoot } = {}) {
  const explicit = env.ZCODE_CUA_LOCAL_HELPER_DIR?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) {
      throw new Error("[local-cua-helper] ZCODE_CUA_LOCAL_HELPER_DIR must be an absolute path");
    }
    return isLocalHelperRuntimeRoot(explicit) ? explicit : undefined;
  }
  const defaultRoot = resolve(desktopPackageRoot, "local-cua-helper");
  return isLocalHelperRuntimeRoot(defaultRoot) ? defaultRoot : undefined;
}

function isLocalHelperRuntimeRoot(root) {
  return existsSync(join(root, RUNTIME_MANIFEST));
}

export function isLocalCuaHelperRuntimeAvailable(options) {
  return resolveLocalCuaHelperRuntimeDir(options) !== undefined;
}

function describeManifestViolation(manifest, expected) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return "manifest is not an object";
  }
  if (!MANIFEST_KEYS.every((key) => key in manifest) || MANIFEST_KEYS.length !== Object.keys(manifest).length) {
    return `manifest keys must be exactly ${MANIFEST_KEYS.join(", ")}`;
  }
  if (manifest.schemaVersion !== 1) return "schemaVersion must be 1";
  if (manifest.packageName !== EXPECTED_PACKAGE_NAME) {
    return `packageName must be ${EXPECTED_PACKAGE_NAME}`;
  }
  if (manifest.platform !== "win32") return "platform must be win32";
  if (manifest.arch !== expected.arch) {
    return `manifest arch ${manifest.arch} does not match build arch ${expected.arch}`;
  }
  if (manifest.electronVersion !== expected.electronVersion) {
    return `manifest electronVersion ${manifest.electronVersion} does not match build electron ${expected.electronVersion}; the native addon ABI would not load`;
  }
  if (typeof manifest.entry !== "string" || manifest.entry.length === 0) return "entry is invalid";
  if (typeof manifest.addon !== "string" || manifest.addon.length === 0) return "addon is invalid";
  if (manifest.entry === manifest.addon) return "entry and addon must differ";
  for (const key of ["entry", "addon"]) {
    const hash = manifest.sha256?.[key];
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/u.test(hash)) {
      return `sha256.${key} is not a lowercase sha256 hex digest`;
    }
  }
  return null;
}

async function assertRegularFile(root, relativePath, label) {
  const absolutePath = join(root, relativePath);
  const stats = await lstat(absolutePath).catch(
    () => {
      throw new Error(`[local-cua-helper] ${label} "${relativePath}" is missing under ${root}`);
    },
  );
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`[local-cua-helper] ${label} "${relativePath}" must be a regular file`);
  }
  return absolutePath;
}

/**
 * 校验并整体复制到 bundled-tools/<win32-arch>/cua-helper。任何校验失败直接抛错
 * （宁可构建失败也不打进一个运行时必挂的 helper）；目录未配置时返回 skipped。
 */
export async function stageLocalCuaHelperRuntime({
  desktopPackageRoot,
  outputRoot,
  targetPlatform,
  electronVersion,
}) {
  const sourceRoot = resolveLocalCuaHelperRuntimeDir({ desktopPackageRoot });
  if (!sourceRoot) {
    return { status: "skipped", reason: "local-cua-helper-runtime-not-present" };
  }
  if (targetPlatform?.os !== "win32") {
    return { status: "skipped", reason: "unsupported-platform" };
  }
  const expected = {
    arch: targetPlatform.arch,
    electronVersion: electronVersion?.trim(),
  };
  if (!expected.electronVersion) {
    throw new Error("[local-cua-helper] electronVersion is required");
  }

  const manifest = JSON.parse(await readFile(join(sourceRoot, RUNTIME_MANIFEST), "utf8"));
  const violation = describeManifestViolation(manifest, expected);
  if (violation) {
    throw new Error(`[local-cua-helper] ${RUNTIME_MANIFEST} in ${sourceRoot}: ${violation}`);
  }

  const artifactHashes = {};
  for (const label of ["entry", "addon"]) {
    const absolutePath = await assertRegularFile(sourceRoot, manifest[label], label);
    const bytes = await readFile(absolutePath);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== manifest.sha256[label]) {
      throw new Error(
        `[local-cua-helper] ${label} "${manifest[label]}" sha256 mismatch: manifest=${manifest.sha256[label]} actual=${actual}; the local copy is corrupt or mixed from different versions`,
      );
    }
    artifactHashes[label] = actual;
  }
  // module-type package.json（staged 产物的固定形态）必须随目录一起在，保证 entry 的
  // ESM 解析不依赖 detect-module；官方产物自带，缺了说明目录被裁剪过。
  await assertRegularFile(sourceRoot, "package.json", "package.json");

  const outputDir = resolve(outputRoot, `win32-${targetPlatform.arch}`, "cua-helper");
  await rm(outputDir, { recursive: true, force: true });
  await cp(sourceRoot, outputDir, {
    recursive: true,
    verbatimSymlinks: false,
    // node-repl-host-server.js 是同目录的另一个注入件（见 overlayNodeReplHostServer），
    // 不属于 helper 运行时，不能混进安装包的 tools/cua-helper。
    filter: (src) => !src.endsWith(NRH_SERVER_OVERRIDE_BASENAME),
  });

  const stagedFileCount = await countFiles(outputDir);
  console.log(
    `[prepare-local-cua-helper] staged ${manifest.packageVersion} ${manifest.platform}/${manifest.arch}` +
      ` entry=${artifactHashes.entry.slice(0, 12)}… addon=${artifactHashes.addon.slice(0, 12)}…` +
      ` files=${stagedFileCount} -> ${outputDir}`,
  );
  return { status: "staged", sourceRoot, outputDir, manifest };
}

async function countFiles(root) {
  let count = 0;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      count += await countFiles(join(root, entry.name));
    } else if (entry.isFile()) {
      count += 1;
    }
  }
  return count;
}

/**
 * 用官方编译产物覆盖 staged glm 的 node-repl-host/dist/mcp/server.js（真实 CUA 客户端）。
 * 必须在 prepare:agent-bundle 之后运行。守卫：文件须含 ensureStandaloneHelperLaunched
 * （只有真实客户端有）且 >4MB（占位版约 2MB），防止错拿占位或残缺副本。
 */
export function overlayNodeReplHostServer({ desktopPackageRoot, platformKey }) {
  const sourceRoot = resolveLocalCuaHelperRuntimeDir({ desktopPackageRoot });
  if (!sourceRoot) {
    return { status: "skipped", reason: "local-cua-helper-runtime-not-present" };
  }
  const source = join(sourceRoot, NRH_SERVER_OVERRIDE_BASENAME);
  if (!existsSync(source)) {
    return { status: "skipped", reason: "node-repl-host-server-override-not-present" };
  }
  if (statSync(source).size < 4 * 1024 * 1024) {
    throw new Error(
      `[local-cua-helper] ${source} is too small to be the official node-repl-host server bundle (>4MB expected)`,
    );
  }
  const target = resolve(
    desktopPackageRoot,
    "bundled-agents",
    platformKey,
    "glm",
    "packages",
    "node-repl-host",
    "dist",
    "mcp",
    "server.js",
  );
  if (!existsSync(target)) {
    throw new Error(
      `[local-cua-helper] staged node-repl-host server missing at ${target}; run prepare:agent-bundle first`,
    );
  }
  const contents = readFileSync(source, "utf8");
  if (!contents.includes("ensureStandaloneHelperLaunched")) {
    throw new Error(
      `[local-cua-helper] ${source} does not look like the official client bundle (missing ensureStandaloneHelperLaunched)`,
    );
  }
  copyFileSync(source, target);
  console.log(
    `[prepare-local-cua-helper] overlaid node-repl-host server (${(statSync(source).size / 1024 / 1024).toFixed(1)}MB) -> ${target}`,
  );
  return { status: "staged", source, target };
}
