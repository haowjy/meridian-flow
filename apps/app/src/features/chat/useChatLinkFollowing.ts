/**
 * Chat's half of link following: the scope, destination, and outcome host a
 * transcript's links follow through, over the shared `features/links` follower.
 * `ChatView` provides the returned navigation to transcript references and
 * renders the returned dialog props.
 *
 * Scope: the thread's Work, and its lineage while the thread is on No Work (a
 * bare `scratch://` is the lineage's), with no base URI (so relative links are
 * text). It is pending only while the thread or the Works snapshot is loading; a click
 * then waits, showing checking, and is never answered from a guessed Work.
 * A null thread binding remains pending rather than guessing No Work. A No
 * Work thread uses the locked row id whichever snapshot names it first, so
 * the scope does not
 * change identity mid-load and drop a click. A thread whose Work the loaded
 * snapshot does not have (deleted, or not visible) asks with its own binding,
 * and the server answers. Known gap: the server answers null once that Work is
 * gone, so existing names read as missing; the thread normally disappears with
 * its Work, and the fix is the server's.
 *
 * Destination: the Editor, opened the way chat's other document doors open it
 * (exact-reference pills, tool-row names), with no explicit host Work: the
 * route keeps the current Editor Work. Having the Editor
 * adopt the chat's Work is a decision for all of chat's doors at once (#625).
 *
 * Visibility: `active` is the chat's visibility, so hiding the dock or opening
 * Settings aborts a follow and dismisses its dialog. ChatView remounts per
 * thread, so switching threads aborts too.
 *
 * Drawing: the chat owns one resolution cache and hands it to the follower and
 * to the transcript, so a syntax link's chip and a click on it read the same
 * answer. One requester asks about every link the transcript shows, batched.
 * The cache is created once and never destroyed, as the follower's own would
 * be: `destroy()` drops listeners, and a StrictMode remount keeps the
 * instance.
 *
 * Exact `@` references in writer messages ask by identity rather than through
 * the resolver, from the chat's `ReferenceAvailability` store. The catalog
 * revision that re-registers the resolver also refreshes that store, so a
 * deleted document turns its references dashed without a reload.
 */

import type { Thread, Work } from "@meridian/contracts/protocol";
import { type ComponentProps, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { lookupProjectContextAvailability } from "@/client/query/project-context-availability";
import { useWorks } from "@/client/query/useWorks";
import { createLinkRequester, createLinkResolution } from "@/core/editor/links";
import {
  type LinkDestination,
  type LinkFollowDialog,
  type LinkResolutionScope,
  useFollowOutcomeState,
  useLinkableDocuments,
  useLinkFollower,
} from "@/features/links";
import { useOpenChatDocument } from "@/features/project/context/open-chat-document";
import type { TranscriptLinkNavigation } from "@/rich-content/TranscriptReference";

import { createReferenceAvailability, type ReferenceAvailability } from "./reference-availability";

/** What a chat link is resolved against, or pending while that is still loading. */
function chatLinkScope({
  projectId,
  activeWork,
  thread,
  rootThreadId,
  noWorkId,
  worksSettled,
}: {
  projectId: string;
  /** The thread's Work from the Works snapshot; null when unknown or missing. */
  activeWork: Pick<Work, "id"> | null;
  thread: Pick<Thread, "workId"> | null;
  /** The chat's lineage while it is on No Work: a bare `scratch://` is the lineage's. */
  rootThreadId: string | null;
  noWorkId: string | null;
  /** The Works snapshot has loaded or failed; it will not name more Works by waiting. */
  worksSettled: boolean;
}): LinkResolutionScope | "pending" {
  if (activeWork) return { projectId, workId: activeWork.id, rootThreadId, baseUri: null };
  if (!worksSettled || !thread?.workId) return "pending";
  // A thread whose Work the snapshot lacks asks with its own binding; No Work is still its lineage.
  return {
    projectId,
    workId: thread.workId,
    rootThreadId: thread.workId === noWorkId ? rootThreadId : null,
    baseUri: null,
  };
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
  references: ReferenceAvailability;
  dialog: ComponentProps<typeof LinkFollowDialog>;
} {
  const { status: worksStatus, noWork } = useWorks(projectId);
  const threadKnown = activeThread !== null;
  const threadWorkId = activeThread?.workId ?? null;
  const noWorkId = noWork?.id ?? null;
  // The first chat's id: a No Work chat's Scratch is its lineage's.
  const lineageId = activeThread?.rootThreadId ?? null;
  const scope = useMemo(
    () =>
      chatLinkScope({
        projectId,
        activeWork,
        thread: threadKnown ? { workId: threadWorkId } : null,
        rootThreadId: activeWork?.isNoWork || threadWorkId === noWorkId ? lineageId : null,
        noWorkId,
        worksSettled: worksStatus !== "loading" && worksStatus !== "disabled",
      }),
    [activeWork, projectId, threadKnown, threadWorkId, noWorkId, lineageId, worksStatus],
  );
  const index = useLinkableDocuments(
    scope === "pending" ? { projectId: null, workId: null } : scope,
  );

  const openReferenceDocument = useOpenChatDocument(projectId);
  const open = useCallback<LinkDestination>(
    (document, gesture) =>
      openReferenceDocument({
        documentId: document.documentId,
        disposition: gesture === "new-tab" ? "background" : "current",
      }),
    [openReferenceDocument],
  );

  const { outcome, reporter } = useFollowOutcomeState();
  const [resolution] = useState(createLinkResolution);
  const [requester] = useState(() => createLinkRequester(resolution));
  const follower = useLinkFollower({ scope, index, resolution, active, open, reporter });

  // Exact `@` references ask by identity, not through the resolver, but the
  // same catalog change is what makes their answers stale: a revision change
  // (a document created, renamed, moved, or deleted) asks again about every
  // reference shown, in one batch.
  const references = useMemo(
    () => createReferenceAvailability((ids) => lookupProjectContextAvailability(projectId, ids)),
    [projectId],
  );
  // The revision this store last answered for. Seeded from the first COMPLETE
  // index, because the catalogs loading is not a change: counting it would ask
  // about every reference twice on opening a chat. A new store (project
  // change) starts over.
  const seen = useRef<{ store: ReferenceAvailability; revision: string } | null>(null);
  useEffect(() => {
    if (!index.complete) return;
    if (seen.current?.store !== references) {
      seen.current = { store: references, revision: index.revision };
      return;
    }
    if (seen.current.revision === index.revision) return;
    seen.current.revision = index.revision;
    references.refresh();
  }, [index.complete, index.revision, references]);

  const navigation = useMemo<TranscriptLinkNavigation>(
    () => ({
      follow: (target) => follower.follow(target),
      canFollow: follower.canFollow,
      resolution,
      watch: requester.watch,
    }),
    [follower, requester, resolution],
  );

  return {
    navigation,
    references,
    dialog: {
      outcome,
      projectId,
      scratchRootThreadId: scope === "pending" ? null : (scope.rootThreadId ?? null),
      onClose: follower.dismiss,
      onRetry: follower.retry,
      onOpen: (document) => open(document, "current"),
    },
  };
}
