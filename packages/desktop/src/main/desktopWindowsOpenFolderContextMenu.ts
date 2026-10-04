import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { Locale } from "@zcode/shared";

const MENU_KEY_NAME = "ZCode.OpenInZCode";
const DIRECTORY_MENU_KEY = `HKCU\\Software\\Classes\\Directory\\shell\\${MENU_KEY_NAME}`;
const DRIVE_MENU_KEY = `HKCU\\Software\\Classes\\Drive\\shell\\${MENU_KEY_NAME}`;
const DIRECTORY_BACKGROUND_MENU_KEY = `HKCU\\Software\\Classes\\Directory\\Background\\shell\\${MENU_KEY_NAME}`;
const MENU_LABELS: Record<Locale, string> = {
  "zh-CN": "在ZCode中打开",
  "en-US": "Open in ZCode",
};

type Logger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

interface WindowsOpenFolderRegistryOperation {
  args: string[];
}

function getWindowsOpenFolderMenuName(locale: Locale): string {
  return MENU_LABELS[locale] ?? MENU_LABELS["en-US"];
}

function quoteWindowsCommandArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function buildWindowsOpenFolderCommand(
  executablePath: string,
  appArgs: readonly string[] = [],
  workspacePlaceholder = '"%1"',
): string {
  return [
    quoteWindowsCommandArg(executablePath),
    ...appArgs.map(quoteWindowsCommandArg),
    "--open-workspace",
    workspacePlaceholder,
  ].join(" ");
}

function buildWindowsOpenFolderRegistryOperations(options: {
  executablePath: string;
  appArgs?: readonly string[];
  locale: Locale;
}): WindowsOpenFolderRegistryOperation[] {
  const menuName = getWindowsOpenFolderMenuName(options.locale);
  // 空白处右键没有选中项，%1 不会被替换成目录；Background 场景必须用 Explorer 的
  // 当前目录占位符 %V（系统 cmd/Powershell 与 VS Code 同此），一处键同时覆盖
  // 文件夹内、桌面与驱动器根目录的空白右键。
  const menuKeys: Array<{ menuKey: string; workspacePlaceholder: string }> = [
    { menuKey: DIRECTORY_MENU_KEY, workspacePlaceholder: '"%1"' },
    { menuKey: DRIVE_MENU_KEY, workspacePlaceholder: '"%1"' },
    { menuKey: DIRECTORY_BACKGROUND_MENU_KEY, workspacePlaceholder: '"%V"' },
  ];

  return menuKeys.flatMap(({ menuKey, workspacePlaceholder }) => {
    const command = buildWindowsOpenFolderCommand(
      options.executablePath,
      options.appArgs ?? [],
      workspacePlaceholder,
    );

    return [
      { args: ["add", menuKey, "/ve", "/d", menuName, "/f"] },
      {
        args: [
          "add",
          menuKey,
          "/v",
          "MUIVerb",
          "/t",
          "REG_SZ",
          "/d",
          menuName,
          "/f",
        ],
      },
      {
        args: [
          "add",
          menuKey,
          "/v",
          "Icon",
          "/t",
          "REG_SZ",
          "/d",
          options.executablePath,
          "/f",
        ],
      },
      { args: ["add", `${menuKey}\\command`, "/ve", "/d", command, "/f"] },
    ];
  });
}

function runRegAdd(args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("reg.exe", [...args], {
      stdio: "ignore",
      windowsHide: true,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      reject(new Error(`reg.exe exited with code ${code ?? "unknown"}`));
    });
  });
}

export async function installWindowsOpenFolderContextMenu(options: {
  platform: NodeJS.Platform;
  executablePath: string;
  argv: readonly string[];
  isDefaultApp: boolean;
  locale: Locale;
  logger: Logger;
}): Promise<void> {
  if (options.platform !== "win32") {
    return;
  }

  const appArgs =
    // 开发态 Windows 的 process.execPath 是 Electron 可执行文件。
    // 注册表命令必须同时带上应用入口，否则 Explorer 右键菜单只能启动空 Electron。
    options.isDefaultApp && options.argv[1] ? [resolve(options.argv[1])] : [];
  const operations = buildWindowsOpenFolderRegistryOperations({
    executablePath: options.executablePath,
    appArgs,
    locale: options.locale,
  });

  try {
    await Promise.all(operations.map((operation) => runRegAdd(operation.args)));

    options.logger.info("[open-folder] Windows Explorer 右键菜单已安装或更新", {
      executablePath: options.executablePath,
      hasDefaultAppEntry: appArgs.length > 0,
      locale: options.locale,
    });
  } catch (error) {
    options.logger.warn("[open-folder] Windows Explorer 右键菜单安装失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
