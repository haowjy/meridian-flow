/** The one door from a subagent card or row to that subagent's own chat. */

import { t } from "@lingui/core/macro";
import { MessageSquareShare } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useOpenChatThread } from "./ChatThreadNavigation";

export function OpenSubagentChatButton({ threadId }: { threadId: string | null | undefined }) {
  const openThread = useOpenChatThread();
  if (!threadId || !openThread) return null;
  const label = t`Open subagent chat`;
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
