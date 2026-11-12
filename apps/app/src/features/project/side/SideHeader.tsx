/**
 * SideHeader — the band above the side view: the picker naming what it shows, the held mark while a pick is in force (pressing it releases the hold), and Open in main. The
 * side's page sits below it, inset from main's. The side's own toggle is the shell's corner button; the spacer holds its
 * place.
 */
import { t } from "@lingui/core/macro";
import { Maximize2, MessageSquare, Pin } from "lucide-react";
import type { ReactNode } from "react";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import type { OpenDocument } from "@/client/stores";
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
import { useNewChatAbout, useShellCommands, useSideItem } from "./SideView";

/**
 * The side's chat's name: its title, or for a new chat what its composer will attach: main's
 * document while the composer follows it, else the chip the writer kept.
 */
export function useSideChatName(projectId: string, chatId: string | null): string {
  const { threads } = useProjectThreads(projectId);
  const about = useNewChatAbout().about;
  const mainName = useMainItem().document.document?.name ?? null;
  if (chatId === null) {
    const aboutName = about === "follows" ? mainName : (about?.label ?? null);
    return aboutName ? t`New chat about ${aboutName}` : t`New chat`;
  }
  return displayThreadTitle(threads?.find((thread) => thread.id === chatId)?.title);
}

function SideBand({
  projectId,
  name,
  icon,
  actions,
  onOpenInMain,
  leading,
  trailing,
}: {
  projectId: string;
  /** Null while the side shows nothing. */
  name: string | null;
  icon: ReactNode;
  actions?: ReactNode;
  onOpenInMain?: () => void;
  /** Before the picker (the phone sheet's close). */
  leading?: ReactNode;
  /** After everything (the phone has no corner toggle to make room for). */
  trailing?: ReactNode;
}) {
  const side = useSideItem();
  const { releaseSide } = useShellCommands(projectId);
  return (
    <div className="shrink-0">
      <header className="flex h-10 items-stretch pl-2 coarse:h-11">
        {leading}
        {/* No overflow-hidden: clipping here shears the title's hover pill. */}
        <div className="relative flex min-w-0 flex-1 items-center gap-1.5 pr-1">
          <SidePicker projectId={projectId} name={name} icon={icon} />
        </div>
        <div className="flex shrink-0 items-center gap-0.5 pr-2">
          {side.source === "held" ? (
            <IconButton size="sm" label={t`Held here. Follow main again`} onClick={releaseSide}>
              <Pin aria-hidden />
            </IconButton>
          ) : null}
          {actions}
          {onOpenInMain ? (
            <IconButton size="sm" label={t`Open in main`} onClick={onOpenInMain}>
              <Maximize2 aria-hidden />
            </IconButton>
          ) : null}
          {trailing ?? <PanelToggleSpacer />}
        </div>
      </header>
      {side.failed ? (
        <div className="px-2 pb-1">
          <InlineErrorRow
            message={
              side.failed.read === "document"
                ? t`Couldn't look up the document to show here.`
                : t`Couldn't find what goes with this.`
            }
            onRetry={side.failed.retry}
          />
        </div>
      ) : null}
    </div>
  );
}

export function SideDocumentHeader({
  projectId,
  document,
  onOpenInMain,
}: {
  projectId: string;
  document: OpenDocument;
  onOpenInMain: () => void;
}) {
  const Icon = fileKindIcon(document.name);
  return (
    <SideBand
      projectId={projectId}
      name={document.name}
      icon={<Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
      onOpenInMain={onOpenInMain}
    />
  );
}

export function SideChatHeader({
  projectId,
  threadId,
  onOpenInMain,
  leading,
  trailing,
}: {
  projectId: string;
  threadId: string | null;
  onOpenInMain?: () => void;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  const activity = useThreadActivity({ threadId: threadId ?? "", seed: null });
  const name = useSideChatName(projectId, threadId);
  return (
    <SideBand
      projectId={projectId}
      name={name}
      icon={<MessageSquare aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
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
export function SideEmptyHeader({ projectId }: { projectId: string }) {
  const side = useSideItem();
  return (
    <SideBand
      projectId={projectId}
      name={side.pending ? t`Finding what goes with this…` : null}
      icon={null}
    />
  );
}
