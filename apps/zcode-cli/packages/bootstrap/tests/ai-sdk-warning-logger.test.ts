import { afterEach, describe, expect, it } from "vitest";
import type { Logger } from "@zcode/contracts";
import {
  installZCodeProtocolAiSdkWarningLogger,
  redactText,
} from "../src/zcode-protocol/ai-sdk-warning-logger.js";

type AiSdkWarningGlobal = typeof globalThis & {
  AI_SDK_LOG_WARNINGS?: unknown;
};

function captureWarnings() {
  const entries: { message: string; context: Record<string, unknown> }[] = [];
  const logger = {
    warn: (message: string, context?: Record<string, unknown>) => {
      entries.push({ message, context: context ?? {} });
    },
  } as unknown as Logger;
  installZCodeProtocolAiSdkWarningLogger(logger);
  const emit = (options: {
    model?: unknown;
    provider?: unknown;
    warnings?: unknown;
  }): void => {
    const warningLogger = (globalThis as AiSdkWarningGlobal).AI_SDK_LOG_WARNINGS;
    if (typeof warningLogger !== "function") {
      throw new Error("warning logger was not installed");
    }
    (warningLogger as (value: unknown) => void)(options);
  };
  return { entries, emit };
}

const originalWarningLogger = (globalThis as AiSdkWarningGlobal).AI_SDK_LOG_WARNINGS;

afterEach(() => {
  (globalThis as AiSdkWarningGlobal).AI_SDK_LOG_WARNINGS = originalWarningLogger;
});

describe("AI SDK warning log redaction", () => {
  it("elides embedded reasoning payloads and keeps only their size", () => {
    const reasoningText = "secret-chain-of-thought-".repeat(500);
    const { entries, emit } = captureWarnings();

    emit({
      model: "deepseek-v4.1-flash",
      provider: "openai.responses",
      warnings: [
        {
          type: "other",
          message: `Non-OpenAI reasoning parts are not supported. Skipping reasoning part: {"type":"reasoning","text":"${reasoningText}","providerOptions":{"anthropic":{"signature":"abc123"}}}`,
        },
      ],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.message).toBe("AI SDK model warning");
    expect(entries[0]?.context).toMatchObject({
      event: "model.sdk.warning",
      model: "deepseek-v4.1-flash",
      provider: "openai.responses",
      warningCount: 1,
    });

    const serialized = JSON.stringify(entries[0]?.context);
    // 正文与签名都不得出现在日志里
    expect(serialized).not.toContain("secret-chain-of-thought");
    expect(serialized).not.toContain("abc123");
    expect(serialized).toContain("__elided__");

    const warnings = entries[0]?.context.warnings as Record<string, unknown>[];
    expect(warnings[0]?.type).toBe("other");
    const message = warnings[0]?.message as string;
    expect(message.startsWith("Non-OpenAI reasoning parts are not supported.")).toBe(true);
    expect(message.length).toBeLessThan(200);
    const elided = JSON.parse(
      (message.match(/\{"__elided__":true,"bytes":(\d+)\}/) ?? [])[0] ?? "{}",
    ) as { bytes?: number };
    expect(elided.bytes).toBeGreaterThan(reasoningText.length);
  });

  it("truncates long plain-text warnings", () => {
    const { entries, emit } = captureWarnings();

    emit({ warnings: [{ type: "other", message: "x".repeat(10_000) }] });

    const warnings = entries[0]?.context.warnings as Record<string, unknown>[];
    const message = warnings[0]?.message as string;
    expect(message.length).toBeLessThan(600);
    expect(message).toContain("(truncated,");
  });

  it("collapses oversized warning arrays", () => {
    const { entries, emit } = captureWarnings();

    emit({
      warnings: Array.from({ length: 100 }, (_, index) => ({ type: "other", feature: `f${index}` })),
    });

    const warnings = entries[0]?.context.warnings as Record<string, unknown>[];
    expect(entries[0]?.context.warningCount).toBe(100);
    expect(warnings).toHaveLength(21);
    expect(warnings.at(-1)).toEqual({ type: "truncated", omitted: 80 });
  });

  it("keeps structural fields for non-string and malformed inputs without throwing", () => {
    const { entries, emit } = captureWarnings();

    emit({ warnings: ["plain-string", null, 42, { type: "unsupported", feature: "temperature" }] });

    expect(entries).toHaveLength(1);
    const warnings = entries[0]?.context.warnings as Record<string, unknown>[];
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toEqual({ value: "plain-string" });
    expect(warnings[3]).toMatchObject({ type: "unsupported", feature: "temperature" });
  });

  it("does not throw when warnings is not an array", () => {
    const { entries, emit } = captureWarnings();

    emit({ warnings: { notAnArray: true } });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.context).toMatchObject({ warningCount: 0, warnings: [] });
  });
});

describe("redactText", () => {
  it("returns undefined for non-strings", () => {
    expect(redactText(undefined)).toBeUndefined();
    expect(redactText(42)).toBeUndefined();
    expect(redactText({ a: 1 })).toBeUndefined();
  });

  it("leaves text without braces intact", () => {
    expect(redactText("plain message")).toBe("plain message");
  });

  it("elides an unterminated payload instead of keeping it", () => {
    const input = 'prefix {"type":"reasoning","text":"unterminated';
    expect(redactText(input)).toBe(
      `prefix {"__elided__":true,"bytes":${input.length - "prefix ".length}}`,
    );
  });

  it("elides each payload and keeps surrounding text", () => {
    expect(redactText('a {"x":1} b {"y":2} c')).toBe(
      'a {"__elided__":true,"bytes":7} b {"__elided__":true,"bytes":7} c',
    );
  });

  it("does not treat braces inside JSON strings as nesting", () => {
    expect(redactText('msg {"text":"has } inside"} tail')).toBe(
      'msg {"__elided__":true,"bytes":23} tail',
    );
  });
});
