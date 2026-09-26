import {
  WEIXIN_API_BASE,
  WEIXIN_BOT_PATH,
  QR_POLL_INTERVAL_MS,
  assertApiOk,
  buildLoginHeaders,
  parseLoginQrcode,
  parseLoginStatus,
  type LoginPollResult,
  type LoginQrcode,
} from "../domain/weixinProtocol.js";

/** 登录 GET 的单请求超时（闭源 30s）。 */
const LOGIN_TIMEOUT_MS = 30_000;

export interface WeixinLoginDeps {
  /** 覆盖 API base（本地 mock/测试用），缺省官方地址。 */
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * 扫码登录客户端（adapters）：GET /get_bot_qrcode → 每 3s GET /get_qrcode_status。
 * 仅走登录头（iLink-App-ClientVersion: 1），成功后由调用方保管 bot_token。
 */
export class WeixinLoginClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: WeixinLoginDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  get apiBase(): string {
    return (this.deps.apiBaseUrl ?? WEIXIN_API_BASE).replace(/\/+$/u, "");
  }

  /** 获取登录二维码；qrUrl 供展示（可能为图片 URL 或二维码内容串）。 */
  async beginLogin(): Promise<LoginQrcode> {
    const payload = await this.getJson("/get_bot_qrcode?bot_type=3");
    assertApiOk("/get_bot_qrcode", payload);
    return parseLoginQrcode(payload);
  }

  /** 轮询一次扫码状态；网络异常不区分类型，直接抛出由调用方决定重试。 */
  async pollLogin(qrCode: string): Promise<LoginPollResult> {
    const payload = await this.getJson(`/get_qrcode_status?qrcode=${encodeURIComponent(qrCode)}`);
    assertApiOk("/get_qrcode_status", payload);
    return parseLoginStatus(payload);
  }

  get pollIntervalMs(): number {
    return QR_POLL_INTERVAL_MS;
  }

  private async getJson(pathAndQuery: string): Promise<unknown> {
    const response = await this.fetchImpl(`${this.apiBase}${WEIXIN_BOT_PATH}${pathAndQuery}`, {
      method: "GET",
      headers: buildLoginHeaders(),
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Weixin login ${pathAndQuery.split("?")[0]} failed: HTTP ${response.status}`);
    }
    return (await response.json()) as unknown;
  }
}
