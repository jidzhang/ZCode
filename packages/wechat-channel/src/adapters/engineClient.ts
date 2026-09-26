import { randomUUID } from "node:crypto";
import { connectViaWebSocket } from "@zcode/client";
import type { Event } from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import type { ZCodeMessageWithParts } from "@zcode/shared";
import type { RenderMessage } from "../domain/replyFormatter.js";
import type { EnginePort } from "../app/ports.js";

const reconnectDelaysMs = [1_000, 2_000, 5_000, 10_000, 30_000];

interface TaskRuntime {
  busy: boolean;
}

export interface EngineClientOptions {
  wsUrl: string;
  workspacePath: string;
  /** 引擎任务协作模式，缺省 yolo（官方 bot 行为）。 */
  taskMode?: "yolo" | "plan" | "edit" | "auto" | "autoEdit" | "build";
  clientLabel?: string;
  logger: Pick<Console, "info" | "warn" | "error">;
}

/**
 * 引擎适配器：经 @zcode/client 连接 zcode --web 后端，复用 zcodeTaskService 门面。
 * 忙时降级路径：sendPrompt 被拒时转 enqueueTaskCommand 入引擎队列（不丢消息）。
 * 与 feishu-channel 的 EngineClient 结构性重复（见 SPEC 迁移边界：channel-core 待抽取）。
 */
export class EngineClient implements EnginePort {
  private services: IServiceAccessor | null = null;
  private connecting: Promise<IServiceAccessor> | null = null;
  private disposed = false;
  private reconnectAttempt = 0;
  private readonly connectionListeners = new Set<(connected: boolean) => void>();
  private readonly runtimes = new Map<string, TaskRuntime>();

  constructor(private readonly options: EngineClientOptions) {}

  get connected(): boolean {
    return this.services !== null;
  }

  async initialize(): Promise<void> {
    await this.ensureConnection();
  }

  onConnectionChange(cb: (connected: boolean) => void): () => void {
    this.connectionListeners.add(cb);
    return () => this.connectionListeners.delete(cb);
  }

  async createTask(): Promise<string> {
    const services = await this.ensureConnection();
    const result = await services.zcodeTaskService.createTask({
      workspacePath: this.options.workspacePath,
      mode: this.options.taskMode ?? "yolo",
    });
    const taskId = result.taskId;
    this.runtimes.set(taskId, { busy: false });
    return taskId;
  }

  async sendInput(taskId: string, content: string): Promise<"sent" | "queued"> {
    const services = await this.ensureConnection();
    const runtime = this.runtimes.get(taskId);
    try {
      await services.zcodeTaskService.sendPrompt({
        taskId,
        traceId: newTraceId(),
        content,
        clientId: "wechat-channel",
      });
      if (runtime) runtime.busy = true;
      return "sent";
    } catch (error) {
      // 引擎忙/拒绝时降级入队；入队结果由 host 排队消化，不丢消息。
      this.options.logger.warn(
        "wechat-channel",
        `sendPrompt rejected, enqueueing: ${String(error)}`,
      );
      await services.zcodeTaskService.enqueueTaskCommand({
        workspacePath: this.options.workspacePath,
        taskId,
        commandId: newTraceId(),
        traceId: newTraceId(),
        type: "send_prompt",
        content,
        clientId: "wechat-channel",
        clientLabel: this.options.clientLabel ?? "wechat-channel",
      });
      return "queued";
    }
  }

  async stopGeneration(taskId: string): Promise<void> {
    const services = await this.ensureConnection();
    await services.zcodeTaskService.stopGeneration({
      taskId,
      workspacePath: this.options.workspacePath,
    });
  }

  async readMessages(taskId: string): Promise<readonly RenderMessage[]> {
    const services = await this.ensureConnection();
    const messages = await services.zcodeAgentService.readSessionMessages({
      workspacePath: this.options.workspacePath,
      sessionId: taskId,
    });
    return messages.map((message) => mapMessage(message));
  }

  onTurnSignal(taskId: string, cb: () => void): () => void {
    void this.withTaskService(async (services) => {
      const event: Event<unknown> = services.zcodeTaskService.onDynamicTaskEvent({
        workspacePath: this.options.workspacePath,
        taskId,
      });
      event(() => cb());
    });
    return () => {};
  }

  onTerminal(taskId: string, cb: () => void): () => void {
    void this.withTaskService(async (services) => {
      const event: Event<unknown> = services.zcodeTaskService.onDynamicTaskTerminalOutcome(taskId);
      event(() => {
        const runtime = this.runtimes.get(taskId);
        if (runtime) runtime.busy = false;
        cb();
      });
    });
    return () => {};
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.runtimes.clear();
    this.services = null;
  }

  // ── 内部 ──

  private async withTaskService(fn: (services: IServiceAccessor) => Promise<void>): Promise<void> {
    try {
      const services = await this.ensureConnection();
      await fn(services);
    } catch (error) {
      this.options.logger.warn("wechat-channel", `task service call failed: ${String(error)}`);
    }
  }

  private async ensureConnection(): Promise<IServiceAccessor> {
    if (this.services) return this.services;
    if (this.connecting) return this.connecting;
    this.connecting = this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<IServiceAccessor> {
    while (!this.disposed) {
      try {
        const services = await connectViaWebSocket(this.options.wsUrl, {
          onClose: () => {
            this.services = null;
            this.notifyConnection(false);
            void this.scheduleReconnect();
          },
        });
        await services.zcodeTaskService.initialize({ workspacePath: this.options.workspacePath });
        this.services = services;
        this.reconnectAttempt = 0;
        this.notifyConnection(true);
        this.options.logger.info("wechat-channel", `engine connected: ${this.options.wsUrl}`);
        return services;
      } catch (error) {
        if (this.disposed) throw error;
        const delay =
          reconnectDelaysMs[Math.min(this.reconnectAttempt, reconnectDelaysMs.length - 1)] ??
          30_000;
        this.reconnectAttempt += 1;
        this.options.logger.warn(
          "wechat-channel",
          `engine connect failed, retry in ${delay}ms: ${String(error)}`,
        );
        await sleep(delay);
      }
    }
    throw new Error("engine client disposed");
  }

  private async scheduleReconnect(): Promise<void> {
    if (this.disposed || this.services || this.connecting) return;
    await this.ensureConnection().catch(() => {});
  }

  private notifyConnection(connected: boolean): void {
    for (const listener of this.connectionListeners) listener(connected);
  }
}

function mapMessage(message: ZCodeMessageWithParts): RenderMessage {
  const withInfo = message as ZCodeMessageWithParts & { info?: { role?: string } };
  return {
    role: withInfo.info?.role,
    parts: message.parts.map((part) => ({
      type: part.type,
      text: "text" in part ? part.text : undefined,
      tool: "tool" in part ? part.tool : undefined,
      status: "status" in part ? String((part as { status: unknown }).status) : undefined,
      synthetic: "synthetic" in part ? Boolean(part.synthetic) : undefined,
      ignored: "ignored" in part ? Boolean(part.ignored) : undefined,
    })),
  };
}

function newTraceId(): string {
  return randomUUID();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
