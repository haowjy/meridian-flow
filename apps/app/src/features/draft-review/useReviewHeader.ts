/**
 * useReviewHeader — everything a review header needs that is not layout: the
 * Work's drafts for the switcher (with their change counts), the open review's
 * changes, and the whole-draft commands that move on to the next draft.
 *
 * The desktop header and the phone header are two layouts over this one model,
 * so Apply draft, Discard draft, Apply all, "No changes left" and the refusal
 * line cannot drift between them.
 */
import { useMemo, useState } from "react";

import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { type DockRow, dockRows, draftAfter } from "@/features/chat/docked-drafts";
import type { InlineReviewMessageCode } from "@/features/chat/draft-review-session";
import type { DraftSwitcherProps } from "./DraftSwitcher";
import { useDraftChangeCounts } from "./useDraftChangeCounts";
import { type ReviewChangesView, useReviewChanges } from "./useReviewChanges";

export type ReviewHeaderOptions = {
  documentId: string;
  draftId: string;
  /** Set for a draft-only document: closes its tab instead of returning to live. */
  onCloseDraftOnly?: () => void;
  /** Opens another draft of the Work in review (the editor's launcher). */
  onOpenDraft: (row: DockRow) => void;
};

export type ReviewHeaderModel = {
  controller: ReturnType<typeof useDraftReview>["controller"];
  view: ReviewChangesView;
  /** What `DraftSwitcher` is given, minus the layout-specific props. */
  switcher: Omit<DraftSwitcherProps, "touch">;
  /** The next draft in the switcher, if the Work has one. */
  next: DockRow | null;
  locked: boolean;
  /** Nothing left to publish: the draft already matches live, so its commands go. */
  finished: boolean;
  /** The refusal code of the last whole-draft command, if it was refused. */
  commandError: InlineReviewMessageCode | null;
  showLive: () => void;
  applyDraft: () => void;
  discardDraft: () => void;
};

export function useReviewHeader({
  documentId,
  draftId,
  onCloseDraftOnly,
  onOpenDraft,
}: ReviewHeaderOptions): ReviewHeaderModel {
  const { controller, groups } = useDraftReview();
  const view = useReviewChanges(controller);
  const rows = useMemo(() => dockRows(groups), [groups]);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const counts = useDraftChangeCounts(
    controller,
    rows
      .filter((row) => row.documentId !== documentId)
      .map((row) => ({ documentId: row.documentId, draftId: row.draft.draftId })),
    switcherOpen,
  );
  const allCounts = useMemo(() => {
    const merged = new Map(counts);
    if (view.status === "ready") merged.set(documentId, view.items.length);
    return merged;
  }, [counts, documentId, view.items.length, view.status]);

  const next = draftAfter(rows, documentId);
  const locked = controller.dispositionLocked;
  const finished = view.cleared || (view.status === "ready" && view.items.length === 0);
  const commandError =
    controller.inlineReviewMessage?.tone === "error" ? controller.inlineReviewMessage.code : null;
  const showLive = () => (onCloseDraftOnly ?? controller.exitInlineReview)();

  /** Run a whole-draft command, then move to the next draft (or live) without waiting on it. */
  const dispose = (command: () => Promise<unknown>) => {
    if (locked) return;
    void command();
    if (next) onOpenDraft(next);
  };
  const selections = rows.map((row) => ({
    documentId: row.documentId,
    draftId: row.draft.draftId,
  }));

  return {
    controller,
    view,
    next,
    locked,
    finished,
    commandError,
    showLive,
    applyDraft: () => dispose(() => controller.apply(documentId, draftId)),
    discardDraft: () => dispose(() => controller.discard(documentId, draftId)),
    switcher: {
      rows,
      currentDocumentId: documentId,
      currentName: controller.inlineReview?.cleared?.documentName ?? null,
      counts: allCounts,
      onOpenChange: setSwitcherOpen,
      draftOnly: Boolean(onCloseDraftOnly),
      disabled: locked,
      onOpenDraft,
      onShowLive: showLive,
      onApplyAll: () => void controller.disposeDrafts("apply", selections),
      onDiscardAll: () => void controller.disposeDrafts("discard", selections),
    },
  };
}
