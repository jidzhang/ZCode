import { describe, expect, it, vi } from "vitest";
import {
  TEXT_PROOFREAD_MAX_LENGTH_DELTA,
  TEXT_PROOFREAD_MIN_CHARS,
} from "../src/text-proofread/contract.js";
import {
  buildTextProofreadMessages,
  cleanProofreadOutput,
  isReasoningLevelRejectedError,
  runTextProofread,
  shouldProofreadText,
} from "../src/text-proofread/textProofread.js";

const selection = { providerId: "test-provider", modelId: "glm-test" };
const selectionWithLevel = {
  providerId: "test-provider",
  modelId: "glm-test",
  options: { reasoningLevel: "medium" },
};

describe("Text proofread", () => {
  it("少于 5 字（trim 后）不请求模型", async () => {
    const generate = vi.fn();
    await expect(runTextProofread({ text: "  你好  ", selection, generate })).resolves.toEqual({
      kind: "skipped",
    });
    expect(generate).not.toHaveBeenCalled();
    expect(shouldProofreadText("abcde")).toBe(true);
    expect(shouldProofreadText("abcd")).toBe(false);
    expect(shouldProofreadText("  abcd  ")).toBe(false);
    expect(TEXT_PROOFREAD_MIN_CHARS).toBe(5);
  });

  it("只喂 system prompt 与原文，不给会话上下文", () => {
    const messages = buildTextProofreadMessages("我想适和这个方案");
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]).toEqual({ role: "user", content: "我想适和这个方案" });
  });

  it("清洗输出包裹层：围栏、前缀标签、整体引号", () => {
    expect(cleanProofreadOutput("我想适合这个方案")).toBe("我想适合这个方案");
    expect(cleanProofreadOutput("```\n我想适合这个方案\n```")).toBe("我想适合这个方案");
    expect(cleanProofreadOutput("纠错：我想适合这个方案")).toBe("我想适合这个方案");
    expect(cleanProofreadOutput("“我想适合这个方案”")).toBe("我想适合这个方案");
  });

  it("正常纠错：替换正文并报告未换档", async () => {
    const generate = vi.fn(async () => ({
      text: "我想适合这个方案",
      finishReason: "stop",
    }));
    await expect(
      runTextProofread({ text: "我想适和这个方案", selection, generate }),
    ).resolves.toEqual({
      kind: "corrected",
      text: "我想适合这个方案",
      fallbackUsed: false,
    });
    expect(generate).toHaveBeenCalledWith({ selection });
  });

  it("结果与原文一致视为未发现明显错别字", async () => {
    const generate = vi.fn(async () => ({ text: "我想适合这个方案", finishReason: "stop" }));
    await expect(
      runTextProofread({ text: "我想适合这个方案", selection, generate }),
    ).resolves.toEqual({ kind: "unchanged" });
  });

  it("长度相差超过 10 字判为改写并丢弃", async () => {
    const original = "我想适合这个方案";
    const rewritten = "我觉得这个方案其实挺适合我们当前的情况的";
    expect(Math.abs(rewritten.length - original.length)).toBeGreaterThan(
      TEXT_PROOFREAD_MAX_LENGTH_DELTA,
    );
    const generate = vi.fn(async () => ({ text: rewritten, finishReason: "stop" }));
    await expect(runTextProofread({ text: original, selection, generate })).resolves.toEqual({
      kind: "discarded",
      reason: "length-delta",
    });
  });

  it("截断与空输出一律丢弃", async () => {
    await expect(
      runTextProofread({
        text: "我想适和这个方案",
        selection,
        generate: async () => ({ text: "我想适合", finishReason: "length" }),
      }),
    ).resolves.toEqual({ kind: "discarded", reason: "truncated" });
    await expect(
      runTextProofread({
        text: "我想适和这个方案",
        selection,
        generate: async () => ({ text: "   ", finishReason: "stop" }),
      }),
    ).resolves.toEqual({ kind: "discarded", reason: "empty" });
  });

  it("最低档被上游拒绝：改用会话档位重试一次并标记 fallbackUsed", async () => {
    const generate = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('模型 reasoning 档位 "disabled" 被上游拒绝，请在模型配置中删除该档位后再试。'),
      )
      .mockResolvedValueOnce({ text: "我想适合这个方案", finishReason: "stop" });
    const onReasoningFallback = vi.fn();

    await expect(
      runTextProofread({
        text: "我想适和这个方案",
        selection: selectionWithLevel,
        fallbackSelection: selectionWithLevel,
        generate,
        onReasoningFallback,
      }),
    ).resolves.toEqual({
      kind: "corrected",
      text: "我想适合这个方案",
      fallbackUsed: true,
    });
    expect(onReasoningFallback).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenNthCalledWith(1, { selection: selectionWithLevel });
    expect(generate).toHaveBeenNthCalledWith(2, {
      selection: selectionWithLevel,
      reasoningLevel: "medium",
    });
  });

  it("非档位错误不重试，原样抛出", async () => {
    const generate = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(
      runTextProofread({
        text: "我想适和这个方案",
        selection: selectionWithLevel,
        fallbackSelection: selectionWithLevel,
        generate,
      }),
    ).rejects.toThrow("network down");
    expect(generate).toHaveBeenCalledOnce();
  });

  it("会话没有档位时不重试（无可用兜底档）", async () => {
    const generate = vi.fn(async () => {
      throw new Error('模型 reasoning 档位 "disabled" 被上游拒绝');
    });
    await expect(
      runTextProofread({
        text: "我想适和这个方案",
        selection,
        fallbackSelection: selection,
        generate,
      }),
    ).rejects.toThrow("被上游拒绝");
    expect(generate).toHaveBeenCalledOnce();
  });

  it("识别档位拒绝错误的多种形态", () => {
    expect(
      isReasoningLevelRejectedError(new Error('模型 reasoning 档位 "disabled" 被上游拒绝')),
    ).toBe(true);
    expect(isReasoningLevelRejectedError(new Error("reasoning_effort not supported"))).toBe(true);
    expect(
      isReasoningLevelRejectedError(
        new Error("wrapper", { cause: new Error("thinking is unsupported") }),
      ),
    ).toBe(true);
    expect(isReasoningLevelRejectedError(new Error("network down"))).toBe(false);
  });
});
