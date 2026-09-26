import { randomInt, randomUUID } from "node:crypto";
import {
  WEIXIN_API_BASE,
  WEIXIN_BOT_PATH,
  assertApiOk,
  buildBotHeaders,
  buildGetConfigBody,
  buildGetUpdatesBody,
  buildSendTextBody,
  buildSendTypingBody,
  buildWechatUin,
  parseUpdatesBatch,
} from "../domain/weixinProtocol.js";
import type { InboundMessage, WeixinPort } from "../app/ports.js";

/** 服务端长轮询约 90s；客户端超时留出余量，避免正常等待被判失败。 */
const POLL_TIMEOUT_MS = 95_000;
const BACKOFF_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** 连续失败达到该值后升级日志（iLink 错误码语义未公开，不做自动退出）。 */
const CONSECUTIVE_FAILURE_LOG_THRESHOLD = 10;

export interface WeixinClientOptions {
  botToken: string;
  /** 覆盖 API base（本地 mock/测试用），缺省官方地址。 */
  apiBaseUrl?: string;
  /** 发送失败后的唯一一次重试等待；避免对 iLink 重试风暴。 */
  retryDelayMs?: number;
  logger: Pick<Console, "info" | "warn" | "error">;
}

/**
 * 微信适配器：iLink bot HTTP 长轮询（出站 HTTPS，无公网回调）。
 * 协议细节全部经 domain/weixinProtocol 构造/解析；本类只管传输、游标与重试。
 */
export class WeixinClient implements WeixinPort {
  private messageHandler: ((message: InboundMessage) => Promise<void>) | null = null;
  private readonly controller = new AbortController();
  private pollLoop: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly options: WeixinClientOptions) {}

  get apiBase(): string {
    return (this.options.apiBaseUrl ?? WEIXIN_API_BASE).replace(/\/+$/u, "");
  }

  async start(): Promise<void> {
    if (this.pollLoop) return;
    this.pollLoop = this.pollForever();
    this.options.logger.info("wechat-channel", "weixin getupdates polling started");
  }

  onMessage(cb: (message: InboundMessage) => Promise<void>): void {
    this.messageHandler = cb;
  }

  async sendText(userId: string, text: string, contextToken?: string): Promise<void> {
    await this.withRetry(() =>
      this.postJson(
        "/sendmessage",
        buildSendTextBody({
          fromUserId: "",
          toUserId: userId,
          clientId: `zcode-weixin-${randomUUID()}`,
          text,
          contextToken,
        }),
      ),
    );
  }

  async sendTypingIndicator(userId: string, contextToken?: string): Promise<void> {
    // typing 是尽力而为的体验信号：任何失败静默降级，绝不影响主回复链路。
    try {
      const config = await this.postJson(
        "/getconfig",
        buildGetConfigBody({ userId, contextToken }),
      );
      const typingTicket = readTypingTicket(config);
      if (!typingTicket) return;
      await this.postJson("/sendtyping", buildSendTypingBody({ userId, typingTicket }));
    } catch (error) {
      this.options.logger.warn("wechat-channel", `typing indicator failed: ${String(error)}`);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.controller.abort();
    this.messageHandler = null;
    await this.pollLoop?.catch(() => {});
  }

  // ── 内部 ──

  private async pollForever(): Promise<void> {
    let buf: string | undefined;
    let failures = 0;
    while (!this.disposed) {
      try {
        const payload = await this.postJson(
          "/getupdates",
          buildGetUpdatesBody(buf),
          this.controller.signal,
          POLL_TIMEOUT_MS,
        );
        assertApiOk("/getupdates", payload);
        const batch = parseUpdatesBatch(payload);
        buf = batch.nextBuf ?? buf;
        failures = 0;
        for (const message of batch.messages) {
          await this.dispatch(message);
        }
      } catch (error) {
        if (this.disposed || this.controller.signal.aborted) return;
        failures += 1;
        const delay =
          BACKOFF_DELAYS_MS[Math.min(failures - 1, BACKOFF_DELAYS_MS.length - 1)] ?? 30_000;
        const suffix =
          failures >= CONSECUTIVE_FAILURE_LOG_THRESHOLD
            ? "；连续失败较多，若持续请重新扫码登录（token 可能已失效）"
            : "";
        this.options.logger.warn(
          "wechat-channel",
          `getupdates failed, retry in ${delay}ms${suffix}: ${String(error)}`,
        );
        await sleepUntil(this.controller.signal, delay);
      }
    }
  }

  private async dispatch(message: InboundMessage): Promise<void> {
    const handler = this.messageHandler;
    if (!handler) return;
    try {
      await handler(message);
    } catch (error) {
      this.options.logger.error("wechat-channel", `inbound dispatch failed: ${String(error)}`);
    }
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      const delay = this.options.retryDelayMs ?? 1_000;
      this.options.logger.warn(
        "wechat-channel",
        `weixin call failed, retry once: ${String(error)}`,
      );
      await sleep(delay);
      return fn();
    }
  }

  private async postJson(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<unknown> {
    const headers = buildBotHeaders(
      this.options.botToken,
      buildWechatUin(randomInt(0, 4_294_967_296)),
    );
    const timeoutSignal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
    const composite =
      signal && timeoutSignal
        ? AbortSignal.any([signal, timeoutSignal])
        : (signal ?? timeoutSignal);
    const response = await fetch(`${this.apiBase}${WEIXIN_BOT_PATH}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: composite,
    });
    if (!response.ok) {
      throw new Error(`Weixin iLink ${path} failed: HTTP ${response.status}`);
    }
    return (await response.json()) as unknown;
  }
}

function readTypingTicket(config: unknown): string {
  const record =
    typeof config === "object" && config !== null ? (config as Record<string, unknown>) : {};
  const ticket = record.typing_ticket;
  return typeof ticket === "string" ? ticket : "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepUntil(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
