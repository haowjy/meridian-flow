/**
 * Chat's half of link following: the scope, destination, and outcome host a
 * transcript's links follow through, over the shared `features/links` follower.
 *
 * The scope is the thread's Work. While the snapshots that name it are still
 * loading the scope is pending, so a click waits and shows checking instead of
 * being answered from a guessed Work. Once they have loaded, the scope is
 * always known: a thread whose Work the snapshot no longer has (deleted, or not
 * visible) asks with its own binding and lets the server answer, which comes
 * back as nothing found. Neither case is ever treated as No Work.
 */

import type { Thread, Work } from "@meridian/contracts/protocol";
import { type ComponentProps, useCallback, useMemo } from "react";

import { useWorks } from "@/client/query/useWorks";
import {
  type LinkDestination,
  type LinkFollowDialog,
  type LinkResolutionScope,
  useFollowOutcomeState,
  useLinkableDocuments,
  useLinkFollower,
} from "@/features/links";
import { useOpenProjectDocument } from "@/features/project/context/open-project-document";
import type { TranscriptLinkNavigation } from "@/rich-content/TranscriptReference";

/** What a chat link is resolved against, or pending while that is still loading. */
export function chatLinkScope({
  projectId,
  activeWork,
  thread,
  worksSettled,
}: {
  projectId: string;
  /** The thread's Work from the Works snapshot; null when unknown or missing. */
  activeWork: Pick<Work, "id"> | null;
  thread: Pick<Thread, "workId"> | null;
  /** The Works snapshot has loaded or failed; it will not name more Works by waiting. */
  worksSettled: boolean;
}): LinkResolutionScope | "pending" {
  if (activeWork) return { projectId, workId: activeWork.id, baseUri: null };
  if (!worksSettled || !thread) return "pending";
  return { projectId, workId: thread.workId, baseUri: null };
}

export function useChatLinkFollowing({
  projectId,
  activeThread,
  activeWork,
  active,
}: {
  projectId: string;
  activeThread: Thread | null;
  activeWork: Work | null;
  /** The chat is showing; hiding it aborts a follow in flight. */
  active: boolean;
}): {
  navigation: TranscriptLinkNavigation;
  dialog: ComponentProps<typeof LinkFollowDialog>;
} {
  const { status: worksStatus } = useWorks(projectId);
  const threadWorkId = activeThread?.workId ?? null;
  const scope = useMemo(
    () =>
      chatLinkScope({
        projectId,
        activeWork,
        thread: activeThread ? { workId: threadWorkId } : null,
        worksSettled: worksStatus !== "loading" && worksStatus !== "disabled",
      }),
    [activeThread, activeWork, projectId, threadWorkId, worksStatus],
  );
  const index = useLinkableDocuments(
    scope === "pending" ? { projectId: null, workId: null } : scope,
  );

  // The Editor adopts the chat's Work, so the document opens where the model
  // was working. The No Work row opens as explicit No Work, never as a Work id,
  // and a Work the snapshot does not have is not a place the Editor can go.
  const openReferenceDocument = useOpenProjectDocument(projectId);
  const destinationWorkId = activeWork && !activeWork.isNoWork ? activeWork.id : null;
  const open = useCallback<LinkDestination>(
    (document, gesture) =>
      openReferenceDocument({
        documentId: document.documentId,
        workId: destinationWorkId,
        disposition: gesture === "new-tab" ? "background" : "current",
      }),
    [destinationWorkId, openReferenceDocument],
  );

  const { outcome, reporter } = useFollowOutcomeState();
  const follower = useLinkFollower({ scope, index, active, open, reporter });

  const navigation = useMemo<TranscriptLinkNavigation>(
    () => ({ follow: (target) => follower.follow(target), canFollow: follower.canFollow }),
    [follower],
  );

  return {
    navigation,
    dialog: {
      outcome,
      projectId,
      // Cancel and Escape while checking stop the follow; on any other
      // outcome there is nothing left to stop.
      onClose: () => (outcome?.state === "checking" ? follower.cancel() : reporter.clear()),
      onRetry: () => {
        if (outcome) follower.follow(outcome.target);
      },
      onOpen: (document) => open(document, "current"),
    },
  };
}
