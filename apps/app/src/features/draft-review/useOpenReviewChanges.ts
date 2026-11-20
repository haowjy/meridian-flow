/**
 * Open review rows are the Work's suggestions in the host's editor, without command or focus
 * ownership, after the item's pending move (its tree line) when it has one. A delete replaces the text rows:
 * its banner and single document row are the review. Focus and stepping walk the visible text
 * changes (`changes`) alone; a tree line has no place in the text.
 */
import { useContext, useSyncExternalStore } from "react";
import { useOwnerDraftList } from "@/client/query/useOwnerDrafts";
import { type HostEditor, HostEditorContext } from "@/features/suggestion-review/host-editor";
import { useSuggestionChanges } from "@/features/suggestion-review/useSuggestionChanges";
import type { DraftChangesData } from "./draft-changes";
import { useDraftCommandState } from "./draft-changes";
import type { DraftRef } from "./review-command-types";
import { itemChange, type ReviewChange } from "./review-model";
import { treeChange, treeLineOf } from "./tree-line";
import type { DraftReviewController } from "./useDraftReviewController";

type ReviewRead = {
  status: "idle" | "loading" | "ready";
  changes: readonly ReviewChange[];
};

/**
 * The open review's changes are the Work's suggestions in the host's editor. `host` serves the one caller above the host's boundary (its address admission).
 */
function useSuggestionRead(draft: DraftRef | null, host: HostEditor | null): ReviewRead {
  const fromBoundary = useContext(HostEditorContext);
  const store = fromBoundary ?? host;
  const editor = useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    store?.get ?? noEditor,
    noEditor,
  );
  const listed = useOwnerDraftList(draft?.projectId ?? "", draft?.ownerKey ?? "", Boolean(draft));
  const item = draft ? listed.data?.items.find((row) => row.itemKey === draft.itemKey) : undefined;
  const read = useSuggestionChanges(draft ? editor : null, draft?.ownerKey ?? "", item);
  // A document only the Work holds is plain text: the document itself is its one change.
  const changes = item?.wholeItem ? [itemChange(item)] : read.changes;
  return { status: !draft ? "idle" : read.ready || item?.wholeItem ? "ready" : "loading", changes };
}
const noSubscription = () => () => undefined;
const noEditor = () => null;

export function useOpenReviewChanges(
  controller: Pick<DraftReviewController, "projectId" | "ownerKey" | "inlineReview">,
  options?: { enabled?: boolean; host?: HostEditor | null },
) {
  const inline = options?.enabled === false ? null : controller.inlineReview;
  const draft = inline
    ? {
        projectId: controller.projectId,
        ownerKey: controller.ownerKey,
        documentId: inline.documentId,
        itemKey: inline.itemKey,
      }
    : null;
  const command = useDraftCommandState(draft?.itemKey ?? "");
  const listed = useOwnerDraftList(controller.projectId, controller.ownerKey, Boolean(draft));
  const item = draft ? listed.data?.items.find((row) => row.itemKey === draft.itemKey) : undefined;
  const withoutText = item?.hasDraft === false || item?.tree?.deleted === true;
  const read = useSuggestionRead(draft, options?.host ?? null);
  const line = item && !item.isNew ? treeLineOf(item) : null;
  const changes = line?.kind === "delete" ? [] : read.changes;
  const items = (item && line ? [treeChange(item, line), ...changes] : changes).map((change) => ({
    change,
  }));
  return {
    inline,
    documentId: inline?.documentId ?? null,
    itemKey: inline?.itemKey ?? null,
    changes,
    items,
    // A draft gone while on screen has nothing to act on.
    status: command.ended
      ? "gone"
      : withoutText
        ? "ready"
        : (read.status as DraftChangesData["status"]),

    completing: command.discarding
      ? ("discard" as const)
      : command.applying
        ? ("apply" as const)
        : null,
    // A listed new file is still its own change once its text is gone: Apply draft creates it.
    finished:
      read.status === "ready" &&
      !items.length &&
      !item?.isNew &&
      !command.pending &&
      !command.discarding,
  };
}
