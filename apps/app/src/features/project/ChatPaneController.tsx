/**
 * ChatPaneController — desktop controller for the centered Chat destination.
 *
 * The persistent `ChatSurface` owns the live conversation instance outside the
 * screen switch. This controller renders only the destination chrome that keeps
 * sidebar/context rail reopen controls reachable above that surface.
 */
import { Trans } from "@lingui/react/macro";

import { ChatThreadTitle } from "@/features/chat/ChatThreadHeader";
import { ThreadContentsPopover } from "@/features/chat/ThreadContentsPopover";
import type { ThreadDocumentSelection } from "@/features/chat/ThreadDocumentSections";

import { PaneTitle } from "./PaneTitle";
import { PaneHeader, type PaneHeaderRailToggle } from "./shell/PaneHeader";

export type ChatPaneControllerProps = {
  projectId: string;
  activeThreadId: string | null;
  sidebarToggle: PaneHeaderRailToggle;
  contextToggle: PaneHeaderRailToggle;
  onSelectThread: (threadId: string) => void;
  /** Popover document-open handoff. Resolved by the parent into the rail viewer. */
  onOpenDocument?: (selection: ThreadDocumentSelection) => void;
};

export function ChatPaneController({
  projectId,
  activeThreadId,
  sidebarToggle,
  contextToggle,
  onSelectThread,
  onOpenDocument,
}: ChatPaneControllerProps) {
  return (
    <main className="main-pane flex shrink-0 flex-col">
      <PaneHeader
        title={
          activeThreadId ? (
            <ChatThreadTitle
              projectId={projectId}
              threadId={activeThreadId}
              onSelectThread={onSelectThread}
            />
          ) : (
            <PaneTitle>
              <Trans>Chat</Trans>
            </PaneTitle>
          )
        }
        left={sidebarToggle}
        right={contextToggle}
        actions={
          <ThreadContentsPopover threadId={activeThreadId} onOpenDocument={onOpenDocument} />
        }
      />
    </main>
  );
}
