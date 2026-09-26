import type { RenderMessage } from "../domain/replyFormatter.js";
import type { WeixinChatType } from "../domain/weixinProtocol.js";

/** 微信入站消息（已按 messageId 去重前 Original；群聊消息也由此进入，由 coordinator 处理）。 */
export interface InboundMessage {
  userId: string;
  messageId: string;
  text: string;
  /** 被动回复上下文；回复发送时须原样回传。 */
  contextToken?: string;
  chatType: WeixinChatType;
}

/** 引擎侧端口：adapters 实现，coordinator 消费（与飞书通道同名端口同语义）。 */
export interface EnginePort {
  /** 建立/恢复连接；解析失败抛错。 */
  initialize(): Promise<void>;
  onConnectionChange(cb: (connected: boolean) => void): () => void;
  /** 为会话创建新 task，返回 taskId。 */
  createTask(): Promise<string>;
  /**
   * 发送输入。引擎忙时由 adapter 决定入队降级，返回值告知实际走向：
   * "sent"=作为新输入被接受；"queued"=已入引擎队列等待消化。
   */
  sendInput(taskId: string, content: string): Promise<"sent" | "queued">;
  /** 停止当前生成；引擎侧队列保留。 */
  stopGeneration(taskId: string): Promise<void>;
  /** 全量重读会话消息（终态渲染唯一数据源，幂等）。 */
  readMessages(taskId: string): Promise<readonly RenderMessage[]>;
  /** 回合过程中的变化信号（coordinator 用作 typing 刷新触发）。 */
  onTurnSignal(taskId: string, cb: () => void): () => void;
  /** 回合终止信号（完成/失败/中断）。 */
  onTerminal(taskId: string, cb: () => void): () => void;
  dispose(): Promise<void>;
}

/** 微信侧端口：adapters 实现。 */
export interface WeixinPort {
  /** 开始 getupdates 长轮询并派发入站消息；返回后轮询已在运行。 */
  start(): Promise<void>;
  onMessage(cb: (message: InboundMessage) => Promise<void>): void;
  /** 发送文本；contextToken 为最近入站消息的被动回复上下文，缺失时不带。 */
  sendText(userId: string, text: string, contextToken?: string): Promise<void>;
  /** 刷新 typing 指示；失败静默降级，不抛错。 */
  sendTypingIndicator(userId: string, contextToken?: string): Promise<void>;
  dispose(): Promise<void>;
}
