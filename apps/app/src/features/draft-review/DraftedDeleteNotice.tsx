/** DraftedDeleteNotice — the document-level disposition for an open drafted delete. */
import { Trans } from "@lingui/react/macro";
import { Trash2 } from "lucide-react";
import { DocumentNotice } from "@/components/app/DocumentNotice";
import { useDraftReview } from "./DraftReviewProvider";
import { ReviewActions } from "./ReviewActions";
import { useReviewChanges } from "./useReviewChanges";

export function DraftedDeleteNotice({ documentId }: { documentId: string }) {
  const { controller } = useDraftReview();
  const review = controller.inlineReview;
  const itemKey = review?.documentId === documentId ? review.itemKey : "";
  const view = useReviewChanges(controller, { enabled: Boolean(itemKey) });
  const deletion = view.items.find(({ change }) => change.tree?.kind === "delete")?.change;
  if (!deletion) return null;

  return (
    <div className="px-4 pt-3" data-drafted-delete-notice>
      <DocumentNotice
        icon={<Trash2 aria-hidden className="size-4" />}
        action={
          <ReviewActions
            scope="change"
            disabled={view.locked}
            discardAsks
            onDiscard={() => void view.discard(deletion)}
            onApply={() => void view.apply(deletion)}
          />
        }
      >
        <Trans>Deleted in this draft</Trans>
      </DocumentNotice>
    </div>
  );
}
