/**
 * feishu-channel 公开契约：飞书 bot 通道（复用引擎会话/队列，默认不回显工具调用）。
 * SPEC 见同目录 SPEC.md；adapters 实现细节不经过此文件暴露。
 */

/** 回复模式：final=仅最终文本；stream=流式卡片仅文本；verbose=流式卡片含工具调用行。 */
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

export interface FeishuChannelOptions {
  /** 引擎 WS 地址（zcode --web 后端 /ws/host）。 */
  engineWsUrl: string;
  /** 引擎工作区绝对路径；飞书会话统一绑定到该 workspace。 */
  workspacePath: string;
  /** 飞书自建应用凭据。 */
  appId: string;
  appSecret: string;
  /** 默认回复模式，缺省 "stream"。 */
  defaultReplyMode?: ReplyMode;
  /** 引擎任务协作模式，缺省 "yolo"（与官方飞书 bot 行为一致：不产生权限询问）。 */
  taskMode?: ChannelTaskMode;
  /** 允许的飞书 chatId 白名单；空/缺省表示不限制。 */
  allowedChatIds?: string[];
  /** 流式卡片渲染节流毫秒，缺省 800。 */
  streamThrottleMs?: number;
}

export interface FeishuChannelHandle {
  /** 停止飞书长连接并断开引擎 WS；进程级一次性。 */
  stop(): Promise<void>;
}

/**
 * 启动通道。返回后长连接已建立；引擎断连会自动重连，
 * 断连期间入站消息会收到"未接受"回执而非静默丢弃。
 */
export function startFeishuChannel(options: FeishuChannelOptions): Promise<FeishuChannelHandle> {
  return import("./module.js").then((m) => m.startFeishuChannelImpl(options));
}
