# 侧栏项目名与任务行文字层级

2026-11-16：左侧项目侧栏中，项目名与项目内任务行标题用同一主字号 `text-ui-base`，颜色分两档：任务行标题保持实色 `text-foreground`；项目名用 `text-foreground/85`，比任务行浅半档，用于区分「项目（一级容器）」与「任务（二级条目）」。

## 演进

- 原状：项目名 `text-foreground-subtle`（70%），任务行实色。用户反馈项目名太虚。
- 5b474294（2026-11-11）：项目名提到实色 `text-foreground`，随后用户反馈与任务行同色、两级混淆。
- 本次：项目名取 `text-foreground/85` 中间档（oklab 透明度混合，明暗主题均随 `--color-foreground` 走）。不新增 token；`text-foreground/<n>` 是仓库既有写法（tabs、stack-trace 等）。

分区标题（置顶/日期）、空态、显示更多入口维持 `text-foreground-subtle` 辅助档不变；扁平任务列表（无项目分组）任务行仍为实色。

## 验收

改的是唯一渲染点 `ProjectNodeContent` 的项目名 span；hover/选中态未改（项目名不随 hover 提亮，与改前一致）。桌面与手机远控共用该组件与主题 token。验证走 `pnpm typecheck` + `pnpm lint`，视觉由用户在本地打包实机确认。
