import { ShareIcon } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConversationShareSelectionStore } from "@/store/conversationShareSelectionStore.js";
import { WINDOWS_CAPTION_CONTROL_CLASS } from "@/windowCaptionControls.js";

// safe-zcode：分享发布默认关闭。分享会把对话内容发布到官方后端（zcode.z.ai，
// 见 conversationShareService 的 webShareCallbackUrl），在账号登录策略明确前，
// 不向官方后端发布任何会话内容；他人分享的链接导入（被动拉取）不受此开关影响。
// 需要恢复时将此常量改为 true，或后续接入设置项。导出供测试按门控跳过入口用例。
export const CONVERSATION_SHARE_PUBLISH_ENABLED = false;

export function ConversationShareMenu({
  taskId,
  useWindowsCaptionSpacing = false,
}: {
  taskId: string;
  useWindowsCaptionSpacing?: boolean;
}) {
  if (!CONVERSATION_SHARE_PUBLISH_ENABLED) return null;
  const { intl } = useZCodeIntl();
  const openShare = useConversationShareSelectionStore((state) => state.openShare);
  const closeShare = useConversationShareSelectionStore((state) => state.closeShare);
  const publishing = useConversationShareSelectionStore(
    (state) => state.dockStates[taskId]?.publishing ?? false,
  );
  const active = useConversationShareSelectionStore((state) => state.drafts[taskId]?.open ?? false);
  const handleClick = () => {
    if (publishing) return;
    if (active) closeShare(taskId);
    else openShare(taskId);
  };

  const trigger = (
    <Button
      type="button"
      variant="ghost"
      // 分享曾使用更大的热区和独立 mask 缩放；复用相邻工具栏按钮的尺寸与图标规范。
      size="icon-md"
      className={cn(
        "text-foreground hover:bg-hover hover:text-foreground [app-region:no-drag]",
        useWindowsCaptionSpacing ? "ml-3" : "ml-2.5",
        useWindowsCaptionSpacing && WINDOWS_CAPTION_CONTROL_CLASS,
        active && "bg-selected",
      )}
      aria-label={intl.formatMessage({ id: "conversationShare.trigger" })}
      data-testid="conversation-share-trigger"
      data-share-session={taskId}
      aria-pressed={active}
      disabled={publishing}
      onClick={handleClick}
    >
      <ShareIcon className="size-4" />
    </Button>
  );

  return active ? (
    trigger
  ) : (
    <ControlHintTooltip
      title={intl.formatMessage({ id: "conversationShare.trigger" })}
      side="bottom"
    >
      {trigger}
    </ControlHintTooltip>
  );
}
