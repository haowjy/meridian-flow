import { useEffect, useRef } from "react";
import { probeChatDestination } from "@/client/chat-submissions/thread-availability";
import { useThreadTransport } from "@/client/providers/TransportProvider";
import { dropMainTabChat, readMainTabs } from "./main-tabs";

/**
 * Closes the chat tabs of chats deleted somewhere else (another window or device). A delete's
 * `project-chats-hint` names the chat ids it removed, so those tabs close without a request. The
 * owner-gate probe covers only what no hint can name: once at mount, and on a hint with
 * `recheckTabs` (a deleted Work, or a reconnect after which hints may have been lost). It skips
 * the chat main is showing (that chat has its own verdict) and runs one batch at a time. Only a
 * definitive "deleted" closes a tab: a chat the server does not know yet (a first send still in
 * flight) and a failed probe leave it open. Ordinary lifecycle hints do nothing here.
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
    let probing = false;
    const probe = () => {
      if (probing) return;
      probing = true;
      const tabs = readMainTabs(accountId, projectId).chat.tabs.filter(
        (tab) => tab.chatId !== shown.current,
      );
      void Promise.all(
        tabs.map(async (tab) => {
          const verdict = await probeChatDestination(accountId, tab.chatId);
          if (active && (verdict === "deleted" || verdict === "project-deleted"))
            dropMainTabChat(accountId, projectId, tab.chatId);
        }),
      ).finally(() => {
        probing = false;
      });
    };
    probe();
    const unsubscribe = transport.subscribeCatalog(projectId, (hint) => {
      if (hint.type !== "project-chats-hint") return;
      for (const chatId of hint.removedChatIds ?? [])
        if (chatId !== shown.current) dropMainTabChat(accountId, projectId, chatId);
      if (hint.recheckTabs) probe();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [accountId, projectId, transport]);
}
