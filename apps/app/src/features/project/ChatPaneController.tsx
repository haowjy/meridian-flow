/**
 * ChatPaneController — desktop controller for the centered Chat destination.
 *
 * The persistent `ChatSurface` owns the live conversation instance outside the
 * screen switch. This controller renders only the destination chrome that keeps
 * sidebar/context rail reopen controls reachable above that surface.
 */
import { Trans } from "@lingui/react/macro";

import { ChatThreadTitle } from "@/features/chat/ChatThreadHeader";

import { useResolvedChatThread } from "./chat/chat-thread-resolution";
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
  // Same resolution as the ChatScreen body — otherwise the header shows the
  // "Chat" fallback while the body already renders the fallback thread.
  const { resolvedThreadId } = useResolvedChatThread(projectId, activeThreadId);
  return (
    <PaneHeader
      title={
        resolvedThreadId ? (
          <ChatThreadTitle
            projectId={projectId}
            threadId={resolvedThreadId}
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
