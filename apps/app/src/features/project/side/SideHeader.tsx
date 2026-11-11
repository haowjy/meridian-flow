/**
 * SideHeader — the band above the side view: the name of what it shows and Open in main. No page
 * rises into it, so its title is the quiet chip. The side's own toggle is the shell's corner
 * button; the spacer holds its place.
 */
import { t } from "@lingui/core/macro";
import { Maximize2 } from "lucide-react";
import type { ReactNode } from "react";
import type { ContextTab } from "@/client/stores";
import { IconButton } from "@/components/ui/icon-button";
import { ChatFilesMenu } from "@/features/chat/ChatFilesMenu";
import { ChatThreadTitle } from "@/features/chat/ChatThreadTitle";
import { SubagentHeader } from "@/features/chat/SubagentHeader";
import { useThreadActivity } from "@/features/chat/useThreadActivity";
import { cn } from "@/lib/utils";
import { fileKindIcon } from "../context/context-file-icon";
import { PanelToggleSpacer } from "../shell/PanelToggleButton";
import { titleChipClass } from "../shell/tab-chip";

function SideBand({
  title,
  actions,
  onOpenInMain,
}: {
  title: ReactNode;
  actions?: ReactNode;
  onOpenInMain?: () => void;
}) {
  return (
    <header className="flex h-10 shrink-0 items-stretch pl-2 coarse:h-11">
      {/* No overflow-hidden: clipping here shears the title's hover pill. */}
      <div className="relative flex min-w-0 flex-1 items-center gap-1 pr-1">{title}</div>
      <div className="flex shrink-0 items-center gap-0.5 pr-2">
        {actions}
        {onOpenInMain ? (
          <IconButton size="sm" label={t`Open in main`} onClick={onOpenInMain}>
            <Maximize2 className="size-3.5" aria-hidden />
          </IconButton>
        ) : null}
        <PanelToggleSpacer />
      </div>
    </header>
  );
}

export function SideDocumentHeader({
  tab,
  onOpenInMain,
}: {
  tab: ContextTab;
  onOpenInMain: () => void;
}) {
  const Icon = fileKindIcon(tab.name);
  return (
    <SideBand
      title={
        <span
          className={cn(titleChipClass("quiet"), "min-w-0")}
          title={tab.kind === "new" ? tab.name : tab.path}
        >
          <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-sm font-medium">{tab.name}</span>
        </span>
      }
      onOpenInMain={onOpenInMain}
    />
  );
}

export function SideChatHeader({
  projectId,
  threadId,
  onOpenInMain,
}: {
  projectId: string;
  threadId: string | null;
  onOpenInMain?: () => void;
}) {
  const activity = useThreadActivity({ threadId: threadId ?? "", seed: null });
  return (
    <SideBand
      title={<ChatThreadTitle projectId={projectId} threadId={threadId} />}
      actions={
        threadId ? (
          <>
            <ChatFilesMenu projectId={projectId} threadId={threadId} />
            <SubagentHeader threadId={threadId} nodes={activity.activity.children} />
          </>
        ) : null
      }
      onOpenInMain={onOpenInMain}
    />
  );
}
