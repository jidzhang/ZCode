# Reasoning 档位被拒显式报错 + 逐档连通性验证 spec

## 背景

`auxiliaryModelOptions` 取 `optionSpecs.reasoningLevel.values[0]` 作为辅助调用档位；
连通性探针早期版本同样硬编码档位。自定义 provider 的 values 首位若经 map 翻译后是
上游不支持的 effort（如 `disabled → none`，而 muse-spark 只接受
minimal/low/medium/high/xhigh），辅助调用与探针在运行时以 400
`invalid_request_error` 失败。见 `specs/model-connectivity-probe.md`。

原则：**不静默降档**。坏档必须明确汇报给用户，由用户手动删除；
运行时把问题藏起来等于把地雷留给下次。

## C：档位被拒显式报错（core runtime-model 层）

1. 位置：`withReasoningRejectReport` 包裹 `createRuntimeModel` 返回的 Model，
   一处覆盖主 turn 与全部辅助调用（generateText/streamText）。
2. 触发条件（`isReasoningLevelRejected`，`reasoning-degrade.ts`）：
   先按状态码过滤（仅 400/422），再要求 param 或 message 证据——
   param 精确名或带点前缀（`reasoning.effort`、`reasoning_effort`、`reasoning`、
   `thinking`、`effort`），message 匹配 `reasoning.*not supported` 等标记。
   cause 链下探 3 层；裸子串不匹配，避免无关 400 误判。
3. 行为：把坏档位名写进错误再上抛：
   `模型 reasoning 档位 "X" 被上游拒绝，请在模型配置中删除该档位后再试。（原始错误：…）`，
   cause 保留原错误。非档位错误原样透出。
4. 流式：以 error 事件交付的失败与抛出的异常同样换错（探针即按 error 事件消费）；
   首内容事件（text/reasoning/tool delta）之前才算"未产出"，合成 start 不算——
   已产出内容后失败是流中断，原错上抛。
5. 日志：`model.reasoning.rejected`（level/model/provider），warn 级。

## D：测试按钮逐档验证（core 探针循环）

1. `testModelConnectivity` 对 values 每一档各打一枪最小探针（预算沿用
   `specs/model-connectivity-probe.md`：有效 max，下限 16）。
2. 某档失败只记不抛，继续下一档；收尾时失败档汇总进一条错误：
   `模型连通性测试 1/3 个档位失败：disabled（…）`。
   取消传播：abort 后不再发起剩余档位（档间检查），已中止的档不计入失败。
3. 协议/UI/结果类型零改动：成功=全过，失败消息里点名坏档。
4. 探针经 C 包裹层：坏档报错已带档位名，D 只做收集与汇总。

## E：失败辅助调用写 model-io（已实现）

记录模式唯一事实源：`resolveModelIORecordingMode({env, skipTranscript})`
（`runner-debug.ts`），generate/stream 两条 runner 共用——
`full`（常规调用，成功/失败都写完整记录）、`error-summary`（skipTranscript 的
后台调用，失败只写摘要，防自反馈）、`none`（test 环境，零磁盘副作用）。
摘要含 querySource、wire 摘要（max_output_tokens / reasoning.effort / stream /
toolNames，raw capture 缺失时回落 AI SDK options 值）、错误（含一层 cause message）；
不记 messages 正文。generate/stream 共用同一摘要构造，避免双份漂移。

## 验收

1. muse-spark values 含 disabled 时：辅助调用失败报错点名 `"disabled"`，
   用户删档后恢复；测试按钮报 `1/N 个档位失败：disabled（…）`。
2. values 全合法时：零行为变化（判定函数返回 false，原错透出）。
3. GLM `[disabled, enabled]` 双档模型：disabled 合法走不到报错分支，行为不变。
