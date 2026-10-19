/** One project lifecycle owner settles remote dispositions for every Work with draft-only presentations. */

import type { ThreadDraftListItem } from "@meridian/contracts/branches";
import { resourceIdentityIndex } from "@meridian/resource-replica";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { contextCatalogScope } from "@/client/query/useContextCatalog";
import { useWorkBranchDrafts } from "@/client/query/useWorkBranchDrafts";
import {
  useObservedResourceProjection,
  useOptionalAccountResourceReplica,
} from "@/features/project/context/account-feature-context";
import { useOptionalOpenEditorReview } from "@/features/project/dock/editor-review-handoff";
import { usePresentedDocument } from "@/features/project/presented-document";
import {
  type DraftOnlyContainer,
  type DraftOnlyPresentation,
  useDraftOnlyLifecycle,
} from "./draft-only-lifecycle";
import type { DraftRef } from "./review-command-types";

export function DraftOnlySettlement({
  projectId,
  editorWorkId,
}: {
  projectId: string;
  /** The Work the Editor presents documents in: the entry its tab restores when no review is addressed. */
  editorWorkId: string | null;
}) {
  const lifecycle = useDraftOnlyLifecycle(projectId);
  // Primitive snapshot: a fresh presentation array is not an external-store change.
  useSyncExternalStore(
    lifecycle.subscribe,
    () => JSON.stringify(lifecycle.presentations(projectId)),
    () => "",
  );
  const presentations = lifecycle.presentations(projectId);
  const works = new Set(presentations.map((draft) => draft.workId));
  return [...works].map((workId) => (
    <WorkSettlement
      key={workId}
      projectId={projectId}
      workId={workId}
      editorWorkId={editorWorkId}
      lifecycle={lifecycle}
      membership={JSON.stringify(presentations.filter((draft) => draft.workId === workId))}
    />
  ));
}

function WorkSettlement({
  projectId,
  workId,
  editorWorkId,
  lifecycle,
  membership,
}: {
  projectId: string;
  workId: string;
  editorWorkId: string | null;
  lifecycle: DraftOnlyContainer;
  membership: string;
}) {
  const queryClient = useQueryClient();
  const resources = useOptionalAccountResourceReplica();
  const drafts = useWorkBranchDrafts(projectId, workId);
  const projection = useObservedResourceProjection(resources, projectId);
  // A draft-only tab whose draft left the active list was disposed of
  // elsewhere. The list cannot say how, so the catalog decides: a document
  // that now exists was applied, otherwise the draft was discarded.
  useEffect(() => {
    if (!resources || !projectId || !workId) return;
    if (drafts.status !== "ready" && drafts.status !== "empty") return;
    const isOrphan = (draft: DraftRef, activeDrafts: readonly ThreadDraftListItem[]) =>
      draft.workId === workId && !activeDrafts.some((row) => row.itemKey === draft.itemKey);
    const activeDrafts = drafts.drafts ?? [];
    if (!lifecycle.presentations(projectId).some((draft) => isOrphan(draft, activeDrafts))) return;

    const scopeFor = (draft: DraftOnlyPresentation) =>
      contextCatalogScope(projectId, draft.contextLocation.scheme, { workId: draft.workId });
    const scopes = new Map(
      lifecycle
        .presentations(projectId)
        .filter((draft) => isOrphan(draft, activeDrafts))
        .flatMap((draft) => {
          const scope = scopeFor(draft);
          return scope ? [[JSON.stringify(scope), scope] as const] : [];
        }),
    );
    const attempt = new AbortController();
    // A catalog observation that starts now: joining an older in-flight one
    // could report the pre-Apply tree and misread a remote Apply as a Discard.
    for (const [key, scope] of scopes) {
      void resources
        .acquireCatalogAfter(projectId, scope)
        .then((view) => {
          if (attempt.signal.aborted) return;
          queryClient.setQueryData(projectQueryKeys.contextCatalog(projectId, scope), view);
          const currentDrafts =
            queryClient.getQueryData<ThreadDraftListItem[]>(
              projectQueryKeys.workBranchDrafts(projectId, workId),
            ) ?? [];
          for (const draft of lifecycle.presentations(projectId)) {
            if (!isOrphan(draft, currentDrafts) || JSON.stringify(scopeFor(draft)) !== key)
              continue;
            if (view.entries.get(draft.documentId)?.kind === "file") void lifecycle.promote(draft);
            else lifecycle.remove(draft);
          }
        })
        // A failed membership check leaves this scope's tabs intact, never guesses Discard.
        .catch(() => undefined);
    }
    return () => attempt.abort();
  }, [
    lifecycle,
    membership,
    drafts.drafts,
    drafts.status,
    projectId,
    queryClient,
    resources,
    workId,
  ]);

  const presented = usePresentedDocument();
  const presentedRef = useRef(presented);
  presentedRef.current = presented;
  const openReview = useOptionalOpenEditorReview();
  // Draft-only means "hidden live". The replica showing the document (by its
  // current id or an alias: a join, New file, a link's Create) makes it live at
  // once for every Work. A tab the writer was looking at keeps the review it
  // showed, opened over the live document: the view the chip's Draft choice gives.
  useEffect(() => {
    if (drafts.status !== "ready") return;
    const identities = resourceIdentityIndex(projection.records);
    const promoting = new Set<string>();
    for (const draft of lifecycle.presentations(projectId)) {
      const row = drafts.drafts?.find((candidate) => candidate.itemKey === draft.itemKey);
      if (draft.workId !== workId || !row || !identities.byDocumentId(draft.documentId)) continue;
      if (promoting.has(draft.documentId)) continue;
      promoting.add(draft.documentId);
      // The review the Editor shows, captured before promotion clears the entries: its
      // address, else (a route that has dropped `item`) its own Work's entry on the tab.
      const shown = presentedRef.current;
      const own = lifecycle
        .presentations(projectId)
        .find(
          (entry) =>
            entry.container === "editor" &&
            entry.documentId === draft.documentId &&
            entry.workId === editorWorkId,
        );
      const review =
        shown?.container === "editor" && shown.documentId === draft.documentId && shown.draftOnly
          ? (shown.review ?? (own ? { workId: own.workId, itemKey: own.itemKey } : null))
          : null;
      void lifecycle.promote(draft).then((promoted) => {
        const now = presentedRef.current;
        if (!promoted || !review) return;
        // Promotion itself clears the address (the route drops `item`); only a different one means the writer moved.
        const moved =
          now?.review !== null &&
          now?.review !== undefined &&
          (now.review.workId !== review.workId || now.review.itemKey !== review.itemKey);
        if (now?.container !== "editor" || now.documentId !== draft.documentId || moved) return;
        void openReview?.({
          workId: review.workId,
          documentId: draft.documentId,
          itemKey: review.itemKey,
          contextLocation: draft.contextLocation,
          isNew: false,
        }).catch(() => undefined);
      });
    }
  }, [
    lifecycle,
    membership,
    drafts.drafts,
    drafts.status,
    projection.records,
    projectId,
    workId,
    editorWorkId,
    openReview,
  ]);

  return null;
}
