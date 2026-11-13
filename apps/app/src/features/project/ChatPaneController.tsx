/**
 * ChatPaneController — main's band while main holds a chat: the chat lane, and the chat's own
 * controls.
 *
 * The persistent `ChatSurface` owns the live conversation instance; this renders only its chrome.
 */

import { ChatFilesMenu } from "@/features/chat/ChatFilesMenu";
import { SubagentHeader } from "@/features/chat/SubagentHeader";
import { useThreadActivity } from "@/features/chat/useThreadActivity";
import { useChatNavigation } from "./routing/chat-navigation";
import type { OpenContextRoute } from "./routing/ProjectNavigationContext";
import { MainHeader } from "./shell/MainHeader";
import type { PaneHeaderRailToggle } from "./shell/PaneHeader";

export type ChatPaneControllerProps = {
  projectId: string;
  threadId: string | null;
  open: OpenContextRoute;
  sidebarToggle: PaneHeaderRailToggle;
  contextToggle: PaneHeaderRailToggle;
};

export function ChatPaneController({
  projectId,
  threadId,
  open,
  sidebarToggle,
  contextToggle,
}: ChatPaneControllerProps) {
  const chat = useChatNavigation();
  const activity = useThreadActivity({
    threadId: threadId ?? "",
    seed: null,
  });
  return (
    <MainHeader
      projectId={projectId}
      open={open}
      kind="chat"
      mainTab={threadId ? { kind: "chat", chatId: threadId } : undefined}
      keepMain={threadId === null}
      onNew={() => void chat.openNewChat()}
      onShowRecents={() => void chat.openChatRecents()}
      sidebarToggle={sidebarToggle}
      sideToggle={contextToggle}
      actions={
        threadId ? (
          <>
            <ChatFilesMenu projectId={projectId} threadId={threadId} />
            <SubagentHeader threadId={threadId} nodes={activity.activity.children} />
          </>
        ) : null
      }
    />
  );
}
