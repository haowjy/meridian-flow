/**
 * One project lifecycle owner for draft-only presentations. It never decides that an item closed: an item
 * absent from a list or a metadata read is not evidence of Apply or Discard. The item's own command outcome
 * is the promote or remove signal (`useWorkDraftCommands`); this owner only turns a draft-only tab live the
 * moment the replica shows its document (a join, New file, a link's Create), for every Work at once.
 */

import { resourceIdentityIndex } from "@meridian/resource-replica";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useWorkDrafts } from "@/client/query/useWorkDrafts";
import {
  useObservedResourceProjection,
  useOptionalAccountResourceReplica,
} from "@/features/project/context/account-feature-context";
import { useOptionalOpenEditorReview } from "@/features/project/dock/editor-review-handoff";
import { usePresentedDocument } from "@/features/project/presented-document";
import { type DraftOnlyContainer, useDraftOnlyLifecycle } from "./draft-only-lifecycle";

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
  const resources = useOptionalAccountResourceReplica();
  const drafts = useWorkDrafts(projectId, workId);
  const projection = useObservedResourceProjection(resources, projectId);
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
