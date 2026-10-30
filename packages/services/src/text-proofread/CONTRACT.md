# text-proofread

消息编辑窗「纠错」的纯逻辑：保守纠错 prompt、输出清洗、安全闸（截断/空/长度差异 ≤10 字）、
最低思考档被拒后的单次换档。规格见 `specs/text-proofread-in-edit.md`。

## 意图

用户点编辑窗「纠错」时，用会话当前模型以最低思考成本只纠正明显错别字/笔误，结果回填编辑框，
由用户自己决定修改或发送。**只建议，不自动改写、不自动发送。**

## 不变量

- 输入只有一段原文（无会话历史）；输出只回填编辑框，不写会话、不落 turn。
- 主尝试由 core 按 `querySource=text_proofread` 绑定**最低公开档**（与标题/提交信息同一约定）。
- 档位被上游拒绝时，允许用调用方给的会话档位**重试一次**，且必须报告 `fallbackUsed`
  并触发 `onReasoningFallback`——换档不能静默，坏档仍要暴露给用户去改配置。
- 只采纳等长或近似等长的结果：`|len(改后) - len(原文trim)| > 10` 直接丢弃；
  输出被截断（finishReason length/max_tokens）或清洗后为空同样丢弃。
- 少于 5 个字符（trim 后）不发请求，UI 静默无效果。

## 与其它模块的交集

- 实现方（`zcode-agent/zcodeAgentService.proofreadText`）负责把 `generate` 接到协议
  `workspace/generateText`（不新增协议方法），并把 `fallbackUsed` 转成用户提示。
- UI 只消费 `TextProofreadOutcome` 枚举，不感知错误类；未知错误由调用方统一提示失败。
