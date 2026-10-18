import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationSnapshot, ConversationTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import { createZCodeTaskServiceAdapter } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";

// Bugfix（2026-10-18）配套：getTaskRuntimeBusyState 是 DM 补话放行判定的数据源，
// 此前只有 botsService 侧 mock 的间接覆盖，adapter 自身行为（busy 判定、终态遇排队
// 输入维持忙、workspace 身份采纳与 mismatch）没有测试。这里走真实 observeRuntime
// 与连接 facade，只 fake 底层 agent 传输。

const disposables: Array<{ disposeAll(): void }> = [];

afterEach(() => {
  while (disposables.length > 0) {
    disposables.pop()?.disposeAll();
  }
});

function makeSnapshot(params: {
  sessionId: string;
  phase?: ConversationSnapshot["control"]["phase"];
  queueItems?: ConversationSnapshot["queue"]["items"];
}): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: params.sessionId,
    logEpoch: "epoch-wire",
    seq: 11,
    revision: 1,
    control: {
      phase: params.phase ?? "running",
      sessionEnded: false,
      canStop: true,
      stopState: "stoppable",
      stopTargetKind: "assistant",
      activeWorks: [{ kind: "primaryTurn", startedAt: 1_000 }],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: true },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: true },
      pauseGoal: { allowed: false, reasonCode: "guard.noGoal" },
      resumeGoal: { allowed: false, reasonCode: "guard.noGoal" },
    },
    inputRouting: { mode: "enqueue" },
    meta: { title: "Indexed session", titleSource: "custom" },
    config: {
      provider: "glm",
      model: "glm-5",
      thought: "medium",
      thoughtLevels: [],
      followupMode: "queue",
      mode: "build",
    },
    modelTransition: null,
    usage: {
      contextWindow: {
        usedTokens: 0,
        maxTokens: 200_000,
        autoCompactThresholdTokens: null,
      },
      cumulative: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    queue: { items: params.queueItems ?? [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    // 软门禁 additive 字段:归一化形态(带 default(null))
    workspaceHookAdmission: null,
    goal: null,
    plan: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  };
}

function createAgentWithSnapshot(snapshot: ConversationSnapshot) {
  const dispose = vi.fn();
  let listener: ((value: unknown) => void) | undefined;
  const topic = `conversation/${snapshot.sessionId}`;
  const frame: ConversationTopicFrame = {
    topic,
    subscriptionId: "mine",
    fromSeq: 0,
    toSeq: snapshot.seq,
    sentAt: 1_700_000_000_000,
    payload: { kind: "snapshot", snapshot },
  };
  const wire = {
    wireVersion: 1,
    kind: "complete",
    deliveryKind: "initial",
    logicalFrameId: "initial",
    logicalFrameOrdinal: 1,
    topic,
    subscriptionId: "mine",
    frame,
  };
  return {
    onDynamicConversationFrame: vi.fn(() => (handler: (value: unknown) => void) => {
      listener = handler;
      return { dispose };
    }),
    subscribeConversationV4: vi.fn(async () => {
      listener?.(wire);
      return { ack: { subscriptionId: "mine" } };
    }),
    unsubscribeConversationV4: vi.fn(async () => undefined),
    disposeAll: vi.fn(async () => undefined),
  };
}

function createAdapter(agent: unknown) {
  const service = createZCodeTaskServiceAdapter({
    zcodeAgentService: agent as never,
    // 构造期只订阅 syncer 的 ready/terminal 事件（dispose 时释放）；相位探测不触碰索引，
    // 其余 syncer 能力用 no-op stub 满足构造期依赖。
    taskIndexSyncer: {
      onSessionTerminalEvent: () => ({ dispose: () => undefined }),
      onSessionReadyEvent: () => ({ dispose: () => undefined }),
      disposeAll: () => undefined,
    } as never,
  }) as unknown as {
    getTaskRuntimeBusyState(params: {
      taskId: string;
      workspacePath: string;
      workspaceIdentity?: string;
    }): Promise<boolean | null>;
    onDynamicTaskEvent(params: {
      taskId: string;
      workspacePath: string;
      workspaceIdentity?: string;
    }): unknown;
    disposeAll(): void;
  };
  disposables.push(service);
  return service;
}

describe("adapter getTaskRuntimeBusyState", () => {
  it("reports idle for an unregistered desktop-initiated task whose runtime is terminal", async () => {
    const agent = createAgentWithSnapshot(
      makeSnapshot({ sessionId: "task-1", phase: "completedSuccess" }),
    );
    const service = createAdapter(agent);

    await expect(
      service.getTaskRuntimeBusyState({ taskId: "task-1", workspacePath: "/work" }),
    ).resolves.toBe(false);
    expect(agent.unsubscribeConversationV4).toHaveBeenCalled();
  });

  it("keeps the busy verdict while a terminal phase still has pending queue items", async () => {
    // 回合结束后 host 命令队列才 drain：终态与排队输入短暂并存时不能按终态放行，
    // 否则新消息会插到排队输入之前（恢复"忙时直投"乱序）。此时必须维持 busy。
    const queuedItem = {
      sourceCommandId: "command",
      queueItemId: "queue",
      clientId: "client",
      kind: "sendText",
      text: "hello",
      delivery: { requested: "queue", admitted: "queue" },
      order: { admissionSeq: 1 },
      steer: { state: "notRequested" },
      dispatch: { state: "queued" },
      admittedAt: 1,
    } as unknown as ConversationSnapshot["queue"]["items"][number];
    const agent = createAgentWithSnapshot(
      makeSnapshot({
        sessionId: "task-1",
        phase: "completedSuccess",
        queueItems: [queuedItem],
      }),
    );
    const service = createAdapter(agent);

    await expect(
      service.getTaskRuntimeBusyState({ taskId: "task-1", workspacePath: "/work" }),
    ).resolves.toBe(true);
  });

  it("adopts the registered target's workspace identity when the probe omits it", async () => {
    // Bot 上下文可能只报 workspacePath；注册目标带着 identity 时必须采纳后再比对，
    // 直接拿原始入参会永远 mismatch，僵尸 running 反而清不掉。
    const agent = createAgentWithSnapshot(
      makeSnapshot({ sessionId: "task-1", phase: "completedInterrupted" }),
    );
    const service = createAdapter(agent);
    service.onDynamicTaskEvent({
      taskId: "task-1",
      workspacePath: "/work",
      workspaceIdentity: "ssh://host/work",
    });

    await expect(
      service.getTaskRuntimeBusyState({ taskId: "task-1", workspacePath: "/work" }),
    ).resolves.toBe(false);
  });

  it("rejects a probe whose workspace identity does not match the registered target", async () => {
    // workspaceKey 优先取 identity：两边都有身份时按身份判 mismatch，路径仅作缺身份时的回退。
    const agent = createAgentWithSnapshot(
      makeSnapshot({ sessionId: "task-1", phase: "completedSuccess" }),
    );
    const service = createAdapter(agent);
    service.onDynamicTaskEvent({
      taskId: "task-1",
      workspacePath: "/work",
      workspaceIdentity: "ssh://host/work",
    });

    await expect(
      service.getTaskRuntimeBusyState({
        taskId: "task-1",
        workspacePath: "/work",
        workspaceIdentity: "ssh://other/work",
      }),
    ).rejects.toThrow("Task workspace mismatch");
  });
});
