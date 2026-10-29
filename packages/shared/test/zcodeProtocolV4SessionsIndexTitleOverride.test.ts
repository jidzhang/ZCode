import { describe, expect, it } from "vitest";
import { sessionSummarySchema } from "@zcode/shared/zcode-protocol-v4";

// manual_regenerate 覆盖帧的协议契约（specs/session-title-manual-regenerate.md）：
// titleOverriddenBy 是单帧 additive optional 字段——旧 frame 缺席照常解析，非法值拒绝。
describe("sessionSummarySchema titleOverriddenBy", () => {
  const base = {
    sessionId: "s-1",
    workspaceId: "ws-1",
    title: "新标题",
    titleSource: "generated",
    phase: "completedSuccess",
    sessionEnded: true,
    hasBackgroundWork: false,
    lastActivityAt: 2,
    createdAt: 1,
  };

  it("覆盖帧携带 manual_regenerate 正常解析并保留字段", () => {
    expect(
      sessionSummarySchema.parse({ ...base, titleOverriddenBy: "manual_regenerate" }),
    ).toMatchObject({ titleOverriddenBy: "manual_regenerate" });
  });

  it("旧 frame / 常规帧缺省该字段照常解析", () => {
    const parsed = sessionSummarySchema.parse(base);
    expect(parsed.titleOverriddenBy).toBeUndefined();
  });

  it("非枚举值拒绝（运行时校验，不静默吞）", () => {
    expect(sessionSummarySchema.safeParse({ ...base, titleOverriddenBy: "auto" }).success).toBe(
      false,
    );
  });
});
