/**
 * text-proofread 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { ITextProofread, TextProofreadRequest } from "./contract.js";

export async function exampleTextProofread(
  textProofread: ITextProofread,
  input: Pick<TextProofreadRequest, "text" | "selection" | "generate">,
): Promise<string | null> {
  if (textProofread.isBelowMinimum(input.text)) return null;
  const outcome = await textProofread.proofread({
    ...input,
    fallbackSelection: input.selection,
    onReasoningFallback: () => {
      // 调用方负责 warn 日志与用户提示：换档可以，但不能静默。
    },
  });
  return outcome.kind === "corrected" ? outcome.text : null;
}
