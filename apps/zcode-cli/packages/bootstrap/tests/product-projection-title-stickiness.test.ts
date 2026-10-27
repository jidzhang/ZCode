import { describe, expect, it } from "vitest";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";

function harness() {
  const projection = new ProductProjection("title-stickiness", "epoch");
  let seq = 0;
  const apply = (type: SessionEvent["type"], payload: unknown) =>
    projection.applyEvent({
      id: `event-${++seq}`,
      sessionId: "title-stickiness",
      turnId: "turn-1",
      traceId: "trace",
      timestamp: new Date(1700000000000 + seq),
      sequenceNumber: seq,
      type,
      payload,
    } as SessionEvent);
  apply(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200000 });
  const meta = () => projection.getSnapshot().meta;
  return { apply, meta };
}

describe("SessionTitleUpdated 投影的 custom 粘性", () => {
  it("自动 generated 不覆盖 custom（既有行为保持）", () => {
    const { apply, meta } = harness();
    apply(SessionEventType.SessionTitleUpdated, {
      source: "custom",
      title: "用户手敲",
      previousTitle: "",
    });
    apply(SessionEventType.SessionTitleUpdated, {
      source: "generated",
      title: "自动生成试图覆盖",
      previousTitle: "用户手敲",
    });
    expect(meta().title).toBe("用户手敲");
    expect(meta().titleSource).toBe("custom");
  });

  it("reason=manual_regenerate 的 generated 可覆盖 custom（手动「自动命名」）", () => {
    const { apply, meta } = harness();
    apply(SessionEventType.SessionTitleUpdated, {
      source: "custom",
      title: "用户手敲",
      previousTitle: "",
    });
    apply(SessionEventType.SessionTitleUpdated, {
      source: "generated",
      reason: "manual_regenerate",
      title: "重生成标题",
      previousTitle: "用户手敲",
    });
    expect(meta().title).toBe("重生成标题");
    expect(meta().titleSource).toBe("generated");
  });
});
