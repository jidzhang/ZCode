import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { acquireFileLock } from "./atomicFileLock.js";

const DEFAULT_LOCK_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const;
const DEFAULT_LOCK_OWNERLESS_GRACE_MS = 100;
const DEFAULT_LOCK_MAX_WAIT_MS = 8_000;
// Bugfix: 高并发/杀软扫描下 Windows 原子替换的 EPERM 可持续超过 1.5s（全量单测
// 4 线程并发时两次复现），原 5 档重试预算不够；补两档长退避把窗口拉到约 6 秒。
// 2026-10-22 二次加档：上游 3.16.2 合并后全量单测下 bundled-config-replacement
// 连续两轮复现 EPERM 超过 6s 预算（单跑稳定通过），杀软对 %TEMP% 新文件的扫描
// 排队随全量负载变长；再补两档到约 25 秒，仍低于该链路 30s 测试超时。
const DEFAULT_RENAME_RETRY_DELAYS_MS = [
  50, 100, 200, 400, 800, 1600, 3200, 6400, 12_800,
] as const;
const processFileLockTails = new Map<string, Promise<void>>();

export interface SharedFileLockOptions {
  lockRetryDelaysMs?: readonly number[];
  lockOwnerlessGraceMs?: number;
  lockMaxWaitMs?: number;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isRetryableRenameError(error: unknown): boolean {
  const code = getErrorCode(error);
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

async function renameWithRetry(
  tempFile: string,
  filePath: string,
  retryDelaysMs: readonly number[],
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tempFile, filePath);
      return;
    } catch (error) {
      const delayMs = retryDelaysMs[attempt];
      if (delayMs === undefined || !isRetryableRenameError(error)) {
        throw error;
      }
      await sleep(delayMs);
    }
  }
}

export async function withFileLock<T>(
  filePath: string,
  operation: () => Promise<T>,
  options: SharedFileLockOptions = {},
): Promise<T> {
  // 同一进程几十个 caller 同时轮询目录锁会形成惊群，后排请求可能在
  // 很短的实际写入之后仍撞上 8 秒超时。先做进程内 FIFO，每个进程只让队首竞争 OS 锁。
  const previousTail = processFileLockTails.get(filePath) ?? Promise.resolve();
  let releaseProcessQueue!: () => void;
  const currentTail = new Promise<void>((resolve) => {
    releaseProcessQueue = resolve;
  });
  processFileLockTails.set(filePath, currentTail);
  await previousTail;

  let releaseLock: (() => Promise<void>) | undefined;
  try {
    await mkdir(dirname(filePath), { recursive: true });
    releaseLock = await acquireFileLock(
      filePath,
      options.lockRetryDelaysMs ?? DEFAULT_LOCK_RETRY_DELAYS_MS,
      options.lockOwnerlessGraceMs ?? DEFAULT_LOCK_OWNERLESS_GRACE_MS,
      options.lockMaxWaitMs ?? DEFAULT_LOCK_MAX_WAIT_MS,
    );
    return await operation();
  } finally {
    try {
      await releaseLock?.();
    } finally {
      releaseProcessQueue();
      if (processFileLockTails.get(filePath) === currentTail) {
        processFileLockTails.delete(filePath);
      }
    }
  }
}

export async function atomicWritePrivateTextFile(
  filePath: string,
  content: string,
  renameRetryDelaysMs: readonly number[] = DEFAULT_RENAME_RETRY_DELAYS_MS,
): Promise<void> {
  const directory = dirname(filePath);
  const tempPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
    await renameWithRetry(tempPath, filePath, renameRetryDelaysMs);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function backupCorruptFile(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  const contentId = createHash("sha256").update(content).digest("hex").slice(0, 24);
  const backupPath = `${filePath}.corrupt-${contentId}.bak`;
  try {
    // 同一损坏凭据会被 Desktop、CLI 和重试循环反复读取。按内容确定备份名并
    // 排他创建，让失败路径稳定收敛到一份证据，同时避免 copyFile 继承历史宽松权限。
    await writeFile(backupPath, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (getErrorCode(error) !== "EEXIST") throw error;
  }
  await chmod(backupPath, 0o600);
  return backupPath;
}
