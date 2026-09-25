/**
 * ChatIndexController — the centered chat index at the project root.
 *
 * Header band grammar matches the Editor showing Recently opened: the index
 * chip is the active tab the page rises into, and the current chat waits
 * beside it as an inactive tab that leads back.
 */
import { displayThreadTitle } from "@/lib/thread-title";
import { ChatIndex } from "./chat-index/ChatIndex";
import { ChatIndexChip, CurrentChatChip } from "./chat-index/ChatIndexButton";
import { useProjectThreadGroups } from "./data/project-thread-groups";
import { useChatNavigation } from "./routing/chat-navigation";
import { PaneHeader, type PaneHeaderRailToggle } from "./shell/PaneHeader";

export type ChatIndexControllerProps = {
  projectId: string;
  sidebarToggle: PaneHeaderRailToggle;
  contextToggle: PaneHeaderRailToggle;
};

export function ChatIndexController({
  projectId,
  sidebarToggle,
  contextToggle,
}: ChatIndexControllerProps) {
  const { display, openChat } = useChatNavigation();
  // ChatIndexController only renders while the index is showing, so the
  // display is always the "index" variant; the chip reopens the remembered
  // current chat, which stays live behind the index even though it is not
  // displayed content.
  const currentThreadId = display.kind === "index" ? display.currentThreadId : null;
  const { threadById } = useProjectThreadGroups(projectId);
  return (
    <main className="main-pane flex min-h-0 flex-1 flex-col">
      <PaneHeader
        leading={<ChatIndexChip active />}
        title={
          currentThreadId ? (
            <CurrentChatChip
              title={displayThreadTitle(threadById.get(currentThreadId)?.title)}
              onClick={() => void openChat(currentThreadId)}
            />
          ) : null
        }
        left={sidebarToggle}
        right={contextToggle}
      />
      <div className="page-sheet min-h-0">
        <ChatIndex projectId={projectId} />
      </div>
    </main>
  );
}
