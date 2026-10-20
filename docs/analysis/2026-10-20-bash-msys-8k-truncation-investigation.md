# Bash 脚本 ~8.19KB 静默截断与引号失败调查

- 调查日期：2026-10-20。
- 症状：近期会话频繁出现 heredoc 和含引号的 Bash 命令失败；每次都被立即发现并手工修改，但同类错误反复出现。
- 触发问题：软件层面能否避免同类错误反复发生。
- 数据材料：`~/.zcode/cli/db/db.sqlite`（`part` 表约 5 周 103,755 条、`tool_usage` 表 24,815 条，只读查询）＋会话内最小复现探针。
- 状态：调查报告，修复未实施。短期缓解已录入全局经验教训库；长期修复设计见第 5 节，待排期。

结论：失败分三类，最大一类（12 次）不是模型错误，而是 Git-for-Windows 的 msys-2.0.dll 对 `bash -c` 单参脚本存在 ~8192 字节固定缓冲——超长部分静默截断、进程仍以 exit 0 结束，无任何报错。错误反馈把传输层截断归咎于模型 heredoc 语法（`here-document delimited by end-of-file`），模型按提示改语法永远改不对，这是"反复犯同一错误"的主因。第二类约 20 次是模型引号习惯缺陷（路径尾反斜杠逃逸闭引号、双引号内裸反引号），可通过预执行静态检查拦截。第三类 6 次是模型输出 max-tokens 中途截断，存储的命令本身缺少结束符，可直接判别。

## 1. 执行链路与失败分类

### 1.1 当前执行链路

posix-bash profile 下，Bash 工具最终以 `spawn(gitBash.exe, ["-c", "-l", script], { shell: false })` 执行，`script` 由三段拼接：

```text
embedded-search prelude（函数定义等）
        ↓
用户命令本体
        ↓
cwd-capture wrapper（3 行）：
  __zcode_status=$?
  if [ "$__zcode_status" -eq 0 ]; then pwd -P > '<tmpfile>'; fi
  exit "$__zcode_status"
```

关键文件：

| 文件 | 作用 |
| --- | --- |
| `apps/zcode-cli/packages/adapters/src/exec/execution-command.ts` | 解析 shell profile，Git Bash 时产出 `args: ["-c", "-l", command]` |
| `apps/zcode-cli/packages/adapters/src/exec/bash-shell-provider.ts` | `createGitBashProvider`：`shell: false`、`GIT_EDITOR`/`SHELL` 覆盖 |
| `apps/zcode-cli/packages/adapters/src/exec/cwd-capture.ts` | 拼接 cwd 捕获 wrapper 三行 |
| `apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-process.ts` | `prepareChildSpawn`：登录模式决策与最终 spawn |
| `packages/core/src/tool/handlers/bash.ts` | 仅有输出限制 `MAX_INLINE_OUTPUT_BYTES = 30_000`，无输入长度限制 |

wrapper 的存在解释了失败样本中 `__zcode_status=$?` 出现在 python stdin 内容里的现象：截断点落在用户命令内部时，剩余尾部连同 wrapper 一起被吞。

### 1.2 三类失败统计（近 5 周，排除调查会话自身）

| 类别 | 次数 | 特征 | 责任方 |
| --- | --- | --- | --- |
| msys-2.0.dll 静默截断 | 12 | 存储完整、bash 实收不全、报 heredoc EOF / SyntaxError、exit 非 0 | 基础设施（msys 缓冲） |
| 引号习惯类 | ~20 | `"D:\dir\"` 尾 `\` 逃逸闭引号 → `unexpected EOF while looking for matching '"'`；双引号内裸反引号触发命令替换 | 模型生成习惯 |
| max-tokens 中途截断 | 6 | 存储的命令本身就没有结束符（heredoc 无 EOF 行、引号不闭合） | 模型输出上限 |

口径说明：LIKE 签名统计必须排除当前调查会话自身的查询行，否则自污染；`python - <<EOF` 场景里 python 先消费全部 stdin 作源码属正常行为，不是 bug，第一批统计曾误计。

## 2. 截断问题证据链

1. 存储侧完整：SQLite `part` 表保存的 `state.input.command` 字节数超过 8300；同一命令 bash 实际只收到约 7.2KB（由报错行号与内容位置反推）。
2. 历史边界：5 周内成功执行的 heredoc 命令最长 7,530 字节；失败样本最小 8,303 字节。中间无样本。
3. 最小复现：直接 `spawn("...\\bash.exe", ["-c", script], { shell: false })`，脚本尾部放 `echo MARKER_REACHED`：

   | 脚本总字节 | MARKER 是否出现 | exit code |
   | --- | --- | --- |
   | 8,169 | 是 | 0 |
   | 8,209 | 否（静默丢尾） | 0 |

4. 责任方定位：同一 16,000 字符 argv 传给原生 `node.exe` 无损 → 截断发生在 MSYS 层（msys-2.0.dll 对 `-c` 参数的固定缓冲），不是 libuv/Node，也不是拼接逻辑丢字。
5. 错误形态：结束符 `EOF` 落在截断点之后 → bash 报 `here-document delimited by end-of-file (wanted 'EOF')` → 下游解释器（如 python）收到残缺源码报 SyntaxError → 错误文本被原样回给模型，全程无"命令被截断"的提示。

运行版（官方 3.15.3 桌面后端）补充观察：单行 8,500 字符内联命令经工具层报 `spawn ENAMETOOLONG`，是同一缓冲约束的另一种表现形态，与 fork 最小复现的静默截断并存，未深究。

## 3. 引号习惯类机理

- `"D:\dir\"`：双引号内的 `\"` 是转义引号，闭引号被吞，bash 继续找配对引号直至脚本末尾。Windows 路径习惯尾带反斜杠，与 bash 转义规则冲突。
- 双引号内裸反引号：触发命令替换，嵌套引号配对错乱。
- 特征是同一天同一 subagent 链路连犯 3 次以上：错误反馈（`unexpected EOF while looking for matching '"'`）没有指出具体位置，模型修正命中率低。

## 4. 为什么"经验库已有教训"仍反复失败

- 教训库对 subagent 和新会话不可靠携带：子代理不会自动继承主会话沉淀的教训。
- 截断类靠提示无解：反馈失真使模型从错误文本中得出的结论（"我语法写错了"）与真相（"命令被截断了"）相反，模型无法自救。
- 结论：必须由软件在执行链路上消解，而不是靠提示词防御。

## 5. 修复设计（未实施）

按层次分四项，1＋2 为根治组合，建议一起做：

1. **根治截断（exec 层交付方式改造）**：命令超阈值（建议 7.5KB）时不再走 `bash -c <script>`，改走 stdin 交付（`bash -l -s`，脚本经 stdin 写入）或临时脚本文件。长度风险在基础设施层消解，对模型透明。改动点集中在 `node-execution-adapter-process.ts` 的 spawn 参数与 `execution-command.ts` 的命令解析；需同步验证 cwd-capture wrapper、登录模式快照、`ExecutionRequest.stdin` 现有管道（`writeChildInput` 已具备 stdin 写入能力）与 Windows 进程树清理路径。
2. **反馈诚实（截断签名附注）**：工具结果后处理检测"EOF 型语法错误 ＋ 命令长度 ≥ 阈值"签名时，在结果中附注"命令在传输层被截断，已执行部分不完整"，把归因从模型语法纠正为基础设施，即使保留 `-c` 交付也不再误导。
3. **预执行静态 lint**：spawn 前扫描两类已确认陷阱——双引号内以反斜杠收尾的路径字面量、双引号内裸反引号——命中即拒绝执行并给出明确修正建议。拦截点建议在 `packages/core/src/tool/handlers/bash.ts`（该文件当前无输入侧校验）。
4. **提示层辅助**：bash 工具描述中提示"大段脚本先 Write 落盘再执行"。对截断类无实质作用，仅辅助引号类，优先级最低。

验收场景：

- 10KB heredoc 命令完整执行、MARKER 到达、exit 0。
- 构造 9KB 命令制造截断签名，工具结果包含截断附注而非纯语法错误。
- `"C:\dir\"` 型命令被 lint 拒绝且报错指明尾反斜杠转义问题。
- 既有测试全绿：`execution-command`、`cwd-capture`、bash handler 相关单测，以及 Linux/macOS 平台回归（交付方式改造不得影响 posix 直跑路径）。
