import { useEffect, useRef } from "react";
import { probeChatDestination } from "@/client/chat-submissions/thread-availability";
import { useThreadTransport } from "@/client/providers/TransportProvider";
import { readMainTabs } from "./main-tabs";

export function useDropGoneChatTabs(
  accountId: string,
  projectId: string,
  onGone: (chatId: string) => void,
): void {
  const transport = useThreadTransport();
  const gone = useRef(onGone);
  gone.current = onGone;
  useEffect(() => {
    let active = true;
    let probing = false;
    const probe = () => {
      if (probing) return;
      probing = true;
      const tabs = readMainTabs(accountId, projectId).chat.tabs;
      void Promise.all(
        tabs.map(async (tab) => {
          const verdict = await probeChatDestination(accountId, tab.chatId);
          if (active && (verdict === "deleted" || verdict === "project-deleted"))
            gone.current(tab.chatId);
        }),
      ).finally(() => {
        probing = false;
      });
    };
    probe();
    const unsubscribe = transport.subscribeCatalog(projectId, (hint) => {
      if (hint.type !== "project-chats-hint") return;
      for (const chatId of hint.removedChatIds ?? []) gone.current(chatId);
      if (hint.recheckTabs) probe();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [accountId, projectId, transport]);
}
