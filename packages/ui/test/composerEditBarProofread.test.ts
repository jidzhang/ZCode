// @vitest-environment jsdom
// 编辑态状态条「纠错」入口（specs/text-proofread-in-edit.md）：上游 3.18.2 把消息编辑
// 移入 composer 编辑模式后，旧版行内编辑窗的纠错按钮重放到 ComposerEditBar。
// 这里验证按钮的显隐条件与交互；服务调用与撤销步回填分别由 SessionPane/composer 侧拥有。
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  ComposerEditBar,
  type ComposerEditBarProps,
} from "@/composer-edit-mode/ComposerEditBar.js";

const userQueryTarget = { kind: "userQuery", rowId: 12, entityId: "entity-12" } as const;
const queueItemTarget = { kind: "queueItem", queueItemId: "q-1" } as const;

function renderBar(props: {
  target: ComposerEditBarProps["target"];
  invalidReason?: ComposerEditBarProps["invalidReason"];
  proofread?: ComposerEditBarProps["proofread"];
}) {
  const onProofread = vi.fn();
  const proofread = props.proofread ? { ...props.proofread, onProofread } : undefined;
  render(
    createElement(
      TooltipProvider,
      null,
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ComposerEditBar, {
          target: props.target,
          invalidReason: props.invalidReason ?? null,
          submitting: false,
          proofread,
          onRewindWorkspace: vi.fn(),
          onCancel: vi.fn(),
        }),
      ),
    ),
  );
  return onProofread;
}

afterEach(cleanup);

describe("ComposerEditBar 纠错按钮", () => {
  it("编辑用户消息时显示按钮，点击触发宿主 handler", () => {
    const onProofread = renderBar({
      target: userQueryTarget,
      proofread: { busy: false, onProofread: () => {} },
    });

    const button = screen.getByTestId("v4-edit-proofread-12");
    expect(button.getAttribute("aria-label")).toBe("纠错");
    fireEvent.click(button);
    expect(onProofread).toHaveBeenCalledTimes(1);
    // 状态条自身仍完整：取消按钮不受入口增删影响。
    expect(screen.getByTestId("v4-composer-edit-cancel")).toBeTruthy();
  });

  it("busy 请求期间禁用并防重复点击", () => {
    const onProofread = renderBar({
      target: userQueryTarget,
      proofread: { busy: true, onProofread: () => {} },
    });

    const button = screen.getByTestId("v4-edit-proofread-12");
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(onProofread).not.toHaveBeenCalled();
  });

  it("编辑队列项不显示纠错（与旧版行内编辑窗范围一致）", () => {
    renderBar({
      target: queueItemTarget,
      proofread: { busy: false, onProofread: () => {} },
    });

    expect(screen.queryByTestId("v4-edit-proofread-q-1")).toBeNull();
  });

  it("编辑态失效（如目标已不是最新消息）时不显示", () => {
    renderBar({
      target: userQueryTarget,
      invalidReason: "notLatest",
      proofread: { busy: false, onProofread: () => {} },
    });

    expect(screen.queryByTestId("v4-edit-proofread-12")).toBeNull();
  });

  it("宿主未注入 proofread（如只读场景）时不显示，状态条其余按钮不受影响", () => {
    renderBar({ target: userQueryTarget });

    expect(screen.queryByTestId("v4-edit-proofread-12")).toBeNull();
    expect(screen.getByTestId("v4-composer-edit-cancel")).toBeTruthy();
  });
});
