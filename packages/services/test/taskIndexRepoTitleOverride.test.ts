import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { setDataBaseDir } from "#src/paths.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

// 手动「自动命名」覆盖贯通（specs/session-title-manual-regenerate.md 验收 8）：
// rename（custom）后 regenerate 产生的 generated 事实必须能落库——
// 常规路径保持 custom 粘性，titleOverridesCustom 覆盖帧放行并清 title_overridden。
let repo: TaskIndexRepo;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "zcode-task-index-title-override-"));
  setDataBaseDir(tempDir);
  repo = new TaskIndexRepo();
});

afterEach(async () => {
  repo.close();
  setDataBaseDir(null);
  await new Promise((resolve) => setTimeout(resolve, 50));
  rmSync(tempDir, { recursive: true, force: true });
});

function task(taskId: string, title: string): ZCodeTaskMeta {
  return {
    taskId,
    traceId: `trace-${taskId}`,
    title,
    workspacePath: "/workspace/project",
    createdAt: 10,
    updatedAt: 20,
    mode: "default",
    provider: "glm",
    status: "running",
  };
}

const target = { workspacePath: "/workspace/project", taskId: "t-1" };

describe("applyCliFacts titleOverridesCustom", () => {
  it("常规 generated 帧不覆盖 custom（粘性回归守护）", async () => {
    await repo.applyCliFacts({ meta: task("t-1", "用户重命名"), titleSource: "custom" });
    const kept = await repo.applyCliFacts({
      meta: { ...task("t-1", "新标题"), updatedAt: 30 },
      titleSource: "generated",
    });
    expect(kept.title).toBe("用户重命名");
    expect(kept.titleOverridden).toBe(true);
  });

  it("覆盖帧放行 generated 并清 titleOverridden，验收 8：列表拿到新标题", async () => {
    await repo.applyCliFacts({ meta: task("t-1", "用户重命名"), titleSource: "custom" });
    const overridden = await repo.applyCliFacts({
      meta: { ...task("t-1", "新标题"), updatedAt: 30 },
      titleSource: "generated",
      titleOverridesCustom: true,
    });
    expect(overridden.title).toBe("新标题");
    expect(overridden.titleOverridden).toBe(false);
    // 持久化一致：重启后（重新读行）仍是新标题 + 非 custom。
    expect(await repo.getTaskMeta(target)).toMatchObject({
      title: "新标题",
      titleOverridden: false,
    });
    // 覆盖后的常规 generated 帧（无标记）不再被粘性拦截。
    const again = await repo.applyCliFacts({
      meta: { ...task("t-1", "更新标题"), updatedAt: 40 },
      titleSource: "generated",
    });
    expect(again.title).toBe("更新标题");
  });

  it("覆盖帧不误伤 handoff_pending 的组织态保护", async () => {
    await repo.applyCliFacts({ meta: task("t-1", "用户重命名"), titleSource: "custom" });
    const result = await repo.applyCliFacts({
      meta: { ...task("t-1", "新标题"), updatedAt: 30 },
      titleSource: "generated",
      titleOverridesCustom: true,
      deleted: false,
    });
    expect(result.title).toBe("新标题");
  });
});
