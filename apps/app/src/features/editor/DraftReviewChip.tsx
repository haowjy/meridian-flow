/**
 * DraftReviewChip — a subtle identity-bar chip that nudges the writer to
 * review pending AI changes. Lives in the breadcrumb row alongside "Rename" /
 * "Choose a home". Jade-tinted pill matching the identity bar's chip grammar.
 *
 * Self-contained: resolves its own draft state from DraftReviewProvider
 * context, so the identity bar just mounts it and passes the documentId.
 */
import { Trans } from "@lingui/react/macro";
import { draftCommandFailure, useDraftCommandRecords } from "@/client/query/draft-command-record";
import { pendingReviewDraft } from "@/client/query/useWorkDrafts";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { ReviewMessageText } from "@/features/chat/ReviewMessageText";
import { IDENTITY_BAR_BOX_CLASS } from "@/features/project/context/identity-bar-geometry";
import { useAiDraftLauncher } from "@/features/project/dock/useAiDraftLauncher";
import { cn } from "@/lib/utils";

export type DraftReviewChipProps = {
  documentId: string;
};

export function DraftReviewChip({ documentId }: DraftReviewChipProps) {
  const { controller, groupForDocument } = useDraftReview();
  const { openAiDraft } = useAiDraftLauncher();
  const commandRecords = useDraftCommandRecords();

  // Don't show during inline review — the review header handles that state.
  // Held with the rest of the live view until the review body paints, then
  // swapped out with the header in the same frame.
  if (controller.inlineReview?.documentId === documentId && controller.inlineReview.shown) {
    return null;
  }

  const group = groupForDocument(documentId);
  if (!group) return null;
  const draft = pendingReviewDraft(group);
  if (!draft) return null;
  // A launch that failed shows on the chip itself; clicking it again retries.
  const failed =
    draftCommandFailure(commandRecords, {
      projectId: controller.projectId,
      workId: controller.workId,
      documentId,
      draftId: draft.draftId,
    }) === "review-failed";

  return (
    <button
      type="button"
      data-draft-review-chip
      data-draft-review-chip-failed={failed ? "" : undefined}
      onClick={() =>
        group.contextPath &&
        openAiDraft({
          workId: controller.workId,
          documentId: group.documentId,
          draftId: draft.draftId,
          contextPath: group.contextPath,
          documentName: group.documentName ?? undefined,
          isNewDocument: draft.isNewDocument === true,
        })
      }
      disabled={controller.isDisposing}
      className={cn(
        "focus-ring inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-1.5 font-sans text-xs font-medium motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150",
        failed
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-primary/30 bg-primary/10 text-jade-text",
        IDENTITY_BAR_BOX_CLASS,
      )}
    >
      <span
        aria-hidden
        className={cn("size-1.5 rounded-full", failed ? "bg-destructive" : "bg-primary")}
      />
      {failed ? <ReviewMessageText code="review-failed" /> : <Trans>Review draft</Trans>}
    </button>
  );
}
