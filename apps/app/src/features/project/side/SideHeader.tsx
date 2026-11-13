/**
 * SideHeader — the band above the side view: the picker naming what it shows, and Swap with main. The
 * side's page sits below it, inset from main's. The side's own toggle is the shell's corner button;
 * the spacer holds its place.
 */
import { t } from "@lingui/core/macro";
import { ArrowLeftRight, MessageSquare } from "lucide-react";
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
import { PaneHeader } from "../shell/PaneHeader";
import { PanelToggleSpacer } from "../shell/PanelToggleButton";
import { useMainItem } from "../views";
import { SidePicker } from "./SidePicker";
import { useNewChatAbout, useSideItem } from "./SideView";

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
}: {
  projectId: string;
  /** Null while the side shows nothing. */
  name: string | null;
  icon: ReactNode;
  actions?: ReactNode;
  onOpenInMain?: () => void;
}) {
  const side = useSideItem();
  return (
    <>
      <PaneHeader
        title={<SidePicker projectId={projectId} name={name} icon={icon} />}
        actions={
          // The corner toggle always floats over this band, open or closed: its spacer is the
          // side's own, not PaneHeader's closed-rail one.
          <div className="flex items-center gap-0.5">
            {actions}
            {onOpenInMain ? (
              <IconButton size="sm" label={t`Swap with main`} onClick={onOpenInMain}>
                <ArrowLeftRight aria-hidden />
              </IconButton>
            ) : null}
            <PanelToggleSpacer />
          </div>
        }
      />
      {side.failed ? (
        <div className="shrink-0 px-2 pb-1">
          <InlineErrorRow
            message={t`Couldn't look up the document to show here.`}
            onRetry={side.failed.retry}
          />
        </div>
      ) : null}
    </>
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
}: {
  projectId: string;
  threadId: string | null;
  onOpenInMain?: () => void;
}) {
  const activity = useThreadActivity({ threadId: threadId ?? "", seed: null });
  const name = useSideChatName(projectId, threadId);
  return (
    <SideBand
      projectId={projectId}
      name={name}
      icon={<MessageSquare aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
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

/** The side with nothing to show: a document's lookup is out, or no document has been opened. */
export function SideEmptyHeader({ projectId }: { projectId: string }) {
  const side = useSideItem();
  return (
    <SideBand
      projectId={projectId}
      name={side.pending ? t`Finding a document…` : null}
      icon={null}
    />
  );
}
