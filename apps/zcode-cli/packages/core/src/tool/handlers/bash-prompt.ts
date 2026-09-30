export function createBashProviderDescription(input: {
  defaultTimeoutMs: number;
  embeddedSearchEnabled?: boolean;
  maxTimeoutMs: number;
}): string {
  const avoidCommands = input.embeddedSearchEnabled
    ? "`cat`, `head`, `tail`, `sed`, `awk`, or `echo`"
    : "`find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo`";
  // 本地优化(2026-09-30 实测依据):增强搜索分支下 find/grep 不列入避免清单(grep 会
  // 透明替换为 ugrep),但模型实测不会主动用 PATH 上现成的 rg 做文件定位(cmd 测试机
  // 第二跳选 findstr;git-bash 下 find 不包装)。补一句 rg --files 引导,把文件定位
  // 引到 ignore-aware 的 ripgrep 上;--sortr=modified 对齐 Glob 工具的 mtime 降序策略。
  const searchLines = input.embeddedSearchEnabled
    ? [
        "- For finding files by name, prefer `rg --files -g '<glob>'` (fast, respects ignore files; add `--sortr=modified` for most recently changed first) over `find | grep` pipelines, when `rg` is on PATH.",
      ]
    : [];

  return [
    "Executes a bash command and returns its output.",
    "",
    "- Working directory persists between calls, but prefer absolute paths — `cd` in a compound command can trigger a permission prompt. Shell state (env vars, functions) does not persist; the shell is initialized from the user's profile.",
    `- IMPORTANT: Avoid using this tool to run ${avoidCommands} commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user.`,
    ...searchLines,
    `- \`timeout\` is in milliseconds: default ${input.defaultTimeoutMs}, max ${input.maxTimeoutMs}.`,
    "- `run_in_background` runs the command detached: it keeps running across turns and re-invokes you when it exits. No `&` needed.",
    "",
    "# Git",
    "- Interactive flags (`-i`, e.g. `git rebase -i`, `git add -i`) are not supported in this environment.",
    "- Use the `gh` CLI for GitHub operations (PRs, issues, API).",
    "- Commit or push only when the user asks. If on the default branch, branch first.",
  ].join("\n");
}
