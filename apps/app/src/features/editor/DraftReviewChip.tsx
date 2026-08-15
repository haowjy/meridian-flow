/**
 * DraftReviewChip — a subtle identity-bar chip that nudges the writer to
 * review pending AI changes. Lives in the breadcrumb row alongside "Rename" /
 * "Choose a home". Jade-tinted pill matching the identity bar's chip grammar.
 *
 * Self-contained: resolves its own draft state from DraftReviewProvider
 * context, so the identity bar just mounts it and passes the documentId.
 */
import { Trans } from "@lingui/react/macro";
import { pendingReviewDraft } from "@/client/query/useWorkDrafts";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { IDENTITY_BAR_BOX_CLASS } from "@/features/project/context/identity-bar-geometry";
import { useAiDraftLauncher } from "@/features/project/dock/useAiDraftLauncher";
import { cn } from "@/lib/utils";

export type DraftReviewChipProps = {
  documentId: string;
};

export function DraftReviewChip({ documentId }: DraftReviewChipProps) {
  const { controller, groupForDocument } = useDraftReview();
  const { openAiDraft } = useAiDraftLauncher();

  // Don't show during inline review — the review header handles that state.
  if (controller.inlineReview?.documentId === documentId) return null;

  const group = groupForDocument(documentId);
  if (!group) return null;
  const draft = pendingReviewDraft(group);
  if (!draft) return null;

  return (
    <button
      type="button"
      data-draft-review-chip
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
        "focus-ring inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-primary/30 bg-primary/10 px-1.5 font-sans text-xs font-medium text-jade-text motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150",
        IDENTITY_BAR_BOX_CLASS,
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-primary" />
      <Trans>Review draft</Trans>
    </button>
  );
}
