/**
 * SideHeader — the band above the side view: the picker naming what it shows, why it is there,
 * the held mark while a pick is in force (pressing it releases the hold), and Open in main. No
 * page rises into it. The side's own toggle is the shell's corner button; the spacer holds its
 * place.
 */
import { t } from "@lingui/core/macro";
import { Maximize2, MessageSquare, Pin } from "lucide-react";
import type { ReactNode } from "react";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import type { ContextTab } from "@/client/stores";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { IconButton } from "@/components/ui/icon-button";
import { ChatFilesMenu } from "@/features/chat/ChatFilesMenu";
import { SubagentHeader } from "@/features/chat/SubagentHeader";
import { useThreadActivity } from "@/features/chat/useThreadActivity";
import { displayThreadTitle } from "@/lib/thread-title";
import { fileKindIcon } from "../context/context-file-icon";
import { PanelToggleSpacer } from "../shell/PanelToggleButton";
import { useMainItem } from "../views";
import { SidePicker } from "./SidePicker";
import { useShellCommands, useSideItem } from "./SideView";
import type { SideReason } from "./side-item";

/** The quiet line after the side's name that says why it is there. */
export function sideReasonText(reason: SideReason | null, mainName: string | null): string | null {
  switch (reason) {
    case "opened-from":
      return t`You followed a link from here`;
    case "edited":
      return mainName ? t`Edited ${mainName}` : t`Edited this`;
    case "chat-edited":
      return t`This chat wrote it`;
    case "chat-read":
      return t`This chat read it`;
    case "last-document":
      return t`Last document`;
    case "last-chat":
      return t`Last chat`;
    default:
      return null;
  }
}

/** The side's chat's name: its title, or for a new chat what it will be about. */
export function useSideChatName(
  projectId: string,
  chatId: string | null,
  aboutName: string | null,
): string {
  const { threads } = useProjectThreads(projectId);
  if (chatId === null) return aboutName ? t`New chat about ${aboutName}` : t`New chat`;
  return displayThreadTitle(threads?.find((thread) => thread.id === chatId)?.title);
}

function SideBand({
  projectId,
  name,
  icon,
  actions,
  onOpenInMain,
  chatsOnly,
  leading,
  trailing,
}: {
  projectId: string;
  name: string;
  icon: ReactNode;
  actions?: ReactNode;
  onOpenInMain?: () => void;
  chatsOnly?: boolean;
  /** Before the picker (the phone sheet's close). */
  leading?: ReactNode;
  /** After everything (the phone has no corner toggle to make room for). */
  trailing?: ReactNode;
}) {
  const side = useSideItem();
  const { releaseSide } = useShellCommands(projectId);
  const mainName = useMainItem().document.tab?.name ?? null;
  const reason = side.source === "held" ? null : sideReasonText(side.reason, mainName);
  return (
    <div className="shrink-0">
      <header className="flex h-10 items-stretch pl-2 coarse:h-11">
        {leading}
        {/* No overflow-hidden: clipping here shears the title's hover pill. */}
        <div className="relative flex min-w-0 flex-1 items-center gap-1.5 pr-1">
          <SidePicker projectId={projectId} name={name} icon={icon} chatsOnly={chatsOnly} />
          {reason ? (
            <span className="min-w-0 shrink truncate text-xs text-muted-foreground">{reason}</span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 pr-2">
          {side.source === "held" ? (
            <IconButton size="sm" label={t`Held here. Follow main again`} onClick={releaseSide}>
              <Pin className="size-3.5" aria-hidden />
            </IconButton>
          ) : null}
          {actions}
          {onOpenInMain ? (
            <IconButton size="sm" label={t`Open in main`} onClick={onOpenInMain}>
              <Maximize2 className="size-3.5" aria-hidden />
            </IconButton>
          ) : null}
          {trailing ?? <PanelToggleSpacer />}
        </div>
      </header>
      {side.retry ? (
        <div className="px-2 pb-1">
          <InlineErrorRow message={t`Couldn't find what goes with this.`} onRetry={side.retry} />
        </div>
      ) : null}
    </div>
  );
}

export function SideDocumentHeader({
  projectId,
  tab,
  onOpenInMain,
}: {
  projectId: string;
  tab: ContextTab;
  onOpenInMain: () => void;
}) {
  const Icon = fileKindIcon(tab.name);
  return (
    <SideBand
      projectId={projectId}
      name={tab.name}
      icon={<Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
      onOpenInMain={onOpenInMain}
    />
  );
}

export function SideChatHeader({
  projectId,
  threadId,
  onOpenInMain,
  chatsOnly,
  leading,
  trailing,
}: {
  projectId: string;
  threadId: string | null;
  onOpenInMain?: () => void;
  chatsOnly?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  const activity = useThreadActivity({ threadId: threadId ?? "", seed: null });
  const mainName = useMainItem().document.tab?.name ?? null;
  const name = useSideChatName(projectId, threadId, mainName);
  return (
    <SideBand
      projectId={projectId}
      name={name}
      icon={<MessageSquare aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
      chatsOnly={chatsOnly}
      leading={leading}
      trailing={trailing}
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

/** The side with nothing to show: its first companion read is out or failed, or main has no companion. */
export function SideEmptyHeader({ projectId, opening }: { projectId: string; opening: boolean }) {
  const side = useSideItem();
  return (
    <SideBand
      projectId={projectId}
      name={
        opening
          ? t`Opening…`
          : side.pending
            ? t`Finding what goes with this…`
            : t`Choose what sits beside`
      }
      icon={null}
    />
  );
}
