import {
  COMPACT_PROMPT_TOO_LONG_RETRY_MARKER,
  CompactTrigger,
  MAX_COMPACT_PROMPT_TOO_LONG_RETRIES,
  countContextPrefixMessages,
  estimateMessageTokens,
  modelMessageContentToText,
  traceContextToLogContext,
} from "../deps.js";
import type { TraceContext } from "../deps.js";
import {
  cloneRuntimeMessageEntry,
  isContextPrefixEntry,
  isRuntimeAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import { groupByAssistantStartedRounds } from "../../compact/rounds.js";
import { buildProviderRequestMessages } from "./provider-request-messages.js";

interface CompactRetryLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface CompactEntrySelection {
  entriesForSummary: RuntimeMessageEntry[];
  groupsPreserved: number;
  preservedEntries: RuntimeMessageEntry[];
  totalGroups: number;
}

export function selectCompactEntries(input: {
  entries: readonly RuntimeMessageEntry[];
  minimumGroupsToPreserve?: number;
  trigger: CompactTrigger;
}): CompactEntrySelection {
  const split = splitRuntimeEntriesForCompactSelection(input.entries, input.trigger);
  const baseGroupsToPreserve = split.shouldPreserveRecent && split.groups.length > 1 ? 1 : 0;
  const requestedGroupsToPreserve = Math.max(
    baseGroupsToPreserve,
    positiveInt(input.minimumGroupsToPreserve) ?? 0,
  );
  const maxGroupsToPreserve = Math.max(0, split.groups.length - 1);
  const groupsToPreserve = split.shouldPreserveRecent
    ? Math.min(requestedGroupsToPreserve, maxGroupsToPreserve)
    : 0;
  const summaryGroups =
    groupsToPreserve > 0
      ? split.groups.slice(0, split.groups.length - groupsToPreserve)
      : split.groups;
  const preservedGroups = groupsToPreserve > 0 ? split.groups.slice(-groupsToPreserve) : [];

  return {
    entriesForSummary: [...split.prefixEntries, ...summaryGroups.flat()].map(cloneRuntimeEntry),
    groupsPreserved: groupsToPreserve,
    preservedEntries: preservedGroups.flat().map(cloneRuntimeEntry),
    totalGroups: split.groups.length,
  };
}

export function selectCompactEntriesAfterPromptTooLong(input: {
  entries: readonly RuntimeMessageEntry[];
  promptTooLongCause: unknown;
  trigger: CompactTrigger;
  useMidConversationSystem?: boolean;
  currentGroupsPreserved: number;
}): CompactEntrySelection | null {
  const split = splitRuntimeEntriesForCompactSelection(input.entries, input.trigger);
  if (!split.shouldPreserveRecent || split.groups.length < 2) {
    return null;
  }

  const maxGroupsToPreserve = split.groups.length - 1;
  if (input.currentGroupsPreserved >= maxGroupsToPreserve) {
    return null;
  }

  const summarizedGroupCount = split.groups.length - input.currentGroupsPreserved;
  const groupsForSummary = split.groups.slice(0, summarizedGroupCount);
  if (groupsForSummary.length < 2) {
    return null;
  }

  const groupsToMove = countRecentGroupsToPreserveAfterPromptTooLong(
    groupsForSummary,
    input.promptTooLongCause,
    { useMidConversationSystem: input.useMidConversationSystem },
  );
  const nextGroupsPreserved = Math.min(
    maxGroupsToPreserve,
    input.currentGroupsPreserved + groupsToMove,
  );
  if (nextGroupsPreserved <= input.currentGroupsPreserved) {
    return null;
  }

  const nextSelection = selectCompactEntries({
    entries: input.entries,
    minimumGroupsToPreserve: nextGroupsPreserved,
    trigger: input.trigger,
  });
  return hasEnoughRuntimeEntriesToCompact(nextSelection.entriesForSummary) ? nextSelection : null;
}

export function selectCompactEntriesForInitialPromptTooLong(input: {
  entries: readonly RuntimeMessageEntry[];
  promptTooLongCause: unknown;
  trigger: CompactTrigger;
  useMidConversationSystem?: boolean;
}): CompactEntrySelection | null {
  const split = splitRuntimeEntriesForCompactSelection(input.entries, input.trigger);
  if (!split.shouldPreserveRecent || split.groups.length <= 3) {
    return null;
  }

  const tokenGap = getPromptTooLongTokenGap(input.promptTooLongCause);
  if (tokenGap === undefined) {
    return null;
  }

  const groupTokenEstimates = estimateCompactGroupTokens(split.groups, {
    useMidConversationSystem: input.useMidConversationSystem,
  });
  const alreadyPreservedTokens = groupTokenEstimates.at(-1) ?? 0;
  const remainingTokenGap = tokenGap - alreadyPreservedTokens;
  if (remainingTokenGap <= 0) {
    return null;
  }

  const additionalGroupsToPreserve = countRecentGroupsToCoverTokenGap(
    groupTokenEstimates,
    split.groups.length - 1,
    remainingTokenGap,
  );
  const nextSelection = selectCompactEntries({
    entries: input.entries,
    minimumGroupsToPreserve: 1 + additionalGroupsToPreserve,
    trigger: input.trigger,
  });
  return hasEnoughRuntimeEntriesToCompact(nextSelection.entriesForSummary) ? nextSelection : null;
}

export function getRuntimeEntriesToSummarize(
  entries: readonly RuntimeMessageEntry[],
): RuntimeMessageEntry[] {
  return entries.filter((entry) => !isContextPrefixEntry(entry)).map(cloneRuntimeEntry);
}

export function hasEnoughRuntimeEntriesToCompact(entries: readonly RuntimeMessageEntry[]): boolean {
  // 只读判断，不拷贝条目：auto compact 每个模型步都会调用；分组和角色判断都不改条目，结果只有布尔值。
  const entriesToSummarize = entries.filter((entry) => !isContextPrefixEntry(entry));
  return (
    groupRuntimeEntriesByCompactRound(entriesToSummarize).length >= 2 &&
    entriesToSummarize.some((entry) => runtimeEntryRole(entry) === "assistant")
  );
}

export function estimateRuntimeEntryTokens(
  entries: readonly RuntimeMessageEntry[],
  options: { useMidConversationSystem?: boolean } = {},
): number {
  const providerMessages = buildProviderRequestMessages({
    entries,
    applyCacheControl: false,
    useMidConversationSystem: options.useMidConversationSystem,
  }).messages;
  return estimateMessageTokens(providerMessages);
}

export function truncateCompactSummaryRequestEntriesAfterPromptTooLong(options: {
  attempt: number;
  cause: unknown;
  entriesForSummary: readonly RuntimeMessageEntry[];
  logger?: CompactRetryLogger;
  traceContext: TraceContext;
  useMidConversationSystem?: boolean;
}): RuntimeMessageEntry[] | null {
  if (options.attempt >= MAX_COMPACT_PROMPT_TOO_LONG_RETRIES) {
    options.logger?.warn("Compact summary prompt was too long; retry limit reached", {
      ...traceContextToLogContext(options.traceContext),
      attempt: options.attempt,
      event: "compact.prompt_too_long.retry_limit",
      maxAttempts: MAX_COMPACT_PROMPT_TOO_LONG_RETRIES,
      module: "core.runtime",
      remainingMessages: options.entriesForSummary.length,
    });
    return null;
  }

  const truncated = truncateRuntimeEntriesForCompactRetry(
    options.entriesForSummary,
    options.cause,
    { useMidConversationSystem: options.useMidConversationSystem },
  );
  if (!truncated) {
    return null;
  }

  options.logger?.warn("Compact summary prompt was too long; retrying with older rounds dropped", {
    ...traceContextToLogContext(options.traceContext),
    attempt: options.attempt + 1,
    droppedMessages: options.entriesForSummary.length - truncated.length,
    event: "compact.prompt_too_long.retry",
    maxAttempts: MAX_COMPACT_PROMPT_TOO_LONG_RETRIES,
    module: "core.runtime",
    remainingMessages: truncated.length,
  });

  return truncated;
}

export const REACTIVE_COMPACT_SUMMARY_INPUT_RATIO = 0.6;

export interface ReactiveCompactSummaryBudgetResult {
  selection: CompactEntrySelection;
  budgetTokens: number;
  preservedMoreGroups: number;
  prunedOldestGroups: number;
}

/**
 * Reactive 压缩发生在"上下文已经贴墙"之后，summary 请求本身也可能超过上游上限。
 * 按窗口 60% 给 summary 输入设硬预算：优先把最近 round 移出 summary（不丢数据），
 * 只有单个 round 过大时才裁掉最旧的 summary round。
 */
export function capReactiveCompactSummaryInput(input: {
  selection: CompactEntrySelection;
  entries: readonly RuntimeMessageEntry[];
  trigger: CompactTrigger;
  contextWindow: number | undefined;
  useMidConversationSystem?: boolean;
}): ReactiveCompactSummaryBudgetResult | null {
  const contextWindow = input.contextWindow;
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return null;
  }
  const budgetTokens = Math.floor(contextWindow * REACTIVE_COMPACT_SUMMARY_INPUT_RATIO);
  const estimate = (entries: readonly RuntimeMessageEntry[]): number =>
    entries.length === 0
      ? 0
      : estimateRuntimeEntryTokens(entries, {
          useMidConversationSystem: input.useMidConversationSystem,
        });

  if (estimate(input.selection.entriesForSummary) <= budgetTokens) {
    return {
      selection: input.selection,
      budgetTokens,
      preservedMoreGroups: 0,
      prunedOldestGroups: 0,
    };
  }

  const split = splitRuntimeEntriesForCompactSelection(input.entries, input.trigger);
  if (!split.shouldPreserveRecent || split.groups.length < 3) {
    return null;
  }

  const maxGroupsToPreserve = split.groups.length - 1;
  const groupTokens = split.groups.map((group) => estimate(group));
  const prefixTokens = estimate(split.prefixEntries);
  const totalGroupTokens = groupTokens.reduce((total, tokens) => total + tokens, 0);

  for (
    let preserve = Math.max(1, input.selection.groupsPreserved + 1);
    preserve <= maxGroupsToPreserve;
    preserve += 1
  ) {
    const preservedTokens = groupTokens
      .slice(split.groups.length - preserve)
      .reduce((total, tokens) => total + tokens, 0);
    if (prefixTokens + totalGroupTokens - preservedTokens > budgetTokens) continue;
    const selection = selectCompactEntries({
      entries: input.entries,
      minimumGroupsToPreserve: preserve,
      trigger: input.trigger,
    });
    if (estimate(selection.entriesForSummary) <= budgetTokens) {
      return {
        selection,
        budgetTokens,
        preservedMoreGroups: preserve - input.selection.groupsPreserved,
        prunedOldestGroups: 0,
      };
    }
  }

  // 单个 round 本身超预算：保留既有 recent 段，裁掉最旧的 summary round，至少留 2 组。
  const preserved = Math.max(0, Math.min(input.selection.groupsPreserved, split.groups.length - 2));
  const summaryEnd = split.groups.length - preserved;
  let start = 0;
  let summarizedTokens = groupTokens.slice(start, summaryEnd).reduce((total, t) => total + t, 0);
  while (start < summaryEnd - 2 && prefixTokens + summarizedTokens > budgetTokens) {
    summarizedTokens -= groupTokens[start] ?? 0;
    start += 1;
  }
  if (prefixTokens + summarizedTokens > budgetTokens) {
    return null;
  }

  const summaryGroups = split.groups.slice(start, summaryEnd);
  const preservedGroups = preserved > 0 ? split.groups.slice(summaryEnd) : [];
  return {
    selection: {
      entriesForSummary: [...split.prefixEntries, ...summaryGroups.flat()].map(cloneRuntimeEntry),
      groupsPreserved: preserved,
      preservedEntries: preservedGroups.flat().map(cloneRuntimeEntry),
      totalGroups: split.groups.length,
    },
    budgetTokens,
    preservedMoreGroups: Math.max(0, preserved - input.selection.groupsPreserved),
    prunedOldestGroups: start,
  };
}

function splitRuntimeEntriesForCompactSelection(
  inputEntries: readonly RuntimeMessageEntry[],
  trigger: CompactTrigger,
): {
  groups: RuntimeMessageEntry[][];
  prefixEntries: RuntimeMessageEntry[];
  shouldPreserveRecent: boolean;
} {
  const entries = inputEntries.map(cloneRuntimeEntry);
  const prefixCount = countContextPrefixMessages(entries);
  const prefixEntries = entries.slice(0, prefixCount);
  const bodyEntries = entries.slice(prefixCount);

  return {
    groups: groupRuntimeEntriesByCompactRound(bodyEntries),
    prefixEntries,
    shouldPreserveRecent: trigger === CompactTrigger.Auto || trigger === CompactTrigger.Reactive,
  };
}

function countRecentGroupsToPreserveAfterPromptTooLong(
  groupsForSummary: readonly RuntimeMessageEntry[][],
  promptTooLongCause: unknown,
  options: { useMidConversationSystem?: boolean } = {},
): number {
  const tokenGap = getPromptTooLongTokenGap(promptTooLongCause);
  if (tokenGap === undefined) {
    return 1;
  }

  const groupTokenEstimates = estimateCompactGroupTokens(groupsForSummary, {
    useMidConversationSystem: options.useMidConversationSystem,
  });
  return countRecentGroupsToCoverTokenGap(groupTokenEstimates, groupsForSummary.length, tokenGap);
}

function countRecentGroupsToCoverTokenGap(
  groupTokenEstimates: readonly number[],
  groupCount: number,
  tokenGap: number,
): number {
  if (tokenGap <= 0 || groupCount <= 0) {
    return 0;
  }

  let tokensCovered = 0;
  let groupsCovered = 0;
  for (let index = groupCount - 1; index >= 0; index -= 1) {
    tokensCovered += groupTokenEstimates[index] ?? 0;
    groupsCovered += 1;
    if (tokensCovered >= tokenGap) break;
  }

  if (groupsCovered >= groupCount - 1) {
    return Math.max(1, Math.floor(groupCount / 2));
  }
  return Math.max(1, groupsCovered);
}

function estimateCompactGroupTokens(
  groups: readonly RuntimeMessageEntry[][],
  options: { useMidConversationSystem?: boolean } = {},
): number[] {
  return groups.map((group) =>
    estimateRuntimeEntryTokens(group, {
      useMidConversationSystem: options.useMidConversationSystem,
    }),
  );
}

function truncateRuntimeEntriesForCompactRetry(
  entries: readonly RuntimeMessageEntry[],
  promptTooLongCause: unknown,
  options: { useMidConversationSystem?: boolean } = {},
): RuntimeMessageEntry[] | null {
  const prefix: RuntimeMessageEntry[] = [];
  let index = 0;
  while (index < entries.length && isContextPrefixEntry(entries[index]!)) {
    prefix.push(cloneRuntimeEntry(entries[index]!));
    index += 1;
  }

  let candidates = entries.slice(index);
  if (candidates[0] && isCompactPromptTooLongRetryMarker(candidates[0])) {
    candidates = candidates.slice(1);
  }

  const groups = groupRuntimeEntriesByCompactRound(candidates);
  if (groups.length < 2) return null;

  const tokenGap = getPromptTooLongTokenGap(promptTooLongCause);
  let dropCount = 0;
  if (tokenGap !== undefined) {
    let droppedTokens = 0;
    for (const group of groups) {
      droppedTokens += estimateRuntimeEntryTokens(group, {
        useMidConversationSystem: options.useMidConversationSystem,
      });
      dropCount += 1;
      if (droppedTokens >= tokenGap) break;
    }
  } else {
    dropCount = Math.max(1, Math.floor(groups.length * 0.2));
  }

  dropCount = Math.min(dropCount, groups.length - 1);
  if (dropCount < 1) return null;

  const sliced = groups.slice(dropCount).flat().map(cloneRuntimeEntry);
  if (sliced.length === 0) return null;

  const needsMarker = sliced[0] && runtimeEntryRole(sliced[0]) === "assistant";
  return [
    ...prefix,
    ...(needsMarker
      ? [
          {
            message: {
              role: "user" as const,
              content: COMPACT_PROMPT_TOO_LONG_RETRY_MARKER,
            },
          },
        ]
      : []),
    ...sliced,
  ];
}

function isCompactPromptTooLongRetryMarker(entry: RuntimeMessageEntry): boolean {
  if (isRuntimeAttachmentEntry(entry)) return false;
  return (
    entry.message.role === "user" &&
    modelMessageContentToText(entry.message.content) === COMPACT_PROMPT_TOO_LONG_RETRY_MARKER
  );
}

function groupRuntimeEntriesByCompactRound(
  entries: readonly RuntimeMessageEntry[],
): RuntimeMessageEntry[][] {
  // 服务端内置工具把一条持久化 assistant 拆成多条 runtime assistant；共用 compactGroupKey 的
  // 必须算作一组，否则保留组数与 selectPersistedCompactTail 按数据库消息算出的边界不一致。
  return groupByAssistantStartedRounds(entries, runtimeEntryRole, runtimeEntryCompactGroupKey);
}

function runtimeEntryCompactGroupKey(entry: RuntimeMessageEntry): string | undefined {
  return isRuntimeAttachmentEntry(entry) ? undefined : entry.compactGroupKey;
}

function positiveInt(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

function getPromptTooLongTokenGap(cause: unknown): number | undefined {
  let current: unknown = cause;
  const seen = new WeakSet<object>();

  for (let depth = 0; depth <= 6; depth += 1) {
    if (typeof current === "string") {
      const gap = parsePromptTooLongTokenGap(current);
      if (gap !== undefined) return gap;
      return undefined;
    }
    if (current === undefined || current === null || typeof current !== "object") {
      return undefined;
    }
    if (seen.has(current)) return undefined;
    seen.add(current);

    const record = current as Record<string, unknown>;
    for (const key of ["message", "errorDetails", "details", "body"]) {
      const value = record[key];
      if (typeof value === "string") {
        const gap = parsePromptTooLongTokenGap(value);
        if (gap !== undefined) return gap;
      }
    }
    current = record.cause ?? record.lastError ?? record.error;
  }

  return undefined;
}

function parsePromptTooLongTokenGap(message: string): number | undefined {
  const greaterThan = message.match(/(\d[\d,]*)\s*tokens?\s*>\s*(\d[\d,]*)/i);
  if (greaterThan) {
    return tokenGap(greaterThan[1], greaterThan[2]);
  }

  // 2026-11-03 deepseek 路由：「Input too long: model limit 1048576 tokens,
  // requested 1094684 tokens」。没有 ">" 关系，必须按 limit/requested 两个词取数。
  const modelLimit = message.match(
    /model limit\s+(\d[\d,]*)\s*tokens?[\s\S]*?requested\s+(\d[\d,]*)\s*tokens?/i,
  );
  if (modelLimit) {
    return tokenGap(modelLimit[2], modelLimit[1]);
  }

  // OpenAI 风格：「maximum context length is 128000 tokens. However, your messages
  // resulted in 130000 tokens」。
  const maximumContextLength = message.match(
    /maximum context length is\s+(\d[\d,]*)\s*tokens?[\s\S]*?(?:resulted in|requested)\s+(\d[\d,]*)\s*tokens?/i,
  );
  if (maximumContextLength) {
    return tokenGap(maximumContextLength[2], maximumContextLength[1]);
  }

  return undefined;
}

function tokenGap(
  actualValue: string | undefined,
  limitValue: string | undefined,
): number | undefined {
  const actual = Number(actualValue?.replace(/,/g, ""));
  const limit = Number(limitValue?.replace(/,/g, ""));
  if (!Number.isFinite(actual) || !Number.isFinite(limit) || actual <= limit) {
    return undefined;
  }
  return Math.ceil(actual - limit);
}

function cloneRuntimeEntry(entry: RuntimeMessageEntry): RuntimeMessageEntry {
  return cloneRuntimeMessageEntry(entry);
}

function runtimeEntryRole(entry: RuntimeMessageEntry): "system" | "user" | "assistant" | "tool" {
  if (isRuntimeAttachmentEntry(entry)) return "user";
  return entry.message.role;
}
