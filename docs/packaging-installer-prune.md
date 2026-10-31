# 安装包裁剪记录（3.17.1 起）

> 目的：记录 2026-10-31 首次安装包瘦身删除了什么、依据是什么、如何验证、如何恢复。
> 背景：3.16.2-safe.8（181.2 MiB）→ 3.17.1 合并后（215.5 MiB）体积跳涨 34 MiB，
> 用户要求在"不破坏运行"的前提下瘦身。

## 结果

| 版本              | 体积          | 说明                               |
| ----------------- | ------------- | ---------------------------------- |
| 3.16.2-safe.8     | 181.2 MiB     | 合并前基线                         |
| 3.17.1 原始合并包 | 215.5 MiB     | 上游 3.17.1 + CUA helper E44       |
| 3.17.1 裁剪后     | **176.2 MiB** | 本文档所述裁剪（-39.3 MiB / -18%） |

官方 3.16.3 安装包为 182.0 MiB（Electron 41、无内置 npm），裁剪后 fork 比官方小 6 MiB。

## 删了什么

`packages/desktop/electron-builder.config.js` 的 `PACKAGING_PRUNE_PATTERNS` 新增 71 个
`!node_modules/<pkg>/**` 排除项（见该文件内 2026-10-31 注释块，含逐包清单）。这些包全部
满足以下三个条件，缺一不删：

1. **main 侧零引用**：在 main/host/preload/services/rpc/client/provider/provider-node/
   shared/server 全部源码（约 1300 文件）中，`import`/`require`/动态字符串引用计数为 0。
2. **不在运行时外部依赖闭包内**：tsup 的 `desktopNodeRuntimeExternals`
   （electron、node-pty、ssh2、undici、@larksuiteoapi/node-sdk、yaml、node-forge、yauzl）
   及 playwright-core 的 package.json 依赖递归闭包（共 66 包）里的包一律保留——
   该闭包把 axios、protobufjs、ws、qs 等从候选清单中救回。
3. **renderer/web 已自带**：这些包只被 `packages/ui`/`packages/web` 使用，两端经 Vite
   构建 bundle 进 `out/renderer` 静态资产；asar 里 `node_modules` 下的副本是 hoisted
   布局带来的纯冗余（651 个顶层包全量入包）。

典型大户（未压缩体积）：echarts 23.8、mermaid 21.2、pdfjs-dist 16.0、@extend-ai 15.3、
lottie-web 14.2、@shikijs 10.0、cytoscape-fcose 8.9、world-atlas 7.8、lucide-react 6.9、
highlight.js 5.2。合计约 219.5 MiB（未压缩），NSIS 压缩后 ≈ 39 MiB。

与上游既有先例的关系：上游在同一 files 列表里早已排除 `react`/`react-dom`/`@zcode/**`，
理由相同（Vite 已 bundle）。本裁剪是把同一逻辑延伸到全部 UI-only 依赖。

## 明确不删的

- **locales 不动**：`electronLanguages: ["en-US", "zh-CN"]` 原样，语言包仅 2 个。
- CUA helper（tools/cua-helper）与 glm agent bundle：fork 注入的功能资产。
- 所有 main 侧有引用、或在 externals 闭包内的包（含 axios/protobufjs/@types/node 等）。
- @zcode workspace 包、react/react-dom（上游既有排除，保持一致）。

## 怎么验证的

1. 体积：重打包后 215.5 → 176.2 MiB；`app.asar` 350 → 142.1 MiB。
2. 真实启动冒烟：`win-unpacked/ZCode.exe`（`ZCODE_DATA_BASE_DIR` 指向临时目录隔离），
   主进程协议注册/crash-capture/ARMS stub 正常初始化，main+GPU+renderer+host 多进程
   存活，应用日志 0 error，无 `ERR_MODULE_NOT_FOUND` / 缺模块错误。
3. 产物核验：CUA helper runtime-manifest = 44.7.0、glm node-repl-host server.js 为
   真实客户端（4.7 MiB）、main bundle 无内嵌遥测上报端点。

## 如何恢复

删除即为纯配置回退：从 `PACKAGING_PRUNE_PATTERNS` 中移除对应 `!node_modules/<pkg>/**`
行再重新打包即可。若上游后续让 main/host 直接依赖其中某个包（源码出现 import），
启动时会立即 `ERR_MODULE_NOT_FOUND <pkg>`——按报错包名从清单中移除该行是自我修复路径。

## NSIS 压缩档位实测（2026-10-31，结论：无可挤空间）

electron-builder 的 NSIS target **默认就是 `SetCompressor /SOLID lzma`**（与手写
NSIS 脚本常见的 `/SOLID lzma` 一致）。根级 `compression` 选项三档实测
（同一份裁剪后 win-unpacked，skip-build 仅重跑 NSIS 阶段）：

| 档位                    | 体积                    | NSIS 阶段耗时 |
| ----------------------- | ----------------------- | ------------- |
| normal（上游默认）      | 176.2 MiB               | ~3 分钟       |
| maximum（LZMA ultra）   | 176.2 MiB（字节级相同） | ~3 分钟       |
| store（完全不压缩对照） | 177.2 MiB               | ~2 分钟       |

store 仅比 maximum 大 1 MiB：安装包主体在 NSIS 之前已被 electron-builder 打成
高熵的 app-64.7z，NSIS 的 solid LZMA 对它压不动，最终体积被收敛到同一水平线，
档位只影响 7z/NSIS 两层怎么分工，不改地板。

结论：**176.2 MiB 就是当前数据集的体积地板**；compression 配置已从
electron-builder.config.js 移除（还原上游默认 normal，避免留一个无效选项误导
后来者）。再想减体积只有两条路：继续减数据（收益递减），或换收发形态
（如差分更新、按需下载组件），均不在本期范围。

## 附：审计脚本要点（可复现）

- 体积清单：`asar.getRawHeader(app.asar).header.files.node_modules` 递归求和。
- 引用检测：`/[\'"]<pkg>(\/|[\'"])/` 正则匹配 main 侧 8 个源码根的合并文本。
- 闭包计算：从 8 个 externals 的 package.json dependencies/optionalDependencies
  递归展开（跳过 `workspace:*`），与候选清单求交，交集保留。
