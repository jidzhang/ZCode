import { helpText, modeListText, parseChannelCommand } from "../domain/commandRouter.js";
import { buildReplyCard } from "../domain/cardBuilder.js";
import { finalTextOf, renderAssistantReply } from "../domain/replyFormatter.js";
import type { ReplyMode } from "../contract.js";
import type { EnginePort, FeishuPort, InboundMessage } from "./ports.js";

export interface CoordinatorOptions {
  defaultReplyMode: ReplyMode;
  allowedChatIds: readonly string[] | undefined;
  streamThrottleMs: number;
  logger: Pick<Console, "info" | "warn" | "error">;
}

interface ChatState {
  taskId?: string;
  mode: ReplyMode;
  cardMessageId?: string;
  renderTimer?: ReturnType<typeof setTimeout>;
  rendering: boolean;
  renderPending: boolean;
}

const DEDUPE_CAPACITY = 2048;

/** 面向用户的错误摘要：不回显内部堆栈与地址，避免把敏感信息带进飞书会话。 */
function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const singleLine = raw.replace(/\s+/gu, " ").trim();
  return singleLine.length > 160 ? `${singleLine.slice(0, 157)}…` : singleLine;
}

/**
 * 通道单一所有者：chat→task 映射、回复模式、去重、节流与卡片 id。
 * 引擎拥有会话/回合/队列；本类不维护第二份回合状态，
 * "是否在渲染"仅服务于节流，不作为业务事实。
 */
export class FeishuChannelCoordinator {
  private readonly chats = new Map<string, ChatState>();
  private readonly seen = new Set<string>();
  private connected = false;

  constructor(
    private readonly engine: EnginePort,
    private readonly feishu: FeishuPort,
    private readonly options: CoordinatorOptions,
  ) {}

  start(): void {
    this.feishu.onMessage((message) => this.handleInbound(message));
    this.engine.onConnectionChange((connected) => {
      this.connected = connected;
      if (!connected) this.options.logger.warn("feishu-channel", "engine disconnected");
      else this.options.logger.info("feishu-channel", "engine connected");
    });
  }

  private isAllowed(chatId: string): boolean {
    const allowed = this.options.allowedChatIds;
    return !allowed || allowed.length === 0 || allowed.includes(chatId);
  }

  private async handleInbound(message: InboundMessage): Promise<void> {
    if (!this.isAllowed(message.chatId)) return;
    if (this.seen.has(message.messageId)) return;
    this.remember(message.messageId);

    const state = this.chatState(message.chatId);
    const command = parseChannelCommand(message.text);
    try {
      switch (command.kind) {
        case "help":
          await this.feishu.sendText(message.chatId, helpText(state.mode));
          return;
        case "modeList":
          await this.feishu.sendText(message.chatId, modeListText());
          return;
        case "mode":
          state.mode = command.mode;
          await this.feishu.sendText(message.chatId, `回复模式已切换：${command.mode}`);
          return;
        case "stop":
          await this.handleStop(message.chatId, state);
          return;
        case "new":
          await this.handleNew(message.chatId, state);
          return;
        case "none":
          await this.handlePrompt(message.chatId, state, command.text);
          return;
      }
    } catch (error) {
      this.options.logger.error("feishu-channel", `inbound handling failed: ${String(error)}`);
      await this.safeSendText(message.chatId, `处理失败：${errorMessage(error)}`);
    }
  }

  private async handlePrompt(chatId: string, state: ChatState, text: string): Promise<void> {
    if (!this.connected) {
      // 引擎断连期间明确回执，不静默丢消息；文本由发送方稍后重发。
      await this.safeSendText(chatId, "引擎未连接，本条消息未被接受；恢复后请重发。");
      return;
    }
    const taskId = await this.ensureTask(chatId, state);
    this.watchTask(chatId, state, taskId);
    const outcome = await this.engine.sendInput(taskId, text);
    if (outcome === "queued") {
      await this.safeSendText(chatId, "⏬ 已加入队列（当前回合结束后自动执行）。");
      return;
    }
    // sent：正常新输入；若此前无卡片且为流式模式，先发出占位卡片，让用户立即看到回执。
    if (state.mode !== "final" && !state.cardMessageId) {
      await this.renderNow(chatId, state, taskId);
    }
  }

  private async handleStop(chatId: string, state: ChatState): Promise<void> {
    if (!state.taskId) {
      await this.safeSendText(chatId, "当前没有进行中的会话。");
      return;
    }
    await this.engine.stopGeneration(state.taskId);
    await this.safeSendText(chatId, "已发送停止指令（排队中的输入保留，/new 可开始新会话）。");
  }

  private async handleNew(chatId: string, state: ChatState): Promise<void> {
    this.teardownRender(state);
    state.taskId = undefined;
    state.cardMessageId = undefined;
    await this.safeSendText(chatId, "已开始新会话（旧会话保留在引擎中）。");
  }

  private async ensureTask(chatId: string, state: ChatState): Promise<string> {
    if (state.taskId) return state.taskId;
    const taskId = await this.engine.createTask();
    state.taskId = taskId;
    this.options.logger.info("feishu-channel", `task created for chat ${chatId}: ${taskId}`);
    return taskId;
  }

  private watchTask(chatId: string, state: ChatState, taskId: string): void {
    this.engine.onTurnSignal(taskId, () => this.scheduleRender(chatId, state, taskId));
    this.engine.onTerminal(taskId, () => {
      void this.renderFinal(chatId, state, taskId);
    });
  }

  // ── 渲染 ──

  private scheduleRender(chatId: string, state: ChatState, taskId: string): void {
    if (state.mode === "final") return;
    if (state.rendering) {
      state.renderPending = true;
      return;
    }
    state.rendering = true;
    state.renderTimer = setTimeout(() => {
      state.renderTimer = undefined;
      void this.renderNow(chatId, state, taskId).finally(() => {
        state.rendering = false;
        if (state.renderPending) {
          state.renderPending = false;
          this.scheduleRender(chatId, state, taskId);
        }
      });
    }, this.options.streamThrottleMs);
  }

  private async renderNow(chatId: string, state: ChatState, taskId: string): Promise<void> {
    if (state.mode === "final") return;
    const messages = await this.engine.readMessages(taskId);
    const rendered = renderAssistantReply({ messages, mode: state.mode, running: true });
    const card = buildReplyCard(rendered, { mode: state.mode });
    state.cardMessageId = await this.feishu.upsertCard(chatId, state.cardMessageId ?? null, card);
  }

  private async renderFinal(chatId: string, state: ChatState, taskId: string): Promise<void> {
    try {
      this.teardownRender(state);
      const messages = await this.engine.readMessages(taskId);
      const rendered = renderAssistantReply({ messages, mode: state.mode, running: false });
      if (state.mode === "final") {
        await this.safeSendText(chatId, finalTextOf(rendered));
        return;
      }
      const card = buildReplyCard(rendered, { mode: state.mode });
      state.cardMessageId = await this.feishu.upsertCard(chatId, state.cardMessageId ?? null, card);
    } catch (error) {
      this.options.logger.error("feishu-channel", `final render failed: ${String(error)}`);
    }
  }

  private teardownRender(state: ChatState): void {
    if (state.renderTimer) clearTimeout(state.renderTimer);
    state.renderTimer = undefined;
    state.rendering = false;
    state.renderPending = false;
  }

  private chatState(chatId: string): ChatState {
    const existing = this.chats.get(chatId);
    if (existing) return existing;
    const created: ChatState = {
      mode: this.options.defaultReplyMode,
      rendering: false,
      renderPending: false,
    };
    this.chats.set(chatId, created);
    return created;
  }

  private remember(messageId: string): void {
    if (this.seen.size >= DEDUPE_CAPACITY) {
      const oldest = this.seen.values().next().value;
      if (oldest) this.seen.delete(oldest);
    }
    this.seen.add(messageId);
  }

  private async safeSendText(chatId: string, text: string): Promise<void> {
    try {
      await this.feishu.sendText(chatId, text);
    } catch (error) {
      this.options.logger.warn("feishu-channel", `sendText failed: ${String(error)}`);
    }
  }
}
