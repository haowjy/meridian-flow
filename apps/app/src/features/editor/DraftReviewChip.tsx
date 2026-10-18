/**
 * DraftReviewChip — the live document's version chip when it has a pending
 * draft: "Live" with the same version menu the review shows (`DraftSwitcher`),
 * where picking Branch opens the review. On the identity row (desktop) and under
 * the phone's top bar; once the review paints, the caller swaps in the
 * reviewing chip in the same frame.
 *
 * Self-contained: resolves its own draft state from DraftReviewProvider
 * context, so a host just mounts it with the documentId. Renders nothing when
 * the document has no pending draft.
 */
import {
  branchCommandFailure,
  useBranchCommandRecords,
} from "@/client/query/branch-command-record";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { DraftSwitcher } from "@/features/draft-review/DraftSwitcher";
import { useAiDraftLauncher } from "@/features/project/dock/useAiDraftLauncher";

export type DraftReviewChipProps = {
  documentId: string;
  /** A phone's chip: a 44px target around the pill. */
  touch?: boolean;
};

export function DraftReviewChip({ documentId, touch = false }: DraftReviewChipProps) {
  const { controller, fileForDocument } = useDraftReview();
  const { openReviewFile } = useAiDraftLauncher();
  const commandRecords = useBranchCommandRecords();

  const group = fileForDocument(documentId);
  if (!group) return null;
  const draft = group.draft;
  // A launch that failed shows on the chip itself; clicking it again retries.
  const failed =
    branchCommandFailure(commandRecords, {
      projectId: controller.projectId,
      workId: controller.workId,
      documentId,
      itemKey: draft.itemKey,
    })?.code === "review-failed";

  return (
    <DraftSwitcher
      showing="live"
      draftOnly={false}
      disabled={controller.isDisposing}
      failed={failed}
      touch={touch}
      onShowLive={() => undefined}
      onShowDraft={() => openReviewFile(group, controller.workId)}
    />
  );
}
