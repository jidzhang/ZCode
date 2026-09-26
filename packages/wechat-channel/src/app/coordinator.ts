import { helpText, modeListText, parseChannelCommand } from "../domain/commandRouter.js";
import { finalTextOf, renderAssistantReply } from "../domain/replyFormatter.js";
import type { ReplyMode } from "../contract.js";
import type { EnginePort, InboundMessage, WeixinPort } from "./ports.js";

export interface CoordinatorOptions {
  defaultReplyMode: ReplyMode;
  allowedUserIds: readonly string[] | undefined;
  /** 是否启用 typing 指示；关闭时 scheduleTyping 直接短路。 */
  typingEnabled: boolean;
  /** stream/verbose 模式下 typing 指示的刷新节流毫秒。 */
  typingThrottleMs: number;
  logger: Pick<Console, "info" | "warn" | "error">;
}

interface UserState {
  taskId?: string;
  mode: ReplyMode;
  /** 最近一条入站消息的被动回复上下文；终态文本发送时回传。 */
  contextToken?: string;
  typingTimer?: ReturnType<typeof setTimeout>;
  typingRunning: boolean;
}

const DEDUPE_CAPACITY = 2048;

/** 面向用户的错误摘要：不回显内部堆栈与地址，避免把敏感信息带进微信会话。 */
function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const singleLine = raw.replace(/\s+/gu, " ").trim();
  return singleLine.length > 160 ? `${singleLine.slice(0, 157)}…` : singleLine;
}

/**
 * 通道单一所有者：userId→task 映射、回复模式、去重、typing 节流与最近 context_token。
 * 引擎拥有会话/回合/队列；本类不维护第二份回合状态，
 * "typing 是否在刷新"仅服务于节流，不作为业务事实。
 */
export class WechatChannelCoordinator {
  private readonly users = new Map<string, UserState>();
  private readonly seen = new Set<string>();
  private connected = false;

  constructor(
    private readonly engine: EnginePort,
    private readonly weixin: WeixinPort,
    private readonly options: CoordinatorOptions,
  ) {}

  start(): void {
    this.weixin.onMessage((message) => this.handleInbound(message));
    this.engine.onConnectionChange((connected) => {
      this.connected = connected;
      if (!connected) this.options.logger.warn("wechat-channel", "engine disconnected");
      else this.options.logger.info("wechat-channel", "engine connected");
    });
  }

  private isAllowed(userId: string): boolean {
    const allowed = this.options.allowedUserIds;
    return !allowed || allowed.length === 0 || allowed.includes(userId);
  }

  private async handleInbound(message: InboundMessage): Promise<void> {
    if (message.chatType === "group") {
      // 官方明确 bots 仅支持私聊；回执一次提示后忽略（回执失败静默，群上下文未验证）。
      await this.safeSendText(
        message.userId,
        "仅支持私聊，请在微信机器人私聊中使用。",
        message.contextToken,
      );
      return;
    }
    if (!this.isAllowed(message.userId)) return;
    if (this.seen.has(message.messageId)) return;
    this.remember(message.messageId);

    const state = this.userState(message.userId);
    // context_token 属于"最近一条入站消息"的会话属性；终态回复回传最近一次的 token。
    if (message.contextToken) state.contextToken = message.contextToken;
    const command = parseChannelCommand(message.text);
    try {
      switch (command.kind) {
        case "help":
          await this.safeSendText(message.userId, helpText(state.mode), message.contextToken);
          return;
        case "modeList":
          await this.safeSendText(message.userId, modeListText(), message.contextToken);
          return;
        case "mode":
          state.mode = command.mode;
          await this.safeSendText(
            message.userId,
            `回复模式已切换：${command.mode}`,
            message.contextToken,
          );
          return;
        case "stop":
          await this.handleStop(message.userId, state, message.contextToken);
          return;
        case "new":
          await this.handleNew(message.userId, state, message.contextToken);
          return;
        case "none":
          await this.handlePrompt(message.userId, state, command.text, message.contextToken);
          return;
      }
    } catch (error) {
      this.options.logger.error("wechat-channel", `inbound handling failed: ${String(error)}`);
      await this.safeSendText(
        message.userId,
        `处理失败：${errorMessage(error)}`,
        message.contextToken,
      );
    }
  }

  private async handlePrompt(
    userId: string,
    state: UserState,
    text: string,
    contextToken: string | undefined,
  ): Promise<void> {
    if (!this.connected) {
      // 引擎断连期间明确回执，不静默丢消息；文本由发送方稍后重发。
      await this.safeSendText(userId, "引擎未连接，本条消息未被接受；恢复后请重发。", contextToken);
      return;
    }
    const taskId = await this.ensureTask(userId, state);
    this.watchTask(userId, state, taskId);
    const outcome = await this.engine.sendInput(taskId, text);
    if (outcome === "queued") {
      await this.safeSendText(userId, "⏬ 已加入队列（当前回合结束后自动执行）。", contextToken);
      return;
    }
    if (state.mode !== "final") {
      // 无卡片媒介：立即给一条接受回执，运行期间由 typing 节流器持续指示。
      await this.safeSendText(userId, "已收到，正在处理…", contextToken);
      this.scheduleTyping(userId, state);
    }
  }

  private async handleStop(
    userId: string,
    state: UserState,
    contextToken: string | undefined,
  ): Promise<void> {
    if (!state.taskId) {
      await this.safeSendText(userId, "当前没有进行中的会话。", contextToken);
      return;
    }
    await this.engine.stopGeneration(state.taskId);
    await this.safeSendText(
      userId,
      "已发送停止指令（排队中的输入保留，/new 可开始新会话）。",
      contextToken,
    );
  }

  private async handleNew(
    userId: string,
    state: UserState,
    contextToken: string | undefined,
  ): Promise<void> {
    this.teardownTyping(state);
    state.taskId = undefined;
    await this.safeSendText(userId, "已开始新会话（旧会话保留在引擎中）。", contextToken);
  }

  private async ensureTask(userId: string, state: UserState): Promise<string> {
    if (state.taskId) return state.taskId;
    const taskId = await this.engine.createTask();
    state.taskId = taskId;
    this.options.logger.info("wechat-channel", `task created for user ${userId}: ${taskId}`);
    return taskId;
  }

  private watchTask(userId: string, state: UserState, taskId: string): void {
    this.engine.onTurnSignal(taskId, () => this.scheduleTyping(userId, state));
    this.engine.onTerminal(taskId, () => {
      void this.renderFinal(userId, state, taskId);
    });
  }

  // ── typing 与终态渲染 ──

  private scheduleTyping(userId: string, state: UserState): void {
    if (state.mode === "final" || !this.options.typingEnabled) return;
    if (state.typingRunning) return;
    state.typingRunning = true;
    state.typingTimer = setTimeout(() => {
      state.typingTimer = undefined;
      void this.weixin
        .sendTypingIndicator(userId, state.contextToken)
        .catch(() => {})
        .finally(() => {
          state.typingRunning = false;
          // typing 指示有效期短；回合仍在进行时以固定节拍续期，直到终态 teardown。
          if (state.taskId) {
            this.scheduleTyping(userId, state);
          }
        });
    }, this.options.typingThrottleMs);
  }

  private async renderFinal(userId: string, state: UserState, taskId: string): Promise<void> {
    try {
      this.teardownTyping(state);
      const messages = await this.engine.readMessages(taskId);
      const rendered = renderAssistantReply({ messages, mode: state.mode, running: false });
      await this.safeSendText(userId, finalTextOf(rendered, state.mode), state.contextToken);
    } catch (error) {
      this.options.logger.error("wechat-channel", `final render failed: ${String(error)}`);
    }
  }

  private teardownTyping(state: UserState): void {
    if (state.typingTimer) clearTimeout(state.typingTimer);
    state.typingTimer = undefined;
    state.typingRunning = false;
  }

  private userState(userId: string): UserState {
    const existing = this.users.get(userId);
    if (existing) return existing;
    const created: UserState = {
      mode: this.options.defaultReplyMode,
      typingRunning: false,
    };
    this.users.set(userId, created);
    return created;
  }

  private remember(messageId: string): void {
    if (this.seen.size >= DEDUPE_CAPACITY) {
      const oldest = this.seen.values().next().value;
      if (oldest) this.seen.delete(oldest);
    }
    this.seen.add(messageId);
  }

  private async safeSendText(userId: string, text: string, contextToken?: string): Promise<void> {
    try {
      await this.weixin.sendText(userId, text, contextToken);
    } catch (error) {
      this.options.logger.warn("wechat-channel", `sendText failed: ${String(error)}`);
    }
  }
}
