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
 * Visibility: `active` is the chat's visibility, so hiding the side or opening
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
 * Doors: a URI door (a written-document name, a passage row) follows through this same
 * follower, carrying its shell's placement policy. One chat, one latest click: a door
 * and a transcript link cancel each other, and a hidden chat or a switched thread
 * cancels both.
 *
 * Exact `@` references in writer messages read the replay by identity
 * (`useReferenceAvailability`), so a deleted document turns its references
 * dashed at once.
 */

import type { Thread, Work } from "@meridian/contracts/protocol";
import { type ComponentProps, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTopChat } from "@/client/query/useTopChat";
import { useWorks } from "@/client/query/useWorks";
import { createLinkAnswerCache, createLinkRequester } from "@/core/editor/links";
import { chatOwnerKey } from "@/features/draft-review/draft-owner-key";
import {
  type LinkDestination,
  type LinkDocumentRef,
  type LinkFollowDialog,
  type LinkResolutionScope,
  useFollowOutcomeState,
  useLinkableDocuments,
  useLinkFollower,
} from "@/features/links";
import type { FolderMenuHost } from "@/features/project/context/FolderMenu";
import { useOpenProjectDocument } from "@/features/project/context/open-project-document";
import { useLinkPlacement } from "@/features/project/review-launch";
import type { TranscriptLinkNavigation } from "@/rich-content/TranscriptReference";
import { type ChatDoors, type ContextPassageAnchor, useChatDoors } from "./ChatContextNavigation";

/** What a chat link is resolved against, or pending while that is still loading. */
function chatLinkScope({
  projectId,
  activeWork,
  thread,
  rootThreadId,
  chatId,
  noWorkId,
  worksSettled,
}: {
  projectId: string;
  /** The thread's Work from the Works snapshot; null when unknown or missing. */
  activeWork: Pick<Work, "id"> | null;
  thread: Pick<Thread, "workId"> | null;
  /** The chat's lineage while it is on No Work: a bare `scratch://` is the lineage's. */
  rootThreadId: string | null;
  /** The chat that owns the uploads a bare `uploads://` names. */
  chatId: string | null;
  noWorkId: string | null;
  /** The Works snapshot has loaded or failed; it will not name more Works by waiting. */
  worksSettled: boolean;
}): LinkResolutionScope | "pending" {
  if (activeWork) return { projectId, workId: activeWork.id, rootThreadId, chatId, baseUri: null };
  if (!worksSettled || !thread?.workId) return "pending";
  // A thread whose Work the snapshot lacks asks with its own binding; No Work is still its lineage.
  return {
    projectId,
    workId: thread.workId,
    rootThreadId: thread.workId === noWorkId ? rootThreadId : null,
    chatId,
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
  /** What the chat's folder chips (transcript and composer) open documents through. */
  folders: FolderMenuHost;
  dialog: ComponentProps<typeof LinkFollowDialog>;
  /** The shell's URI doors, following through this same follower; null without a shell. */
  doors: {
    open: (uri: string, passage?: ContextPassageAnchor) => void;
    canOpen: ChatDoors["canOpen"];
  } | null;
} {
  const { status: worksStatus, noWork } = useWorks(projectId);
  const threadKnown = activeThread !== null;
  const threadWorkId = activeThread?.workId ?? null;
  const noWorkId = noWork?.id ?? null;
  // The first chat's id: a No Work chat's Scratch is its lineage's.
  const lineageId = activeThread?.rootThreadId ?? null;
  const chatId =
    useTopChat(projectId, activeThread)?.chatId ??
    (activeThread?.kind === "subagent" ? null : (activeThread?.id ?? null));
  const scope = useMemo(
    () =>
      chatLinkScope({
        projectId,
        activeWork,
        thread: threadKnown ? { workId: threadWorkId } : null,
        rootThreadId: activeWork?.isNoWork || threadWorkId === noWorkId ? lineageId : null,
        chatId,
        noWorkId,
        worksSettled: worksStatus !== "loading" && worksStatus !== "disabled",
      }),
    [activeWork, projectId, threadKnown, threadWorkId, noWorkId, lineageId, chatId, worksStatus],
  );
  const index = useLinkableDocuments(
    scope === "pending" ? { projectId: null, workId: null } : scope,
  );

  const openReferenceDocument = useOpenProjectDocument(projectId);
  const openLive = useCallback(
    (document: LinkDocumentRef) =>
      openReferenceDocument({
        documentId: document.documentId,
        ...(document.trashed ? { trashed: true as const } : {}),
        ...(document.focus ? { focus: true as const } : {}),
      }),
    [openReferenceDocument],
  );
  // A page this chat drafted opens on its draft.
  const place = useLinkPlacement(
    projectId,
    chatOwnerKey(activeWork, activeThread?.rootThreadId ?? null) || null,
  );
  const linkWorkId = activeWork?.id ?? null;
  const open = useCallback<LinkDestination>(
    (document) => place(document, openLive, linkWorkId),
    [place, openLive, linkWorkId],
  );
  const folders = useMemo<FolderMenuHost>(
    () => ({ projectId, openDocument: (documentId) => void open({ documentId }) }),
    [open, projectId],
  );

  const { outcome, reporter } = useFollowOutcomeState();
  const [resolution] = useState(createLinkAnswerCache);
  const [requester] = useState(() => createLinkRequester(resolution));
  const follower = useLinkFollower({ scope, index, resolution, active, open, reporter });

  const shellDoors = useChatDoors();
  const doors = useMemo(
    () =>
      shellDoors
        ? {
            canOpen: shellDoors.canOpen,
            open: (uri: string, passage?: ContextPassageAnchor) => {
              const door = shellDoors.prepare(uri, passage);
              if (door) follower.follow(door.link, null, door.policy);
            },
          }
        : null,
    [follower, shellDoors],
  );

  const navigation = useMemo<TranscriptLinkNavigation>(
    () => ({
      follow: (target) => {
        shellDoors?.retire();
        follower.follow(target);
      },
      canFollow: follower.canFollow,
      resolution,
      watch: requester.watch,
    }),
    [follower, requester, resolution, shellDoors],
  );

  return {
    navigation,
    folders,
    doors,
    dialog: {
      outcome,
      projectId,
      scratchRootThreadId: scope === "pending" ? null : (scope.rootThreadId ?? null),
      onClose: follower.dismiss,
      onRetry: follower.retry,
      onOpen: (document) => open(document),
    },
  };
}
