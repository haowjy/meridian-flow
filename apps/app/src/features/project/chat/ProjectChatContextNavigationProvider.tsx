/**
 * ProjectChatContextNavigationProvider — the project shell's side of the chat's URI doors:
 * placement policy, and nothing else.
 *
 * A door asks the question a transcript link asks: what document is at this address, and is
 * it live or only in a draft? The chat owns the one follower that asks (`useChatLinkFollowing`),
 * so a door and a transcript link share one latest click, one dialog, and the chat's
 * visibility and thread lifetime. This file prepares each door as a question plus a policy:
 * a live answer opens by the document id the resolver named, in the pane `useLinkPlacement` picks; a hidden document goes
 * to its Work's review by item identity; a missing one routes by address, so the route says
 * so in place. An upload has no Editor address, so no door opens it.
 *
 * Every door (and, through `retire`, every transcript click) retires a passage still landing.
 * A passage door's answer hands the resolved id and its placement to passage navigation, which
 * opens that document inside the answer, in the pane the placement picks, and lands on the
 * anchor if the open result allows. No lookup
 * stands between the answer and the open.
 */

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
import { chatOwnerKey } from "@/features/draft-review/draft-owner-key";
import type { LinkDestination, LinkDocumentRef } from "@/features/links";
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

/**
 * Where a door's answer goes, whatever kind of door it is. Passage intent lives here, apart
 * from whether a route holds the document: an upload has no route and still has an anchor.
 */
type Placement = {
  workId: string | null;
  passage?: ContextPassageAnchor;
};

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
  activeWork: { id: string; handle: string | null } | null;
  availableWorks: readonly { id: string; handle: string | null }[];
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
  const passages = usePassageDoors(projectId, activeWork?.id ?? null);
  const openChatDocument = useOpenProjectDocument(projectId);
  const route = useCallback(
    (target: RouteTarget) => onOpenContextTarget?.(contextRouteRequest(target)),
    [onOpenContextTarget],
  );

  // A live answer opens the document the resolver named, by identity: never by address, which
  // could be held by a hidden sibling's review.
  const openLive = useCallback(
    (door: Placement, document: LinkDocumentRef, signal?: AbortSignal) =>
      openChatDocument({
        documentId: document.documentId,
        workId: door.workId ?? undefined,
        ...(signal ? { signal } : {}),
      }),
    [openChatDocument],
  );
  // The chat's own drafts: its Work's, or under No Work its lineage's. A link to a document the
  // chat drafted opens that draft, the way its draft strip does.
  const place = useLinkPlacement(
    projectId,
    chatOwnerKey(
      activeWork && { id: activeWork.id, isNoWork: activeWork.id === noWorkId },
      rootThreadId,
    ) || null,
  );
  const openFound = useCallback(
    (door: Placement, document: LinkDocumentRef, gesture: Parameters<LinkDestination>[1]) => {
      const { passage } = door;
      if (!passage) return place(document, gesture, (found) => openLive(door, found), door.workId);
      // The passage door opens the document wherever the placement puts it, once, and lands there.
      passages.land(passage, document.documentId, (signal) =>
        place(document, gesture, (found) => openLive(door, found, signal), door.workId),
      );
      return Promise.resolve();
    },
    [openLive, passages, place],
  );
  // Only a route-backed door overrides the follower's missing outcome: its route says so in
  // place. A resource door has no route, so it keeps the follower's shared outcome.
  const openMissing = useCallback(
    (_door: Placement, target: RouteTarget) => {
      route(target);
    },
    [route],
  );

  const prepare = useCallback(
    (uri: string, passage?: ContextPassageAnchor): PreparedDoor | null => {
      if (!onOpenContextTarget || !activeWork || !noWorkId) return null;
      // An upload belongs to its chat and has no Editor address: no door opens it.
      if (chatIdForUploadsUri(uri, chats)) return null;
      const target = contextRouteTargetFromUri(uri, activeWork, availableWorks, noWorkId, lineages);
      if (!target) return null;
      // The catalog knows a document only by its canonical spelling, whoever owns it: a bare
      // `scratch://x` is the chat's lineage or the active Work, so name that owner's handle.
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
          open: (document, gesture) => openFound(door, document, gesture),
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
