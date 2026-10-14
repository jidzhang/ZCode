import { spawn } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// 非 CLI 进程（Electron/Host、存储准备 Worker）只加载模块，不拦截原始入口。
if (process.argv.includes("app-server") && process.argv.includes("--stdio")) {
  // 仅由本组 WDIO 预加载的透明 stdio 代理。真实 Host/CLI 完成保存、解析和执行；
  // 故障位于传输边界，不修改业务对象，也不记录其他 RPC 的鉴权或模型凭据。
  const child = spawn(process.execPath, process.argv.slice(1), {
    stdio: ["pipe", "pipe", "inherit"],
    // 只移除当前代理预加载，保留覆盖采集等其他 Node 参数，防止递归启动代理。
    // Windows 的 --import 只接受 file:// URL（绝对路径按 URL 解析会直接报
    // ERR_UNSUPPORTED_ESM_URL_SCHEME），POSIX 则路径与 URL 两种写法都合法；
    // 四种自引用形式都必须剥净，否则子进程再次预载代理，形成无限递归。
    env: {
      ...process.env,
      NODE_OPTIONS: (process.env.NODE_OPTIONS ?? "")
        .replace(
          new RegExp(
            // 注意 import.meta.url 本身已是 URL 形式，不能再喂给 pathToFileURL（会被
            // 当作路径再包一层 file:/ 前缀，生成的形式永远匹配不上）。
            [fileURLToPath(import.meta.url), import.meta.url]
              .flatMap((form) => [`--import=${JSON.stringify(form)}`, `--import=${form}`])
              .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
              .join("|"),
            "g",
          ),
          "",
        )
        .trim(),
    },
  });
  const root = process.env.ZCODE_E2E_ARTIFACT_DIR;
  const control = join(root, "subagent-config-control.json");
  const log = join(root, `subagent-config-rpc-${child.pid}.jsonl`);
  const pending = new Map();
  let outbound = Promise.resolve(),
    inbound = Promise.resolve();
  const writeLog = (event) =>
    appendFile(
      log,
      JSON.stringify({
        time: Date.now(),
        pid: child.pid,
        hostPid: process.ppid,
        cwd: process.cwd(),
        ...event,
      }) + "\n",
    );
  createInterface({ input: child.stdout }).on("line", (line) => {
    outbound = outbound
      .then(async () => {
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          process.stdout.write(line + "\n");
          return;
        }
        if (frame.method === "subagents/readRuntimeConfig") {
          const state = JSON.parse(await readFile(control, "utf8").catch(() => "{}"));
          const sessionId = frame.params.sessionId;
          const failed = state.failedSessionIds?.includes(sessionId) === true;
          await writeLog({ kind: "read", sessionId, failed });
          // 重载不再阻塞 RPC；关闭用例在测试传输边界保持请求待决，独立验证真实断连取消。
          if (state.heldSessionIds?.includes(sessionId)) {
            await writeLog({ kind: "held", sessionId });
            return;
          }
          if (failed) {
            child.stdin.write(
              JSON.stringify({
                id: frame.id,
                error: { code: -32603, message: "E2E_CONFIG_UNAVAILABLE" },
              }) + "\n",
            );
            return;
          }
          pending.set(frame.id, sessionId);
        }
        process.stdout.write(line + "\n");
      })
      .catch((error) => {
        process.stderr.write(String(error));
        process.exitCode = 1;
        child.kill();
      });
  });
  createInterface({ input: process.stdin })
    .on("line", (line) => {
      inbound = inbound
        .then(async () => {
          const frame = JSON.parse(line);
          if (pending.has(frame.id)) {
            await writeLog({
              kind: "snapshot",
              sessionId: pending.get(frame.id),
              snapshot: frame.result,
              error: frame.error,
            });
            pending.delete(frame.id);
          }
          child.stdin.write(line + "\n");
        })
        .catch((error) => {
          process.stderr.write(String(error));
          process.exitCode = 1;
          child.kill();
        });
    })
    .on("close", () => {
      void inbound.then(() => child.stdin.end());
    });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code) => {
    void Promise.all([inbound, outbound]).finally(() => process.exit(code ?? 1));
  });
  // 预加载阶段等待代理子进程退出，不能再次执行当前进程原定的 CLI 入口。
  await new Promise(() => {});
}
