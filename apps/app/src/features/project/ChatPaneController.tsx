/**
 * ChatPaneController — desktop controller for the centered Chat destination.
 *
 * The persistent `ChatSurface` owns the live conversation instance outside the
 * screen switch. This controller renders only the destination chrome that keeps
 * sidebar/context rail reopen controls reachable above that surface.
 */
import { ChatThreadTitle } from "@/features/chat/ChatThreadHeader";
import { ChatIndexChip } from "./chat-index/ChatIndexButton";
import { useProjectChatNavigation } from "./routing/ProjectNavigationContext";

import { PaneHeader, type PaneHeaderRailToggle } from "./shell/PaneHeader";

export type ChatPaneControllerProps = {
  projectId: string;
  threadId: string | null;
  sidebarToggle: PaneHeaderRailToggle;
  contextToggle: PaneHeaderRailToggle;
  onSelectThread: (threadId: string) => void;
};

export function ChatPaneController({
  projectId,
  threadId,
  sidebarToggle,
  contextToggle,
  onSelectThread,
}: ChatPaneControllerProps) {
  const navigation = useProjectChatNavigation();
  return (
    <PaneHeader
      leading={
        <ChatIndexChip
          active={false}
          onClick={navigation?.openChatIndex && (() => void navigation.openChatIndex?.())}
        />
      }
      title={
        <ChatThreadTitle
          projectId={projectId}
          threadId={threadId}
          onSelectThread={onSelectThread}
          // The centered chat body is page-sheet: the switcher wears the
          // active-tab chip so the page continues up into the band.
          variant="tab"
        />
      }
      left={sidebarToggle}
      right={contextToggle}
    />
  );
}
