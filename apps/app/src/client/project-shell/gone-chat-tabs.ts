import { useQueries } from "@tanstack/react-query";
import { useEffect } from "react";
import { probeChatDestination } from "@/client/chat-submissions/thread-availability";
import { dropMainTabChat, useMainTabs } from "./main-tabs";

const RECHECK_MS = 30_000;

/**
 * Closes the chat tabs of chats deleted somewhere else (another window or device). The project's
 * chat list lists primary chats only and learns of a delete elsewhere only by refetch, so it cannot
 * say a tab's chat is gone; the owner gate can. Each chat tab asks it at mount, on a return to the
 * window and every 30s. Only a definitive "deleted" closes a tab: a chat the server does not know yet
 * (a first send still in flight) and a failed probe leave it open.
 */
export function useDropGoneChatTabs(accountId: string, projectId: string): void {
  const { tabs } = useMainTabs(accountId, projectId).chat;
  const probes = useQueries({
    queries: tabs.flatMap((tab) =>
      tab.kind === "chat"
        ? [
            {
              queryKey: ["chat-tab-availability", accountId, tab.chatId],
              queryFn: () => probeChatDestination(accountId, tab.chatId),
              staleTime: RECHECK_MS,
              refetchInterval: RECHECK_MS,
              refetchOnWindowFocus: true,
            },
          ]
        : [],
    ),
  });
  const gone = probes.flatMap((probe, i) => {
    const tab = tabs[i];
    return tab?.kind === "chat" && (probe.data === "deleted" || probe.data === "project-deleted")
      ? [tab.chatId]
      : [];
  });
  const goneKey = gone.join(" ");
  useEffect(() => {
    for (const chatId of goneKey ? goneKey.split(" ") : [])
      dropMainTabChat(accountId, projectId, chatId);
  }, [accountId, projectId, goneKey]);
}
