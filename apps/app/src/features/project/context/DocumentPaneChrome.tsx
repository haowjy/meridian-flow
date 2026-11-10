/**
 * DocumentPaneChrome — what sits above an open document's editor: the passage
 * notice, the frozen-document notice (an archived Work, a trashed chat), a failed
 * review command, and the document's properties. The Editor's page and the dock's
 * document stack the same chrome. The document's identity and state are elsewhere:
 * in Write mode at the end of the toolbar row, in the dock in its header (the Live
 * menu lists other owners' drafts).
 */
import type { ContextTab } from "@/client/stores";
import { DraftedDeleteNotice } from "@/features/draft-review/DraftedDeleteNotice";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { DraftReviewFailureNotices } from "@/features/editor/DraftReviewBand";
import { PassageNotice } from "@/features/editor/PassageNotice";
import { useAiDraftLauncher } from "../review-launch";
import { DocumentFreezeNotice } from "./DocumentFreezeNotice";
import { DocumentProperties } from "./DocumentProperties";
import type { DocumentFreeze } from "./use-document-freeze";

export type DocumentPaneChromeProps = {
  projectId: string;
  tab: ContextTab;
  /** Set when the document as shown is frozen: by its archived Work, or a trashed chat. */
  freeze: DocumentFreeze | null;
  /**
   * Write mode: show a failed review command here (the dock's header shows its
   * own).
   */
  reviewNotices: boolean;
};

export function DocumentPaneChrome({
  projectId,
  tab,
  freeze,
  reviewNotices,
}: DocumentPaneChromeProps) {
  return (
    <>
      {/* A jump that could not find its passage says so here, over the page
          rather than in the layout. */}
      <PassageNotice documentId={tab.documentId} />
      {freeze ? (
        <DocumentFreezeNotice projectId={projectId} freeze={freeze} className="px-4 pt-3" />
      ) : null}
      {reviewNotices ? <ReviewFailureNotices tab={tab} /> : null}
      <DocumentProperties projectId={projectId} tab={tab} />
      <DraftedDeleteNotice documentId={tab.documentId} />
    </>
  );
}

function ReviewFailureNotices({ tab }: { tab: ContextTab }) {
  const { controller } = useDraftReview();
  const { openReviewFile } = useAiDraftLauncher();
  const review = controller.inlineReview;
  if (review?.documentId !== tab.documentId || !review.shown) return null;
  return (
    <DraftReviewFailureNotices
      documentId={tab.documentId}
      itemKey={review.itemKey}
      onOpenDraft={(row) => openReviewFile(row, controller.ownerKey)}
    />
  );
}
