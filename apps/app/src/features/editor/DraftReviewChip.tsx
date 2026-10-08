/**
 * DraftReviewChip — the live document's entry into its pending draft: "Review
 * draft", on the identity row (desktop) and under the phone's top bar. It is the
 * pending state of the Draft chip (`DraftChip`); once the review paints, the
 * caller swaps it for the reviewing state (`DraftSwitcher`) in the same frame.
 *
 * Self-contained: resolves its own draft state from DraftReviewProvider
 * context, so a host just mounts it with the documentId. Renders nothing when
 * the document has no pending draft.
 */
import { Trans } from "@lingui/react/macro";
import { draftCommandFailure, useDraftCommandRecords } from "@/client/query/draft-command-record";
import { pendingReviewDraft } from "@/client/query/useWorkDrafts";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { ReviewMessageText } from "@/features/chat/ReviewMessageText";
import { DraftChipFace, draftChipHitClass } from "@/features/draft-review/DraftChip";
import { useAiDraftLauncher } from "@/features/project/dock/useAiDraftLauncher";
import { cn } from "@/lib/utils";

export type DraftReviewChipProps = {
  documentId: string;
  /** A phone's chip: a 44px target around the pill. */
  touch?: boolean;
};

export function DraftReviewChip({ documentId, touch = false }: DraftReviewChipProps) {
  const { controller, groupForDocument } = useDraftReview();
  const { openAiDraft } = useAiDraftLauncher();
  const commandRecords = useDraftCommandRecords();

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
    })?.code === "review-failed";

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
        draftChipHitClass(touch),
        "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150 disabled:opacity-50",
      )}
    >
      <DraftChipFace state={failed ? "failed" : "pending"} touch={touch}>
        {failed ? (
          <ReviewMessageText failure={{ code: "review-failed" }} />
        ) : (
          <Trans>Review draft</Trans>
        )}
      </DraftChipFace>
    </button>
  );
}
