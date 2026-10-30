import type { ModelSelection, ZCodeWorkspaceModelMessage } from "@zcode/shared";

/**
 * text-proofread 对外契约：消息编辑窗「纠错」的纯逻辑接口、共享常量与结果类型。
 * 规格见 specs/text-proofread-in-edit.md；实现见 textProofread.ts。
 *
 * 不变量：
 * - 只处理一段原文，不读会话历史；输出只回填编辑框，不自动发送。
 * - 任何"可能改写本意"的输出（长度差异超过阈值、被截断、空）都不采纳。
 * - 最低思考档由 core 按 querySource 绑定；档位被上游拒绝时允许用调用方给的
 *   会话档位重试一次，且必须报告 fallbackUsed，不能静默改档。
 */

/** 纠错请求的协议 querySource；core 据此绑定最低公开档位。 */
export const TEXT_PROOFREAD_QUERY_SOURCE = "text_proofread";
/** 编辑框 trim 后不足该字数时，点击不做任何事、不发请求。 */
export const TEXT_PROOFREAD_MIN_CHARS = 5;
/** 纠错只应是等长或近似等长的替换；与原文相差超过该字数即判为改写并丢弃。 */
export const TEXT_PROOFREAD_MAX_LENGTH_DELTA = 10;

export type TextProofreadDiscardReason = "truncated" | "empty" | "length-delta";

export type TextProofreadOutcome =
  | { kind: "skipped" }
  | { kind: "unchanged" }
  /** 输出验收不通过：调用方提示后保留原文，不改动编辑框。 */
  | { kind: "discarded"; reason: TextProofreadDiscardReason }
  | { kind: "corrected"; text: string; fallbackUsed: boolean };

export interface TextProofreadAttempt {
  selection: ModelSelection;
  /**
   * undefined = 由 core 按 querySource 绑定最低公开档（主尝试）；
   * 有值 = 显式档位（最低档被上游拒绝后的兜底重试）。
   */
  reasoningLevel?: string;
}

export interface TextProofreadGeneratorResult {
  text: string;
  finishReason?: string;
}

export interface TextProofreadRequest {
  /** 编辑框当前正文（原样传入，不 trim 回写）。 */
  text: string;
  /** 会话当前模型 + 用户当前档位。 */
  selection: ModelSelection;
  /** 兜底选择：通常与 selection 相同；只有它自带 reasoningLevel 时才会被用于重试。 */
  fallbackSelection?: ModelSelection | null;
  /** 执行一次模型调用（协议 workspace/generateText）。 */
  generate: (attempt: TextProofreadAttempt) => Promise<TextProofreadGeneratorResult>;
  /** 发生档位兜底时回调（调用方记 warn 并提示用户）。 */
  onReasoningFallback?: (error: unknown) => void;
}

/** 纠错模块的公开意图：一个纠错、一个门槛判断。 */
export interface ITextProofread {
  /**
   * 纠错。前置：text 为编辑框原文。后置：返回 skipped/unchanged/discarded/corrected 之一，
   * 只有 corrected 携带可回填的正文。无副作用、不缓存、不写会话。
   */
  proofread(request: TextProofreadRequest): Promise<TextProofreadOutcome>;
  /** 低于最小字数：UI 应静默无效果、不发请求。 */
  isBelowMinimum(text: string): boolean;
}

/** 纠错 prompt 的两段输入：system 约束 + 原文，不给会话上下文。 */
export type TextProofreadMessages = ZCodeWorkspaceModelMessage[];
