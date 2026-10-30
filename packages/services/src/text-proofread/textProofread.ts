/**
 * 消息编辑窗「纠错」的实现：保守纠错 prompt、输出清洗、安全闸与档位兜底。
 * 契约与不变量见 contract.ts，规格见 specs/text-proofread-in-edit.md。
 */
import {
  TEXT_PROOFREAD_MAX_LENGTH_DELTA,
  TEXT_PROOFREAD_MIN_CHARS,
  type TextProofreadGeneratorResult,
  type TextProofreadMessages,
  type TextProofreadOutcome,
  type TextProofreadRequest,
} from "./contract.js";

/**
 * 保守纠错约定：只改明显错别字与笔误，拿不准就保持原样。
 * 弱约束时模型会顺手润色/改写，因此规则必须写死并强调"拿不准就保留"。
 */
export const TEXT_PROOFREAD_SYSTEM_PROMPT = `You are a proofreading tool for a chat message the user is about to send.

Fix only obvious typos and obvious slip-of-the-keyboard errors in the user's text.

Rules:
- Preserve the user's meaning, wording, tone, and language exactly.
- Do not rewrite, rephrase, shorten, expand, translate, or improve style.
- Preserve code identifiers, file paths, URLs, commands, proper nouns, numbers, and deliberate wording.
- If something is not an obvious typo, or you are not sure whether it is a typo, keep it unchanged.
- Preserve line breaks and the overall structure of the text.
- Output only the corrected text: no explanations, quotes, labels, prefixes, or markdown fences.`;

export function buildTextProofreadMessages(text: string): TextProofreadMessages {
  return [
    { role: "system", content: TEXT_PROOFREAD_SYSTEM_PROMPT },
    { role: "user", content: text },
  ];
}

export function shouldProofreadText(text: string): boolean {
  return text.trim().length >= TEXT_PROOFREAD_MIN_CHARS;
}

/**
 * 清洗模型输出：去掉偶发的围栏/前缀标签/整体包裹引号与首尾空白。
 * 只做"包裹层"清理，不碰正文——任何正文改动都由安全闸在长度上兜住。
 */
export function cleanProofreadOutput(raw: string): string {
  let text = raw.trim();
  const fenced = text.match(/^```[^\n]*\r?\n([\s\S]*?)\r?\n?```$/);
  if (fenced?.[1] !== undefined) text = fenced[1].trim();
  text = text.replace(
    /^(?:纠错后?|修改后?|更正后?|corrected(?:\s+text)?|fixed(?:\s+text)?|result)\s*[:：]\s*/i,
    "",
  );
  return stripWrappingQuotes(text.trim()).trim();
}

/**
 * 判断错误是否为"推理档位被上游拒绝"：core 已把坏档名写进错误
 * （specs/reasoning-degrade-retry.md），并沿 cause 链保留原始错误。
 */
export function isReasoningLevelRejectedError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const message = extractErrorMessage(current);
    if (message && REASONING_REJECTION_MARKERS.some((pattern) => pattern.test(message))) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * 执行一次纠错：主尝试用最低公开档；最低档被上游拒绝且会话当前档位可用时，
 * 用会话档位重试一次（并让调用方记录/提示，不静默隐藏坏档）。
 */
export async function runTextProofread(
  params: TextProofreadRequest,
): Promise<TextProofreadOutcome> {
  const original = params.text;
  if (!shouldProofreadText(original)) return { kind: "skipped" };

  let fallbackUsed = false;
  let result: TextProofreadGeneratorResult;
  try {
    result = await params.generate({ selection: params.selection });
  } catch (error) {
    const fallbackLevel = params.fallbackSelection?.options?.reasoningLevel;
    if (!isReasoningLevelRejectedError(error) || !params.fallbackSelection || !fallbackLevel) {
      throw error;
    }
    params.onReasoningFallback?.(error);
    fallbackUsed = true;
    result = await params.generate({
      selection: params.fallbackSelection,
      reasoningLevel: fallbackLevel,
    });
  }

  if (isTruncatedFinish(result.finishReason)) {
    return { kind: "discarded", reason: "truncated" };
  }
  const corrected = cleanProofreadOutput(result.text);
  if (!corrected) return { kind: "discarded", reason: "empty" };

  const originalTrimmed = original.trim();
  if (corrected === originalTrimmed) return { kind: "unchanged" };
  if (Math.abs(corrected.length - originalTrimmed.length) > TEXT_PROOFREAD_MAX_LENGTH_DELTA) {
    return { kind: "discarded", reason: "length-delta" };
  }
  return { kind: "corrected", text: corrected, fallbackUsed };
}

/** 供 IZCodeAgentService 组合使用的默认实现（ITextProofread）。 */
export const textProofread = {
  proofread: runTextProofread,
  isBelowMinimum: (text: string) => !shouldProofreadText(text),
} as const;

const REASONING_REJECTION_MARKERS: readonly RegExp[] = [
  /档位\s*"[^"]*"\s*被上游拒绝/,
  /reasoning[^\n]{0,48}(?:not supported|unsupported|invalid)/i,
  /(?:reasoning_effort|reasoning\.effort|thinking)[^\n]{0,64}(?:not supported|unsupported|invalid)/i,
];

function extractErrorMessage(error: unknown): string | null {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return null;
}

function isTruncatedFinish(finishReason: string | undefined): boolean {
  if (!finishReason) return false;
  const normalized = finishReason.toLowerCase();
  return normalized.includes("length") || normalized.includes("max_tokens");
}

function stripWrappingQuotes(text: string): string {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
    ["‘", "’"],
    ["「", "」"],
  ];
  for (const [open, close] of pairs) {
    if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) {
      return text.slice(open.length, text.length - close.length);
    }
  }
  return text;
}
