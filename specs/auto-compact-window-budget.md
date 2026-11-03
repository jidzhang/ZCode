# 自动压缩窗口预算与超窗恢复

## 背景

2026-11-03 的 deepseek-v4.1-flash 会话在约 96 万 token 处直接失败，同会话切 GLM 可继续到自动压缩。日志与数据库证据：

- 模型目录 `zcode-builtin.json` 的兜底规则 `.*` 给出 `contextWindow=1,000,000`；deepseek 专属规则只声明 `maxOutputTokens=384000`，没有单独窗口。
- 旧阈值 = 1,000,000 − 21,000（输出预留）− 13,000（buffer）= 966,000；preflight `max_tokens = 窗口 − 估算 − 1,000`，把每次请求总量顶到约 999k。
- 11-03 09:38：最后一次成功 prompt 914,774（91.5%）；下一请求估算 916,466（91.6%）、`max_tokens=82,534`（总量约 999k），上游返回 `Inference engine abort. Finish reason: [UNKNOWN]`。该文案未被识别为超窗，reactive compact 不触发，turn 直接失败。
- 11-02 04:26/04:28：同一段历史 GLM 报 692,400，切到 deepseek 后上游报 `requested 1,094,684 / 1,094,685 tokens`（`model limit 1048576`），05:24 又到 1,229,387。usage 锚点未按模型隔离，且 `Input too long` 未被识别，既不压缩也不恢复。
- 反向证据：GLM 实测 1,307,531 输入仍成功；deepseek 在 966,711 时触发过自动压缩并成功完成。压缩机制本身可用，问题在请求预算、错误识别、切模型锚点。

## 产品规则

1. **压缩阈值**：`threshold = min(floor(window × 0.90), max(0, window − outputReserve − buffer))`
   - `outputReserve = min(maxOutputTokens ?? 32k, 21k)`（沿用现有 reserve）
   - `buffer = 13k`（沿用现有 buffer）
   - 1M 窗口：900,000；200k：166,000；128k：94,000。小窗口由既有预算上限接管，行为不变。
2. **单步输出上限**：`maxTokens = min(baseline, 32k, window − estimatedUsage − margin)`。
   - `margin = min(max(ceil(window × 2%), 16k), floor(window × 5%))`
   - `available ≤ 0` 时返回 `min(baseline, 1024)`，不再回退到模型声明的完整输出预算。
   - 模型声明的 384k/64k 输出不再用于把窗口填满；32k 是正常单步上限。
3. **超窗识别**：
   - core 与 adapters 同时识别 `Input too long ... model limit N tokens, requested M tokens`、`maximum context length ... tokens ... requested/resulted`、`N tokens > M`。
   - `Inference engine abort` 仅在 `estimatedInputTokens ≥ 85% × window` 时归入 `context_exceeded`；低于 85% 仍按普通 provider 失败处理。
   - 命中后走既有 reactive compact + 自动重发原请求。
4. **压缩请求预算**：
   - Reactive：summary 输入按窗口 60% 预算选段，优先多保留最近 round（不丢数据）；只有单个 round 过大、无法满足预算时才裁剪最旧 round 并记录 warn。
   - token gap 解析支持 `model limit N tokens, requested M tokens` 与 `maximum context length is N ... resulted in M`。
   - Auto：保持完整 summary（92% 阈值已保证 summary + 20k 输出在窗口内），超窗时按 gap 重选。
   - Reactive 允许启用截断兜底；Auto 不允许。
5. **切模型锚点**：usage 锚点必须来自同 `providerId + modelId` 的 assistant；身份不匹配时跳过，回退本地 `chars/3` 估算。不引入探测、学习或持久化容量表。
6. **不变项**：模型目录中的窗口值、用户配置项、手动 `/compact` 入口、microcompact 行为不变。

## 状态与事件顺序

- 唯一所有者：core runtime 的 auto-compact decision（`shouldAutoCompact`）与 model-step preflight（`resolveModelStepMaxOutputTokens`）。
- 顺序：请求前预算 → 发送 → 失败分类 → reactive compact（60% 预算）→ 重建 history → 重发。无新增持久化状态。
- 切模型瞬间：新模型第一条请求前，锚点查询跳过旧模型 assistant，`tokenSource` 回退为 `estimate`。

## 验收场景

1. 1M / 200k / 128k 窗口的阈值分别为 900,000 / 166,000 / 94,000。
2. `window=1,000,000`、`estimatedUsage=916,466`、`baseline=384,000` 时，单步 `max_tokens=32,000`。
3. `Input too long: model limit 1048576 tokens, requested 1094684 tokens` 判为 `context_exceeded`。
4. `Inference engine abort` + 估算 916k/1M 判为 `context_exceeded`；估算 500k/1M 不归因。
5. GLM assistant 的 usage 锚点不会被 deepseek 复用；同模型 assistant 仍复用。
6. Reactive 压缩时，summary 输入估算 >60% 窗口时，选段结果 ≤60% 或记录裁剪 warn。
7. 既有 compact/token-limit 单测同步更新后通过；`pnpm typecheck`、`pnpm lint` 通过。

## 边界

- 跨路由计数差异（同段历史 692k vs 1.09M）不由阈值解决；由规则 5 的锚点隔离与规则 3/4 的恢复路径兜底。
- 冷恢复历史若缺 assistant 模型身份，锚点按兼容路径接受；不在本 spec 的验证范围内。