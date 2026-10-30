import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { materializeZCodeBuiltinProviderConfig } from "../src/index.js";
import * as persistence from "@zcode/shared/node";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function environmentRoot() {
  const root = await mkdtemp(join(tmpdir(), "todo104-bundled-"));
  roots.push(root);
  return root;
}
function release(revision: number) {
  return JSON.stringify({
    schemaVersion: 1,
    revision,
    config: {
      providerConfigRules: { providerRules: [], templateRules: [] },
      modelConfigRules: {
        modelRules: [],
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [],
        builtinProviderModelRules: [],
      },
    },
  });
}

it("同内容并发启动复用固定资源且不改写文件", async () => {
  const environmentConfigRoot = await environmentRoot();
  const options = { environmentConfigRoot, content: release(1) };
  const file = await materializeZCodeBuiltinProviderConfig(options);
  const before = await stat(file, { bigint: true });
  expect(
    await Promise.all(
      Array.from({ length: 8 }, () => materializeZCodeBuiltinProviderConfig(options)),
    ),
  ).toEqual(Array(8).fill(file));
  expect((await stat(file, { bigint: true })).mtimeNs).toBe(before.mtimeNs);
  expect(await readdir(dirname(file))).toEqual(["zcode-builtin.json"]);
});

it("替换期间并发读取只见完整旧版或新版，不产生 hash 历史文件", async () => {
  const environmentConfigRoot = await environmentRoot();
  const file = await materializeZCodeBuiltinProviderConfig({
    environmentConfigRoot,
    content: release(1),
  });
  // 读者跑独立进程：生产读者（desktop main / CLI）本就是另一个进程，而 Windows 上
  // rename 覆盖"正被打开的句柄"直接 EPERM（实测：并发读循环下 200 次替换失败 147 次）。
  // 同事件循环的读者会与 writer 重试相位锁定——Node 定时器在 Windows 按约 15.6ms
  // 量化，读者周期与任何重试间隔落在同一刻度：实测 1/5/10/50ms 让出与 2~6400ms
  // 重试表全部连续撞上打开窗口，而暂停读者后同一 rename 立即成功。跨进程读者没有
  // 这条锁，重试按正常概率收敛。
  const reader = spawn(
    process.execPath,
    [
      "-e",
      `const { readFile } = require("node:fs/promises");
       const path = process.argv[1];
       (async () => {
         for (;;) {
           let parsed;
           try {
             parsed = JSON.parse(await readFile(path, "utf8"));
           } catch (error) {
             console.error("torn read: " + (error && error.message));
             process.exit(2);
           }
           if (parsed.revision !== 1 && parsed.revision !== 2) {
             console.error("unexpected revision " + parsed.revision);
             process.exit(3);
           }
           await new Promise((resolve) => setTimeout(resolve, 5));
         }
       })();`,
      file,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let readerStderr = "";
  reader.stderr.setEncoding("utf8");
  reader.stderr.on("data", (chunk: string) => {
    readerStderr += chunk;
  });
  const readerExit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    reader.on("close", (code, signal) => resolve({ code, signal }));
  });
  try {
    for (let index = 0; index < 200; index++) {
      await materializeZCodeBuiltinProviderConfig({
        environmentConfigRoot,
        content: release((index % 2) + 1),
      });
    }
  } finally {
    reader.kill();
  }
  const exit = await readerExit;
  // 收尾 kill 的退出形态随平台/Node 版本不同（实测 Windows 报 signal=SIGTERM、
  // code=null）；读者自行退出只可能是撕裂读(2)或越界值(3)，两者都写 stderr。
  expect(readerStderr).toBe("");
  expect(exit.code === null || exit.code === 1).toBe(true);
  expect(await readdir(dirname(file))).toEqual(["zcode-builtin.json"]);
});

it("资源校验或原子写入失败时保留旧内容，错误向调用方报告", async () => {
  const environmentConfigRoot = await environmentRoot();
  const file = await materializeZCodeBuiltinProviderConfig({
    environmentConfigRoot,
    content: release(1),
  });
  const before = await readFile(file, "utf8");
  await expect(
    materializeZCodeBuiltinProviderConfig({ environmentConfigRoot, content: "{}" }),
  ).rejects.toThrow();
  vi.spyOn(persistence, "atomicWritePrivateTextFile").mockRejectedValueOnce(
    new Error("fixture write failure"),
  );
  await expect(
    materializeZCodeBuiltinProviderConfig({ environmentConfigRoot, content: release(2) }),
  ).rejects.toThrow("fixture write failure");
  expect(await readFile(file, "utf8")).toBe(before);
  expect(await readdir(dirname(file))).toEqual(["zcode-builtin.json"]);
});
