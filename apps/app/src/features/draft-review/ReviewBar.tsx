/**
 * Review changes' bar (design §6, item 3): what the draft is compared against, Inline or Side by
 * side, the stepper, the chapter's Discard · Apply, and Close. The stepper walks this chapter's
 * changes, then the draft's next changed chapter in the Changes list's order, wrapping at the
 * ends; only it crosses chapters, and it replaces the review's history entry as it does.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Columns2, X } from "lucide-react";
import { useOwnerDrafts } from "@/client/query/useOwnerDrafts";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { useItemLauncher } from "@/features/project/review-launch";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { useOptionalDraftReview } from "./DraftReviewProvider";
import { ReviewActions } from "./ReviewActions";
import { ReviewStepper } from "./ReviewStepper";
import { setReviewLayout, useReviewLayout, useReviewMode, useReviewRows } from "./review-mode";

export function ReviewBar() {
  const mode = useReviewMode();
  const review = useOptionalDraftReview();
  const layout = useReviewLayout();
  const rows = useReviewRows(mode?.documentId ?? "") ?? [];
  const files = useOwnerDrafts(mode?.projectId ?? null, mode?.draftId ?? null).files ?? [];
  const { openReview } = useItemLauncher();
  const touch = useCoarsePointer();
  if (!mode || !review) return null;
  const focused = rows.findIndex((row) => row.id === mode.changeId);
  const locked = review.controller.dispositionLocked;
  const ref = { documentId: mode.documentId, itemKey: mode.itemKey };

  const step = (direction: 1 | -1) => {
    const next = focused + direction;
    if (next >= 0 && next < rows.length) return mode.focus(rows[next].id);
    // Past this chapter's last change: the draft's next changed chapter, wrapping.
    const changed = files.filter((file) => file.item.pending && file.contextLocation);
    const here = changed.findIndex((file) => file.documentId === mode.documentId);
    const file = changed.at((here + direction + changed.length) % changed.length);
    if (!file?.contextLocation || file.documentId === mode.documentId) {
      if (rows.length > 0) mode.focus(rows[direction === 1 ? 0 : rows.length - 1].id);
      return;
    }
    openReview({
      draftId: mode.draftId,
      documentId: file.documentId,
      itemKey: file.item.itemKey,
      contextLocation: file.contextLocation,
      documentName: file.documentName ?? undefined,
      draftOnly: file.draftOnly,
      replace: true,
    });
  };
  const pressChapter = (verdict: "apply" | "discard") => {
    mode.close();
    void review.controller.startItem(verdict, ref).outcome;
  };

  return (
    <div data-review-bar className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-xs text-muted-foreground">
        <Trans>against Live</Trans>
      </span>
      <IconButton
        size="xs"
        variant="quiet"
        label={layout === "side" ? t`Show inline` : t`Show side by side`}
        aria-pressed={layout === "side"}
        className="review-layout-toggle"
        onClick={() => setReviewLayout(layout === "side" ? "inline" : "side")}
      >
        <Columns2 aria-hidden />
      </IconButton>
      <span className="flex-1" />
      <ReviewStepper
        count={rows.length}
        crosses={files.filter((file) => file.item.pending).length > 1}
        focusedIndex={focused}
        disabled={rows.length === 0}
        onStep={step}
        compact
        touch={touch}
      />
      <ReviewActions
        scope="document"
        density="icon"
        touch={touch}
        disabled={locked}
        onDiscard={() => pressChapter("discard")}
        onApply={() => pressChapter("apply")}
      />
      <Button type="button" size="sm" variant="quiet" onClick={mode.close}>
        <X aria-hidden />
        <Trans>Close</Trans>
      </Button>
    </div>
  );
}
