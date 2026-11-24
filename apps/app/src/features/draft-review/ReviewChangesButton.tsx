import { Plural, Trans } from "@lingui/react/macro";
import { X } from "lucide-react";
import type { OpenDocument } from "@/client/stores";
import { Button } from "@/components/ui/button";
import { useItemLauncher } from "@/features/project/review-launch";
import { useDraftPage, useReviewMode, useReviewRows } from "./review-mode";

/**
 * `Review N changes` on a plain draft page: the one door from the page into Review changes on
 * this chapter, at its first change; in Review changes it is Close, in the same place, so the
 * writer goes in and out without moving the pointer. The count is the editor's, so a write that
 * lands while the writer types changes only this number.
 */
export function ReviewChangesButton({ document }: { document: OpenDocument }) {
  const page = useDraftPage();
  const mode = useReviewMode();
  const rows = useReviewRows();
  const { openReview } = useItemLauncher();
  if (mode)
    return (
      <Button type="button" size="sm" variant="quiet" onClick={mode.close}>
        <X aria-hidden />
        <Trans>Close</Trans>
      </Button>
    );
  if (!page || !rows?.length || document.kind !== "tracked") return null;
  return (
    <Button
      type="button"
      size="sm"
      variant="quiet"
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
