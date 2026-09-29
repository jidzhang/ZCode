#!/usr/bin/env node
import { loadEndpointEnv } from "./load-endpoint-env.mjs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import {
  copyRuntimeNodeModules,
  patchNodePtyPrebuilds,
  stageTuiRuntime,
} from "./zcode-distribution/assets.mjs";
import { installScriptSource } from "./zcode-distribution/installer.mjs";

const root = resolve(import.meta.dirname, "..");
const defaultOutDir = resolve(root, "dist", "zcode");
const defaultBaseUrl = (await loadEndpointEnv()).ZCODE_DIST_BASE_URL?.trim() || "";
const packageDirName = "zcode";
const usage = `Usage:
  pnpm build:zcode
  node scripts/build-zcode.mjs --skip-build
  node scripts/build-zcode.mjs --version 3.3.3-dev.1
  node scripts/build-zcode.mjs --out-dir dist/zcode
  node scripts/build-zcode.mjs --base-url http://host/zcode/deps/zcode/

Options:
  --skip-build        Reuse existing web/server/agent build outputs.
  --version <text>    Release version. Defaults to root package.json version.
  --out-dir <path>    Output directory. Defaults to dist/zcode.
  --base-url <url>    Default install.sh download base URL.
  --help, -h          Show this help.
`;

function readArgValue(argv, arg, index) {
  if (arg.includes("=")) {
    return {
      nextIndex: index,
      value: arg.slice(arg.indexOf("=") + 1),
    };
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${arg}`);
  }
  return {
    nextIndex: index + 1,
    value,
  };
}

function parseArgs(argv) {
  const options = {
    baseUrl: defaultBaseUrl,
    help: false,
    outDir: defaultOutDir,
    skipBuild: false,
    version: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--skip-build") {
      options.skipBuild = true;
      continue;
    }
    if (arg === "--version" || arg.startsWith("--version=")) {
      const { nextIndex, value } = readArgValue(argv, arg, index);
      options.version = value;
      index = nextIndex;
      continue;
    }
    if (arg === "--out-dir" || arg.startsWith("--out-dir=")) {
      const { nextIndex, value } = readArgValue(argv, arg, index);
      options.outDir = resolve(root, value);
      index = nextIndex;
      continue;
    }
    if (arg === "--base-url" || arg.startsWith("--base-url=")) {
      const { nextIndex, value } = readArgValue(argv, arg, index);
      options.baseUrl = value.endsWith("/") ? value : `${value}/`;
      index = nextIndex;
      continue;
    }
    throw new Error(`Unknown option "${arg}". Run with --help for usage.`);
  }

  return options;
}

function commandText(command, args) {
  return [command, ...args].join(" ");
}

function run(command, args, options = {}) {
  console.log(`[zcode] ${commandText(command, args)}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    // Windows 下 spawnSync 不带 shell 无法解析 pnpm.CMD（CreateProcess 只认可执行映像，
    // 新版 Node 对 .cmd/.bat 直接 EINVAL）。参数均为无空格的简单 token，shell 合并是安全的。
    ...(process.platform === "win32" ? { shell: true } : {}),
    ...options,
  });
  if (result.error) {
    throw new Error(`${commandText(command, args)} failed: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new Error(`${commandText(command, args)} failed`);
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function sha256File(file) {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
}

async function assertFile(file, label) {
  const fileStat = await stat(file).catch(() => null);
  if (!fileStat?.isFile()) {
    throw new Error(`Missing ${label}: ${file}`);
  }
}

async function assertDirectory(directory, label) {
  const directoryStat = await stat(directory).catch(() => null);
  if (!directoryStat?.isDirectory()) {
    throw new Error(`Missing ${label}: ${directory}`);
  }
}

async function buildOutputs(skipBuild) {
  if (skipBuild) {
    console.log("[zcode] skipping build; reusing existing outputs");
    return;
  }

  run("pnpm", ["--filter", "@zcode/cli...", "build"]);
  await rm(resolve(root, "packages", "server", "dist"), {
    force: true,
    recursive: true,
  });
  run("pnpm", ["--filter", "@zcode/server", "build"]);
  run("pnpm", ["--filter", "@zcode/web", "build"]);
}

async function stageZCodePackage({ packageRoot, version }) {
  const webDist = resolve(root, "packages", "web", "dist");
  const serverDist = resolve(root, "packages", "server", "dist");
  const agentBundle = resolve(root, "apps", "zcode-cli", "packages", "cli", "dist", "zcode.cjs");
  const agentProvider = resolve(root, "apps/zcode-cli/packages/cli/dist/provider");

  await assertDirectory(webDist, "web dist");
  await assertDirectory(serverDist, "server dist");
  await assertFile(resolve(serverDist, "entry-http.js"), "server HTTP entry");
  await assertFile(agentBundle, "agent app-server bundle");
  await assertFile(resolve(agentProvider, "zcode-builtin.json"), "Agent provider config");

  await rm(packageRoot, {
    force: true,
    recursive: true,
  });
  await mkdir(packageRoot, {
    recursive: true,
  });

  await cp(webDist, resolve(packageRoot, "web"), {
    recursive: true,
  });
  await cp(serverDist, resolve(packageRoot, "server"), {
    recursive: true,
  });
  await mkdir(resolve(packageRoot, "agent"), {
    recursive: true,
  });
  await cp(agentBundle, resolve(packageRoot, "agent", "zcode.cjs"));
  // TUI 入口通过真正的 CLI 路径定位伴随配置；只复制 JS 会在仓库外启动失败。
  await cp(agentProvider, resolve(packageRoot, "agent/provider"), { recursive: true });
  await cp(
    resolve(root, "apps/zcode-cli/packages/cli/dist/THIRD-PARTY-NOTICES.md"),
    resolve(packageRoot, "agent/THIRD-PARTY-NOTICES.md"),
  );
  await chmod(resolve(packageRoot, "agent", "zcode.cjs"), 0o755);

  // 本地 fork 加固：vite "hidden" sourcemap 仍会把 .map 文件本体（含 sourcesContent
  // 源码全文）写进 web 产物并随包发布。"hidden" 只是不写 sourceMappingURL 引用，
  // 防不了拿到安装包的人解包直读。这里只删 .map，JS/CSS 资产全部保留；
  // node_modules 里第三方库自带的 map 不在 web/assets 下，不受影响。
  const webAssetsDir = resolve(packageRoot, "web", "assets");
  if (existsSync(webAssetsDir)) {
    for (const entry of await readdir(webAssetsDir)) {
      if (entry.endsWith(".map")) {
        await rm(resolve(webAssetsDir, entry), { force: true });
      }
    }
  }


  await stageTuiRuntime(packageRoot);
  await copyRuntimeNodeModules(packageRoot);
  await patchNodePtyPrebuilds(packageRoot);

  await mkdir(resolve(packageRoot, "bin"), {
    recursive: true,
  });
  const runner = resolve(packageRoot, "bin", "zcode.mjs");
  await cp(resolve(root, "scripts/zcode-distribution/runner.mjs"), runner);
  await chmod(runner, 0o755);

  await writeFile(
    resolve(packageRoot, "package.json"),
    JSON.stringify(
      {
        name: "zcode-runtime",
        private: true,
        type: "module",
        version,
      },
      null,
      2,
    ),
  );
}

async function createTarball({ packageParent, releaseDir, tarballName }) {
  await mkdir(releaseDir, {
    recursive: true,
  });
  const tarball = resolve(releaseDir, tarballName);
  await rm(tarball, {
    force: true,
  });
  // GNU tar 把 "D:\..." 的盘符冒号解释成远程主机名（rsh 协议），Windows 必须加
  // --force-local 关闭该解释，否则打包在 Windows 上必然失败（上游仅 macOS/Linux 开发）。
  // Windows System32 自带 bsdtar 不认 --force-local（且无此问题），所以按 tar 实现自适应：
  // 优先用 GNU tar（Git for Windows 自带），找不到再用系统 tar 裸参数。
  let tarArgs = ["-czf", tarball, "-C", packageParent, packageDirName];
  let tarBin = "tar";
  let tarOptions = {};
  if (process.platform === "win32") {
    const gitUsrBin = "C:/Program Files/Git/usr/bin";
    if (existsSync(`${gitUsrBin}/tar.exe`)) {
      // 三个坑一次说清：
      // 1. run() 在 Windows 走 shell:true，路径含空格必须自带引号；
      // 2. GNU tar 需要 --force-local 处理盘符冒号（bsdtar 不认也不用）；
      // 3. GNU tar 的 -z 会调外部 gzip，按 PATH 查找——从 cmd 启动时
      //    PATH 里没有 Git 的 usr/bin，gzip 找不到导致 Broken pipe，
      //    所以把 Git 的 usr/bin 前置到子进程 PATH。
      tarBin = `"${gitUsrBin}/tar.exe"`;
      tarArgs = ["--force-local", ...tarArgs];
      tarOptions.env = { ...process.env, PATH: `${gitUsrBin};${process.env.PATH}` };
    }
  }
  run(tarBin, tarArgs, tarOptions);
  return tarball;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.help && !options.baseUrl)
    throw new Error("Configure ZCODE_DIST_BASE_URL in .env or pass --base-url");
  if (options.help) {
    console.log(usage);
    return;
  }

  const rootPackageJson = await readJson(resolve(root, "package.json"));
  const version = options.version ?? rootPackageJson.version;
  if (!version || typeof version !== "string") {
    throw new Error("Unable to resolve ZCode version.");
  }

  await buildOutputs(options.skipBuild);

  const outDir = options.outDir;
  const workDir = resolve(outDir, ".work");
  const packageParent = workDir;
  const packageRoot = resolve(packageParent, packageDirName);
  const releaseDir = resolve(outDir, "releases", version);
  const tarballName = `${packageDirName}-${version}.tar.gz`;

  await rm(workDir, {
    force: true,
    recursive: true,
  });
  await stageZCodePackage({
    packageRoot,
    version,
  });
  const tarball = await createTarball({
    packageParent,
    releaseDir,
    tarballName,
  });
  const sha256 = await sha256File(tarball);
  await writeFile(resolve(releaseDir, "sha256.txt"), `${sha256}  ${tarballName}\n`);

  await writeFile(
    resolve(outDir, "latest.json"),
    JSON.stringify(
      {
        baseUrl: options.baseUrl,
        createdAt: new Date().toISOString(),
        name: "zcode",
        sha256,
        tarball: tarballName,
        version,
      },
      null,
      2,
    ),
  );
  const installScript = resolve(outDir, "install.sh");
  await writeFile(installScript, installScriptSource(options.baseUrl));
  await chmod(installScript, 0o755);
  await rm(workDir, {
    force: true,
    recursive: true,
  });

  console.log(`[zcode] release directory: ${outDir}`);
  console.log(`[zcode] tarball: ${tarball}`);
  console.log(`[zcode] sha256: ${sha256}`);
}

await main();
