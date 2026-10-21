import { describe, expect, it } from "vitest";
import * as f from "./botsService.fixtures.js";

const actor = {
  provider: "webhook" as const,
  botId: "webhook-1",
  providerUserId: "user-1",
  chatType: "private" as const,
};

describe("botsService help", () => {
  it("shows command help after binding succeeds", async () => {
    const repo = f.createMemoryRepo(f.baseConfig);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService: f.createLegacyTaskService(),
      repo: repo as never,
    });

    const code = await service.createBindCode({ botId: "webhook-1" });
    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: `/bind ${code.code}`,
      actor,
    });

    expect(replies[0]?.text).toBe(
      [
        "绑定成功。发送 **/帮助** 查看可用命令。",
        "",
        "ZCode 机器人命令：",
        "**/帮助 或 /help** — 查看这份说明",
        "**/状态 或 /status** — 查看工作区、模型和任务状态",
        "**/新建 或 /new 或 /clear** — 开始新任务；旧任务保留，发 /任务 可切回",
        "**/项目 或 /workspace 或 /project** — 切换工作区",
        "**/模型 或 /model** — 切换模型",
        "**/模式 或 /mode** — 切换运行模式",
        "**/思考 或 /think** — 切换思考级别",
        "**/回复 或 /reply** — 切换回复方式",
        "**/任务 或 /task** — 切换到已有任务（客户端左侧列表的会话）",
        "**/停止 或 /stop** — 停止当前任务生成",
        "**/重连 或 /reconnect** — 重连远端工作区",
        "**/bind <code>** — 绑定当前聊天",
      ].join("\n"),
    );
    service.disposeAll();
  });

  it("returns concise Chinese command help for /帮助", async () => {
    const repo = f.createMemoryRepo(f.baseConfig);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService: f.createLegacyTaskService(),
      repo: repo as never,
    });

    const code = await service.createBindCode({ botId: "webhook-1" });
    await service.handleInboundMessage({
      botId: "webhook-1",
      text: `/bind ${code.code}`,
      actor,
    });
    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/帮助",
      actor,
    });

    expect(replies[0]?.text).toBe(
      [
        "ZCode 机器人命令：",
        "**/帮助 或 /help** — 查看这份说明",
        "**/状态 或 /status** — 查看工作区、模型和任务状态",
        "**/新建 或 /new 或 /clear** — 开始新任务；旧任务保留，发 /任务 可切回",
        "**/项目 或 /workspace 或 /project** — 切换工作区",
        "**/模型 或 /model** — 切换模型",
        "**/模式 或 /mode** — 切换运行模式",
        "**/思考 或 /think** — 切换思考级别",
        "**/回复 或 /reply** — 切换回复方式",
        "**/任务 或 /task** — 切换到已有任务（客户端左侧列表的会话）",
        "**/停止 或 /stop** — 停止当前任务生成",
        "**/重连 或 /reconnect** — 重连远端工作区",
        "**/bind <code>** — 绑定当前聊天",
      ].join("\n"),
    );
    service.disposeAll();
  });

  it("returns English command help with new or clear wording", async () => {
    const repo = f.createMemoryRepo(f.baseConfig);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService: f.createLegacyTaskService(),
      repo: repo as never,
      settingService: f.createSettingService({
        locale: "en-US",
        lastWorkspaceSession: [
          {
            kind: "remote",
            workspacePath: "/tmp/workspace",
            workspaceIdentity: "remote:server:test-owner:/tmp/workspace",
          },
        ],
      }),
    });

    const code = await service.createBindCode({ botId: "webhook-1" });
    await service.handleInboundMessage({
      botId: "webhook-1",
      text: `/bind ${code.code}`,
      actor,
    });
    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/help",
      actor,
    });

    expect(replies[0]?.text).toContain(
      "**/new or /clear** — Start a new task (conversation)",
    );
    expect(replies[0]?.text).toContain("**/task** — Switch task (conversation)");
    service.disposeAll();
  });
});
