import { t } from "@lingui/core/macro";
import { MessageSquareShare } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { useOpenChatThread } from "./ChatThreadNavigation";
import { subagentMarkName } from "./subagent/display";

export function OpenSubagentChatButton({
  threadId,
  agentName,
  onOpened,
}: {
  threadId: string | null | undefined;
  agentName: string | null | undefined;
  onOpened?: () => void;
}) {
  const contextOpenThread = useOpenChatThread();
  const openThread = contextOpenThread;
  if (!threadId || !openThread) return null;
  const name = subagentMarkName(agentName);
  const label = t`Open "${name}"`;
  return (
    <IconButton
      type="button"
      size="sm"
      label={label}
      onClick={(event) => {
        event.stopPropagation();
        openThread(threadId);
        onOpened?.();
      }}
      className="size-7"
    >
      <MessageSquareShare aria-hidden />
    </IconButton>
  );
}
