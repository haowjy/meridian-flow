/**
 * Shared header chrome for thread-info proto — agent mark, title slot, ⓘ + collapse.
 */
import { PanelRightClose } from "lucide-react";
import type { ReactNode } from "react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { PanelToggleButton } from "@/features/project/shell/PanelToggleButton";

import { MOCK_AGENT_INITIALS, MOCK_AGENT_NAME } from "./mock-data";

export function MockChatHeaderChrome({
  titleControl,
  extraActions,
}: {
  titleControl: ReactNode;
  extraActions?: ReactNode;
}) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-1 border-b border-border-subtle bg-background px-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <AgentMark />
        <span className="text-muted-foreground" aria-hidden>
          ·
        </span>
        <div className="min-w-0 flex-1">{titleControl}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {extraActions}
        <PanelToggleButton icon={PanelRightClose} label="Collapse chat" onClick={() => {}} />
      </div>
    </header>
  );
}

function AgentMark() {
  return (
    <span className="flex shrink-0 items-center gap-1.5" title={`Started with ${MOCK_AGENT_NAME}`}>
      <Avatar className="size-6">
        <AvatarFallback className="bg-gradient-mark text-fine font-semibold text-white">
          {MOCK_AGENT_INITIALS}
        </AvatarFallback>
      </Avatar>
      <span className="sr-only">{MOCK_AGENT_NAME}</span>
    </span>
  );
}
