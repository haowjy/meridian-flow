/**
 * DraftReviewHeader — the editor's chrome while a document is under inline
 * review. A thin strip above the identity bar: "Back to live" exit on the
 * left, whole-draft Apply all / Discard all on the right. Matches the dock
 * strip's geometry. A draft-only document has no live version to go back to,
 * so its exit closes the tab (the draft stays in the Work's list to reopen).
 */
import { Trans } from "@lingui/react/macro";
import { ChevronLeft, Loader2, X } from "lucide-react";

import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { ReviewMessageText } from "@/features/chat/ReviewMessageText";

export type DraftReviewHeaderProps = {
  documentId: string;
  draftId: string;
  /** Set for a draft-only document: closes its tab instead of returning to live. */
  onCloseDraftOnly?: () => void;
};

export function DraftReviewHeader({
  documentId,
  draftId,
  onCloseDraftOnly,
}: DraftReviewHeaderProps) {
  const { controller } = useDraftReview();
  const busy = controller.isDisposing;
  const commandError =
    controller.inlineReviewMessage?.tone === "error" &&
    controller.inlineReviewMessage.code !== "discard-failed"
      ? controller.inlineReviewMessage.code
      : null;

  return (
    <section
      // px-4 matches the identity bar's band padding so Apply all and the
      // Rename chip share one right edge.
      className="flex min-h-7 shrink-0 flex-wrap items-center gap-1.5 border-border border-b bg-dock-surface px-4 text-caption"
      role="status"
      aria-live="polite"
      data-draft-review-header
    >
      <button
        type="button"
        onClick={() => (onCloseDraftOnly ?? controller.exitInlineReview)()}
        disabled={busy}
        className="text-button -ml-1 inline-flex items-center gap-0.5 text-xs"
      >
        {onCloseDraftOnly ? (
          <>
            <X className="size-3" aria-hidden />
            <Trans>Close review</Trans>
          </>
        ) : (
          <>
            <ChevronLeft className="size-3" aria-hidden />
            <Trans>Back to live</Trans>
          </>
        )}
      </button>
      {commandError ? (
        <p className="text-destructive text-xs" role="alert">
          <ReviewMessageText code={commandError} />
        </p>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => controller.discard(documentId, draftId)}
          disabled={busy}
          className="text-button"
        >
          <Trans>Discard all</Trans>
        </button>
        <button
          type="button"
          onClick={() => controller.apply(documentId, draftId)}
          disabled={busy || !controller.canApplyReviewedDraft}
          className="focus-ring inline-flex h-5 shrink-0 items-center rounded-sm bg-primary px-2.5 font-semibold text-primary-foreground disabled:opacity-50"
        >
          {controller.isApplying ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
          <Trans>Apply all</Trans>
        </button>
      </div>
    </section>
  );
}
