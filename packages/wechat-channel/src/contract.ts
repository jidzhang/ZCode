/**
 * wechat-channel 公开契约：微信 iLink bot 通道（复用引擎会话/队列，纯文本降级渲染）。
 * SPEC 见同目录 SPEC.md；adapters 实现细节不经过此文件暴露。
 */

/** 回复模式：final=仅最终文本；stream=接受回执+typing 指示+终态文本；verbose=终态附工具行。
 * 取值与飞书通道保持同一命令面；微信为纯文本媒介，stream 无中间内容更新。 */
export type ReplyMode = "final" | "stream" | "verbose";

export const REPLY_MODES: readonly ReplyMode[] = ["final", "stream", "verbose"];

export function isReplyMode(value: string): value is ReplyMode {
  return (REPLY_MODES as readonly string[]).includes(value);
}

/** 通道建任务用的引擎协作模式；与 @zcode/shared 的 ZCodeTaskMode 取值一致。 */
export type ChannelTaskMode = "yolo" | "plan" | "edit" | "auto" | "autoEdit" | "build";

export const CHANNEL_TASK_MODES: readonly ChannelTaskMode[] = [
  "yolo",
  "plan",
  "edit",
  "auto",
  "autoEdit",
  "build",
];

export function isChannelTaskMode(value: string): value is ChannelTaskMode {
  return (CHANNEL_TASK_MODES as readonly string[]).includes(value);
}

export interface WechatChannelOptions {
  /** 引擎 WS 地址（zcode --web 后端 /ws/host）。 */
  engineWsUrl: string;
  /** 引擎工作区绝对路径；微信会话统一绑定到该 workspace。 */
  workspacePath: string;
  /** iLink bot token（scripts/wechat-login.mjs 扫码登录获得）。 */
  botToken: string;
  /** 默认回复模式，缺省 "stream"。 */
  defaultReplyMode?: ReplyMode;
  /** 引擎任务协作模式，缺省 "yolo"（与官方 bot 行为一致：不产生权限询问）。 */
  taskMode?: ChannelTaskMode;
  /** 允许的微信 userId 白名单；空/缺省表示不限制。 */
  allowedUserIds?: string[];
  /** stream/verbose 模式 typing 指示刷新节流毫秒，缺省 10_000。 */
  typingThrottleMs?: number;
  /** 是否启用 typing 指示，缺省 true。 */
  typingEnabled?: boolean;
  /** 覆盖 iLink API base（本地 mock/测试用）。 */
  apiBaseUrl?: string;
}

export interface WechatChannelHandle {
  /** 停止微信长轮询并断开引擎 WS；进程级一次性。 */
  stop(): Promise<void>;
}

/**
 * 启动通道。返回后长轮询已建立；引擎断连会自动重连，
 * 断连期间入站消息会收到"未接受"回执而非静默丢弃。
 */
export function startWechatChannel(options: WechatChannelOptions): Promise<WechatChannelHandle> {
  return import("./module.js").then((m) => m.startWechatChannelImpl(options));
}
