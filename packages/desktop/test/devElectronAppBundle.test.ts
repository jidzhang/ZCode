import {
  mkdtemp,
  readFile,
  readlink,
  rm,
  mkdir,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEV_ELECTRON_APP_BUNDLE_ID,
  DEV_ELECTRON_APP_NAME,
  DEV_ELECTRON_PROTOCOL_SCHEME,
  DEV_ELECTRON_BUNDLE_FORMAT,
  patchDevElectronInfoPlist,
  prepareDevElectronAppBundle,
  resolveDevElectronAppBundlePath,
} from "../scripts/devElectronAppBundle.mjs";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("dev Electron app bundle", () => {
  it("adds a product identity and zcode URL scheme to the raw Electron plist", () => {
    const source = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>CFBundleDisplayName</key>
\t<string>Electron</string>
\t<key>CFBundleIdentifier</key>
\t<string>com.github.Electron</string>
\t<key>CFBundleName</key>
\t<string>Electron</string>
</dict>
</plist>
`;

    const patched = patchDevElectronInfoPlist(source);

    expect(patched).toContain(`<string>${DEV_ELECTRON_APP_NAME}</string>`);
    expect(patched).toContain(`<string>${DEV_ELECTRON_APP_BUNDLE_ID}</string>`);
    expect(patched).toContain("<key>CFBundleURLTypes</key>");
    expect(patched).toContain(`<string>${DEV_ELECTRON_PROTOCOL_SCHEME}</string>`);
    expect((patched.match(/<key>CFBundleURLTypes<\/key>/gu) ?? []).length).toBe(1);
  });

  it("derives a stable ignored bundle path per Electron version and architecture", () => {
    expect(
      resolveDevElectronAppBundlePath({
        runtimeRoot: "/tmp/zcode-runtime",
        electronVersion: "41.0.3",
        arch: "arm64",
      }),
    ).toBe("/tmp/zcode-runtime/41.0.3-arm64/ZCode Dev.app");
  });

  it("makes the macOS dev launcher use the prepared bundle executable", async () => {
    const devScript = await readFile(new URL("../scripts/dev.mjs", import.meta.url), "utf8");

    expect(devScript).toContain('process.platform === "darwin" && existsSync(electronBinary)');
    expect(devScript).toContain("prepareDevElectronAppBundle");
    expect(devScript).toContain("electronCommand = devBundle.executablePath");
  });

  it("copies the runtime and patches only the Dev bundle plist", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-dev-bundle-test-"));
    tempRoots.push(root);
    const sourceApp = join(root, "source", "Electron.app");
    const sourceContents = join(sourceApp, "Contents");
    await mkdir(sourceContents, { recursive: true });
    await writeFile(
      join(sourceContents, "Info.plist"),
      `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>Electron</string>
<key>CFBundleIdentifier</key><string>com.github.Electron</string>
<key>CFBundleName</key><string>Electron</string>
</dict></plist>\n`,
      "utf8",
    );
    const outputRoot = join(root, "runtime");

    const result = await prepareDevElectronAppBundle({
      electronAppPath: sourceApp,
      runtimeRoot: outputRoot,
      electronVersion: "41.0.3",
      arch: "arm64",
    });

    expect(result.appPath).toBe(`${outputRoot}/41.0.3-arm64/ZCode Dev.app`);
    expect(result.executablePath).toBe(
      `${outputRoot}/41.0.3-arm64/ZCode Dev.app/Contents/MacOS/Electron`,
    );
    const plist = await readFile(join(result.appPath, "Contents", "Info.plist"), "utf8");
    expect(plist).toContain("dev.zcode.app.development");
    expect(plist).toContain("<string>zcode</string>");
  });

  // Windows 普通用户无符号链接权限（需开发者模式），fs.symlink EPERM；覆盖由 CI Linux 承担。
  it.skipIf(process.platform === "win32")(
    "keeps framework symlinks relative so sandboxed helpers stay inside the bundle",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-dev-bundle-symlink-test-"));
      tempRoots.push(root);
      const sourceApp = join(root, "source", "Electron.app");
      const sourceContents = join(sourceApp, "Contents");
      const framework = join(sourceContents, "Frameworks", "Electron Framework.framework");
      const versionA = join(framework, "Versions", "A", "Resources");
      await mkdir(join(sourceContents, "MacOS"), { recursive: true });
      await mkdir(versionA, { recursive: true });
      await writeFile(
        join(sourceContents, "Info.plist"),
        `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>Electron</string>
<key>CFBundleIdentifier</key><string>com.github.Electron</string>
<key>CFBundleName</key><string>Electron</string>
</dict></plist>\n`,
        "utf8",
      );
      await writeFile(join(sourceContents, "MacOS", "Electron"), "source-v1", "utf8");
      await writeFile(join(versionA, "icudtl.dat"), "icu", "utf8");
      await symlink("A", join(framework, "Versions", "Current"));
      await symlink("Versions/Current/Resources", join(framework, "Resources"));

      const result = await prepareDevElectronAppBundle({
        electronAppPath: sourceApp,
        runtimeRoot: join(root, "runtime"),
        electronVersion: "41.0.3",
        arch: "arm64",
      });

      const copiedFramework = join(
        result.appPath,
        "Contents",
        "Frameworks",
        "Electron Framework.framework",
      );
      expect(await readlink(join(copiedFramework, "Versions", "Current"))).toBe("A");
      expect(await readlink(join(copiedFramework, "Resources"))).toBe("Versions/Current/Resources");
      expect(await readFile(join(copiedFramework, "Resources", "icudtl.dat"), "utf8")).toBe("icu");
    },
  );

  it("rebuilds a cached bundle whose stamp predates the current layout format", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-dev-bundle-format-test-"));
    tempRoots.push(root);
    const sourceApp = join(root, "source", "Electron.app");
    const sourceContents = join(sourceApp, "Contents");
    const sourceMacOS = join(sourceContents, "MacOS");
    await mkdir(sourceMacOS, { recursive: true });
    await writeFile(
      join(sourceContents, "Info.plist"),
      `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>Electron</string>
<key>CFBundleIdentifier</key><string>com.github.Electron</string>
<key>CFBundleName</key><string>Electron</string>
</dict></plist>\n`,
      "utf8",
    );
    await writeFile(join(sourceMacOS, "Electron"), "source-v1", "utf8");
    const outputRoot = join(root, "runtime");

    const first = await prepareDevElectronAppBundle({
      electronAppPath: sourceApp,
      runtimeRoot: outputRoot,
      electronVersion: "41.0.3",
      arch: "arm64",
    });
    const stampPath = join(outputRoot, "41.0.3-arm64", ".zcode-dev-electron-source.json");
    const stamp = JSON.parse(await readFile(stampPath, "utf8"));
    expect(stamp.format).toBe(DEV_ELECTRON_BUNDLE_FORMAT);
    // 模拟旧版脚本留下的缓存：没有 format 字段，源二进制指纹却仍然匹配。
    await writeFile(stampPath, JSON.stringify({ contentHash: stamp.contentHash }), "utf8");
    await writeFile(join(first.appPath, "Contents", "MacOS", "Electron"), "stale-copy", "utf8");

    await prepareDevElectronAppBundle({
      electronAppPath: sourceApp,
      runtimeRoot: outputRoot,
      electronVersion: "41.0.3",
      arch: "arm64",
    });

    expect(await readFile(join(first.appPath, "Contents", "MacOS", "Electron"), "utf8")).toBe(
      "source-v1",
    );
  });

  it("rebuilds the ignored bundle when the source Electron launcher changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-dev-bundle-refresh-test-"));
    tempRoots.push(root);
    const sourceApp = join(root, "source", "Electron.app");
    const sourceContents = join(sourceApp, "Contents");
    const sourceMacOS = join(sourceContents, "MacOS");
    await mkdir(sourceMacOS, { recursive: true });
    await writeFile(
      join(sourceContents, "Info.plist"),
      `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>Electron</string>
<key>CFBundleIdentifier</key><string>com.github.Electron</string>
<key>CFBundleName</key><string>Electron</string>
</dict></plist>\n`,
      "utf8",
    );
    await writeFile(join(sourceMacOS, "Electron"), "source-v1", "utf8");
    const outputRoot = join(root, "runtime");

    const first = await prepareDevElectronAppBundle({
      electronAppPath: sourceApp,
      runtimeRoot: outputRoot,
      electronVersion: "41.0.3",
      arch: "arm64",
    });
    await writeFile(join(sourceMacOS, "Electron"), "source-v2", "utf8");

    await prepareDevElectronAppBundle({
      electronAppPath: sourceApp,
      runtimeRoot: outputRoot,
      electronVersion: "41.0.3",
      arch: "arm64",
    });

    expect(await readFile(join(first.appPath, "Contents", "MacOS", "Electron"), "utf8")).toBe(
      "source-v2",
    );
  });

  it("rebuilds when a same-size source change lands in the same mtime tick", async () => {
    // Bugfix 回归（2026-10-17）：原指纹是 size+mtimeMs，"source-v1"→"source-v2" 这类
    // 同大小改动若两次写入落在同一 mtime 刻度，指纹不变、缓存判定为命中，dev 会一直用
    // 旧二进制。本机实测该碰撞约 10%。这里把 mtime 显式钉在同一刻度上，让该场景
    // 从"概率性逃过判定"变成确定性用例。
    const root = await mkdtemp(join(tmpdir(), "zcode-dev-bundle-same-tick-test-"));
    tempRoots.push(root);
    const sourceApp = join(root, "source", "Electron.app");
    const sourceContents = join(sourceApp, "Contents");
    const sourceMacOS = join(sourceContents, "MacOS");
    await mkdir(sourceMacOS, { recursive: true });
    await writeFile(
      join(sourceContents, "Info.plist"),
      `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>Electron</string>
<key>CFBundleIdentifier</key><string>com.github.Electron</string>
<key>CFBundleName</key><string>Electron</string>
</dict></plist>\n`,
      "utf8",
    );
    const sourceExecutable = join(sourceMacOS, "Electron");
    // 两次写入都钉在同一个 mtime 上：旧指纹（size+mtimeMs）在改动前后完全相同，
    // 必然误判为"未变化"；内容哈希指纹则必须发现这次改动。
    const pinned = new Date();
    await writeFile(sourceExecutable, "source-v1", "utf8");
    await utimes(sourceExecutable, pinned, pinned);
    const outputRoot = join(root, "runtime");
    const beforeSize = (await stat(sourceExecutable)).size;

    const first = await prepareDevElectronAppBundle({
      electronAppPath: sourceApp,
      runtimeRoot: outputRoot,
      electronVersion: "41.0.3",
      arch: "arm64",
    });
    await writeFile(sourceExecutable, "source-v2", "utf8");
    await utimes(sourceExecutable, pinned, pinned);
    expect((await stat(sourceExecutable)).size).toBe(beforeSize);

    await prepareDevElectronAppBundle({
      electronAppPath: sourceApp,
      runtimeRoot: outputRoot,
      electronVersion: "41.0.3",
      arch: "arm64",
    });

    expect(await readFile(join(first.appPath, "Contents", "MacOS", "Electron"), "utf8")).toBe(
      "source-v2",
    );
  });

  it("reuses the ignored bundle when the source Electron launcher is unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-dev-bundle-reuse-test-"));
    tempRoots.push(root);
    const sourceApp = join(root, "source", "Electron.app");
    const sourceContents = join(sourceApp, "Contents");
    const sourceMacOS = join(sourceContents, "MacOS");
    await mkdir(sourceMacOS, { recursive: true });
    await writeFile(
      join(sourceContents, "Info.plist"),
      `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>Electron</string>
<key>CFBundleIdentifier</key><string>com.github.Electron</string>
<key>CFBundleName</key><string>Electron</string>
</dict></plist>\n`,
      "utf8",
    );
    await writeFile(join(sourceMacOS, "Electron"), "source-v1", "utf8");
    const outputRoot = join(root, "runtime");

    const first = await prepareDevElectronAppBundle({
      electronAppPath: sourceApp,
      runtimeRoot: outputRoot,
      electronVersion: "41.0.3",
      arch: "arm64",
    });
    // 重建会先 rm 整个 bundle 目录；用一个标记文件证明第二次确实走了缓存命中。
    const marker = join(first.appPath, "Contents", "cache-witness");
    await writeFile(marker, "kept", "utf8");

    await prepareDevElectronAppBundle({
      electronAppPath: sourceApp,
      runtimeRoot: outputRoot,
      electronVersion: "41.0.3",
      arch: "arm64",
    });

    expect(await readFile(marker, "utf8")).toBe("kept");
  });
});
