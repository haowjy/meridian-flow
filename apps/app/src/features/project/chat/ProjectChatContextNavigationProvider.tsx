/**
 * ProjectChatContextNavigationProvider — the project shell's side of the chat's URI doors:
 * placement policy, and nothing else.
 *
 * A door asks the question a transcript link asks: what document is at this address, and is
 * it live or only in a draft? The chat owns the one follower that asks (`useChatLinkFollowing`),
 * so a door and a transcript link share one latest click, one dialog, and the chat's
 * visibility and thread lifetime. This file prepares each door as a question plus a policy:
 * a live answer opens by the document id the resolver named, where this door opens documents
 * (the Editor, or the dock beside the chat); a hidden document goes to its Work's review by
 * item identity; a missing one routes by address (route-backed doors only), so the route says so in place; an upload door keeps the follower's shared missing outcome.
 *
 * Every door (and, through `retire`, every transcript click) retires a passage still landing.
 * A passage door's answer hands the resolved id to passage navigation, which opens that
 * document inside the answer and lands on the anchor if the open result allows. No lookup
 * stands between the answer and the open.
 */
import { hasContextUriVariable } from "@meridian/contracts/context-uri";
import { type ReactNode, useCallback, useContext, useMemo } from "react";
import { useLineage } from "@/client/query/useLineageTitle";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useWorks } from "@/client/query/useWorks";
import { classifyLinkTarget } from "@/core/editor/links";
import {
  ChatDoorsProvider,
  type ContextPassageAnchor,
  type PreparedDoor,
} from "@/features/chat/ChatContextNavigation";
import type { LinkDestination, LinkDocumentRef } from "@/features/links";
import {
  type ChatLineages,
  type ChatUploadOwners,
  chatIdForUploadsUri,
  contextRouteTargetFromUri,
  canOpenContextUri as isContextUriRoutable,
  parseContextUri,
} from "@/lib/context-uri";
import { contextTabFromDraftGroup } from "../context/context-tab-from-draft";
import { BesideChatContext, useOpenChatDocument } from "../context/open-chat-document";
import { useDockDocumentStore } from "../dock/dock-document-store";
import { useReviewingLinkDestination } from "../dock/useAiDraftLauncher";
import type { ContextRouteRequest } from "../routing/project-route";
import { canonicalDoorUri } from "./canonical-door-uri";
import { usePassageDoors } from "./usePassageDoors";

/** The review handoff never consults its live destination for a hidden document. */
const reviewOnly: LinkDestination = async () => undefined;

type OpenContextTarget = (target: ContextRouteRequest) => void;

type RouteTarget = NonNullable<ReturnType<typeof contextRouteTargetFromUri>>;

/**
 * Where a door's answer goes, whatever kind of door it is. Passage intent lives here, apart
 * from whether a route holds the document: an upload has no route and still has an anchor.
 */
type Placement = {
  workId: string | null;
  passage?: ContextPassageAnchor;
  /** The dock claim a beside-chat door took when it was clicked. */
  claim: number | null;
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
  const passages = usePassageDoors(projectId, activeWork?.id ?? null);
  const besideChat = useContext(BesideChatContext);
  const openChatDocument = useOpenChatDocument(projectId);
  const route = useCallback(
    (target: RouteTarget) =>
      onOpenContextTarget?.({ ...target, workId: target.workId ?? undefined }),
    [onOpenContextTarget],
  );

  // A live answer opens the document the resolver named, by identity: never by address, which
  // could be held by a hidden sibling's review.
  const openLive = useCallback(
    (door: Placement, document: LinkDocumentRef) => {
      if (door.claim !== null && !useDockDocumentStore.getState().isCurrent(door.claim)) return;
      if (door.passage) {
        // The passage door opens the document itself, once, and lands on the passage.
        passages.land(door.workId, door.passage, {
          documentId: document.documentId,
          claim: door.claim ?? undefined,
        });
      } else {
        void openChatDocument({
          documentId: document.documentId,
          workId: door.workId ?? undefined,
          claim: door.claim ?? undefined,
        });
      }
    },
    [passages, openChatDocument],
  );
  // Only a hidden document reaches the review handoff, so its live fallback is never used.
  const openReviewing = useReviewingLinkDestination(reviewOnly);
  // A hidden document is a review. Beside the chat it opens in the dock, as everything
  // beside the chat does; elsewhere the review handoff opens it in the Editor.
  const openFound = useCallback(
    (door: Placement, document: LinkDocumentRef, gesture: Parameters<LinkDestination>[1]) => {
      const { review } = document;
      if (!review) return Promise.resolve(openLive(door, document));
      if (door.claim !== null && !useDockDocumentStore.getState().isCurrent(door.claim))
        return Promise.resolve();
      if (besideChat && door.claim !== null) {
        const tab = contextTabFromDraftGroup({
          documentId: document.documentId,
          ...review,
          isNew: true,
        });
        if (tab)
          besideChat(tab, door.claim, undefined, {
            workId: review.workId,
            itemKey: review.itemKey,
          });
        return Promise.resolve();
      }
      return openReviewing(document, gesture);
    },
    [besideChat, openLive, openReviewing],
  );
  // Only a route-backed door overrides the follower's missing outcome: its route says so in
  // place. A resource door has no route, so it keeps the follower's shared outcome.
  const openMissing = useCallback(
    (door: Placement, target: RouteTarget) => {
      if (door.claim !== null && !useDockDocumentStore.getState().isCurrent(door.claim)) return;
      route(target);
    },
    [route],
  );

  const prepare = useCallback(
    (uri: string, passage?: ContextPassageAnchor): PreparedDoor | null => {
      if (!onOpenContextTarget || !activeWork || !noWorkId) return null;
      if (hasContextUriVariable(uri)) {
        const link = classifyLinkTarget(uri);
        if (!link) return null;
        passages.retire();
        const door: Placement = {
          workId: activeWork.id,
          passage,
          claim: besideChat ? useDockDocumentStore.getState().claim() : null,
        };
        return {
          link,
          policy: { open: (document, gesture) => openFound(door, document, gesture) },
        };
      }
      const uploadsChatId = chatIdForUploadsUri(uri, chats);
      if (uploadsChatId) {
        // An upload is found in its chat's catalog by its explicit spelling, and opens only
        // where the host has a viewer for it (beside the centered chat).
        if (!besideChat) return null;
        const ownerRef =
          uploadsChatId === chat?.chatId
            ? chat.chatRef
            : threads?.find((thread) => thread.id === uploadsChatId)?.ref;
        const catalogUri =
          canonicalDoorUri(
            {
              scheme: "uploads",
              path: parseContextUri(uri)?.path ?? "",
              workId: null,
              chatId: uploadsChatId,
            },
            { ownerRef },
          ) ?? uri;
        const link = classifyLinkTarget(catalogUri);
        if (!link) return null;
        passages.retire();
        const door: Placement = {
          workId: null,
          passage,
          claim: useDockDocumentStore.getState().claim(),
        };
        return {
          link,
          policy: { open: (document, gesture) => openFound(door, document, gesture) },
        };
      }
      const target = contextRouteTargetFromUri(uri, activeWork, availableWorks, noWorkId, lineages);
      if (!target) return null;
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
      // A new intent retires an earlier search row's passage work now, not when this answer lands.
      passages.retire();
      const link = classifyLinkTarget(catalogUri);
      if (!link) {
        route(target);
        return null;
      }
      // The dock is claimed now, so whatever answers later is inside the claim.
      const claim = besideChat ? useDockDocumentStore.getState().claim() : null;
      const door: Placement = { workId: target.workId, passage, claim };
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
      besideChat,
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
      // An upload opens only where the host has a viewer for it (beside the centered chat).
      (hasContextUriVariable(uri) ||
        (chatIdForUploadsUri(uri, chats) !== null
          ? besideChat !== null
          : isContextUriRoutable(uri, activeWork, availableWorks, noWorkId, lineages))),
    [activeWork, availableWorks, noWorkId, lineages, chats, besideChat],
  );
  const doors = useMemo(
    () => (onOpenContextTarget ? { prepare, canOpen, retire: passages.retire } : null),
    [canOpen, onOpenContextTarget, prepare, passages.retire],
  );

  return <ChatDoorsProvider doors={doors}>{children}</ChatDoorsProvider>;
}
