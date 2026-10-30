import { describe, expect, it, vi } from "vitest";

import { textProofreadModule } from "./module.js";
import { textProofread } from "./textProofread.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("text-proofread contract", () => {
  it("declares its module manifest", () => {
    expect(textProofreadModule.id).toBe("text-proofread");
  });

  it("低于最小字数不发请求", async () => {
    const generate = vi.fn();
    expect(textProofread.isBelowMinimum("abcd")).toBe(true);
    await expect(
      textProofread.proofread({
        text: "abcd",
        selection: { providerId: "p", modelId: "m" },
        generate,
      }),
    ).resolves.toEqual({ kind: "skipped" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("corrected 才携带可回填正文", async () => {
    const outcome = await textProofread.proofread({
      text: "我想适和这个方案",
      selection: { providerId: "p", modelId: "m" },
      generate: async () => ({ text: "我想适合这个方案", finishReason: "stop" }),
    });
    expect(outcome.kind).toBe("corrected");
    if (outcome.kind === "corrected") {
      expect(outcome.text).toBe("我想适合这个方案");
      expect(outcome.fallbackUsed).toBe(false);
    }
  });
});
