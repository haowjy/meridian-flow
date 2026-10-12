/** The one door from a subagent card or row to that subagent's own chat. */

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
  /** The agent profile name, not the task title, so the label stays short. */
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
      tooltip={label}
      onClick={(event) => {
        // Cards toggle on row clicks; opening the chat must not also toggle them.
        event.stopPropagation();
        openThread(threadId);
        onOpened?.();
      }}
      // The subagent row's height is set by this door.
      className="size-7"
    >
      <MessageSquareShare aria-hidden />
    </IconButton>
  );
}
