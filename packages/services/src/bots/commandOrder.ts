import type { BotCommandPolicy } from "@zcode/shared";
const BOT_POLICY_COMMAND_ORDER = [
  "status",
  "new",
  "workspace",
  "model",
  "mode",
  "thoughtLevel",
  "reply",
] as const satisfies readonly (keyof BotCommandPolicy)[];

export const BOT_MENU_COMMAND_ORDER = [
  "help",
  ...BOT_POLICY_COMMAND_ORDER,
  // task/stop/reconnect 已在解析器实现但不在 BotCommandPolicy（allowedCommands 无这些键），
  // 帮助菜单直接展示，buildHelpText 侧跳过策略检查。
  "task",
  "stop",
  "reconnect",
  "bind",
] as const;
