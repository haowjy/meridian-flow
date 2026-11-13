import { useEffect } from "react";
import { cleanDeletedChat } from "@/client/chat-submissions/deleted-chat";
import { probeChatDestination } from "@/client/chat-submissions/thread-availability";
import { useThreadTransport } from "@/client/providers/TransportProvider";
import { dropMainTabChat, readMainTabs } from "./main-tabs";

/**
 * Lets go of chats deleted somewhere else (another window or device), tab or shown, through the
 * deleted-chat cleanup, the one exit that moves a shown chat's unsent words into the new-chat
 * composer before the surface leaves; this then closes the tab, which has no surface to do it. A
 * delete's `project-chats-hint` names the chat ids it removed, so those go without a request: the
 * snapshot of a chat main shows is cached until its next load and learns of nothing. The
 * owner-gate probe covers only what no hint can name: once at mount, and on a hint with
 * `recheckTabs` (a deleted Work, or a reconnect after which hints may have been lost). It runs
 * one batch at a time. Only a definitive "deleted" lets go: a chat the server does not know yet
 * (a first send still in flight) and a failed probe leave it. Ordinary lifecycle hints do
 * nothing here.
 */
export function useDropGoneChatTabs(accountId: string, projectId: string): void {
  const transport = useThreadTransport();
  useEffect(() => {
    let active = true;
    // The cleanup declines while this window's own delete is held for Undo: the tab stays for a restore.
    const letGo = async (chatId: string, reason: "deleted" | "project-deleted") => {
      if (await cleanDeletedChat(accountId, chatId, projectId, reason))
        dropMainTabChat(accountId, projectId, chatId);
    };
    let probing = false;
    const probe = () => {
      if (probing) return;
      probing = true;
      const tabs = readMainTabs(accountId, projectId).chat.tabs;
      void Promise.all(
        tabs.map(async (tab) => {
          const verdict = await probeChatDestination(accountId, tab.chatId);
          if (active && (verdict === "deleted" || verdict === "project-deleted"))
            await letGo(tab.chatId, verdict);
        }),
      ).finally(() => {
        probing = false;
      });
    };
    probe();
    const unsubscribe = transport.subscribeCatalog(projectId, (hint) => {
      if (hint.type !== "project-chats-hint") return;
      for (const chatId of hint.removedChatIds ?? []) void letGo(chatId, "deleted");
      if (hint.recheckTabs) probe();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [accountId, projectId, transport]);
}
