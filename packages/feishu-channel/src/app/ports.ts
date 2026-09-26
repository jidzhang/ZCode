import type { RenderMessage } from "../domain/replyFormatter.js";

/** 飞书入站消息（已按 message_id 去重前 Original）。 */
export interface InboundMessage {
  chatId: string;
  messageId: string;
  text: string;
}

/** 引擎侧端口：adapters 实现，coordinator 消费。 */
export interface EnginePort {
  /** 建立/恢复连接；解析失败抛错。 */
  initialize(): Promise<void>;
  onConnectionChange(cb: (connected: boolean) => void): () => void;
  /** 为 chat 创建新 task，返回 taskId。 */
  createTask(): Promise<string>;
  /**
   * 发送输入。引擎忙时由 adapter 决定入队降级，返回值告知实际走向：
   * "sent"=作为新输入被接受；"queued"=已入引擎队列等待消化。
   */
  sendInput(taskId: string, content: string): Promise<"sent" | "queued">;
  /** 停止当前生成；引擎侧队列保留。 */
  stopGeneration(taskId: string): Promise<void>;
  /** 全量重读会话消息（渲染唯一数据源，幂等）。 */
  readMessages(taskId: string): Promise<readonly RenderMessage[]>;
  /** 回合过程中的变化信号（节流后由 coordinator 主动重读）。 */
  onTurnSignal(taskId: string, cb: () => void): () => void;
  /** 回合终止信号（完成/失败/中断）。 */
  onTerminal(taskId: string, cb: () => void): () => void;
  dispose(): Promise<void>;
}

/** 飞书侧端口：adapters 实现。 */
export interface FeishuPort {
  /** 建立长连接并开始派发入站消息。 */
  start(): Promise<void>;
  onMessage(cb: (message: InboundMessage) => Promise<void>): void;
  sendText(chatId: string, text: string): Promise<void>;
  /** 创建或原地更新卡片，返回卡片消息 id。 */
  upsertCard(
    chatId: string,
    cardMessageId: string | null,
    card: Record<string, unknown>,
  ): Promise<string>;
  dispose(): Promise<void>;
}
