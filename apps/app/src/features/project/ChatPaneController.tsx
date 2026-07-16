/**
 * ChatPaneController — desktop controller for the centered Chat destination.
 *
 * The persistent `ChatSurface` owns the live conversation instance outside the
 * screen switch. This controller renders only the destination chrome that keeps
 * sidebar/context rail reopen controls reachable above that surface.
 */
import { Trans } from "@lingui/react/macro";

import { ChatThreadTitle } from "@/features/chat/ChatThreadHeader";

import { PaneTitle } from "./PaneTitle";
import { PaneHeader, type PaneHeaderRailToggle } from "./shell/PaneHeader";

export type ChatPaneControllerProps = {
  projectId: string;
  activeThreadId: string | null;
  sidebarToggle: PaneHeaderRailToggle;
  contextToggle: PaneHeaderRailToggle;
  onSelectThread: (threadId: string) => void;
};

export function ChatPaneController({
  projectId,
  activeThreadId,
  sidebarToggle,
  contextToggle,
  onSelectThread,
}: ChatPaneControllerProps) {
  return (
    <PaneHeader
      title={
        activeThreadId ? (
          <ChatThreadTitle
            projectId={projectId}
            threadId={activeThreadId}
            onSelectThread={onSelectThread}
            // The centered chat body is page-sheet: the switcher wears the
            // active-tab chip so the page continues up into the band.
            variant="tab"
          />
        ) : (
          <PaneTitle>
            <Trans>Chat</Trans>
          </PaneTitle>
        )
      }
      left={sidebarToggle}
      right={contextToggle}
    />
  );
}
