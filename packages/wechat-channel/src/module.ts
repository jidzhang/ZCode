import {
  isChannelTaskMode,
  isReplyMode,
  type WechatChannelHandle,
  type WechatChannelOptions,
} from "./contract.js";
import { WechatChannelCoordinator } from "./app/coordinator.js";
import type { EnginePort, WeixinPort } from "./app/ports.js";
import { EngineClient } from "./adapters/engineClient.js";
import { WeixinClient } from "./adapters/weixinClient.js";

/** 装配入口：contract.startWechatChannel 的实现。 */
export async function startWechatChannelImpl(
  options: WechatChannelOptions,
): Promise<WechatChannelHandle> {
  const logger = console;
  const typingEnabled = options.typingEnabled ?? true;
  const engine: EnginePort = new EngineClient({
    wsUrl: options.engineWsUrl,
    workspacePath: options.workspacePath,
    taskMode: options.taskMode && isChannelTaskMode(options.taskMode) ? options.taskMode : "yolo",
    logger,
  });
  const weixin: WeixinPort = new WeixinClient({
    botToken: options.botToken,
    ...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
    logger,
  });
  const coordinator = new WechatChannelCoordinator(engine, weixin, {
    defaultReplyMode:
      options.defaultReplyMode && isReplyMode(options.defaultReplyMode)
        ? options.defaultReplyMode
        : "stream",
    allowedUserIds: options.allowedUserIds,
    typingEnabled,
    typingThrottleMs: options.typingThrottleMs ?? 10_000,
    logger,
  });

  coordinator.start();
  await engine.initialize();
  await weixin.start();

  return {
    async stop(): Promise<void> {
      await weixin.dispose();
      await engine.dispose();
    },
  };
}
