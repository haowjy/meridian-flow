/**
 * useReviewHeader — everything a review header needs that is not layout: the
 * open review's changes, the next document, and the whole-draft commands that
 * move on to it.
 *
 * The identity row's controls and the phone header are two layouts over this one
 * model, so Apply draft, Discard draft, "No changes left" and the refusal line
 * cannot drift between them. Work-wide Apply all and Discard all belong to the
 * sidebar's Changes tab (`ChangesSource`), not here.
 */

import { useEffect, useRef } from "react";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";
import { useDraftReview } from "./DraftReviewProvider";
import { nextReviewFile } from "./review-files";
import { type ReviewChangesView, useReviewChanges } from "./useReviewChanges";

type ReviewHeaderOptions = {
  documentId: string;
  /** Empty while a stable chrome wrapper has no shown review. */
  itemKey: string;
  /** Set for a draft-only document: closes its tab instead of returning to live. */
  onCloseDraftOnly?: () => void;
  /**
   * Opens another draft of the Work in review (the presenting container's
   * launcher). `takeFocus`: the writer's focus was in the controls that open it.
   */
  onOpenDraft: (row: ReviewFileTarget, takeFocus?: boolean) => void;
  /** A command run with focus in the controls ended this draft's changes without opening another. */
  onEndedWithFocus?: () => void;
};

export type ReviewHeaderModel = {
  controller: ReturnType<typeof useDraftReview>["controller"];
  view: ReviewChangesView;
  /** A draft-only document has no live version: its way out closes the tab. */
  draftOnly: boolean;
  /** Opens another draft of the Work in review (the presenting container's launcher). */
  openDraft: (row: ReviewFileTarget, takeFocus?: boolean) => void;
  /** The draft's next document, if it has one. */
  next: ReviewFileTarget | null;
  locked: boolean;
  canApply: boolean;
  /** Nothing left to apply: the server closed the draft, so its commands go. */
  finished: boolean;
  /** The draft is open but lists no change: formatting remains, handled by Apply draft or Discard draft. */

  /** The last change's command is in flight: the review says so and is not finished. */
  completing: "apply" | "discard" | null;
  showLive: () => void;
  /** `takeFocus`: the writer's focus was in the controls, so it follows to what replaces them. */
  applyDraft: (takeFocus?: boolean) => void;
  /** Discard draft, at once: its notice has the Undo. */
  discardDraft: (takeFocus?: boolean) => void;
};

export function useReviewHeader({
  documentId,
  itemKey,
  onCloseDraftOnly,
  onOpenDraft,
  onEndedWithFocus,
}: ReviewHeaderOptions): ReviewHeaderModel {
  const { controller, files, showLive: showDocumentLive } = useDraftReview();
  const view = useReviewChanges(controller, { enabled: Boolean(itemKey) });

  // Only a file with suggestions has a review to move to: a move or delete alone has none.
  const next = nextReviewFile(
    files.filter((file) => file.item.textChanges > 0 || file.documentId === documentId),
    documentId,
    null,
  );
  const ready = view.status === "ready";
  const locked = controller.dispositionLocked || view.status !== "ready";
  const { finished, completing } = view;
  const showLive = () => (onCloseDraftOnly ?? showDocumentLive)();

  // The item this header shows while it is mounted; null once the writer has left it.
  const shown = useRef<string | null>(itemKey);
  useEffect(() => {
    shown.current = itemKey;
    return () => {
      shown.current = null;
    };
  }, [itemKey]);
  // Local Discard stays in this draft. Only an Apply that landed advances to another file: a
  // refusal shows on the draft the writer applied, so it must not move them first.
  const dispose = (mode: "apply" | "discard", takeFocus: boolean) => {
    if (locked) return;
    const start = controller.startItem(mode, { documentId, itemKey });
    if (!start.sent) return;
    void start.outcome.then((outcome) => {
      if (outcome.kind !== "done") return;
      if (mode === "apply" && next) {
        if (shown.current === itemKey) onOpenDraft(next, takeFocus);
      } else if (takeFocus) onEndedWithFocus?.();
    });
  };
  return {
    controller,
    view,
    next,
    locked,
    canApply: ready && view.items.length > 0,
    finished,
    completing,
    showLive,
    applyDraft: (takeFocus) => dispose("apply", takeFocus === true),
    discardDraft: (takeFocus) => dispose("discard", takeFocus === true),
    draftOnly: Boolean(onCloseDraftOnly),
    openDraft: onOpenDraft,
  };
}
