import { describe, expect, it } from "vitest";
import { SessionEventType, createMessageId, createPartId, createSessionId } from "@zcode/contracts";
import type { MessageInfo, MessagePart, SessionStorePort } from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestModelSelection } from "./test-model-selection.js";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";
import { regenerateSessionTitle } from "../src/runtime/methods/session-title.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

function userMessage(sessionID: string, id: string, text: string, options?: { synthetic?: boolean; visibility?: "model-only" }): MessageInfo {
  return {
    id: createMessageId(id),
    sessionID: createSessionId(sessionID),
    role: "user",
    synthetic: options?.synthetic,
    visibility: options?.visibility,
    time: { created: Date.now() },
  } as MessageInfo;
}

function assistantMessage(sessionID: string, id: string, text: string, options?: { summary?: boolean }): MessageInfo {
  return {
    id: createMessageId(id),
    sessionID: createSessionId(sessionID),
    role: "assistant",
    summary: options?.summary,
    parentID: createMessageId(`${id}-parent`),
    time: { created: Date.now(), completed: Date.now() },
    mode: "build",
    agent: "main",
    path: { cwd: "/workspace", root: "/workspace" },
    cost: 0,
    tokens: { input: 0, output: 0, total: 0 },
  } as unknown as MessageInfo;
}

function textPart(sessionID: string, messageId: string, partId: string, text: string): MessagePart {
  return {
    id: createPartId(partId),
    sessionID: createSessionId(sessionID),
    messageID: createMessageId(messageId),
    type: "text",
    text,
  } as MessagePart;
}

async function seedConversation(
  store: SessionStorePort,
  sessionId: string,
  messages: Array<{ info: MessageInfo; parts: MessagePart[] }>,
): Promise<void> {
  for (const { info, parts } of messages) {
    await store.saveMessage(info);
    for (const part of parts) await store.savePart(part);
  }
}

function buildRuntime(
  sessionId: string,
  store: SessionStorePort,
  generateText: (messages: { role: string; content: string }[]) => { finishReason: string; text: string },
  updateSessionCalls: Array<Parameters<SessionStorePort["updateSession"]>[0]> = [],
) {
  const eventStore = createTestSessionEventStore();
  const runtime = createTestAgentRuntime(createSessionId(sessionId), {
    mode: "build",
    workingDirectory: "/workspace",
    titleGeneration: {
      modelSelection: createTestModelSelection("test/title-model"),
      timeoutMs: 1_000,
    },
  }, {
    eventStore,
    sessionStore: new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "updateSession") {
          return (input: Parameters<SessionStorePort["updateSession"]>[0]) => {
            updateSessionCalls.push(input);
            return (target.updateSession as Function)(input);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as SessionStorePort,
    modelFactory: createTestModelFactory({
      async generateText(request: { messages: { role: string; content: string }[] }) {
        const result = generateText(request.messages);
        return {
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
          ...result,
        };
      },
    } as never),
  });
  return { runtime, eventStore };
}

describe("手动「自动命名」regenerateSessionTitle", () => {
  it("多轮素材：首条 + 最近 user/assistant，排除 synthetic/model-only/compaction 摘要", async () => {
    const sessionId = "regen-material";
    const store = createRecordingSubagentSessionStore();
    await store.createSession({
      id: createSessionId(sessionId),
      title: "旧标题",
      titleSource: "generated",
    } as never);
    await seedConversation(store, sessionId, [
      {
        info: userMessage(sessionId, "u1", "帮我优化输入法测评脚本的流程"),
        parts: [textPart(sessionId, "u1", "p1", "帮我优化输入法测评脚本的流程")],
      },
      {
        // synthetic 系统通知不进素材
        info: userMessage(sessionId, "u2", "已恢复会话", { synthetic: true }),
        parts: [textPart(sessionId, "u2", "p2", "已恢复会话")],
      },
      {
        info: assistantMessage(sessionId, "a1", "我先梳理了现有脚本结构"),
        parts: [textPart(sessionId, "a1", "p3", "我先梳理了现有脚本结构")],
      },
      {
        // compaction 摘要 assistant 不进素材
        info: assistantMessage(sessionId, "a2", "上一阶段摘要", { summary: true }),
        parts: [textPart(sessionId, "a2", "p4", "上一阶段摘要")],
      },
      {
        info: userMessage(sessionId, "u3", "改成联网测试，不测离线了"),
        parts: [textPart(sessionId, "u3", "p5", "改成联网测试，不测离线了")],
      },
      {
        info: assistantMessage(sessionId, "a3", "已切换到联网路径并更新断言"),
        parts: [textPart(sessionId, "a3", "p6", "已切换到联网路径并更新断言")],
      },
    ]);

    let modelInput = "";
    const { runtime, eventStore } = buildRuntime(sessionId, store, (messages) => {
      modelInput = String(messages.at(-1)?.content);
      return { finishReason: "stop", text: '{"title":"输入法联网测评改造"}' };
    });

    await (runtime as unknown as AgentRuntimeInternal).regenerateSessionTitle({
      traceContext: runtime.rootTraceContext,
    });

    expect(modelInput).toContain("Original request: 帮我优化输入法测评脚本的流程");
    expect(modelInput).toContain("Assistant: 我先梳理了现有脚本结构");
    expect(modelInput).toContain("User: 改成联网测试，不测离线了");
    expect(modelInput).toContain("Assistant: 已切换到联网路径并更新断言");
    expect(modelInput).not.toContain("已恢复会话");
    expect(modelInput).not.toContain("上一阶段摘要");

    const session = await store.getSession(createSessionId(sessionId));
    expect(session?.title).toBe("输入法联网测评改造");
    expect(session?.titleSource).toBe("generated");
    const events = await eventStore.getEvents(createSessionId(sessionId));
    const titleEvent = events.find((event) => event.type === SessionEventType.SessionTitleUpdated);
    expect(titleEvent?.payload).toMatchObject({
      reason: "manual_regenerate",
      source: "generated",
      title: "输入法联网测评改造",
    });
  });

  it("覆盖 custom：用户手动重命名过的会话可被手动重生成覆盖，乐观锁名单含 custom", async () => {
    const sessionId = "regen-custom";
    const store = createRecordingSubagentSessionStore();
    await store.createSession({
      id: createSessionId(sessionId),
      title: "用户手敲的标题",
      titleSource: "custom",
    } as never);
    await seedConversation(store, sessionId, [
      {
        info: userMessage(sessionId, "u1", "第一句话很长很长需要被摘要"),
        parts: [textPart(sessionId, "u1", "p1", "第一句话很长很长需要被摘要")],
      },
    ]);

    const updateSessionCalls: Array<Parameters<SessionStorePort["updateSession"]>[0]> = [];
    const { runtime } = buildRuntime(
      sessionId,
      store,
      () => ({ finishReason: "stop", text: '{"title":"摘要后的标题"}' }),
      updateSessionCalls,
    );

    await (runtime as unknown as AgentRuntimeInternal).regenerateSessionTitle({
      traceContext: runtime.rootTraceContext,
    });

    expect(updateSessionCalls.at(-1)).toMatchObject({
      title: "摘要后的标题",
      titleSource: "generated",
    });
    expect(updateSessionCalls.at(-1)?.expectedTitleSources).toContain("custom");
    const session = await store.getSession(createSessionId(sessionId));
    expect(session?.title).toBe("摘要后的标题");
    expect(session?.titleSource).toBe("generated");
  });

  it("无可见用户素材时拒绝（session_title_no_input），不改标题", async () => {
    const sessionId = "regen-empty";
    const store = createRecordingSubagentSessionStore();
    await store.createSession({
      id: createSessionId(sessionId),
      title: "保持不变",
      titleSource: "first_input",
    } as never);
    await seedConversation(store, sessionId, [
      {
        info: userMessage(sessionId, "u1", "内部指令", { visibility: "model-only" }),
        parts: [textPart(sessionId, "u1", "p1", "内部指令")],
      },
    ]);

    const { runtime } = buildRuntime(sessionId, store, () => ({
      finishReason: "stop",
      text: '{"title":"不应出现"}',
    }));

    await expect(
      (runtime as unknown as AgentRuntimeInternal).regenerateSessionTitle({
        traceContext: runtime.rootTraceContext,
      }),
    ).rejects.toThrow("session_title_no_input");
    const session = await store.getSession(createSessionId(sessionId));
    expect(session?.title).toBe("保持不变");
  });

  it("模型空响应时报生成失败，不改标题", async () => {
    const sessionId = "regen-failed";
    const store = createRecordingSubagentSessionStore();
    await store.createSession({
      id: createSessionId(sessionId),
      title: "旧标题",
      titleSource: "default",
    } as never);
    await seedConversation(store, sessionId, [
      {
        info: userMessage(sessionId, "u1", "需要命名的任务"),
        parts: [textPart(sessionId, "u1", "p1", "需要命名的任务")],
      },
    ]);

    const { runtime } = buildRuntime(sessionId, store, () => ({
      finishReason: "stop",
      text: "",
    }));

    await expect(
      (runtime as unknown as AgentRuntimeInternal).regenerateSessionTitle({
        traceContext: runtime.rootTraceContext,
      }),
    ).rejects.toThrow("session_title_generation_failed");
    const session = await store.getSession(createSessionId(sessionId));
    expect(session?.title).toBe("旧标题");
  });
});
