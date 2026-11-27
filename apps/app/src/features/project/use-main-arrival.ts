import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { cleanDeletedChat } from "@/client/chat-submissions/deleted-chat";
import { useDropGoneChatTabs } from "@/client/project-shell/gone-chat-tabs";
import {
  arriveMainTab,
  mainTabKey,
  refreshMainTab,
  useMainTabs,
} from "@/client/project-shell/main-tabs";
import { writeLastShownChat, writeLastShownDocument } from "@/client/project-shell/store";
import { cachedChatTitle } from "@/client/query/project-thread-cache";
import type { OpenDocument } from "@/client/stores";
import { useChatNavigation } from "./routing/chat-navigation";
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
  document: OpenDocument | null;
  locationKey: string | undefined;
}) {
  const navigation = useChatNavigation();
  const queryClient = useQueryClient();
  useDropGoneChatTabs(accountId, projectId, (chatId) => {
    const { display } = navigation;
    void cleanDeletedChat(
      accountId,
      chatId,
      projectId,
      "deleted",
      undefined,
      false,
      undefined,
      cachedChatTitle(queryClient, chatId),
    ).catch(reportError);
    navigation.forgetChat(chatId);
    if (display?.kind === "thread" && display.threadId === chatId)
      void navigation.openNewChat({ replace: true, focus: false });
  });
  const arrivedAt = useRef<string | undefined>(undefined);
  const { tabs } = useMainTabs(accountId, projectId).document;
  const arrivedKey = document ? mainTabKey({ kind: "document", document }) : null;
  const recorded = tabs.some((tab) => mainTabKey(tab) === arrivedKey);
  useEffect(() => {
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
