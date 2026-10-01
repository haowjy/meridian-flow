/**
 * Chat's half of link following: the scope, destination, and outcome host a
 * transcript's links follow through, over the shared `features/links` follower.
 * `ChatView` provides the returned navigation to transcript references and
 * renders the returned dialog props.
 *
 * Scope: the thread's Work, with no base URI (so relative links are text). It
 * is pending only while the thread or the Works snapshot is loading; a click
 * then waits, showing checking, and is never answered from a guessed Work.
 * Once loaded the scope is always known. A No Work thread's Work is the No
 * Work row, by id whichever snapshot names it first, so the scope does not
 * change identity mid-load and drop a click. A thread whose Work the loaded
 * snapshot does not have (deleted, or not visible) asks with its own binding,
 * and the server answers. Known gap: the server answers null once that Work is
 * gone, so existing names read as missing; the thread normally disappears with
 * its Work, and the fix is the server's.
 *
 * Destination: the Editor, opened the way chat's other document doors open it
 * (exact-reference pills, tool-row names), with no Work. Having the Editor
 * adopt the chat's Work is a decision for all of chat's doors at once (#625).
 *
 * Visibility: `active` is the chat's visibility, so hiding the dock or opening
 * Settings aborts a follow and dismisses its dialog. ChatView remounts per
 * thread, so switching threads aborts too.
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
  noWorkId,
}: {
  projectId: string;
  /** The thread's Work from the Works snapshot; null when unknown or missing. */
  activeWork: Pick<Work, "id"> | null;
  thread: Pick<Thread, "workId"> | null;
  /** The Works snapshot has loaded or failed; it will not name more Works by waiting. */
  worksSettled: boolean;
  /** The project's No Work row, once the Works snapshot has it. */
  noWorkId: string | null;
}): LinkResolutionScope | "pending" {
  if (activeWork) return { projectId, workId: activeWork.id, baseUri: null };
  if (!worksSettled || !thread) return "pending";
  return { projectId, workId: thread.workId ?? noWorkId, baseUri: null };
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
  const { status: worksStatus, noWork } = useWorks(projectId);
  const threadKnown = activeThread !== null;
  const threadWorkId = activeThread?.workId ?? null;
  const noWorkId = noWork?.id ?? null;
  const scope = useMemo(
    () =>
      chatLinkScope({
        projectId,
        activeWork,
        thread: threadKnown ? { workId: threadWorkId } : null,
        worksSettled: worksStatus !== "loading" && worksStatus !== "disabled",
        noWorkId,
      }),
    [activeWork, noWorkId, projectId, threadKnown, threadWorkId, worksStatus],
  );
  const index = useLinkableDocuments(
    scope === "pending" ? { projectId: null, workId: null } : scope,
  );

  const openReferenceDocument = useOpenProjectDocument(projectId);
  const open = useCallback<LinkDestination>(
    (document, gesture) =>
      openReferenceDocument({
        documentId: document.documentId,
        disposition: gesture === "new-tab" ? "background" : "current",
      }),
    [openReferenceDocument],
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
      onClose: follower.dismiss,
      onRetry: follower.retry,
      onOpen: (document) => open(document, "current"),
    },
  };
}
