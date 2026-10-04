# Windows 资源管理器"在 ZCode 中打开"右键菜单

## 行为

Windows 主进程在启动时与界面语言切换时，通过 `reg.exe add /f` 把"在ZCode中打开"（en: "Open in ZCode"）幂等注册到当前用户注册表（HKCU）的三个 Explorer 菜单位（实现见 `packages/desktop/src/main/desktopWindowsOpenFolderContextMenu.ts`）：

| 菜单位                                                               | 生效场景                                             | command 路径占位符     |
| -------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------- |
| `HKCU\Software\Classes\Directory\shell\ZCode.OpenInZCode`            | 右键点选文件夹                                       | `"%1"`（选中项路径）   |
| `HKCU\Software\Classes\Drive\shell\ZCode.OpenInZCode`                | 右键点选驱动器                                       | `"%1"`                 |
| `HKCU\Software\Classes\Directory\Background\shell\ZCode.OpenInZCode` | 文件夹内空白处、桌面空白处、驱动器根目录内空白处右键 | `"%V"`（当前浏览目录） |

- 空白处右键没有选中项，`%1` 不会被替换为目录，必须使用 `%V`（与系统 cmd/Powershell、VS Code 的 Background 注册一致）。`Directory\Background` 一处即同时覆盖资源管理器文件夹空白、桌面空白与驱动器根目录空白三种场景。
- 菜单项结构：默认值与 `MUIVerb` 为本地化菜单文案，`Icon` 为应用可执行文件路径，`command` 默认值为 `"<exe>" [--app-entry] --open-workspace "<占位符>"`。
- 开发态（`process.defaultApp` 且 argv[1] 存在）在 `--open-workspace` 前额外写入应用入口参数，避免菜单只启动空 Electron。

## 所有权与不变量

- 这些注册表键的唯一写者是主进程 `installWindowsOpenFolderContextMenu`；无其他写入路径。
- 每次写入都是 `reg add /f` 覆盖：启动时刷新（自愈 exe 路径变化），语言切换时重写 MUIVerb 文案。
- 注册为静态 verb，Explorer 每次右键时读取，写入后无需通知 Shell 刷新。
- 仅写 HKCU，不要求管理员权限；与 per-machine 安装位置（Program Files）无关。

## 失败语义

- 任一 `reg add` 失败：记录 warn 日志并继续，不阻塞启动，不重试。
- 非 win32 平台：函数直接返回（macOS 由 Finder Service workflow 覆盖同等能力）。

## 已知边界（现状，非本次范围）

- 卸载应用不清理这些 HKCU 键，卸载后菜单项残留并指向已删除的 exe。

## 验收场景

1. 安装并启动应用一次后：资源管理器中右键点选文件夹、右键点选驱动器、在文件夹/桌面/驱动器根目录空白处右键，均出现"在ZCode中打开"。
2. 空白处右键触发时，ZCode 打开的是当前浏览的目录（`%V`），与点选该文件夹图标右键（`%1`）行为等价。
3. 界面语言切换后，三个位置的菜单文案同步切换。
