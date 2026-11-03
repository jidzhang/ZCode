import { describe, expect, it } from "vitest";
import { CompactTrigger, type ModelId, type ModelProviderId } from "@zcode/contracts";

import {
  createRuntimeAssistantEntry,
  createRuntimeUserEntry,
  type RuntimeMessageEntry,
} from "../src/agent/message-history.js";
import {
  isModelContextExceededError,
  isModelContextWindowPressure,
  isModelEngineAbortError,
} from "../src/runtime/helpers/model-errors.js";
import {
  capReactiveCompactSummaryInput,
  estimateRuntimeEntryTokens,
} from "../src/runtime/helpers/compact-selection.js";
import { findLatestCommittedAssistantUsage } from "../src/runtime/methods/turn-model-step-usage.js";
import { estimateCurrentModelInputTokens } from "../src/runtime/methods/compact.js";

const DEEPSEEK_INPUT_TOO_LONG =
  "Upstream request failed: [invalid_request_error] Input too long: model limit 1048576 tokens, requested 1094684 tokens trace_id: e63b7e5a1bcbf7146c6f4d89554c987f";

const DEEPSEEK_ENGINE_ABORT =
  "An error occurred in model serving, error message is: [Inference engine abort. Finish reason: [UNKNOWN].]";

function usage(input: number, output = 0) {
  return {
    input,
    output,
    reasoning: 0,
    cache: { read: 0, write: 0 },
    total: input + output,
  };
}

function modelRef(providerId: string, modelId: string) {
  return {
    providerId: providerId as ModelProviderId,
    modelId: modelId as ModelId,
  };
}

describe("context overflow classification", () => {
  it("classifies the deepseek input-too-long wording", () => {
    expect(isModelContextExceededError(new Error(DEEPSEEK_INPUT_TOO_LONG))).toBe(true);
  });

  it("classifies engine abort only as a signal, not as context overflow by itself", () => {
    const error = new Error("Turn execution failed", {
      cause: new Error(DEEPSEEK_ENGINE_ABORT),
    });

    expect(isModelEngineAbortError(error)).toBe(true);
    expect(isModelContextExceededError(error)).toBe(false);
  });

  it("gates engine abort classification on estimated context pressure", () => {
    expect(isModelContextWindowPressure(916_466, 1_000_000)).toBe(true);
    expect(isModelContextWindowPressure(850_000, 1_000_000)).toBe(true);
    expect(isModelContextWindowPressure(500_000, 1_000_000)).toBe(false);
    expect(isModelContextWindowPressure(916_466, undefined)).toBe(false);
  });
});

describe("provider usage anchor isolation", () => {
  const glmEntry = createRuntimeAssistantEntry(
    "glm answer",
    undefined,
    undefined,
    modelRef("provider", "GLM-5.3"),
    usage(692_400, 100),
  );
  const nextUserEntry = createRuntimeUserEntry("next question");
  const entries: RuntimeMessageEntry[] = [glmEntry, nextUserEntry];

  it("skips a foreign model anchor after switching models", () => {
    expect(
      findLatestCommittedAssistantUsage(entries, modelRef("provider", "deepseek-v4.1-flash")),
    ).toBeUndefined();
  });

  it("keeps using the same model anchor", () => {
    expect(
      findLatestCommittedAssistantUsage(entries, modelRef("provider", "GLM-5.3")),
    ).toMatchObject({ messageIndex: 0 });
  });

  it("falls back to the local estimate when the anchor is foreign", () => {
    const messages = [{ role: "user" as const, content: "hello world" }];

    expect(
      estimateCurrentModelInputTokens(
        messages,
        entries,
        modelRef("provider", "deepseek-v4.1-flash"),
      ),
    ).toBe(4);
    expect(
      estimateCurrentModelInputTokens(messages, entries, modelRef("provider", "GLM-5.3")),
    ).toBe(692_500);
  });
});

describe("reactive compact summary input budget", () => {
  function buildRounds(count: number): RuntimeMessageEntry[] {
    const entries: RuntimeMessageEntry[] = [];
    for (let index = 0; index < count; index += 1) {
      entries.push(createRuntimeUserEntry(`user-${index}-${"u".repeat(1_200)}`));
      entries.push(
        createRuntimeAssistantEntry(
          `assistant-${index}-${"a".repeat(1_200)}`,
          undefined,
          undefined,
          modelRef("provider", "GLM-5.3"),
        ),
      );
    }
    return entries;
  }

  it("preserves recent rounds until the summary input fits 60% of the window", () => {
    const entries = buildRounds(6);
    const initial = {
      entriesForSummary: [...entries],
      groupsPreserved: 1,
      preservedEntries: [entries.at(-1)!],
      totalGroups: 6,
    };

    const result = capReactiveCompactSummaryInput({
      selection: initial,
      entries,
      trigger: CompactTrigger.Reactive,
      contextWindow: 6_000,
    });

    expect(result).not.toBeNull();
    expect(result!.budgetTokens).toBe(3_600);
    expect(result!.preservedMoreGroups).toBeGreaterThan(0);
    expect(estimateRuntimeEntryTokens(result!.selection.entriesForSummary)).toBeLessThanOrEqual(
      3_600,
    );
  });

  it("returns null without a usable window", () => {
    const entries = buildRounds(3);

    expect(
      capReactiveCompactSummaryInput({
        selection: {
          entriesForSummary: entries,
          groupsPreserved: 1,
          preservedEntries: [entries.at(-1)!],
          totalGroups: 3,
        },
        entries,
        trigger: CompactTrigger.Reactive,
        contextWindow: undefined,
      }),
    ).toBeNull();
  });
});
