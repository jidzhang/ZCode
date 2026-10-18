import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { dirname, posix } from "node:path";

export const DEV_ELECTRON_PROTOCOL_SCHEME = "zcode";
export const DEV_ELECTRON_APP_NAME = "ZCode Dev";
export const DEV_ELECTRON_APP_BUNDLE_ID = "dev.zcode.app.development";
// 副本布局版本，见 prepareDevElectronAppBundle 中的指纹说明。
export const DEV_ELECTRON_BUNDLE_FORMAT = 2;

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
}

function replacePlistString(plist, key, value) {
  const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`, "u");
  if (!pattern.test(plist)) {
    throw new Error(`Dev Electron Info.plist is missing ${key}`);
  }
  return plist.replace(
    pattern,
    (_match, prefix, suffix) => `${prefix}${escapeXml(value)}${suffix}`,
  );
}

function appendProtocolDeclaration(plist) {
  if (plist.includes(`<string>${DEV_ELECTRON_PROTOCOL_SCHEME}</string>`)) {
    return plist;
  }

  const closingDictIndex = plist.lastIndexOf("</dict>");
  if (closingDictIndex < 0) {
    throw new Error("Dev Electron Info.plist is missing its root dict");
  }

  const protocolDeclaration = `\n\t<key>CFBundleURLTypes</key>\n\t<array>\n\t\t<dict>\n\t\t\t<key>CFBundleURLName</key>\n\t\t\t<string>${DEV_ELECTRON_APP_NAME}</string>\n\t\t\t<key>CFBundleURLSchemes</key>\n\t\t\t<array>\n\t\t\t\t<string>${DEV_ELECTRON_PROTOCOL_SCHEME}</string>\n\t\t\t</array>\n\t\t</dict>\n\t</array>\n`;
  return `${plist.slice(0, closingDictIndex)}${protocolDeclaration}${plist.slice(closingDictIndex)}`;
}

/**
 * 为 macOS 本地 Dev runtime 写入产品身份和 zcode URL scheme。
 * raw Electron 的 Info.plist 没有 CFBundleURLTypes，系统只能把 zcode 交给
 * com.github.Electron；这里仅修改启动副本，避免污染 node_modules 中的 Electron。
 */
export function patchDevElectronInfoPlist(plist) {
  let patched = replacePlistString(plist, "CFBundleDisplayName", DEV_ELECTRON_APP_NAME);
  patched = replacePlistString(patched, "CFBundleIdentifier", DEV_ELECTRON_APP_BUNDLE_ID);
  patched = replacePlistString(patched, "CFBundleName", DEV_ELECTRON_APP_NAME);
  return appendProtocolDeclaration(patched);
}

export function resolveDevElectronAppBundlePath({ runtimeRoot, electronVersion, arch }) {
  return posix.join(runtimeRoot, `${electronVersion}-${arch}`, `${DEV_ELECTRON_APP_NAME}.app`);
}

/** 流式计算文件内容哈希：源二进制 ~200MB，整份读进内存会白白抬高峰值占用。 */
async function hashFileContent(filePath) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

export async function prepareDevElectronAppBundle({
  electronAppPath,
  runtimeRoot,
  electronVersion,
  arch,
}) {
  const appPath = resolveDevElectronAppBundlePath({ runtimeRoot, electronVersion, arch });
  const infoPlistPath = posix.join(appPath, "Contents", "Info.plist");
  const sourceExecutablePath = posix.join(electronAppPath, "Contents", "MacOS", "Electron");
  const existingExecutablePath = posix.join(appPath, "Contents", "MacOS", "Electron");
  // 源二进制的身份指纹，写在 .app 外面：放进 Contents 会污染 bundle 结构。
  const sourceStampPath = posix.join(dirname(appPath), ".zcode-dev-electron-source.json");
  // 指纹是源二进制的**内容哈希**。
  //
  // Bugfix（2026-10-17 实测）：原指纹是 size+mtimeMs。同大小的改动（例如重新解压同一
  // 版本 Electron）落在同一 mtime 刻度时指纹完全相同，缓存会一直复用旧副本 ——
  // 本机实测约 10% 的碰撞率，dev 启动会拿到过期的二进制且没有任何提示。mtimeNs 也
  // 救不了：该文件系统上连续两次写入仍有 84% 落在同一纳秒刻度。内容哈希与时钟无关，
  // 内容变了必然不等。size 是同一份字节的派生值，跟着哈希走，单独存没有判定意义。
  //
  // 这里哈希的是**源**文件，与 stamp 里的值比对；源正在被写时可能读到撕裂内容，
  // 但那只会让下次判定为"需要重拷"，绝不会把旧副本当成新的。
  // 代价是每次 dev 启动多约 0.8s 读盘（页缓存热），换来的是正确的缓存判定；哈希不提前
  // await，重拷路径上与 rm/cp 并行读同一页缓存，串行等待只发生在缓存命中路径。
  //
  // format 字段记录副本的布局版本：布局修复（例如符号链接策略变更）时递增，
  // 让已存在的旧副本在源二进制没变的情况下也能被判定为需要重拷。
  // AV/索引器持锁、npm 重解压替换文件都可能让 open/read 瞬时失败。哈希失败按"无指纹"
  // 处理，落到下方 needsCopy=true 的重拷兜底；不能让一次瞬时读失败打断整个 dev 启动
  // （旧 size+mtime 指纹只 stat、从不读内容，没有这个失败面）。
  const sourceHashPromise = hashFileContent(sourceExecutablePath).catch(() => undefined);
  let needsCopy = true;
  try {
    const existingInfoPlist = await readFile(infoPlistPath, "utf8");
    await access(existingExecutablePath);
    const existingStamp = await readFile(sourceStampPath, "utf8");
    const contentHash = await sourceHashPromise;
    const sourceStamp = contentHash
      ? JSON.stringify({ format: DEV_ELECTRON_BUNDLE_FORMAT, contentHash })
      : undefined;
    needsCopy =
      !existingInfoPlist.includes(`<string>${DEV_ELECTRON_APP_BUNDLE_ID}</string>`) ||
      !existingInfoPlist.includes(`<string>${DEV_ELECTRON_PROTOCOL_SCHEME}</string>`) ||
      sourceStamp === undefined ||
      existingStamp !== sourceStamp;
  } catch {
    // 目录不存在、来源不是本工具生成的 bundle，下面走一次完整复制。
  }

  if (needsCopy) {
    // 只删除本次生成的 ignored runtime 目录，绝不触碰 node_modules 或用户数据。
    await rm(appPath, { recursive: true, force: true });
    await rm(sourceStampPath, { force: true });
    await mkdir(dirname(appPath), { recursive: true });
    // verbatimSymlinks 必须开：Electron Framework.framework 内部靠相对符号链接
    // （Resources -> Versions/Current/Resources、Current -> A）组织。fs.cp 默认会把
    // 相对链接改写成指向 node_modules 的绝对路径，主进程仍能读到，但 GPU / network
    // 等 macOS 沙箱子进程只允许读本 bundle 目录，顺链接出去会被拦，表现为
    // "icudtl.dat not found in bundle" 然后 "GPU process isn't usable. Goodbye."。
    await cp(electronAppPath, appPath, { recursive: true, verbatimSymlinks: true });
    const patchedInfoPlist = patchDevElectronInfoPlist(await readFile(infoPlistPath, "utf8"));
    await writeFile(infoPlistPath, patchedInfoPlist, "utf8");
    // 指纹最后写：中途失败时下次仍会判定为需要重拷，不会留下半成品缓存。
    const contentHash = await sourceHashPromise;
    if (contentHash !== undefined)
      await writeFile(
        sourceStampPath,
        JSON.stringify({ format: DEV_ELECTRON_BUNDLE_FORMAT, contentHash }),
        "utf8",
      );
  }

  return {
    appPath,
    executablePath: posix.join(appPath, "Contents", "MacOS", "Electron"),
  };
}
