/**
 * ProjectChatContextNavigationProvider — adapts chat-local document URI opens
 * to the project route's context-file selection contract.
 *
 * A door asks the question a transcript link asks, through the same follower
 * (`features/links`): what document is at this address, and is it live or only in a
 * draft? A live answer opens where the door always opened it; a hidden document goes
 * to its Work's review by item identity (the server names a draft-created document at its address);
 * a missing one routes anyway, so the route says so in place. A cold answer rides the
 * follower's own checking and failure states. This file keeps only the door's own
 * policy: placement (the Editor route, or the dock beside the chat) and its dock claim.
 *
 * Every door tells passage navigation it happened — carrying an anchor when the row had
 * one. That second call is not an extra for passage rows: it is where navigation
 * ownership changes hands, so an ordinary door retires whatever a search row was still
 * resolving. It never gates the route change, so a search row whose passage has moved
 * still opens its document.
 */
import { type ReactNode, useCallback, useContext, useMemo, useRef } from "react";
import { useLineage } from "@/client/query/useLineageTitle";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useWorks } from "@/client/query/useWorks";
import { classifyLinkTarget, type LinkTarget } from "@/core/editor/links";
import {
  ChatContextNavigationProvider,
  type ContextPassageAnchor,
} from "@/features/chat/ChatContextNavigation";
import {
  type FollowReporter,
  type LinkDestination,
  LinkFollowDialog,
  type LinkResolutionScope,
  useFollowOutcomeState,
  useLinkableDocuments,
  useLinkFollower,
} from "@/features/links";
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

type OpenContextTarget = (target: ContextRouteRequest) => void;

/** The door being followed: what the follower's destination needs besides the answer. */
type DoorIntent = {
  target: NonNullable<ReturnType<typeof contextRouteTargetFromUri>>;
  uri: string;
  passage?: ContextPassageAnchor;
  /** The dock claim a beside-chat door took when it was clicked. */
  claim: number | null;
  link: LinkTarget;
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
  const intent = useRef<DoorIntent | null>(null);
  const route = useCallback(
    ({ target }: Pick<DoorIntent, "target">) =>
      onOpenContextTarget?.({ ...target, workId: target.workId ?? undefined }),
    [onOpenContextTarget],
  );

  // A document that exists is opened where this door opens documents.
  const openFound = useCallback<LinkDestination>(
    async (document) => {
      const door = intent.current;
      if (!door) return;
      const dock = useDockDocumentStore.getState();
      if (door.claim !== null && !dock.isCurrent(door.claim)) return;
      const opened = { ...door.target, uri: door.uri };
      if (!besideChat) {
        route(door);
        doorOpened(opened, door.passage);
      } else if (door.passage) {
        // The passage door opens the document itself, once, and lands on the passage.
        doorOpened(opened, door.passage, {
          documentId: document.documentId,
          claim: door.claim ?? undefined,
        });
      } else {
        void openChatDocument({
          documentId: document.documentId,
          workId: door.target.workId ?? undefined,
          claim: door.claim ?? undefined,
        });
        doorOpened(opened);
      }
    },
    [besideChat, doorOpened, openChatDocument, route],
  );
  const openReviewing = useReviewingLinkDestination(openFound);
  // A hidden document is a review. Beside the chat it opens in the dock, as everything
  // beside the chat does; elsewhere the review handoff opens it in the Editor.
  const open = useCallback<LinkDestination>(
    async (document, gesture) => {
      const door = intent.current;
      const { review } = document;
      if (!door || !review) return openReviewing(document, gesture);
      const dock = useDockDocumentStore.getState();
      if (door.claim !== null && !dock.isCurrent(door.claim)) return;
      doorOpened({ ...door.target, uri: door.uri });
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
        return;
      }
      return openReviewing(document, gesture);
    },
    [besideChat, doorOpened, openReviewing],
  );

  const scope = useMemo<LinkResolutionScope | null>(
    () =>
      activeWork && noWorkId
        ? {
            projectId,
            workId: activeWork.id,
            // Only a No Work chat's bare `scratch://` is its lineage's.
            rootThreadId: activeWork.id === noWorkId ? rootThreadId : null,
            baseUri: null,
          }
        : null,
    [activeWork, noWorkId, projectId, rootThreadId],
  );
  const index = useLinkableDocuments(scope ?? { projectId: null, workId: null });
  const { outcome, reporter: outcomeReporter } = useFollowOutcomeState();
  // Nothing at the address is not this door's to announce: the route says so in place.
  const reporter = useMemo<FollowReporter>(
    () => ({
      clear: outcomeReporter.clear,
      report(result) {
        const door = intent.current;
        if (result.state !== "missing" || !door) return outcomeReporter.report(result);
        outcomeReporter.clear();
        if (door.claim !== null && !useDockDocumentStore.getState().isCurrent(door.claim)) return;
        route(door);
        doorOpened({ ...door.target, uri: door.uri }, door.passage);
      },
    }),
    [doorOpened, outcomeReporter, route],
  );
  const follower = useLinkFollower({ scope, index, open, reporter });

  const openContextUri = useCallback(
    (uri: string, passage?: ContextPassageAnchor) => {
      if (!onOpenContextTarget || !activeWork || !noWorkId) return;
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
      // The dock is claimed now, so whatever answers later is inside the claim.
      const claim = besideChat ? useDockDocumentStore.getState().claim() : null;
      const link = classifyLinkTarget(catalogUri);
      if (!link) return route({ target });
      const door = { target, uri: catalogUri, passage, claim, link };
      intent.current = door;
      follower.follow(link);
    },
    [
      activeWork,
      availableWorks,
      noWorkId,
      lineages,
      onOpenContextTarget,
      besideChat,
      follower,
      route,
      rootThreadId,
      ownHandle,
      threads,
    ],
  );
  const canOpenContextUri = useCallback(
    (uri: string) =>
      !!activeWork &&
      !!noWorkId &&
      isContextUriRoutable(uri, activeWork, availableWorks, noWorkId, lineages),
    [activeWork, availableWorks, noWorkId, lineages],
  );

  return (
    <ChatContextNavigationProvider
      onOpenContextUri={onOpenContextTarget ? openContextUri : null}
      canOpenContextUri={onOpenContextTarget ? canOpenContextUri : null}
    >
      {children}
      <LinkFollowDialog
        outcome={outcome}
        projectId={projectId}
        scratchRootThreadId={scope?.rootThreadId ?? null}
        onClose={follower.dismiss}
        onRetry={follower.retry}
        onOpen={(document) => open(document, "current")}
      />
    </ChatContextNavigationProvider>
  );
}
