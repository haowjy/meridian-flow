/** The one door from a subagent card or row to that subagent's own chat. */

import { t } from "@lingui/core/macro";
import { MessageSquareShare } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useOpenChatThread } from "./ChatThreadNavigation";
import { subagentMarkName } from "./subagent-display";

export function OpenSubagentChatButton({
  threadId,
  agentName,
  openThread: openThreadOverride,
  onOpened,
}: {
  threadId: string | null | undefined;
  /** The agent profile name, not the task title, so the label stays short. */
  agentName: string | null | undefined;
  /** Surfaces outside the chat's navigation context (the tab-row pop-up) pass their own. */
  openThread?: (threadId: string) => void;
  onOpened?: () => void;
}) {
  const contextOpenThread = useOpenChatThread();
  const openThread = openThreadOverride ?? contextOpenThread;
  if (!threadId || !openThread) return null;
  const name = subagentMarkName(agentName);
  const label = t`Open "${name}"`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={(event) => {
            // Cards toggle on row clicks; opening the chat must not also toggle them.
            event.stopPropagation();
            openThread(threadId);
            onOpened?.();
          }}
          className="focus-ring grid size-7 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <MessageSquareShare className="size-4" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
