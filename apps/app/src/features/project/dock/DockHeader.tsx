/** The desktop dock header names its document or the screen’s native occupant. */
import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { ChatFilesMenu } from "@/features/chat/ChatFilesMenu";
import { SubagentHeader } from "@/features/chat/SubagentHeader";
import { useThreadActivity } from "@/features/chat/useThreadActivity";
import { RemovedDocumentChip, RemovedNoticeSlot } from "../context/RemovedDocumentNotice";
import type { OpenDocumentTab } from "../open-documents";
import { PaneTitle } from "../PaneTitle";
import type { ScreenKey } from "../routing/project-route";
import { PanelToggleSpacer } from "../shell/PanelToggleButton";
import { DockDocumentIdentity } from "./DockDocumentIdentity";

export type DockHeaderSlotArgs = {
  screen: ScreenKey;
  projectId: string;
  /** The document that replaces the views while the dock shows one. */
  document: OpenDocumentTab | null;
};

export type DockHeaderProps = DockHeaderSlotArgs & {
  onClose?: () => void;
  threadSelect?: ReactNode;
  threadId?: string | null;
};

export function DockHeader({
  projectId,
  screen,
  document: dockDocument,
  onClose,
  threadSelect,
  threadId,
}: DockHeaderProps) {
  const activity = useThreadActivity({
    threadId: threadId ?? "",
    seed: null,
  });
  // The dock's toggle is the shell's corner button; px-2 here holds its place.
  const collapse = onClose ? <PanelToggleSpacer /> : null;
  if (dockDocument) {
    return (
      <header className="flex min-h-10 shrink-0 items-stretch">
        <DockDocumentIdentity projectId={projectId} document={dockDocument} trailing={collapse} />
      </header>
    );
  }
  return (
    <header className="flex h-10 shrink-0 items-stretch pl-2 coarse:h-11">
      {/* No overflow-hidden: truncation is owned by the min-w-0/truncate chain
          inside, and clipping here shears the trigger's hover pill (it
          bleeds left of the slot). */}
      <div className="relative flex min-w-0 flex-1 items-center gap-1 pr-1">
        {/* The Chat screen's rail: the same chip as an open document's, with nothing open. */}
        {screen === "chat" ? (
          <>
            <PaneTitle>
              <Trans>Recent</Trans>
            </PaneTitle>
            {/* The header's free end holds the notice for a document the dock closed. */}
            <RemovedNoticeSlot>
              <RemovedDocumentChip projectId={projectId} />
            </RemovedNoticeSlot>
          </>
        ) : null}
        {screen !== "chat" ? threadSelect : null}
        {screen !== "chat" && threadId ? (
          <>
            <ChatFilesMenu projectId={projectId} threadId={threadId} />
            <SubagentHeader threadId={threadId} nodes={activity.activity.children} />
          </>
        ) : null}
      </div>
      {collapse ? <div className="flex shrink-0 items-center gap-0.5 px-2">{collapse}</div> : null}
    </header>
  );
}
