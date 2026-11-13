import type {
  BackgroundExecutionSnapshot,
  BackgroundExecutionStartResult,
  ExecutionPort,
  ExecutionRequest,
  ExecutionResult,
  ExecutionRunOptions,
} from "@zcode/contracts";

/**
 * `on_steer`：guide（插话）准入显式触发的转后台（LOCAL-PLAN-BUSY-INPUT-DELIVERY.md §3）。
 * 不 arm 自动转后台定时器；steerToBackgroundSignal abort 时转后台；前台超时保持“到点杀进程”。
 */
export type BashBackgroundLifecycleMode = "explicit" | "auto_on_timeout" | "on_steer";

export type BashBackgroundLifecycleResult =
  | {
      kind: "foreground";
      result: ExecutionResult;
    }
  | {
      kind: "backgrounded";
      /** 触发转后台的原因：超时自动（缺省）或 guide 准入（steer）；调用方据此区分输出语义。 */
      trigger?: "timeout" | "steer";
      task: BackgroundExecutionStartResult;
    };

export interface BashBackgroundLifecycleExecutionPort extends ExecutionPort {
  runBashWithBackgroundLifecycle(
    request: ExecutionRequest,
    lifecycle: { mode: BashBackgroundLifecycleMode },
    options?: ExecutionRunOptions,
  ): Promise<BashBackgroundLifecycleResult>;
}

export function supportsBashBackgroundLifecycle(
  executionPort: ExecutionPort,
): executionPort is BashBackgroundLifecycleExecutionPort {
  return (
    typeof (executionPort as Partial<BashBackgroundLifecycleExecutionPort>)
      .runBashWithBackgroundLifecycle === "function"
  );
}

/**
 * 后台任务终态等待：与上面的后台生命周期一样在 ExecutionPort 接口之外，
 * 由 executor 的后台追踪按鸭子类型探测。缺这个能力时追踪只能退回 1 秒轮询。
 */
export interface BackgroundTaskWaiterExecutionPort extends ExecutionPort {
  waitForBackgroundTask(
    taskId: string,
    options?: { signal?: AbortSignal },
  ): Promise<BackgroundExecutionSnapshot | undefined>;
}

export function supportsBackgroundTaskWaiter(
  executionPort: ExecutionPort,
): executionPort is BackgroundTaskWaiterExecutionPort {
  return (
    typeof (executionPort as Partial<BackgroundTaskWaiterExecutionPort>).waitForBackgroundTask ===
    "function"
  );
}
