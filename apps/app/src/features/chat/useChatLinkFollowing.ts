import type { Thread, Work } from "@meridian/contracts/protocol";
import { type ComponentProps, useCallback, useMemo, useState } from "react";

import { useTopChat } from "@/client/query/useTopChat";
import { useWorks } from "@/client/query/useWorks";
import { createLinkAnswerCache, createLinkRequester } from "@/core/editor/links";
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

function chatLinkScope({
  projectId,
  activeWork,
  thread,
  rootThreadId,
  chatThreadId,
  noWorkId,
  worksSettled,
}: {
  projectId: string;
  activeWork: Pick<Work, "id"> | null;
  thread: Pick<Thread, "workId"> | null;
  rootThreadId: string | null;
  chatThreadId: string | null;
  noWorkId: string | null;
  worksSettled: boolean;
}): LinkResolutionScope | "pending" {
  if (activeWork)
    return { projectId, workId: activeWork.id, rootThreadId, chatThreadId, baseUri: null };
  if (!worksSettled || !thread?.workId) return "pending";
  return {
    projectId,
    workId: thread.workId,
    rootThreadId: thread.workId === noWorkId ? rootThreadId : null,
    chatThreadId,
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
  active: boolean;
}): {
  navigation: TranscriptLinkNavigation;
  folders: FolderMenuHost;
  dialog: ComponentProps<typeof LinkFollowDialog>;
  doors: {
    open: (uri: string, passage?: ContextPassageAnchor) => void;
    canOpen: ChatDoors["canOpen"];
  } | null;
} {
  const { status: worksStatus, noWork } = useWorks(projectId);
  const threadKnown = activeThread !== null;
  const threadWorkId = activeThread?.workId ?? null;
  const noWorkId = noWork?.id ?? null;
  const lineageId = activeThread?.rootThreadId ?? null;
  const chatThreadId =
    useTopChat(projectId, activeThread)?.chatId ??
    (activeThread?.kind === "subagent" ? null : (activeThread?.id ?? null));
  const scope = useMemo(
    () =>
      chatLinkScope({
        projectId,
        activeWork,
        thread: threadKnown ? { workId: threadWorkId } : null,
        rootThreadId: activeWork?.isNoWork || threadWorkId === noWorkId ? lineageId : null,
        chatThreadId,
        noWorkId,
        worksSettled: worksStatus !== "loading" && worksStatus !== "disabled",
      }),
    [
      activeWork,
      projectId,
      threadKnown,
      threadWorkId,
      noWorkId,
      lineageId,
      chatThreadId,
      worksStatus,
    ],
  );
  const index = useLinkableDocuments(
    scope === "pending" ? { projectId: null, workId: null } : scope,
  );

  const openReferenceDocument = useOpenProjectDocument(projectId);
  const openLive = useCallback(
    (document: LinkDocumentRef, placeBeside?: () => boolean) =>
      openReferenceDocument({
        documentId: document.documentId,
        placeBeside,
        ...(document.trashed ? { trashed: true as const } : {}),
        ...(document.focus ? { focus: true as const } : {}),
      }),
    [openReferenceDocument],
  );
  const place = useLinkPlacement(
    projectId,
    activeWork && activeThread ? activeThread.draftId : null,
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
