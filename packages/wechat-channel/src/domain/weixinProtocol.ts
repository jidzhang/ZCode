/**
 * 微信 iLink bot 协议的纯构造/解析层（无 IO、无 await、无 node 内置依赖）。
 * 协议事实来源与字段候选表见同目录 SPEC.md「协议事实」一节；
 * 多候选字段名依次回退是对闭源实现宽容读取风格的镜像。
 */

export const WEIXIN_API_BASE = "https://ilinkai.weixin.qq.com";
export const WEIXIN_BOT_PATH = "/ilink/bot";
const CHANNEL_VERSION = "2.0.0";

/** 闭源实现的发送常量：message_type=2 / message_state=2；入站 message_type=2 是自发回显。 */
export const OUTBOUND_MESSAGE_TYPE = 2;
export const OUTBOUND_MESSAGE_STATE = 2;
export const SELF_ECHO_MESSAGE_TYPE = 2;

/** QR 轮询间隔与有效期缺省（闭源：3s / 120s）。 */
export const QR_POLL_INTERVAL_MS = 3_000;
export const QR_DEFAULT_EXPIRES_SECONDS = 120;

export type WeixinChatType = "private" | "group";

/** 解析后的入站私聊文本消息（协议层输出，coordinator 消费）。 */
export interface ParsedInboundMessage {
  userId: string;
  messageId: string;
  text: string;
  contextToken?: string;
  displayName?: string;
  chatType: WeixinChatType;
}

/** iLink 业务失败（ret/errcode 非零），message 面向日志，不含内部地址。 */
export class WeixinApiError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`Weixin iLink ${path} failed: ${message}`);
    this.name = "WeixinApiError";
  }
}

// ── 请求构造 ──

/** 闭源镜像：随机 uint32 的十进制字符串取 utf8 字节再 base64。uin 由调用方注入以便测试。 */
export function buildWechatUin(uin: number): string {
  return Buffer.from(String(Math.floor(uin) % 4_294_967_296), "utf8").toString("base64");
}

export function buildBotHeaders(botToken: string, uin: string): Record<string, string> {
  return {
    "content-type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${botToken}`,
    "X-WECHAT-UIN": uin,
  };
}

/** 登录接口的 GET 仅带客户端版本头，无需 token。 */
export function buildLoginHeaders(): Record<string, string> {
  return { "iLink-App-ClientVersion": "1" };
}

function withBaseInfo(body: Record<string, unknown>): Record<string, unknown> {
  return { base_info: { channel_version: CHANNEL_VERSION }, ...body };
}

export function buildGetUpdatesBody(buf: string | undefined): Record<string, unknown> {
  return withBaseInfo({ get_updates_buf: buf ?? "" });
}

export function buildSendTextBody(params: {
  fromUserId: string;
  toUserId: string;
  clientId: string;
  text: string;
  contextToken?: string;
}): Record<string, unknown> {
  const msg: Record<string, unknown> = {
    from_user_id: params.fromUserId,
    to_user_id: params.toUserId,
    client_id: params.clientId,
    message_type: OUTBOUND_MESSAGE_TYPE,
    message_state: OUTBOUND_MESSAGE_STATE,
    item_list: [{ type: 1, text_item: { text: normalizeTextForSend(params.text) } }],
  };
  if (params.contextToken) msg.context_token = params.contextToken;
  return withBaseInfo({ msg });
}

export function buildGetConfigBody(params: {
  userId: string;
  contextToken?: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = { ilink_user_id: params.userId };
  if (params.contextToken) body.context_token = params.contextToken;
  return withBaseInfo(body);
}

export function buildSendTypingBody(params: {
  userId: string;
  typingTicket: string;
}): Record<string, unknown> {
  return withBaseInfo({
    ilink_user_id: params.userId,
    typing_ticket: params.typingTicket,
    status: 1,
  });
}

/** 闭源镜像：发出文本统一 CRLF 换行。 */
export function normalizeTextForSend(text: string): string {
  return text.replace(/\r\n|\r|\n/gu, "\r\n");
}

// ── 响应解析 ──

/** ret/errcode 校验；两字段都缺省视为成功（闭源同一语义）。 */
export function assertApiOk(path: string, payload: unknown): void {
  if (!isRecord(payload)) return;
  const ret = readNumber(payload, "ret");
  const errcode = readNumber(payload, "errcode");
  if ((ret !== null && ret !== 0) || (errcode !== null && errcode !== 0)) {
    const message =
      readString(payload, "errmsg") ||
      readString(payload, "message") ||
      `ret=${ret ?? ""} errcode=${errcode ?? ""}`.trim();
    throw new WeixinApiError(path, message);
  }
}

/** 部分响应包一层 data；解包后仍保留外层字段（闭源 unwrapData 语义）。 */
export function unwrapData(payload: unknown): Record<string, unknown> {
  if (isRecord(payload) && isRecord(payload.data)) {
    return { ...payload, ...payload.data };
  }
  return isRecord(payload) ? payload : {};
}

export interface UpdatesBatch {
  messages: readonly ParsedInboundMessage[];
  /** 服务端返回的下一游标；缺省时调用方沿用当前游标。 */
  nextBuf?: string;
}

/** 解析 getupdates 响应：解包 → 消息数组（多候选字段）→ 逐条 parseInboundUpdate。 */
export function parseUpdatesBatch(payload: unknown): UpdatesBatch {
  const container = unwrapData(payload);
  const rawList = firstArray(container, "msgs", "messages", "updates", "items", "list") ?? [];
  const nextBuf = firstString(
    container,
    "get_updates_buf",
    "buf",
    "next_buf",
    "nextBuf",
    "getUpdatesBuf",
    "syncKey",
  );
  const messages = rawList
    .map((raw) => parseInboundUpdate(raw))
    .filter((message): message is ParsedInboundMessage => message !== null);
  return { messages, nextBuf: nextBuf || undefined };
}

/**
 * 解析单条原始更新。message_type=2（自发回显）、无发送者、非文本消息返回 null；
 * 群聊消息原样返回 group，由 coordinator 决定回执与忽略。
 */
export function parseInboundUpdate(raw: unknown): ParsedInboundMessage | null {
  if (!isRecord(raw)) return null;
  if (readNumber(raw, "message_type") === SELF_ECHO_MESSAGE_TYPE) return null;
  const inner = firstRecord(raw, "msg", "message");
  const userId = readWeixinUserId(raw);
  if (!userId.trim()) return null;
  const text = readWeixinText(raw, inner);
  const chatType = firstString(raw, "room", "room_id", "roomId", "chat", "chat_id", "chatId")
    ? "group"
    : "private";
  if (!text.trim()) return null;
  const displayName = readWeixinDisplayName(raw, inner) || undefined;
  const contextToken =
    firstString(raw, "context_token", "contextToken", "context") ||
    (inner ? readString(inner, "context_token") : "") ||
    undefined;
  return {
    userId: userId.trim(),
    messageId: resolveMessageId(raw, inner, userId, text, contextToken),
    text,
    ...(contextToken ? { contextToken } : {}),
    ...(displayName ? { displayName } : {}),
    chatType,
  };
}

/** 闭源 readWeixinUserId 镜像：顶层字符串字段优先，`from`/`sender` 可为字符串或 {id, wxid} 对象。 */
function readWeixinUserId(raw: Record<string, unknown>): string {
  const direct = firstString(raw, "from_user_id", "from_user", "fromUser", "user_id", "userId");
  if (direct) return direct;
  for (const key of ["from", "user"] as const) {
    const value = raw[key];
    if (typeof value === "string" && value) return value;
  }
  const from = firstRecord(raw, "from", "sender");
  if (from) return readString(from, "id") || readString(from, "wxid");
  return "";
}

function readWeixinDisplayName(
  raw: Record<string, unknown>,
  inner: Record<string, unknown> | null,
): string {
  const direct = firstString(raw, "name", "displayName", "nickname");
  if (direct) return direct;
  const from = firstRecord(raw, "from", "sender");
  const nested = from ? readString(from, "name") || readString(from, "nickname") : "";
  if (nested) return nested;
  return inner ? readString(inner, "sender_name") : "";
}

function readWeixinText(
  raw: Record<string, unknown>,
  inner: Record<string, unknown> | null,
): string {
  const direct =
    readString(raw, "text") || readString(raw, "content") || readString(raw, "message");
  if (direct) return direct;
  const items =
    firstArray(raw, "item_list") ?? (inner ? firstArray(inner, "item_list") : undefined) ?? [];
  const parts = items
    .filter(isRecord)
    .map((item) => {
      const textItem = isRecord(item.text_item) ? item.text_item : null;
      return (textItem ? readString(textItem, "text") : "") || readString(item, "text");
    })
    .filter(Boolean);
  if (parts.length > 0) return parts.join("\n");
  return inner ? readString(inner, "text") || readString(inner, "content") : "";
}

function resolveMessageId(
  raw: Record<string, unknown>,
  inner: Record<string, unknown> | null,
  userId: string,
  text: string,
  contextToken: string | undefined,
): string {
  const nested = readNumberOrString(raw, "message_id");
  const id =
    readString(raw, "id") ||
    readString(raw, "msgid") ||
    readString(raw, "msgId") ||
    nested ||
    (inner
      ? readString(inner, "id") ||
        readString(inner, "msgid") ||
        readString(inner, "msgId") ||
        readNumberOrString(inner, "message_id")
      : "") ||
    readNumberOrString(raw, "id") ||
    readNumberOrString(raw, "msgid");
  if (id) return id;
  // 无显式 id 的更新以会话字段复合成幂等键（domain 纯字符串，不经哈希）；
  // 附带 create_time/new_msg_id/seq 等时序字段降低同文本碰撞面；
  // 闭源此处不去重，这里更保守。
  const sequence =
    firstString(raw, "create_time", "timestamp", "time", "new_msg_id", "newMsgId", "seq") ||
    (inner ? firstString(inner, "create_time", "timestamp", "time", "new_msg_id", "seq") : "");
  const suffix = sequence || contextToken || "";
  return `synthetic:${userId}:${suffix}:${text}`;
}

// ── 登录响应解析 ──

export type QrStatus = "pending" | "scanned" | "success" | "expired" | "error";

/** 闭源 normalizeQrStatus 镜像：数字 0-4 与若干字符串别名归一化。 */
export function normalizeQrStatus(value: unknown): QrStatus {
  if (typeof value === "number") {
    if (value === 0) return "pending";
    if (value === 1) return "scanned";
    if (value === 2) return "success";
    if (value === 3 || value === 4) return "expired";
    return "pending";
  }
  if (typeof value !== "string") return "pending";
  const normalized = value.toLowerCase();
  if (["confirmed", "confirm", "authorized", "success", "ok"].includes(normalized))
    return "success";
  if (["scaned", "scanned", "scan", "confirmed_wait"].includes(normalized)) return "scanned";
  if (["expired", "timeout", "cancel", "cancelled", "canceled"].includes(normalized))
    return "expired";
  if (["error", "failed", "fail"].includes(normalized)) return "error";
  return "pending";
}

export interface LoginQrcode {
  qrCode: string;
  qrUrl: string;
  expiresInSeconds: number;
}

export function parseLoginQrcode(payload: unknown): LoginQrcode {
  const data = unwrapData(payload);
  const qrCode = readString(data, "qrcode") || readString(data, "qr_code");
  const qrUrl = readString(data, "qrcode_img_content") || readString(data, "qrcode_url") || qrCode;
  if (!qrCode || !qrUrl) {
    throw new WeixinApiError("/get_bot_qrcode", "did not return a QR code");
  }
  return {
    qrCode,
    qrUrl,
    expiresInSeconds: readNumber(data, "expires_in") ?? QR_DEFAULT_EXPIRES_SECONDS,
  };
}

export interface LoginPollResult {
  status: QrStatus;
  botToken?: string;
  botId?: string;
  errorMessage?: string;
}

export function parseLoginStatus(payload: unknown): LoginPollResult {
  const data = unwrapData(payload);
  const status = normalizeQrStatus(data.status ?? data.qrcode_status ?? data.qr_status);
  if (status === "success") {
    const botToken = readString(data, "bot_token") || readString(data, "token");
    if (!botToken) {
      return {
        status: "error",
        errorMessage: "Weixin login succeeded but did not return bot_token.",
      };
    }
    return {
      status: "success",
      botToken,
      botId: readString(data, "ilink_bot_id") || readString(data, "bot_id") || undefined,
    };
  }
  if (status === "error") {
    return { status: "error", errorMessage: readString(data, "errmsg") || "Weixin login failed." };
  }
  return { status };
}

// ── 宽容字段读取 ──

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

export function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNumberOrString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value === "string") return value;
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function firstString(record: Record<string, unknown>, ...keys: readonly string[]): string {
  for (const key of keys) {
    const value = readString(record, key);
    if (value) return value;
  }
  return "";
}

function firstArray(
  record: Record<string, unknown>,
  ...keys: readonly string[]
): unknown[] | undefined {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return undefined;
}

function firstRecord(
  record: Record<string, unknown>,
  ...keys: readonly string[]
): Record<string, unknown> | null {
  for (const key of keys) {
    const value = record[key];
    if (isRecord(value)) return value;
  }
  return null;
}
