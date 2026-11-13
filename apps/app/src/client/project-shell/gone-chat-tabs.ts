import { useEffect, useRef } from "react";
import { probeChatDestination } from "@/client/chat-submissions/thread-availability";
import { useThreadTransport } from "@/client/providers/TransportProvider";
import { dropMainTabChat, readMainTabs } from "./main-tabs";

/**
 * Closes the chat tabs of chats deleted somewhere else (another window or device). The project's
 * chat list lists primary chats only, so it cannot say a tab's chat is gone; the owner gate can.
 * The probe runs for the chat tabs main isn't showing (the shown chat has its own verdict) once
 * at mount, and again on the catalog channel's `project-chats-hint`, which the server publishes
 * after a chat delete or restore and the socket client replays after a reconnect. Nothing polls:
 * idle tabs cost no request. Only a definitive "deleted" closes a tab: a chat the server does not
 * know yet (a first send still in flight) and a failed probe leave it open.
 */
export function useDropGoneChatTabs(
  accountId: string,
  projectId: string,
  shownChatId: string | null,
): void {
  const transport = useThreadTransport();
  const shown = useRef(shownChatId);
  shown.current = shownChatId;
  useEffect(() => {
    let active = true;
    const check = () => {
      for (const tab of readMainTabs(accountId, projectId).chat.tabs) {
        if (tab.chatId === shown.current) continue;
        void probeChatDestination(accountId, tab.chatId).then((verdict) => {
          if (active && (verdict === "deleted" || verdict === "project-deleted"))
            dropMainTabChat(accountId, projectId, tab.chatId);
        });
      }
    };
    check();
    const unsubscribe = transport.subscribeCatalog(projectId, (hint) => {
      if (hint.type === "project-chats-hint") check();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [accountId, projectId, transport]);
}
