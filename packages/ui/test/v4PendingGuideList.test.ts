import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { QueueItem } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationPendingGuideList } from "@/v4/ConversationPendingGuideList.js";

vi.mock("@/v4/ConversationTurnRow.js", async () => {
  const React = await import("react");
  return {
    ConversationTurnRow: ({
      row,
      userInputStatus,
      onSteerNow,
      onRecallEditQueued,
      onRevokeQueued,
    }: {
      row: { text: string; entityId?: string };
      userInputStatus?: string;
      onSteerNow?: (queueItemId: string) => void;
      onRecallEditQueued?: (queueItemId: string) => void | Promise<void>;
      onRevokeQueued?: (queueItemId: string) => void;
    }) =>
      React.createElement(
        "article",
        null,
        row.text,
        React.createElement("small", null, userInputStatus),
        React.createElement(
          "div",
          { "data-passed-callbacks": [onSteerNow, onRecallEditQueued, onRevokeQueued].map((cb) => (cb ? "1" : "0")).join(",") },
          row.entityId ?? "",
        ),
      ),
  };
});

const guide: QueueItem = {
  sourceCommandId: "command-guide",
  queueItemId: "guide-1",
  clientId: "desktop",
  kind: "sendText",
  text: "请先检查这里",
  attachments: [],
  delivery: { requested: "guide", admitted: "guide" },
  order: { admissionSeq: 1, queuePosition: 0 },
  steer: { state: "steering" },
  dispatch: { state: "queued" },
  admittedAt: 100,
};

describe("ConversationPendingGuideList", () => {
  it("在消息气泡下显示等待引导提示", () => {
    const markup = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ConversationPendingGuideList, {
          context: {} as never,
          items: [guide],
          turnId: "turn-1",
        }),
      ),
    );

    expect(markup).toContain("请先检查这里");
    expect(markup).toContain("等待引导当前任务…");
  });

  it("立即处理/修改/撤销三个回调都透传到行（缺省不传即不渲染按钮）", () => {
    const steerNow = vi.fn();
    const recallEdit = vi.fn();
    const revoke = vi.fn();
    const markup = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ConversationPendingGuideList, {
          context: {} as never,
          items: [guide],
          turnId: "turn-1",
          onSteerNow: steerNow,
          onRecallEditQueued: recallEdit,
          onRevokeQueued: revoke,
        }),
      ),
    );

    expect(markup).toContain('data-passed-callbacks="1,1,1"');
    expect(markup).toContain("guide-1");
  });
});
