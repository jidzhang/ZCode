import { memo, useMemo } from "react";
import type { QueueItem, UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ConversationTurnRow } from "@/v4/ConversationTurnRow.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";

interface ConversationPendingGuideListProps {
  context: ConversationRowRenderContext;
  items: readonly QueueItem[];
  turnId: string;
  /** 「立即处理」入口：sendQueuedNow 中断当前运行 + 该待插话立即生效。 */
  onSteerNow?: (queueItemId: string) => void;
  /** 「修改」入口：撤回编辑（deleteQueueItem + 文本回填 composer）。 */
  onRecallEditQueued?: (queueItemId: string) => void | Promise<void>;
  /** 「撤销」入口：deleteQueueItem 从队列移除该待插话。 */
  onRevokeQueued?: (queueItemId: string) => void;
}

function pendingGuideRow(item: QueueItem, turnId: string): UserInputRow {
  return {
    rowId: -(item.order.admissionSeq + 1),
    turnId,
    productTurnId: turnId,
    entityId: item.queueItemId,
    kind: "userInput",
    text: item.text,
    origin: "realUser",
    sourceCommandId: item.sourceCommandId,
    clientId: item.clientId,
    attachments: item.attachments,
    createdAt: item.admittedAt,
    createdAtSeq: item.order.admissionSeq,
  };
}

function ConversationPendingGuideListImpl({
  context,
  items,
  turnId,
  onSteerNow,
  onRecallEditQueued,
  onRevokeQueued,
}: ConversationPendingGuideListProps) {
  const { intl } = useZCodeIntl();
  const rows = useMemo(() => items.map((item) => pendingGuideRow(item, turnId)), [items, turnId]);
  const status = intl.formatMessage({ id: "chat.message.turnSteer.pending" });

  if (rows.length === 0) return null;
  return (
    // 待引导消息直接渲染行，绕过了普通轮容器；补齐输入框 dock 的水平留白，避免气泡和状态贴边。
    <div data-v4-pending-guide-list="true" className="flex flex-col gap-5 px-4 pt-5">
      {rows.map((row) => (
        <ConversationTurnRow
          key={row.sourceCommandId}
          row={row}
          context={context}
          userInputStatus={status}
          onSteerNow={onSteerNow}
          onRecallEditQueued={onRecallEditQueued}
          onRevokeQueued={onRevokeQueued}
        />
      ))}
    </div>
  );
}

export const ConversationPendingGuideList = memo(ConversationPendingGuideListImpl);
