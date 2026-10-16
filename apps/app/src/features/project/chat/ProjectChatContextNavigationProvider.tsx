/**
 * ProjectChatContextNavigationProvider — adapts chat-local document URI opens
 * to the project route's context-file selection contract.
 *
 * Every door routes the same way, and every door tells passage navigation it
 * happened — carrying an anchor when the row had one. That second call is not
 * an extra for passage rows: it is where navigation ownership changes hands,
 * so an ordinary door retires whatever a search row was still resolving. It
 * never gates the route change, so a search row whose passage has moved still
 * opens its document.
 */
import { contextOwner } from "@meridian/contracts/protocol";
import { type ReactNode, useCallback, useContext, useMemo } from "react";
import { lookupContextCatalogFile } from "@/client/query/useContextCatalog";
import { useLineage } from "@/client/query/useLineageTitle";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useWorks } from "@/client/query/useWorks";

import {
  ChatContextNavigationProvider,
  type ContextPassageAnchor,
} from "@/features/chat/ChatContextNavigation";
import {
  type ChatLineages,
  type ChatUploadOwners,
  chatIdForUploadsUri,
  contextRouteTargetFromUri,
  canOpenContextUri as isContextUriRoutable,
  parseContextUri,
} from "@/lib/context-uri";
import { BesideChatContext, useOpenChatDocument } from "../context/open-chat-document";
import { useDockDocumentStore } from "../dock/dock-document-store";
import type { ContextRouteRequest } from "../routing/project-route";
import { canonicalDoorUri } from "./canonical-door-uri";
import { usePassageDoors } from "./usePassageDoors";

type OpenContextTarget = (target: ContextRouteRequest) => void;

export function ProjectChatContextNavigationProvider({
  projectId,
  activeWork,
  availableWorks,
  rootThreadId,
  chat,
  onOpenContextTarget,
  children,
}: {
  projectId: string;
  activeWork: { id: string; slug: string | null } | null;
  availableWorks: readonly { id: string; slug: string | null }[];
  /** The displayed chat's lineage: where its bare `scratch://` points while it is on No Work. */
  rootThreadId: string | null;
  /** The chat that owns the displayed thread's uploads: a subagent's top chat. */
  chat: { chatId: string; chatRef: string | null } | null;
  onOpenContextTarget?: OpenContextTarget;
  children: ReactNode;
}) {
  const { noWork } = useWorks(projectId);
  const noWorkId = noWork?.id;
  const { threads } = useProjectThreads(projectId);
  // The chat's own lineage answers to its handle even after its first chat is
  // trashed (a fork keeps the notes); the live list is only for other chats.
  const ownHandle = useLineage(projectId, rootThreadId ? { rootThreadId } : null)?.rootThreadRef;
  const lineages = useMemo<ChatLineages>(
    () => ({
      own: rootThreadId,
      idForRef: (ref) =>
        ref === ownHandle
          ? rootThreadId
          : // A handle names the first chat, so it is that chat's own id.
            (threads?.find((thread) => thread.ref === ref && thread.rootThreadId === thread.id)
              ?.id ?? null),
    }),
    [ownHandle, rootThreadId, threads],
  );
  const chats = useMemo<ChatUploadOwners>(
    () => ({
      own: chat?.chatId ?? null,
      idForRef: (ref) =>
        ref === chat?.chatRef
          ? chat.chatId
          : (threads?.find((thread) => thread.ref === ref && thread.kind !== "subagent")?.id ??
            null),
    }),
    [chat, threads],
  );
  const doorOpened = usePassageDoors(projectId, activeWork?.id ?? null);
  const besideChat = useContext(BesideChatContext);
  const openChatDocument = useOpenChatDocument(projectId);
  const openContextUri = useCallback(
    (uri: string, passage?: ContextPassageAnchor) => {
      if (!onOpenContextTarget || !activeWork || !noWorkId) return;
      const uploadsChatId = chatIdForUploadsUri(uri, chats);
      if (uploadsChatId) {
        // An upload has no route: its door opens the document the chat's catalog names.
        const path = parseContextUri(uri)?.path ?? "";
        const ownerRef =
          uploadsChatId === chat?.chatId
            ? chat.chatRef
            : threads?.find((thread) => thread.id === uploadsChatId)?.ref;
        const catalogUri =
          canonicalDoorUri(
            { scheme: "uploads", path, workId: null, chatId: uploadsChatId },
            { ownerRef },
          ) ?? uri;
        const dock = useDockDocumentStore.getState();
        const claim = dock.claim();
        void lookupContextCatalogFile(
          projectId,
          "uploads",
          { chatId: uploadsChatId },
          { uri: catalogUri },
        ).then((file) => {
          if (file && dock.isCurrent(claim))
            void openChatDocument({ documentId: file.documentId, claim });
        });
        return;
      }
      const target = contextRouteTargetFromUri(uri, activeWork, availableWorks, noWorkId, lineages);
      if (!target) return;
      // The catalog knows a document only by its canonical spelling, whoever owns it: a bare
      // `scratch://x` is the chat's lineage or the active Work, so name that owner's handle.
      const ownerRef = target.rootThreadId
        ? target.rootThreadId === rootThreadId
          ? ownHandle
          : threads?.find((thread) => thread.id === target.rootThreadId)?.ref
        : null;
      const workSlug =
        target.workId === noWorkId
          ? null
          : (availableWorks.find(({ id }) => id === target.workId)?.slug ?? undefined);
      const catalogUri = canonicalDoorUri(target, { ownerRef, workSlug }) ?? uri;
      const route = () => onOpenContextTarget({ ...target, workId: target.workId ?? undefined });
      if (!besideChat) {
        route();
        doorOpened({ ...target, uri: catalogUri }, passage);
        return;
      }
      // The chat is in the middle: the document opens beside it and the route stays on the
      // chat. The door claims the dock now, so the lookup is inside the claim.
      const dock = useDockDocumentStore.getState();
      const claim = dock.claim();
      void lookupContextCatalogFile(
        projectId,
        target.scheme,
        contextOwner(target.workId, target.rootThreadId),
        { uri: catalogUri },
      ).then(
        (file) => {
          if (!dock.isCurrent(claim)) return;
          if (!file) {
            // Nothing is there: the route says so in place, as it always has.
            route();
            doorOpened({ ...target, uri: catalogUri }, passage);
          } else if (passage && file.editable) {
            // The passage door opens the document itself, once, and lands on the passage.
            doorOpened({ ...target, uri: catalogUri }, passage, {
              documentId: file.documentId,
              editable: true,
              claim,
            });
          } else {
            void openChatDocument({
              documentId: file.documentId,
              workId: target.workId ?? undefined,
              claim,
            });
            doorOpened({ ...target, uri: catalogUri });
          }
        },
        () => {
          if (dock.isCurrent(claim)) route();
        },
      );
    },
    [
      activeWork,
      availableWorks,
      noWorkId,
      lineages,
      chats,
      chat,
      doorOpened,
      onOpenContextTarget,
      besideChat,
      openChatDocument,
      projectId,
      rootThreadId,
      ownHandle,
      threads,
    ],
  );
  const canOpenContextUri = useCallback(
    (uri: string) =>
      !!activeWork &&
      !!noWorkId &&
      // An upload opens only where the host has a viewer for it (beside the centered chat).
      (chatIdForUploadsUri(uri, chats) !== null
        ? besideChat !== null
        : isContextUriRoutable(uri, activeWork, availableWorks, noWorkId, lineages)),
    [activeWork, availableWorks, noWorkId, lineages, chats, besideChat],
  );

  return (
    <ChatContextNavigationProvider
      onOpenContextUri={onOpenContextTarget ? openContextUri : null}
      canOpenContextUri={onOpenContextTarget ? canOpenContextUri : null}
    >
      {children}
    </ChatContextNavigationProvider>
  );
}
