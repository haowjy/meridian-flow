/**
 * Every arrival of main, for both kinds, in one place. Main shows what its address names; when it
 * arrives at an item this writes the kind's slot (`client/project-shell/store.ts`), which is all
 * the side reads, so a change of kind needs no swap code. Main's empty pages (Recently opened, the
 * new-chat composer, Recent chats) null their slot: the side never holds what main left empty.
 *
 * It also closes the chat tabs of chats deleted elsewhere (`useDropGoneChatTabs`).
 *
 * Placement follows `features/project/.context/pane-state-machine.md`: change that page's rules and
 * diagrams with any change here.
 */
import { useEffect, useRef } from "react";
import { useDropGoneChatTabs } from "@/client/project-shell/gone-chat-tabs";
import {
  arriveMainTab,
  mainTabKey,
  refreshMainTab,
  useMainTabs,
} from "@/client/project-shell/main-tabs";
import { writeLastShownChat, writeLastShownDocument } from "@/client/project-shell/store";
import type { OpenDocument } from "@/client/stores";
import type { MainForSide } from "./side/side-item";

export function useMainArrival({
  accountId,
  projectId,
  main,
  document,
  locationKey,
}: {
  accountId: string;
  projectId: string;
  main: MainForSide;
  /** The document main shows once its address is proven, else null. */
  document: OpenDocument | null;
  locationKey: string | undefined;
}) {
  useDropGoneChatTabs(accountId, projectId, main.kind === "chat" ? main.chatId : null);
  // A document's arrival opens or selects its tab once per arrival at an address; after that its
  // descriptor only refreshes the tab while it is open.
  const arrivedAt = useRef<string | undefined>(undefined);
  const { tabs } = useMainTabs(accountId, projectId).document;
  const arrivedKey = document ? mainTabKey({ kind: "document", document }) : null;
  const recorded = tabs.some((tab) => mainTabKey(tab) === arrivedKey);
  useEffect(() => {
    // The address no longer resolving ends the arrival: a document that comes back at the same
    // address (restored from another window) arrives afresh. A document main shows always has its
    // tab, even after a removal verdict closed it that the document then outlived.
    if (!document) {
      arrivedAt.current = undefined;
      return;
    }
    const tab = { kind: "document", document } as const;
    if (arrivedAt.current === locationKey && recorded) refreshMainTab(accountId, projectId, tab);
    else {
      arrivedAt.current = locationKey;
      arriveMainTab(accountId, projectId, tab);
    }
    writeLastShownDocument(accountId, projectId, {
      documentId: document.documentId,
      ...("workId" in document && document.workId ? { workId: document.workId } : {}),
    });
  }, [accountId, projectId, locationKey, document, recorded]);

  const chatId = main.kind === "chat" ? main.chatId : null;
  const onChatPage = main.kind === "new-chat" || main.kind === "chat-recents";
  const onLanding = main.kind === "landing";
  useEffect(() => {
    if (chatId) {
      arriveMainTab(accountId, projectId, { kind: "chat", chatId });
      writeLastShownChat(accountId, projectId, chatId);
    } else if (onChatPage) writeLastShownChat(accountId, projectId, null);
  }, [accountId, projectId, chatId, onChatPage]);
  useEffect(() => {
    if (onLanding) writeLastShownDocument(accountId, projectId, null);
  }, [accountId, projectId, onLanding]);
}
