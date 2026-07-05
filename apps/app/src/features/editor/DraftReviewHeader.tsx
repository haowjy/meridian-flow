/**
 * DraftReviewHeader — the full-width editor's chrome while a document is under
 * inline review.
 *
 * Review mode is a full-width manuscript with the dock's Changes view; this
 * strip carries the whole-draft controls that used to hang off the deleted
 * in-editor split: LEFT an exit back to the live document, RIGHT Apply all /
 * Discard all. The verbs delegate straight to the shared review controller —
 * the controls moved here, the accept/reject logic did not change.
 */
import { Trans } from "@lingui/react/macro";
import { ChevronLeft, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";

export type DraftReviewHeaderProps = {
  documentId: string;
  draftId: string;
};

export function DraftReviewHeader({ documentId, draftId }: DraftReviewHeaderProps) {
  const { controller } = useDraftReview();
  const busy = controller.isPending;
  const applyBlockedByDiscard = controller.isInlineDiscardPending;
  const cannotPlace =
    controller.cannotPlaceDraft?.documentId === documentId &&
    controller.cannotPlaceDraft.draftId === draftId;
  const staleMessage =
    controller.staleDraft?.draftId === draftId ? controller.staleDraftMessage : null;

  return (
    <section
      className="surface-card flex shrink-0 flex-wrap items-center gap-3 border-border-subtle border-b px-4 py-2"
      data-draft-review-header
    >
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => controller.exitInlineReview()}
        disabled={busy}
        className="-ml-2 text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" aria-hidden />
        <Trans>Back to live</Trans>
      </Button>
      <span
        className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground"
        data-draft-review-status
      >
        <span aria-hidden className="size-2 rounded-full bg-primary" />
        <Trans>Reviewing changes</Trans>
      </span>
      {staleMessage ? (
        <p className="text-destructive text-xs" role="alert">
          {staleMessage}
        </p>
      ) : null}
      <div className="ml-auto flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => controller.reject(documentId, draftId)}
          disabled={busy}
          className="text-muted-foreground hover:text-foreground"
        >
          <Trans>Discard all</Trans>
        </Button>
        {cannotPlace ? null : (
          <Button
            type="button"
            size="sm"
            variant="default"
            onClick={() => controller.accept(documentId, draftId)}
            disabled={busy || applyBlockedByDiscard}
          >
            {controller.isAccepting ? (
              <Loader2 className="size-3 animate-spin" aria-hidden />
            ) : null}
            {applyBlockedByDiscard ? <Trans>Finishing discard…</Trans> : <Trans>Apply all</Trans>}
          </Button>
        )}
      </div>
    </section>
  );
}
