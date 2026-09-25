/**
 * ChatIndexController — the centered chat index at the project root.
 *
 * Header band grammar matches the Editor showing Recently opened: the index
 * chip is the active tab the page rises into, and the remembered chat (or the
 * pending new chat) waits beside it as an inactive tab that leads back.
 */
import { t } from "@lingui/core/macro";

import { displayThreadTitle } from "@/lib/thread-title";
import { ChatIndex } from "./chat-index/ChatIndex";
import { ChatIndexChip, CurrentChatChip } from "./chat-index/ChatIndexButton";
import { useProjectThreadGroups } from "./data/project-thread-groups";
import { useProjectChatNavigation } from "./routing/ProjectNavigationContext";
import { PaneHeader, type PaneHeaderRailToggle } from "./shell/PaneHeader";

export type ChatIndexControllerProps = {
  projectId: string;
  sidebarToggle: PaneHeaderRailToggle;
  contextToggle: PaneHeaderRailToggle;
  onOpenThread: (threadId: string) => void;
};

export function ChatIndexController({
  projectId,
  sidebarToggle,
  contextToggle,
  onOpenThread,
}: ChatIndexControllerProps) {
  const navigation = useProjectChatNavigation();
  const { threadById } = useProjectThreadGroups(projectId);
  const current = navigation?.currentChat;
  const currentTitle =
    current?.kind === "thread"
      ? displayThreadTitle(threadById.get(current.threadId)?.title)
      : current?.kind === "new"
        ? t`New chat`
        : null;
  const showCurrentChat = navigation?.showCurrentChat;
  return (
    <main className="main-pane flex min-h-0 flex-1 flex-col">
      <PaneHeader
        leading={<ChatIndexChip active />}
        title={
          currentTitle && showCurrentChat ? (
            <CurrentChatChip title={currentTitle} onClick={() => void showCurrentChat()} />
          ) : null
        }
        left={sidebarToggle}
        right={contextToggle}
      />
      <div className="page-sheet min-h-0">
        <ChatIndex projectId={projectId} onOpenThread={onOpenThread} />
      </div>
    </main>
  );
}
