// @vitest-environment jsdom
// 按住说话（docs/chat/composer-voice-input.md §按住说话）的指针判定回归：
// 门槛/位移/松开位置/修饰键/非左键/双击/禁用/卸载语义。语音侧接线由实机验收覆盖。
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { useHoldToTalk } from "@/voice-input/ui/useHoldToTalk.js";

function pointerEvent(type: string, init: Record<string, number> = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const key of ["pointerId", "button", "detail", "clientX", "clientY"]) {
    Object.defineProperty(event, key, { value: init[key] ?? 0 });
  }
  for (const key of ["shiftKey", "ctrlKey", "metaKey", "altKey"]) {
    Object.defineProperty(event, key, { value: Boolean(init[key]) });
  }
  return event;
}

function Harness(props: {
  enabled: boolean;
  onTalkStart: () => void;
  onTalkEnd: (outcome: "finish" | "cancel") => void;
}) {
  const bindings = useHoldToTalk({
    enabled: props.enabled,
    thresholdMs: 300,
    moveTolerancePx: 8,
    onTalkStart: props.onTalkStart,
    onTalkEnd: props.onTalkEnd,
  });
  return createElement("div", {
    "data-testid": "area",
    // 经 React 合成指针事件入口（真实使用路径）；松开/取消由 hook 原生监听器接收。
    onPointerDown: bindings.onPointerDown,
  });
}

describe("useHoldToTalk 按住说话判定", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function setup(enabled = true) {
    const onTalkStart = vi.fn();
    const onTalkEnd = vi.fn();
    const view = render(createElement(Harness, { enabled, onTalkStart, onTalkEnd }));
    const area = view.getByTestId("area");
    return { area, onTalkStart, onTalkEnd, view };
  }

  it("按住达到门槛即开始，编辑区内松开 = 结束", () => {
    const { area, onTalkStart, onTalkEnd } = setup();
    fireEvent(area, pointerEvent("pointerdown", { pointerId: 1, button: 0, detail: 1 }));
    expect(onTalkStart).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onTalkStart).toHaveBeenCalledTimes(1);
    // jsdom 的 getBoundingClientRect 为全零矩形：clientX/Y=0 判定在编辑区内。
    fireEvent(area, pointerEvent("pointerup", { pointerId: 1 }));
    expect(onTalkEnd).toHaveBeenCalledWith("finish");
  });

  it("门槛内松开 = 普通点击，不触发", () => {
    const { area, onTalkStart, onTalkEnd } = setup();
    fireEvent(area, pointerEvent("pointerdown", { pointerId: 1, button: 0, detail: 1 }));
    act(() => {
      vi.advanceTimersByTime(120);
    });
    fireEvent(window, pointerEvent("pointerup", { pointerId: 1 }));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onTalkStart).not.toHaveBeenCalled();
    expect(onTalkEnd).not.toHaveBeenCalled();
  });

  it("门槛前移动超容差 = 选择拖拽，取消判定", () => {
    const { area, onTalkStart, onTalkEnd } = setup();
    fireEvent(area, pointerEvent("pointerdown", { pointerId: 1, button: 0, detail: 1, clientX: 0 }));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent(window, pointerEvent("pointermove", { pointerId: 1, clientX: 40 }));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onTalkStart).not.toHaveBeenCalled();
    expect(onTalkEnd).not.toHaveBeenCalled();
  });

  it("移出编辑区松开 = 取消", () => {
    const { area, onTalkStart, onTalkEnd } = setup();
    fireEvent(area, pointerEvent("pointerdown", { pointerId: 1, button: 0, detail: 1 }));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    fireEvent(area, pointerEvent("pointerup", { pointerId: 1, clientX: 999, clientY: 999 }));
    expect(onTalkEnd).toHaveBeenCalledWith("cancel");
  });

  it("非左键、修饰键、双击、禁用态均不触发", () => {
    const { area, onTalkStart, view } = setup();
    fireEvent(area, pointerEvent("pointerdown", { pointerId: 1, button: 2 }));
    fireEvent(area, pointerEvent("pointerdown", { pointerId: 1, button: 0, detail: 1, shiftKey: 1 }));
    fireEvent(area, pointerEvent("pointerdown", { pointerId: 1, button: 0, detail: 2 }));
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(onTalkStart).not.toHaveBeenCalled();
    view.unmount();

    const disabled = setup(false);
    fireEvent(disabled.area, pointerEvent("pointerdown", { pointerId: 1, button: 0, detail: 1 }));
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(disabled.onTalkStart).not.toHaveBeenCalled();
  });

  it("pointercancel 与卸载均按取消结算", () => {
    const { area, onTalkEnd, view } = setup();
    fireEvent(area, pointerEvent("pointerdown", { pointerId: 1, button: 0, detail: 1 }));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    fireEvent(area, pointerEvent("pointercancel", { pointerId: 1 }));
    expect(onTalkEnd).toHaveBeenCalledWith("cancel");
    view.unmount();

    // 第二轮：按住中直接卸载。
    const second = setup();
    fireEvent(second.area, pointerEvent("pointerdown", { pointerId: 2, button: 0, detail: 1 }));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    view.unmount();
    second.view.unmount();
    expect(second.onTalkEnd).toHaveBeenCalledWith("cancel");
  });
});
