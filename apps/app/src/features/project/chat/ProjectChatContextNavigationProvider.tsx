import { type ReactNode, useCallback, useMemo } from "react";
import { useLineage } from "@/client/query/useLineageTitle";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useWorks } from "@/client/query/useWorks";
import { classifyLinkTarget } from "@/core/editor/links";
import {
  ChatDoorsProvider,
  type ContextPassageAnchor,
  type PreparedDoor,
} from "@/features/chat/ChatContextNavigation";
import type { LinkDocumentRef } from "@/features/links";
import {
  type ChatLineages,
  type ChatUploadOwners,
  chatIdForUploadsUri,
  contextRouteTargetFromUri,
  canOpenContextUri as isContextUriRoutable,
} from "@/lib/context-uri";
import { useOpenProjectDocument } from "../context/open-project-document";
import { useLinkPlacement } from "../review-launch";
import { type ContextRouteRequest, contextRouteRequest } from "../routing/project-route";
import { canonicalDoorUri } from "./canonical-door-uri";
import { usePassageDoors } from "./usePassageDoors";

type OpenContextTarget = (target: ContextRouteRequest) => void;

type RouteTarget = NonNullable<ReturnType<typeof contextRouteTargetFromUri>>;

type Placement = {
  workId: string | null;
  passage?: ContextPassageAnchor;
};

export function ProjectChatContextNavigationProvider({
  projectId,
  activeWork,
  availableWorks,
  rootThreadId,
  draftId,
  chat,
  onOpenContextTarget,
  children,
}: {
  projectId: string;
  activeWork: { id: string; handle: string | null } | null;
  availableWorks: readonly { id: string; handle: string | null }[];
  rootThreadId: string | null;
  draftId: string | null;
  chat: { chatId: string; chatRef: string | null } | null;
  onOpenContextTarget?: OpenContextTarget;
  children: ReactNode;
}) {
  const { noWork } = useWorks(projectId);
  const noWorkId = noWork?.id;
  const { threads } = useProjectThreads(projectId);
  const ownHandle = useLineage(projectId, rootThreadId ? { rootThreadId } : null)?.rootThreadRef;
  const lineages = useMemo<ChatLineages>(
    () => ({
      own: rootThreadId,
      idForRef: (ref) =>
        ref === ownHandle
          ? rootThreadId
          : (threads?.find((thread) => thread.ref === ref && thread.rootThreadId === thread.id)
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
  const passages = usePassageDoors(projectId, activeWork?.id ?? null);
  const openChatDocument = useOpenProjectDocument(projectId);
  const route = useCallback(
    (target: RouteTarget) => onOpenContextTarget?.(contextRouteRequest(target)),
    [onOpenContextTarget],
  );

  // A live answer opens the document the resolver named, by identity: never by address, which
  // could be held by a hidden sibling's review.
  const openLive = useCallback(
    (
      door: Placement,
      document: LinkDocumentRef,
      placeBeside: (() => boolean) | undefined,
      signal?: AbortSignal,
    ) =>
      openChatDocument({
        documentId: document.documentId,
        workId: door.workId ?? undefined,
        placeBeside,
        ...(signal ? { signal } : {}),
      }),
    [openChatDocument],
  );
  const place = useLinkPlacement(projectId, draftId);
  const openFound = useCallback(
    (door: Placement, document: LinkDocumentRef) => {
      const { passage } = door;
      if (!passage)
        return place(
          document,
          (found, placeBeside) => openLive(door, found, placeBeside),
          door.workId,
        );
      passages.land(passage, document.documentId, (signal) =>
        place(
          document,
          (found, placeBeside) => openLive(door, found, placeBeside, signal),
          door.workId,
        ),
      );
      return Promise.resolve();
    },
    [openLive, passages, place],
  );
  const openMissing = useCallback(
    (_door: Placement, target: RouteTarget) => {
      route(target);
    },
    [route],
  );

  const prepare = useCallback(
    (uri: string, passage?: ContextPassageAnchor): PreparedDoor | null => {
      if (!onOpenContextTarget || !activeWork || !noWorkId) return null;
      if (chatIdForUploadsUri(uri, chats)) return null;
      const target = contextRouteTargetFromUri(uri, activeWork, availableWorks, noWorkId, lineages);
      if (!target) return null;
      const ownerRef = target.rootThreadId
        ? target.rootThreadId === rootThreadId
          ? ownHandle
          : threads?.find((thread) => thread.id === target.rootThreadId)?.ref
        : null;
      const workHandle =
        target.workId === noWorkId
          ? null
          : (availableWorks.find(({ id }) => id === target.workId)?.handle ?? undefined);
      const catalogUri = canonicalDoorUri(target, { ownerRef, workHandle }) ?? uri;
      // A new intent retires an earlier search row's passage work now, not when this answer lands.
      passages.retire();
      const link = classifyLinkTarget(catalogUri);
      if (!link) {
        route(target);
        return null;
      }
      const door: Placement = { workId: target.workId, passage };
      return {
        link,
        policy: {
          open: (document) => openFound(door, document),
          missing: () => openMissing(door, target),
        },
      };
    },
    [
      activeWork,
      availableWorks,
      noWorkId,
      lineages,
      chats,
      chat,
      onOpenContextTarget,
      passages,
      openFound,
      openMissing,
      route,
      rootThreadId,
      ownHandle,
      threads,
    ],
  );
  const canOpen = useCallback(
    (uri: string) =>
      !!activeWork &&
      !!noWorkId &&
      chatIdForUploadsUri(uri, chats) === null &&
      isContextUriRoutable(uri, activeWork, availableWorks, noWorkId, lineages),
    [activeWork, availableWorks, noWorkId, lineages, chats],
  );
  const doors = useMemo(
    () => (onOpenContextTarget ? { prepare, canOpen, retire: passages.retire } : null),
    [canOpen, onOpenContextTarget, prepare, passages.retire],
  );

  return <ChatDoorsProvider doors={doors}>{children}</ChatDoorsProvider>;
}
