/**
 * DraftReviewHeader — the editor's chrome while a document is under inline
 * review. A thin strip above the identity bar: "Back to live" exit on the
 * left, same-document draft stepping beside it, and whole-draft Apply all /
 * Discard all on the right. Matches the dock strip's geometry.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";

import { useDraftReview } from "@/features/chat/DraftReviewProvider";

export type DraftReviewHeaderProps = {
  documentId: string;
  draftId: string;
};

export function DraftReviewHeader({ documentId, draftId }: DraftReviewHeaderProps) {
  const { controller, reviewableDraftsForDocument } = useDraftReview();
  const busy = controller.isDisposing;
  const drafts = reviewableDraftsForDocument(documentId).active;
  const index = drafts.findIndex((draft) => draft.draftId === draftId);
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
      {drafts.length > 1 && index >= 0 ? (
        <Stepper
          index={index}
          count={drafts.length}
          disabled={busy}
          onStep={(delta) => {
            const target = drafts[index + delta];
            if (target) controller.enterInlineReview(documentId, target.draftId);
          }}
        />
      ) : null}
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

function Stepper({
  index,
  count,
  disabled,
  onStep,
}: {
  index: number;
  count: number;
  disabled: boolean;
  onStep: (delta: -1 | 1) => void;
}) {
  return (
    <div className="inline-flex items-center gap-1 text-ink-muted text-xs">
      <button
        type="button"
        className="focus-ring grid size-6 place-items-center rounded-md hover:bg-surface-subtle hover:text-foreground disabled:opacity-40"
        onClick={() => onStep(-1)}
        disabled={disabled || index === 0}
        aria-label={t`Previous draft`}
      >
        <ChevronLeft className="size-3.5" aria-hidden />
      </button>
      <span className="tabular-nums">
        <Trans>
          Draft {index + 1} of {count}
        </Trans>
      </span>
      <button
        type="button"
        className="focus-ring grid size-6 place-items-center rounded-md hover:bg-surface-subtle hover:text-foreground disabled:opacity-40"
        onClick={() => onStep(1)}
        disabled={disabled || index >= count - 1}
        aria-label={t`Next draft`}
      >
        <ChevronRight className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
