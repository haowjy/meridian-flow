import { Plural } from "@lingui/react/macro";
import type { OpenDocument } from "@/client/stores";
import { Button } from "@/components/ui/button";
import { useItemLauncher } from "@/features/project/review-launch";
import { useDraftPage, useReviewMode, useReviewRows } from "./review-mode";

/**
 * `Review N changes` on a plain draft page: the one door from the page into Review changes on
 * this chapter, at its first change. The count is the editor's, so a write that lands while the
 * writer types changes only this number.
 */
export function ReviewChangesButton({ document }: { document: OpenDocument }) {
  const page = useDraftPage();
  const mode = useReviewMode();
  const rows = useReviewRows(page?.documentId ?? "");
  const { openReview } = useItemLauncher();
  if (!page || mode || !rows?.length || document.kind !== "tracked") return null;
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      onClick={() =>
        openReview({
          draftId: page.draftId,
          documentId: page.documentId,
          itemKey: page.itemKey,
          contextLocation: { scheme: document.scheme, path: document.path },
          documentName: document.name,
        })
      }
    >
      <Plural value={rows.length} one="Review # change" other="Review # changes" />
    </Button>
  );
}
