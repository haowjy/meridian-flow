/** The phone's document change list. Focusing a row closes it; dispositions keep it open until the last change. Failures remain addressed to their row. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { X } from "lucide-react";
import { useEffect } from "react";

import { PhoneIconButton } from "@/components/ui/phone-icon-button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
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
    "projectId" | "workId" | "toast" | "dismissToast" | "exitInlineReview"
  >;
}) {
  useEffect(() => {
    if (open && view.finished) onOpenChange(false);
  }, [open, view.finished, onOpenChange]);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        data-phone-change-sheet
        className="max-h-[78svh] gap-0 rounded-t-2xl border-border-subtle p-0"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-border" />
        <div className="flex shrink-0 items-center gap-2 pl-4 pr-1">
          <SheetTitle className="min-w-0 flex-1 truncate text-sm">
            <Trans>Changes</Trans>
          </SheetTitle>
          <PhoneIconButton aria-label={t`Close the list`} onClick={() => onOpenChange(false)}>
            <X className="size-5" aria-hidden />
          </PhoneIconButton>
        </div>
        <SheetDescription className="sr-only">
          <Trans>Tap a change to go to it in the manuscript.</Trans>
        </SheetDescription>
        <ReviewToast
          toast={controller.toast}
          onDismiss={controller.dismissToast}
          className="static mx-auto mb-2 shrink-0 translate-x-0"
        />
        <div className="min-h-0 overflow-y-auto overscroll-contain px-2 pb-2">
          <DocumentChanges touch view={view} onFocused={() => onOpenChange(false)} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
