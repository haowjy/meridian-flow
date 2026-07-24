/**
 * DraftReviewHeader — the editor's chrome while a document is under inline
 * review. A thin strip above the identity bar: "Back to live" exit on the
 * left, whole-draft Apply all / Discard all on the right. Matches the dock
 * strip's geometry (min-h-7, bg-dock-surface, text-caption).
 */
import { Trans } from "@lingui/react/macro";
import { ChevronLeft, Loader2 } from "lucide-react";

import { useDraftReview } from "@/features/chat/DraftReviewProvider";

export type DraftReviewHeaderProps = {
  documentId: string;
  draftId: string;
};

export function DraftReviewHeader({ documentId, draftId }: DraftReviewHeaderProps) {
  const { controller } = useDraftReview();
  const busy = controller.isDisposing;
  const staleMessage =
    controller.staleDraft?.draftId === draftId ? controller.staleDraftMessage : null;
  const commandError =
    controller.inlineReviewMessage?.tone === "error" &&
    (controller.inlineReviewMessage.code === "apply-failed" ||
      controller.inlineReviewMessage.code === "discard-offline")
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
        onClick={() => controller.exitInlineReview()}
        disabled={busy}
        className="text-button -ml-1 inline-flex items-center gap-0.5 text-xs"
      >
        <ChevronLeft className="size-3" aria-hidden />
        <Trans>Back to live</Trans>
      </button>
      {staleMessage ? (
        <p className="text-destructive text-xs" role="alert">
          {staleMessage}
        </p>
      ) : null}
      {commandError ? (
        <p className="text-destructive text-xs" role="alert">
          {commandError === "apply-failed" ? (
            <Trans>Couldn't apply. Check your connection and try again.</Trans>
          ) : (
            <Trans>Couldn't discard. Check your connection and try again.</Trans>
          )}
        </p>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
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
          disabled={busy || !controller.canAcceptReviewedDraft}
          className="focus-ring inline-flex h-5 shrink-0 items-center rounded-sm bg-primary px-2.5 font-semibold text-primary-foreground disabled:opacity-50"
        >
          {controller.isAccepting ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
          <Trans>Apply all</Trans>
        </button>
      </div>
    </section>
  );
}
