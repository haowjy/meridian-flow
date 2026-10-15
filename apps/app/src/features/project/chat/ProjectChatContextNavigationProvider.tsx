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
 * item identity; a missing one routes by address, so the route says so in place.
 *
 * Every door tells passage navigation it began, which retires whatever an earlier search row
 * was still resolving. A passage door's answer then carries the resolved id to passage
 * navigation, which opens the document itself and lands on the anchor. Passage handling never
 * gates the open, and never re-reads the address.
 */
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
  contextRouteTargetFromUri,
  canOpenContextUri as isContextUriRoutable,
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

/** The door being followed: what the follower's destination needs besides the answer. */
type DoorIntent = {
  target: NonNullable<ReturnType<typeof contextRouteTargetFromUri>>;
  uri: string;
  passage?: ContextPassageAnchor;
  /** The dock claim a beside-chat door took when it was clicked. */
  claim: number | null;
};

export function ProjectChatContextNavigationProvider({
  projectId,
  activeWork,
  availableWorks,
  rootThreadId,
  onOpenContextTarget,
  children,
}: {
  projectId: string;
  activeWork: { id: string; slug: string | null } | null;
  availableWorks: readonly { id: string; slug: string | null }[];
  /** The displayed chat's lineage: where its bare `scratch://` points while it is on No Work. */
  rootThreadId: string | null;
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
  const doorOpened = usePassageDoors(projectId, activeWork?.id ?? null);
  const besideChat = useContext(BesideChatContext);
  const openChatDocument = useOpenChatDocument(projectId);
  const route = useCallback(
    ({ target }: Pick<DoorIntent, "target">) =>
      onOpenContextTarget?.({ ...target, workId: target.workId ?? undefined }),
    [onOpenContextTarget],
  );

  // A live answer opens the document the resolver named, by identity: never by address, which
  // could be held by a hidden sibling's review.
  const openLive = useCallback(
    (door: DoorIntent, document: LinkDocumentRef) => {
      if (door.claim !== null && !useDockDocumentStore.getState().isCurrent(door.claim)) return;
      if (door.passage) {
        // The passage door opens the document itself, once, and lands on the passage.
        doorOpened({ ...door.target, uri: door.uri }, door.passage, {
          documentId: document.documentId,
          claim: door.claim ?? undefined,
        });
      } else {
        void openChatDocument({
          documentId: document.documentId,
          workId: door.target.workId ?? undefined,
          claim: door.claim ?? undefined,
        });
      }
    },
    [doorOpened, openChatDocument],
  );
  // Only a hidden document reaches the review handoff, so its live fallback is never used.
  const openReviewing = useReviewingLinkDestination(reviewOnly);
  // A hidden document is a review. Beside the chat it opens in the dock, as everything
  // beside the chat does; elsewhere the review handoff opens it in the Editor.
  const openFound = useCallback(
    (door: DoorIntent, document: LinkDocumentRef, gesture: Parameters<LinkDestination>[1]) => {
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
  // Nothing at the address is not this door's to announce: the route says so in place.
  const openMissing = useCallback(
    (door: DoorIntent) => {
      if (door.claim !== null && !useDockDocumentStore.getState().isCurrent(door.claim)) return;
      route(door);
    },
    [route],
  );

  const prepare = useCallback(
    (uri: string, passage?: ContextPassageAnchor): PreparedDoor | null => {
      if (!onOpenContextTarget || !activeWork || !noWorkId) return null;
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
      doorOpened({ ...target, uri: catalogUri });
      const link = classifyLinkTarget(catalogUri);
      if (!link) {
        route({ target });
        return null;
      }
      // The dock is claimed now, so whatever answers later is inside the claim.
      const claim = besideChat ? useDockDocumentStore.getState().claim() : null;
      const door: DoorIntent = { target, uri: catalogUri, passage, claim };
      return {
        link,
        policy: {
          open: (document, gesture) => openFound(door, document, gesture),
          missing: () => openMissing(door),
        },
      };
    },
    [
      activeWork,
      availableWorks,
      noWorkId,
      lineages,
      onOpenContextTarget,
      besideChat,
      doorOpened,
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
      isContextUriRoutable(uri, activeWork, availableWorks, noWorkId, lineages),
    [activeWork, availableWorks, noWorkId, lineages],
  );
  const doors = useMemo(
    () => (onOpenContextTarget ? { prepare, canOpen } : null),
    [canOpen, onOpenContextTarget, prepare],
  );

  return <ChatDoorsProvider doors={doors}>{children}</ChatDoorsProvider>;
}
