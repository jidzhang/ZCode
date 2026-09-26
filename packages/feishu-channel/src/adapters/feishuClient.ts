import * as lark from "@larksuiteoapi/node-sdk";
import type { FeishuPort, InboundMessage } from "../app/ports.js";

export interface FeishuClientOptions {
  appId: string;
  appSecret: string;
  logger: Pick<Console, "info" | "warn" | "error">;
  /** 单次发送失败后的唯一一次重试等待；避免对飞书 API 重试风暴。 */
  retryDelayMs?: number;
}

/** 飞书适配器：官方 SDK 长连接（WSS 出站，无需公网回调）。 */
export class FeishuClient implements FeishuPort {
  private readonly client: lark.Client;
  private messageHandler: ((message: InboundMessage) => Promise<void>) | null = null;
  private wsClient: lark.WSClient | null = null;

  constructor(private readonly options: FeishuClientOptions) {
    this.client = new lark.Client({
      appId: options.appId,
      appSecret: options.appSecret,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
    });
  }

  async start(): Promise<void> {
    const dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: unknown) => {
        await this.dispatchInbound(data);
      },
    });
    this.wsClient = new lark.WSClient({
      appId: this.options.appId,
      appSecret: this.options.appSecret,
      loggerLevel: lark.LoggerLevel.warn,
    });
    await this.wsClient.start({ eventDispatcher: dispatcher });
    this.options.logger.info("feishu-channel", "feishu long connection started");
  }

  onMessage(cb: (message: InboundMessage) => Promise<void>): void {
    this.messageHandler = cb;
  }

  async sendText(chatId: string, text: string): Promise<void> {
    await this.withRetry(() =>
      this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) },
      }),
    );
  }

  async upsertCard(
    chatId: string,
    cardMessageId: string | null,
    card: Record<string, unknown>,
  ): Promise<string> {
    const content = JSON.stringify(card);
    if (cardMessageId) {
      await this.withRetry(() =>
        this.client.im.message.patch({
          path: { message_id: cardMessageId },
          data: { content },
        }),
      );
      return cardMessageId;
    }
    const response = await this.withRetry(() =>
      this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, msg_type: "interactive", content },
      }),
    );
    const messageId = extractMessageId(response);
    if (!messageId) throw new Error("feishu create card returned no message_id");
    return messageId;
  }

  async dispose(): Promise<void> {
    // SDK 未暴露显式关闭；断开由进程退出完成，此处保留语义占位。
    this.wsClient = null;
    this.messageHandler = null;
  }

  // ── 内部 ──

  private async dispatchInbound(data: unknown): Promise<void> {
    const handler = this.messageHandler;
    if (!handler) return;
    const inbound = normalizeInbound(data);
    if (!inbound) return;
    try {
      await handler(inbound);
    } catch (error) {
      this.options.logger.error("feishu-channel", `inbound dispatch failed: ${String(error)}`);
    }
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      const delay = this.options.retryDelayMs ?? 1_000;
      this.options.logger.warn(
        "feishu-channel",
        `feishu call failed, retry once: ${String(error)}`,
      );
      await sleep(delay);
      return fn();
    }
  }
}

interface NormalizedInbound {
  chatId: string;
  messageId: string;
  text: string;
}

/** 结构性收窄飞书事件，仅接受文本消息；其余类型忽略。 */
function normalizeInbound(data: unknown): NormalizedInbound | null {
  const envelope = data as {
    message?: { message_id?: string; chat_id?: string; message_type?: string; content?: string };
  };
  const message = envelope?.message;
  if (!message?.message_id || !message.chat_id) return null;
  if (message.message_type !== "text" || !message.content) return null;
  try {
    const parsed = JSON.parse(message.content) as { text?: string };
    if (!parsed.text) return null;
    return { chatId: message.chat_id, messageId: message.message_id, text: parsed.text };
  } catch {
    return null;
  }
}

function extractMessageId(response: unknown): string | null {
  const payload = response as { data?: { message_id?: string } };
  return payload?.data?.message_id ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
