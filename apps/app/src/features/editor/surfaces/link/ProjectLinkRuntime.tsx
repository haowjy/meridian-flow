import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useMemo } from "react";

import {
  getLinkAnswerCache,
  getLinkSurface,
  type InternalLinkNavigator,
} from "@/core/editor/links";
import {
  type FollowReporter,
  type LinkableDocumentIndex,
  type LinkDestination,
  type LinkDocumentRef,
  type LinkResolutionScope,
  useLinkFollower,
} from "@/features/links";
import { useReferenceDragStart } from "@/features/project/context/entry-drag/reference-source";
import { useOpenProjectDocument } from "@/features/project/context/open-project-document";
import { useLinkPlacement } from "@/features/project/review-launch";

import { useEditorScope } from "../../editor-scope";

export function useEditorLinkDestination(): LinkDestination {
  const { projectId, workId } = useEditorScope();
  const openDocument = useOpenProjectDocument(projectId ?? undefined);
  const openLive = useCallback(
    (document: LinkDocumentRef, placeBeside?: () => boolean) =>
      openDocument({
        documentId: document.documentId,
        placeBeside,
        ...(document.trashed ? { trashed: true as const } : {}),
        ...(document.focus ? { focus: true as const } : {}),
        workId: workId ?? undefined,
      }),
    [openDocument, workId],
  );
  const place = useLinkPlacement(projectId, null);
  return useCallback<LinkDestination>(
    (document) => place(document, openLive, workId),
    [place, openLive, workId],
  );
}

export function ProjectLinkRuntime({
  editor,
  documentId,
  baseUri,
  index,
  active,
}: {
  editor: Editor | null;
  documentId: string;
  baseUri: string | null;
  index: LinkableDocumentIndex;
  active: boolean;
}) {
  const { projectId, workId, rootThreadId } = useEditorScope();
  const resolution = useMemo(() => getLinkAnswerCache(editor), [editor]);
  const surface = useMemo(() => getLinkSurface(editor), [editor]);
  const open = useEditorLinkDestination();
  const startDrag = useReferenceDragStart();

  const scope = useMemo<LinkResolutionScope | "pending" | null>(
    () =>
      !active || !projectId
        ? null
        : workId
          ? {
              projectId,
              workId,
              rootThreadId,
              baseUri,
              holderDocumentId: documentId,
            }
          : "pending",
    [active, baseUri, documentId, projectId, rootThreadId, workId],
  );
  const reporter = useMemo<FollowReporter>(
    () => ({
      report: (outcome) => surface?.reportFollow(outcome),
      clear: () => surface?.clearFollow(),
    }),
    [surface],
  );
  const follower = useLinkFollower({ scope, index, resolution, open, reporter, active });

  useEffect(() => {
    if (!active || !surface || !projectId) return;
    const navigate: InternalLinkNavigator = ({ target, ref }) => {
      follower.follow(target, ref);
    };
    const unregisterNavigator = surface.registerNavigator(navigate);
    const unregisterDragSource = startDrag
      ? surface.registerDragSource(({ entry, name, event }) =>
          startDrag(event, { ref: entry, name }),
        )
      : () => {};
    const unregisterHandlers = surface.registerFollowHandlers({
      dismiss: follower.dismiss,
      retry: follower.retry,
    });
    return () => {
      unregisterNavigator();
      unregisterDragSource();
      unregisterHandlers();
    };
  }, [active, follower, projectId, startDrag, surface]);

  return null;
}
