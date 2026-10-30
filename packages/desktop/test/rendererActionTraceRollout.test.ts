import { describe, expect, it, vi } from "vitest";
import {
  createRendererActionTraceRollout,
  resolveRendererActionTraceConfig,
} from "../src/main/rendererActionTraceRollout.js";

describe("renderer action trace rollout", () => {
  it("parses known groups and ignores unknown groups", () => {
    expect(
      resolveRendererActionTraceConfig({
        code: 0,
        data: {
          configs: {
            rendererActionTrace: {
              enabled: true,
              sample_ratio: 0.05,
              enabled_groups: ["core", "future", "settings"],
              config_version: "v1",
            },
          },
        },
      }),
    ).toEqual({
      enabled: true,
      sampleRatio: 0.05,
      enabledGroups: ["core", "settings"],
      configVersion: "v1",
    });
  });

  it("fails closed when the key is missing and rejects an unsafe ratio", () => {
    expect(resolveRendererActionTraceConfig({ code: 0, data: { configs: {} } })).toEqual({
      enabled: false,
      sampleRatio: 0,
      enabledGroups: [],
      configVersion: "disabled",
    });
    expect(
      resolveRendererActionTraceConfig({
        code: 0,
        data: {
          configs: {
            rendererActionTrace: {
              enabled: true,
              sample_ratio: 0.5,
              enabled_groups: ["core"],
              config_version: "bad",
            },
          },
        },
      }),
    ).toBeNull();
  });

  it("keeps the last valid snapshot when refresh fails", async () => {
    const fetchConfig = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce({
        code: 0,
        data: {
          configs: {
            rendererActionTrace: {
              enabled: true,
              sample_ratio: 0.05,
              enabled_groups: ["core"],
              config_version: "v1",
            },
          },
        },
      })
      .mockRejectedValueOnce(new Error("offline"));
    const rollout = createRendererActionTraceRollout({
      fetchConfig,
      logger: { warn: vi.fn() },
      cacheTtlMs: 1,
    });

    expect((await rollout.refresh()).enabled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(await rollout.refresh()).toMatchObject({ enabled: true, configVersion: "v1" });
  });

  it("失败后进入退避窗口：窗口内 60s 定时器触发不再调 fetcher 也不再告警", async () => {
    // 修前行为：snapshotExpiresAt 只在成功时赋值，失败后 60s 定时器每分钟重打一次
    // fetcher（enableStartupOutbound 关闭时是本地抛错）→ 每分钟一条 warn 刷屏。
    const warn = vi.fn();
    const fetchConfig = vi.fn<() => Promise<unknown>>().mockRejectedValue(
      new Error("startup outbound disabled by setting"),
    );
    const rollout = createRendererActionTraceRollout({
      fetchConfig,
      logger: { warn },
    });

    // 首次失败：调用一次 fetcher，记一条 warn，返回默认关闭快照。
    expect((await rollout.refresh()).enabled).toBe(false);
    expect(fetchConfig).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);

    // 退避窗口内（默认 10 分钟）的三次定时器触发：全部走缓存，零新增调用/告警。
    for (let tick = 0; tick < 3; tick += 1) {
      expect((await rollout.refresh()).enabled).toBe(false);
    }
    expect(fetchConfig).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
