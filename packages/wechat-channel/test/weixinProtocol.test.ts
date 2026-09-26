import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBotHeaders,
  buildGetUpdatesBody,
  buildSendTextBody,
  buildWechatUin,
  normalizeTextForSend,
  normalizeQrStatus,
  parseInboundUpdate,
  parseLoginQrcode,
  parseLoginStatus,
  parseUpdatesBatch,
  WeixinApiError,
  assertApiOk,
} from "../src/domain/weixinProtocol.js";

test("鉴权头与闭源实现逐字段一致", () => {
  const headers = buildBotHeaders("token-1", buildWechatUin(12345));
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers.AuthorizationType, "ilink_bot_token");
  assert.equal(headers.Authorization, "Bearer token-1");
  assert.equal(headers["X-WECHAT-UIN"], Buffer.from("12345", "utf8").toString("base64"));
});

test("getupdates 请求体携带 base_info 与游标", () => {
  assert.deepEqual(buildGetUpdatesBody("cursor-1"), {
    base_info: { channel_version: "2.0.0" },
    get_updates_buf: "cursor-1",
  });
  assert.deepEqual(buildGetUpdatesBody(undefined), {
    base_info: { channel_version: "2.0.0" },
    get_updates_buf: "",
  });
});

test("sendmessage 请求体结构完整：from/to/client_id/type/state/item_list", () => {
  const body = buildSendTextBody({
    fromUserId: "",
    toUserId: "wxid_abc",
    clientId: "zcode-weixin-uuid",
    text: "第一行\n第二行",
    contextToken: "ctx-1",
  }) as { msg: Record<string, unknown> };
  assert.equal(body.msg.from_user_id, "");
  assert.equal(body.msg.to_user_id, "wxid_abc");
  assert.equal(body.msg.client_id, "zcode-weixin-uuid");
  assert.equal(body.msg.message_type, 2);
  assert.equal(body.msg.message_state, 2);
  assert.equal(body.msg.context_token, "ctx-1");
  assert.deepEqual(body.msg.item_list, [{ type: 1, text_item: { text: "第一行\r\n第二行" } }]);
  assert.deepEqual((body as Record<string, unknown>).base_info, { channel_version: "2.0.0" });
});

test("sendmessage 缺少 context_token 时不带该字段", () => {
  const body = buildSendTextBody({
    fromUserId: "",
    toUserId: "wxid_abc",
    clientId: "c",
    text: "hi",
  }) as { msg: Record<string, unknown> };
  assert.equal("context_token" in body.msg, false);
});

test("发出文本统一 CRLF 换行（闭源镜像）", () => {
  assert.equal(normalizeTextForSend("a\nb\rc\r\nd"), "a\r\nb\r\nc\r\nd");
});

test("入站解析：闭源 getupdates 典型形态（item_list.text_item + from_user_id）", () => {
  const message = parseInboundUpdate({
    message_type: 1,
    from_user_id: "wxid_user",
    context_token: "ctx-9",
    item_list: [{ type: 1, text_item: { text: "帮我看看这个报错" } }],
  });
  assert.deepEqual(message, {
    userId: "wxid_user",
    messageId: message?.messageId,
    text: "帮我看看这个报错",
    contextToken: "ctx-9",
    chatType: "private",
  });
  assert.ok(message?.messageId?.length);
});

test("入站解析：message_type=2 为自发回显，必须跳过", () => {
  assert.equal(
    parseInboundUpdate({ message_type: 2, from_user_id: "wxid_user", text: "echo" }),
    null,
  );
});

test("入站解析：from 为 {id} 对象时仍能提取发送者", () => {
  const message = parseInboundUpdate({
    text: "hi",
    from: { id: "wxid_obj" },
  });
  assert.equal(message?.userId, "wxid_obj");
});

test("入站解析：群聊标记为 group，缺发送者/空文本返回 null", () => {
  const group = parseInboundUpdate({ text: "hi", from_user_id: "wxid_a", room_id: "room-1" });
  assert.equal(group?.chatType, "group");
  assert.equal(parseInboundUpdate({ text: "no sender" }), null);
  assert.equal(parseInboundUpdate({ from_user_id: "wxid_a", item_list: [] }), null);
});

test("入站解析：无显式 message_id 时以复合键合成幂等键且稳定", () => {
  const raw = { text: "重复投递", from_user_id: "wxid_a", context_token: "ctx" };
  const first = parseInboundUpdate(raw);
  const second = parseInboundUpdate({ ...raw });
  assert.equal(first?.messageId, second?.messageId);
  assert.notEqual(first?.messageId, parseInboundUpdate({ ...raw, text: "其他消息" })?.messageId);
});

test("parseUpdatesBatch：解包 data、msgs 数组、游标透传", () => {
  const batch = parseUpdatesBatch({
    ret: 0,
    data: {
      get_updates_buf: "cursor-next",
      msgs: [
        { message_type: 1, from_user_id: "wxid_a", text: "第一条" },
        { message_type: 2, from_user_id: "wxid_a", text: "自发回显" },
      ],
    },
  });
  assert.equal(batch.messages.length, 1);
  assert.equal(batch.messages[0]?.text, "第一条");
  assert.equal(batch.nextBuf, "cursor-next");
});

test("parseUpdatesBatch：无游标时沿用当前（nextBuf 为 undefined）", () => {
  const batch = parseUpdatesBatch({ data: { msgs: [] } });
  assert.equal(batch.nextBuf, undefined);
});

test("assertApiOk：ret/errcode 非零抛 WeixinApiError，优先 errmsg", () => {
  assert.throws(
    () => assertApiOk("/sendmessage", { ret: -1, errmsg: "bad token" }),
    (error) => {
      assert.ok(error instanceof WeixinApiError);
      assert.match(error.message, /\/sendmessage failed: bad token/);
      return true;
    },
  );
  assert.doesNotThrow(() => assertApiOk("/sendmessage", { ret: 0 }));
  // 两字段缺省视为成功（闭源同一语义）。
  assert.doesNotThrow(() => assertApiOk("/sendmessage", {}));
});

test("二维码状态归一化覆盖闭源全部取值", () => {
  assert.equal(normalizeQrStatus(0), "pending");
  assert.equal(normalizeQrStatus(1), "scanned");
  assert.equal(normalizeQrStatus(2), "success");
  assert.equal(normalizeQrStatus(3), "expired");
  assert.equal(normalizeQrStatus(4), "expired");
  assert.equal(normalizeQrStatus("SCANED"), "scanned");
  assert.equal(normalizeQrStatus("confirmed"), "success");
  assert.equal(normalizeQrStatus("timeout"), "expired");
  assert.equal(normalizeQrStatus("whatever"), "pending");
});

test("登录响应解析：二维码与成功态", () => {
  const qr = parseLoginQrcode({
    data: { qrcode: "QR123", qrcode_img_content: "https://example.test/qr.png", expires_in: 60 },
  });
  assert.deepEqual(qr, {
    qrCode: "QR123",
    qrUrl: "https://example.test/qr.png",
    expiresInSeconds: 60,
  });
  assert.throws(() => parseLoginQrcode({ data: {} }), WeixinApiError);

  const success = parseLoginStatus({
    data: { status: 2, bot_token: "tk-1", ilink_bot_id: "bot-1" },
  });
  assert.deepEqual(success, { status: "success", botToken: "tk-1", botId: "bot-1" });

  const noToken = parseLoginStatus({ data: { status: 2 } });
  assert.equal(noToken.status, "error");

  assert.deepEqual(parseLoginStatus({ data: { status: 1 } }), { status: "scanned" });
});
