import { BACKGROUND_BASH_OUTPUT_MAX_BYTES, type BackgroundBashOutputResult } from "@zcode/shared";
import { readBashOutput } from "./bash-file-output.js";
import { NodeExecutionAdapterRun } from "./node-execution-adapter-run.js";
import {
  BASH_RUNTIME_OUTPUT_LIMIT_BYTES,
  DEFAULT_TIMEOUT_MS,
  isBashMergedOutputRequest,
} from "./execution-utils.js";
import type {
  BashBackgroundLifecycleMode,
  BashBackgroundLifecycleResult,
  InternalExecutionRunOptions,
} from "./execution-adapter-types.js";
import type {
  BackgroundExecutionSnapshot,
  BackgroundExecutionStartResult,
  ExecutionRequest,
  ExecutionResult,
  ExecutionRunOptions,
} from "@zcode/contracts";

export class NodeExecutionAdapterLifecycle extends NodeExecutionAdapterRun {
  async start(
    request: ExecutionRequest,
    options: ExecutionRunOptions = {},
  ): Promise<BackgroundExecutionStartResult> {
    if (this.closePromise) {
      throw new Error("Execution adapter is shutting down");
    }

    const preparation = this.usesBashTempOutput(request)
      ? await this.prepareBashOutput(request, options)
      : undefined;

    const taskId = `exec_${crypto.randomUUID()}`;
    const controller = new AbortController();
    const startedAt = new Date();
    const outputPaths =
      preparation && "result" in preparation ? {} : this.outputPathsForRequest(request);
    const runRequest =
      request.captureCwdAfterSuccess === true
        ? { ...request, captureCwdAfterSuccess: undefined }
        : request;
    if (runRequest !== request) {
      this.outputPathsByRequest.set(runRequest, outputPaths);
    }
    if (!isBashMergedOutputRequest(runRequest)) await this.ensureBackgroundOutputFiles(outputPaths);
    const record = this.createBackgroundTaskRecord({
      controller,
      outputPaths,
      startedAt,
      taskId,
      request,
    });
    this.backgroundTasks.set(taskId, record);

    const externalAbort = () => controller.abort();
    if (options.signal?.aborted) {
      controller.abort();
    } else {
      options.signal?.addEventListener("abort", externalAbort, { once: true });
      record.externalAbort = externalAbort;
    }

    if (preparation && "result" in preparation) this.emitResult(options, preparation.result);
    const running =
      preparation && "result" in preparation
        ? Promise.resolve(preparation.result)
        : this.run(runRequest, {
            ...options,
            preparedBashOutput:
              preparation && "prepared" in preparation ? preparation.prepared : undefined,
            signal: controller.signal,
            onOutputEncodingResolved: (encoding) => {
              record.legacyOutputEncoding = encoding;
            },
            shouldRetainExecutionAfterRootExit: () => true,
            ...(isBashMergedOutputRequest(runRequest)
              ? { bashLifecycle: { isBackgrounded: () => true } }
              : {}),
            onEvent: (event) => {
              this.updateBackgroundTaskRecordFromEvent(record, event);
              return options.onEvent?.(event);
            },
          } as InternalExecutionRunOptions);
    void running.then(
      (result) => {
        this.finalizeBackgroundTaskRecord(record, result);
        if (record.externalAbort) {
          options.signal?.removeEventListener("abort", record.externalAbort);
        }
      },
      (error) => {
        const failure = this.toFailure("unknown", error);
        this.finalizeBackgroundTaskRecord(
          record,
          this.createStoppedResult(startedAt, "spawn_error", failure.message),
        );
        if (record.externalAbort) {
          options.signal?.removeEventListener("abort", record.externalAbort);
        }
      },
    );

    return {
      taskId,
      status: "running",
      startedAt,
      pid: record.pid,
      ...outputPaths,
    };
  }

  async runBashWithBackgroundLifecycle(
    request: ExecutionRequest,
    lifecycle: { mode: BashBackgroundLifecycleMode },
    options: ExecutionRunOptions = {},
  ): Promise<BashBackgroundLifecycleResult> {
    const useBashFile = isBashMergedOutputRequest(request);
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (lifecycle.mode === "auto_on_timeout" && timeoutMs <= 0) {
      return {
        kind: "foreground",
        result: await this.run(request, options),
      };
    }

    const taskId = `exec_${crypto.randomUUID()}`;
    const startedAt = new Date();
    const controller = new AbortController();
    const originalPersistOutput = request.outputLimit?.persistOutput ?? "none";
    const originalMaxArtifactBytes = useBashFile
      ? undefined
      : (request.outputLimit?.maxArtifactBytes ?? this.persistedOutputLimit(request));
    const runRequest: ExecutionRequest = {
      ...request,
      // auto_on_timeout/explicit 置 0：转后台后的进程不能被 run 层内部 timer 杀掉。
      // on_steer 保留原 timeoutMs：前台「超时=杀进程」语义由 run 层自己的 timer 兑现，
      // 结果里的超时值与错误文案也保持真实；转后台后该 timer 被 isBackgrounded 守卫跳过（见 run 层）。
      timeoutMs: lifecycle.mode === "on_steer" ? timeoutMs : 0,
      outputLimit: {
        ...request.outputLimit,
        killProcessOnPersistedLimit: false,
        maxPersistedBytes: BASH_RUNTIME_OUTPUT_LIMIT_BYTES,
        persistOutput: "always",
      },
    };
    const preparation = this.usesBashTempOutput(runRequest)
      ? await this.prepareBashOutput(runRequest, options)
      : undefined;
    if (preparation && "result" in preparation) {
      this.emitResult(options, preparation.result);
      return { kind: "foreground", result: preparation.result };
    }
    const outputPaths = this.outputPathsForRequest(runRequest);
    if (!isBashMergedOutputRequest(runRequest)) {
      await this.ensureBackgroundOutputFiles(outputPaths);
    }
    const record = this.createBackgroundTaskRecord({
      controller,
      outputPaths,
      startedAt,
      taskId,
      request,
    });

    type LifecycleState = "preparing" | "foreground" | "backgrounded" | "settling" | "terminal";
    let state: LifecycleState = "preparing";
    const bashLifecycle: InternalExecutionRunOptions["bashLifecycle"] = useBashFile
      ? {
          isBackgrounded: () => state === "backgrounded",
          onExit: () => {
            // root 已退出后只是异步读取结果，不能被前台 deadline 再转为后台任务。
            if (state === "preparing" || state === "foreground") {
              state = "settling";
              clearForegroundDeadline();
              removeExternalAbort();
              removeSteerListener();
            }
          },
        }
      : lifecycle.mode === "on_steer"
        ? {
            // 非 Bash 合并输出的 on_steer 请求（通用生命周期调用方）：run 层为保住「超时=杀进程」
            // 保留了原 timeoutMs，转后台后只能靠 isBackgrounded 守卫跳过内部超时——必须提供该回调，
            // 否则后台进程会在原超时点被误杀（LOCAL-PLAN-BUSY-INPUT-DELIVERY.md §3）。
            isBackgrounded: () => state === "backgrounded",
          }
        : undefined;
    let persistedLimitReached = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let resolveOutcome: (result: BashBackgroundLifecycleResult) => void = () => undefined;
    const outcome = new Promise<BashBackgroundLifecycleResult>((resolve) => {
      resolveOutcome = resolve;
    });

    const externalAbort = () => {
      if (state === "backgrounded" || state === "terminal") return;
      controller.abort();
    };
    if (options.signal?.aborted) {
      controller.abort();
    } else {
      options.signal?.addEventListener("abort", externalAbort, { once: true });
      record.externalAbort = externalAbort;
    }

    const removeExternalAbort = () => {
      if (!record.externalAbort) return;
      options.signal?.removeEventListener("abort", record.externalAbort);
      record.externalAbort = undefined;
    };

    const clearForegroundDeadline = () => {
      if (!timeoutTimer) return;
      clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
    };

    // guide（插话）准入触发的转后台信号（LOCAL-PLAN-BUSY-INPUT-DELIVERY.md §3）：
    // 前台运行期间挂监听，abort 即原地转后台（进程不杀）。auto_on_timeout 与 on_steer 都适用：
    // 合格命令本来就能在超时自动转后台，steer 只是让这一刻更早发生，不改变无 steer 时的行为。
    const steerSignal = options.steerToBackgroundSignal;
    const onSteerAbort = () => {
      // commit 失败（已 settling/terminal/aborted）说明进程已收尾，直接忽略，不阻塞 guide 消费。
      commitBackground("steer");
    };
    const armSteerListener = () => {
      if (!steerSignal || state !== "foreground") return;
      if (steerSignal.aborted) {
        commitBackground("steer");
        return;
      }
      steerSignal.addEventListener("abort", onSteerAbort, { once: true });
    };
    const removeSteerListener = () => {
      steerSignal?.removeEventListener("abort", onSteerAbort);
    };

    const commitBackground = (trigger: "timeout" | "steer" = "timeout") => {
      if (state !== "foreground" || controller.signal.aborted) return false;

      // 旧 explicit background 复用了通用 start()，foreground timeout 与
      // parent turn abort 会继续挂在子进程上。这里先原子提交状态，再同步清理 deadline、
      // 脱离 parent abort 并登记 task，避免 abort/completion 在提交缝隙里误杀后台进程。
      state = "backgrounded";
      bashLifecycle?.onBackgrounded?.();
      clearForegroundDeadline();
      removeExternalAbort();
      removeSteerListener();
      this.backgroundTasks.set(taskId, record);
      if (persistedLimitReached) {
        controller.abort("output_limit");
      }
      resolveOutcome({
        kind: "backgrounded",
        trigger,
        task: {
          taskId,
          status: "running",
          startedAt,
          pid: record.pid,
          ...outputPaths,
        },
      });
      return true;
    };

    const armForegroundDeadline = () => {
      if (lifecycle.mode !== "auto_on_timeout" || timeoutTimer || state !== "foreground") {
        return;
      }
      timeoutTimer = setTimeout(commitBackground, timeoutMs);
    };

    const backgroundRunOptions: InternalExecutionRunOptions = {
      ...options,
      preparedBashOutput: preparation?.prepared,
      signal: controller.signal,
      onOutputEncodingResolved: (encoding) => {
        record.legacyOutputEncoding = encoding;
      },
      bashLifecycle,
      onPersistedLimit: () => {
        if (!controller.signal.aborted) {
          persistedLimitReached = true;
        }
      },
      onEvent: (event) => {
        this.updateBackgroundTaskRecordFromEvent(record, event);
        if (
          event.type === "started" &&
          event.pid !== undefined &&
          state === "preparing" &&
          !controller.signal.aborted
        ) {
          state = "foreground";
          if (lifecycle.mode === "explicit") {
            commitBackground();
          } else {
            // auto_on_timeout 维持原「到点自动转后台」；on_steer 不 arm 自动定时器（超时由 run 层
            // 原 timeoutMs 保底杀进程）。两者都额外挂 steer 监听，保证 guide 准入时正在前台跑的
            // Bash 能立即让位（设计见 LOCAL-PLAN-BUSY-INPUT-DELIVERY.md §3）。
            armForegroundDeadline();
            armSteerListener();
          }
        }
        if (state === "backgrounded") return;
        return options.onEvent?.(event);
      },
      // 通用 lifecycle 仍使用独立 collector 和共享硬预算；Bash 由文件 watchdog 处理。
      sharePersistedOutputLimitAcrossStreams: true,
      shouldStopOnPersistedLimit: () => state === "backgrounded",
      shouldRetainExecutionAfterRootExit: () => state === "backgrounded",
    };

    const settleExecution = async (unprocessedResult: ExecutionResult) => {
      clearForegroundDeadline();
      // 前台已收尾（含超时被杀），steer 信号即使随后 abort 也不再有任何可转后台的对象。
      removeSteerListener();
      if (state === "backgrounded") {
        this.finalizeBackgroundTaskRecord(
          record,
          this.normalizeBashBackgroundOutputLimitResult(unprocessedResult, persistedLimitReached),
        );
        return;
      }
      if (state === "terminal") return;

      state = "terminal";
      removeExternalAbort();
      const result = await this.normalizeBashBackgroundLifecycleForegroundResult(
        unprocessedResult,
        outputPaths,
        originalMaxArtifactBytes,
        originalPersistOutput,
      );
      // 前台完成仍复用 BackgroundTaskRecord；只结算 outcome 会让
      // record.completion 永久保持 pending，并被异步资源检测识别为泄漏。
      this.finalizeBackgroundTaskRecord(record, result);
      resolveOutcome({
        kind: "foreground",
        result,
      });
    };

    void (async () => {
      try {
        await settleExecution(await this.run(runRequest, backgroundRunOptions));
      } catch (error) {
        const failure = this.toFailure("unknown", error);
        await settleExecution(this.createStoppedResult(startedAt, "spawn_error", failure.message));
      }
    })();

    return await outcome;
  }

  async readBackgroundBashOutput(
    workId: string,
    sessionId: string,
  ): Promise<BackgroundBashOutputResult> {
    const record = this.backgroundTasks.get(workId);
    if (!record || record.sessionId !== sessionId || !record.isBash || !record.outputPath)
      return { kind: "unavailable", workId };
    // 先冻结状态，再读文件；若读取期间退出，下次查询才能返回终态及其最终尾窗。
    const snapshot = this.snapshot(record);
    try {
      const output = await readBashOutput(
        record.outputPath,
        BACKGROUND_BASH_OUTPUT_MAX_BYTES,
        true,
        record.legacyOutputEncoding,
      );
      return {
        kind: "output",
        workId,
        // Stop 先标记 cancelled，结算稍后才完成；不能让详情提前停止最终尾读。
        status: snapshot.result ? snapshot.status : "running",
        output: output.text,
        truncated: output.truncated,
        outputPath: record.outputPath,
      };
    } catch (error) {
      return {
        kind: "read_failed",
        workId,
        code: error instanceof Error && "code" in error ? String(error.code) : undefined,
      };
    }
  }

  async getBackgroundTask(taskId: string): Promise<BackgroundExecutionSnapshot | undefined> {
    const record = this.backgroundTasks.get(taskId);
    return record ? this.snapshot(record) : undefined;
  }

  async waitForBackgroundTask(
    taskId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<BackgroundExecutionSnapshot | undefined> {
    const record = this.backgroundTasks.get(taskId);
    if (!record) return undefined;
    if (record.status !== "running") return this.snapshot(record);
    if (options.signal?.aborted) return this.snapshot(record);

    if (!options.signal) return await record.completion;

    return await new Promise<BackgroundExecutionSnapshot>((resolve) => {
      const abort = () => resolve(this.snapshot(record));
      options.signal?.addEventListener("abort", abort, { once: true });
      record.completion.then((snapshot) => {
        options.signal?.removeEventListener("abort", abort);
        resolve(snapshot);
      });
    });
  }

  async cancelBackgroundTask(taskId: string): Promise<BackgroundExecutionSnapshot | undefined> {
    const record = this.backgroundTasks.get(taskId);
    if (!record) return undefined;
    if (record.status === "running") {
      record.status = "cancelled";
      record.controller.abort();
    }
    return this.snapshot(record);
  }
}
