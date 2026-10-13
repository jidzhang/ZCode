# 模型连通性探针预算 spec

## 背景

设置页每行模型的"测试"按钮走正式模型执行链发一次极小探针请求
（`testModelConnectivity`，`apps/zcode-cli/packages/core/src/runtime/methods/workspace-generate-text.ts`），
用于验证鉴权、headers、reasoning 映射与流消费是否打通。

## 问题

探针曾用 `CONNECTIVITY_PROBE_MAX_OUTPUT_TOKENS = 1` 硬编码覆盖输出预算，
经 `openai-responses` 映射落到 wire 上为 `max_output_tokens: 1`。
部分上游网关（如 opencode-go-proxy 后的 `https://opencode.ai/zen/go/v1`，
要求 `max_output_tokens >= 16`）直接返回 400，
表现为"正常对话可用、测试按钮必失败"。
同时探针链路只透传 `{providerId, modelId}`，用户在模型配置里填写的
`maxOutputTokens`（`optionSpecs.maxOutputTokens.max`）被硬编码覆盖，
留空时继承的默认值（如 32000）同样被覆盖——用户填写与否都不生效。

## 规则

1. 探针输出预算 = 目标模型的有效 `optionSpecs.maxOutputTokens.max`
  （即用户填写值；留空时为内置/继承默认值，如默认档 32000），
   不再使用独立的 1 token 硬编码。
2. 有效值缺失或非正数时回落 `DEFAULT_NORMAL_REQUEST_MAX_OUTPUT_TOKENS`（32000，
   与普通对话 `resolveNormalRequestMaxOutputTokens` 同源），与灰字 placeholder 显示一致。
3. 不设独立下限：探针预算即有效 max（= `optionSpecs.maxOutputTokens.max`，
   天然通过 bind 本地校验）。曾评估对 <16 的配置钳到网关下限 16，但高于
   spec.max 的 wire 值会被 bind 拒绝，虚报也会掩盖"模型配置与网关不兼容"的
   事实——按原值发送、网关 400 如实透出。探针不改写用户配置。
4. 探针 prompt 保持不变（system `You are ZCode connectivity probe.` + user `hi`），
   无 tools，不混入会话历史。

## 状态所有者与接口

- 所有者：`testModelConnectivity`（`workspace-generate-text.ts`）。
- 输入：`ModelConnectivityTestInput.selection` + `createRuntimeModel` 解析出的
  `baseModel.optionSpecs.maxOutputTokens.max`（已含用户填写/继承合并结果，
  无需改动 `ModelSelection` schema 与整条 selection 透传链）。
- 无协议改动：`zcodeProviderTestModelConnectivityParamsSchema` 不变。

## 验收场景

1. 用户填写 maxOutputTokens=32 的 opencode-responses 模型点测试 →
   wire 上 `max_output_tokens: 32`，测试通过。
2. 留空（灰字 32000）的同类模型点测试 →
   wire 上 `max_output_tokens: 32000`，测试通过。
3. 用户手填 maxOutputTokens=8 的模型点测试 → 探针按 8 原样发送（不虚报到 16），
   用户配置值未被改写；若网关要求 >=16 而返回 400，测试如实失败并透出原始错误，
   提示用户上调模型配置。
4. 正常对话预算逻辑不变（`turn-model-step.ts` 未动）。
