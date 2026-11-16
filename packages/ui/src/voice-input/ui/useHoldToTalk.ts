import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

/**
 * 按住说话（docs/chat/composer-voice-input.md §按住说话）：编辑区按住鼠标左键 ≥thresholdMs
 * 且位移 ≤moveTolerancePx 进入语音输入；松开在编辑区内 = 结束，移出 = 取消。
 *
 * 与既有鼠标行为共存的判定都在这里收口（快速点击/选择拖拽/双击三击/修饰键/非左键不触发），
 * 语音侧只拿到 onTalkStart / onTalkEnd 两个时机。内部零 state：指针高频移动不触发 React 渲染。
 */
export interface HoldToTalkBindings {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

interface ActiveTalk {
  pointerId: number;
  element: HTMLDivElement;
  detach: () => void;
}

export function useHoldToTalk(options: {
  enabled: boolean;
  /** 按住多久进入说话（默认 300ms）；窗口内松开视为普通点击。 */
  thresholdMs?: number;
  /** 触发前允许的位移（默认 8px）；超过视为文本选择拖拽，取消判定。 */
  moveTolerancePx?: number;
  onTalkStart: () => void;
  /** finish = 编辑区内松开（正常结束）；cancel = 移出松开 / pointercancel / 卸载。 */
  onTalkEnd: (outcome: "finish" | "cancel") => void;
}): HoldToTalkBindings {
  const { enabled, thresholdMs = 300, moveTolerancePx = 8, onTalkStart, onTalkEnd } = options;

  const pendingRef = useRef<{ release: () => void } | null>(null);
  const activeRef = useRef<ActiveTalk | null>(null);
  // 回调走 ref：按住期间回调变化（如语音状态推进）不需要重建绑定，也不产生渲染。
  const startRef = useRef(onTalkStart);
  startRef.current = onTalkStart;
  const endRef = useRef(onTalkEnd);
  endRef.current = onTalkEnd;

  const clearPending = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    pending.release();
  }, []);

  const endTalk = useCallback((talk: ActiveTalk, outcome: "finish" | "cancel") => {
    if (activeRef.current !== talk) return;
    activeRef.current = null;
    talk.detach();
    endRef.current(outcome);
  }, []);

  const beginTalk = useCallback(
    (element: HTMLDivElement, pointerId: number) => {
      const handlePointerUp = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) return;
        // Pointer Capture 后事件仍以 element 为 target；按 clientX/Y 判定是否仍在编辑区内。
        const rect = element.getBoundingClientRect();
        const inside =
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom;
        endTalk(talk, inside ? "finish" : "cancel");
      };
      const handlePointerCancel = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) return;
        endTalk(talk, "cancel");
      };
      const handleLostCapture = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) return;
        endTalk(talk, "cancel");
      };
      const talk: ActiveTalk = { pointerId, element, detach: () => {} };
      talk.detach = () => {
        try {
          element.releasePointerCapture(pointerId);
        } catch {
          // 元素已销毁或本就无捕获时 releasePointerCapture 会抛，忽略。
        }
        element.removeEventListener("pointerup", handlePointerUp);
        element.removeEventListener("pointercancel", handlePointerCancel);
        element.removeEventListener("lostpointercapture", handleLostCapture);
      };
      activeRef.current = talk;
      // 捕获后 move/up 不再进入 contenteditable，原生选择拖拽随之冻结；jsdom 无此 API 时跳过。
      try {
        element.setPointerCapture(pointerId);
      } catch {
        // 忽略：环境不支持时退化为普通冒泡监听（pointerup 仍会在 element 上触发）。
      }
      element.addEventListener("pointerup", handlePointerUp);
      element.addEventListener("pointercancel", handlePointerCancel);
      element.addEventListener("lostpointercapture", handleLostCapture);
      // 冻结按住开始时的原生选择（按下未移动时通常是零宽选区），避免视觉残留。
      if (typeof window !== "undefined") {
        window.getSelection()?.removeAllRanges();
      }
      startRef.current();
    },
    [endTalk],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!enabled) return;
      // 只吃无修饰的 primary 左键单击；双击/三击（detail>1）保留词选/段落选语义。
      if (event.button !== 0 || event.detail > 1) return;
      if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      // 已在按住说话（或另一指针先到）时忽略后续按下。
      if (activeRef.current || pendingRef.current) return;
      const element = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      const onMove = (move: PointerEvent) => {
        if (move.pointerId !== pointerId) return;
        if (
          Math.abs(move.clientX - startX) > moveTolerancePx ||
          Math.abs(move.clientY - startY) > moveTolerancePx
        ) {
          clearPending();
        }
      };
      const onUp = (up: PointerEvent) => {
        if (up.pointerId !== pointerId) return;
        // 门槛内松开 = 普通点击，交给编辑器原生处理（聚焦/光标）。
        clearPending();
      };
      const release = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
      // 触发前的取消判定挂 window：拖出编辑区后 move/up 不再经过本元素。
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      const timer = setTimeout(() => {
        pendingRef.current = null;
        release();
        beginTalk(element, pointerId);
      }, thresholdMs);
      pendingRef.current = {
        release: () => {
          clearTimeout(timer);
          release();
        },
      };
    },
    [beginTalk, clearPending, enabled, moveTolerancePx, thresholdMs],
  );

  // 卸载时收尾：未决计时器清掉；进行中的按住按取消结算（语音侧取消会删语音文字）。
  useEffect(
    () => () => {
      clearPending();
      const active = activeRef.current;
      if (active) endTalk(active, "cancel");
    },
    [clearPending, endTalk],
  );

  return { onPointerDown };
}
