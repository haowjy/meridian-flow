import { useEffect, useRef } from "react";
import { probeChatDestination } from "@/client/chat-submissions/thread-availability";
import { useThreadTransport } from "@/client/providers/TransportProvider";
import { readMainTabs } from "./main-tabs";

/**
 * Lets go of chats deleted somewhere else (another window or device), tab or shown, through
 * `onGone`, the same call a delete made here makes. A delete's `project-chats-hint` names the chat
 * ids it removed, so those go without a request: the snapshot of a chat main shows is cached
 * until its next load and learns of nothing. The owner-gate probe covers only what no hint can
 * name: once at mount, and on a hint with `recheckTabs` (a deleted Work, or a reconnect after
 * which hints may have been lost). It runs one batch at a time. Only a definitive "deleted"
 * lets go: a chat the server does not know yet (a first send still in flight) and a failed probe
 * leave it. Ordinary lifecycle hints do nothing here.
 */
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
