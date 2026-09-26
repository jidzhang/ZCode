import {
  isChannelTaskMode,
  isReplyMode,
  type FeishuChannelHandle,
  type FeishuChannelOptions,
} from "./contract.js";
import { FeishuChannelCoordinator } from "./app/coordinator.js";
import type { EnginePort, FeishuPort } from "./app/ports.js";
import { EngineClient } from "./adapters/engineClient.js";
import { FeishuClient } from "./adapters/feishuClient.js";

/** 装配入口：contract.startFeishuChannel 的实现。 */
export async function startFeishuChannelImpl(
  options: FeishuChannelOptions,
): Promise<FeishuChannelHandle> {
  const logger = console;
  const engine: EnginePort = new EngineClient({
    wsUrl: options.engineWsUrl,
    workspacePath: options.workspacePath,
    taskMode: options.taskMode && isChannelTaskMode(options.taskMode) ? options.taskMode : "yolo",
    logger,
  });
  const feishu: FeishuPort = new FeishuClient({
    appId: options.appId,
    appSecret: options.appSecret,
    logger,
  });
  const coordinator = new FeishuChannelCoordinator(engine, feishu, {
    defaultReplyMode:
      options.defaultReplyMode && isReplyMode(options.defaultReplyMode)
        ? options.defaultReplyMode
        : "stream",
    allowedChatIds: options.allowedChatIds,
    streamThrottleMs: options.streamThrottleMs ?? 800,
    logger,
  });

  coordinator.start();
  await engine.initialize();
  await feishu.start();

  return {
    async stop(): Promise<void> {
      await feishu.dispose();
      await engine.dispose();
    },
  };
}
