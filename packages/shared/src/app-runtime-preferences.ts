import { z } from "zod";

export const appToolSearchModeSchema = z.enum(["auto", "local", "off"]);
export type AppToolSearchMode = z.infer<typeof appToolSearchModeSchema>;
/**
 * App 设置缺省的 ToolSearch 模式：设置 schema、Host 偏好响应与设置页初始显示都读这一处。
 * 独立 CLI 不读 App 设置，默认值另行定义；旧 Host 协议响应缺字段时仍按 off 解析。
 */
export const DEFAULT_APP_TOOL_SEARCH_MODE: AppToolSearchMode = "off";

/**
 * settings.json `logLevel` 的 UI 可选项；与 appSettingsSchema 同源，默认 warn。
 * `off` 表示完全不写日志（阈值取 Error 之上），两侧阈值比较都是数值，天然支持。
 */
export const appLogLevelSchema = z.enum(["info", "warn", "error", "off"]);
export type AppLogLevel = z.infer<typeof appLogLevelSchema>;

export const APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL = "settings:app-runtime-preferences";
export const ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV = "ZCODE_E2E_ASK_USER_QUESTION_CLOCK_SCALE";

export const appRuntimePreferencesChangedBroadcastPayloadSchema = z
  .object({
    askUserQuestionAutoResolutionEnabled: z.boolean(),
    modelIoFullRetentionEnabled: z.boolean().default(false),
    pluginAutoRecommendationEnabled: z.boolean().default(false),
  })
  .strict();

export type AppRuntimePreferencesChangedBroadcastPayload = z.infer<
  typeof appRuntimePreferencesChangedBroadcastPayloadSchema
>;
