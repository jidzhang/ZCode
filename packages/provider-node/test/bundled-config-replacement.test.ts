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
  let finished = false;
  const writer = (async () => {
    try {
      // 写次数放大到 200：读者让出间隙后仍能在替换期间取得大量样本。
      for (let index = 0; index < 200; index++) {
        await materializeZCodeBuiltinProviderConfig({
          environmentConfigRoot,
          content: release((index % 2) + 1),
        });
      }
    } finally {
      finished = true;
    }
  })();
  // Windows 上 rename 覆盖"正被打开的句柄"直接 EPERM（实测：无退避的并发读循环
  // 200 次替换失败 147 次；3 个忙循环读者时 160 次密集重试仍耗尽）。因此读者不能
  // 空转——空转会把目标文件占满整个时间窗，任何重试策略都赢不了，测的就不是原子
  // 替换语义而是平台共享标志。生产读者是事件驱动的短读，这里每次读后让出 1ms，
  // 既保留"替换期间并发读只见完整旧版或新版"的断言，又不制造不可能满足的争用。
  const reader = (async () => {
    do {
      const fileContent = JSON.parse(await readFile(file, "utf8"));
      expect([1, 2]).toContain(fileContent.revision);
      expect(fileContent).toEqual(JSON.parse(release(fileContent.revision)));
      await new Promise((resolve) => setTimeout(resolve, 1));
    } while (!finished);
  })();
  await Promise.all([writer, reader]);
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
