/**
 * DraftReviewHeader — the editor's chrome while a document is under inline
 * review. Uses DraftBannerStrip for consistent banner geometry. Adds a
 * "Back to live" exit and the whole-draft Apply all / Discard all controls.
 */
import { Trans } from "@lingui/react/macro";
import { ChevronLeft, Loader2 } from "lucide-react";

import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { DraftBannerStrip } from "./DraftBannerStrip";

export type DraftReviewHeaderProps = {
  documentId: string;
  draftId: string;
};

export function DraftReviewHeader({ documentId, draftId }: DraftReviewHeaderProps) {
  const { controller } = useDraftReview();
  const busy = controller.isDisposing;
  const staleMessage =
    controller.staleDraft?.draftId === draftId ? controller.staleDraftMessage : null;

  return (
    <DraftBannerStrip
      data-draft-review-header
      leading={
        <button
          type="button"
          onClick={() => controller.exitInlineReview()}
          disabled={busy}
          className="text-button -ml-1 inline-flex items-center gap-0.5 text-xs"
        >
          <ChevronLeft className="size-3" aria-hidden />
          <Trans>Back to live</Trans>
        </button>
      }
      label={<Trans>Reviewing draft</Trans>}
      alert={
        staleMessage ? (
          <p className="text-destructive text-xs" role="alert">
            {staleMessage}
          </p>
        ) : null
      }
      actions={
        <>
          <button
            type="button"
            onClick={() => controller.reject(documentId, draftId)}
            disabled={busy}
            className="text-button"
          >
            <Trans>Discard all</Trans>
          </button>
          <button
            type="button"
            onClick={() => controller.accept(documentId, draftId)}
            disabled={busy}
            className="focus-ring inline-flex h-5 shrink-0 items-center rounded-sm bg-primary px-2.5 font-semibold text-primary-foreground disabled:opacity-50"
          >
            {controller.isAccepting ? (
              <Loader2 className="size-3 animate-spin" aria-hidden />
            ) : null}
            <Trans>Apply all</Trans>
          </button>
        </>
      }
    />
  );
}
