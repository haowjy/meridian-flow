/** The phone's document change list. Focusing a row closes it; dispositions keep it open until the last change. Failures remain addressed to their row. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useEffect } from "react";

import { PhoneSheet } from "@/components/ui/phone-shell";
import { DocumentChanges } from "@/features/draft-review/DocumentChanges";
import { ReviewToast } from "@/features/draft-review/ReviewToast";
import type { DraftReviewController } from "@/features/draft-review/useDraftReviewController";
import type { ReviewChangesView } from "@/features/draft-review/useReviewChanges";

export function MobileChangeSheet({
  open,
  onOpenChange,
  view,
  controller,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: ReviewChangesView;
  controller: Pick<
    DraftReviewController,
    "projectId" | "ownerKey" | "toast" | "dismissToast" | "exitInlineReview"
  >;
}) {
  useEffect(() => {
    if (open && view.finished) onOpenChange(false);
  }, [open, view.finished, onOpenChange]);
  return (
    <PhoneSheet
      open={open}
      onOpenChange={onOpenChange}
      title={<Trans>Changes</Trans>}
      description={<Trans>Tap a change to go to it in the manuscript.</Trans>}
      closeLabel={t`Close the list`}
      data-phone-change-sheet
    >
      <ReviewToast
        toast={controller.toast}
        onDismiss={controller.dismissToast}
        className="static mx-auto mb-2 shrink-0 translate-x-0"
      />
      <div className="min-h-0 overflow-y-auto overscroll-contain px-2 pb-2">
        <DocumentChanges touch view={view} onFocused={() => onOpenChange(false)} />
      </div>
    </PhoneSheet>
  );
}
