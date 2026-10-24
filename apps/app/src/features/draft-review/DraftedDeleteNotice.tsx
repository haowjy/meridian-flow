/** DraftedDeleteNotice — the document-level disposition for an open drafted delete. */
import { Trans } from "@lingui/react/macro";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDraftReview } from "./DraftReviewProvider";
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
      <div
        role="status"
        className="flex min-w-0 items-center gap-3 rounded-lg border border-border-subtle bg-card py-1.5 pr-1.5 pl-3 text-sm"
      >
        <Trash2 aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 text-muted-foreground">
          <Trans>Deleted in this draft</Trans>
        </p>
        <Button
          type="button"
          size="sm"
          variant="quiet"
          disabled={view.locked}
          onClick={() => void view.discard(deletion)}
          className="shrink-0 [@media(pointer:coarse)]:min-h-11"
        >
          <Trans>Discard</Trans>
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={view.locked}
          onClick={() => void view.apply(deletion)}
          className="shrink-0 [@media(pointer:coarse)]:min-h-11"
        >
          <Trans>Apply</Trans>
        </Button>
      </div>
    </div>
  );
}
