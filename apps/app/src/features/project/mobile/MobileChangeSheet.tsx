/**
 * MobileChangeSheet — this document's change list on a phone: a sheet that
 * rises over the manuscript, dimmed behind it. It is the same list the desktop
 * identity row opens (`DocumentChanges`: the changes, or the state that stands
 * in for them, such as Applying, formatting-only or No changes left with the
 * way on), with "All changes in <Work>" at its foot for the Work's other drafts.
 * It opens whatever the change count is, so a formatting-only or just-finished
 * draft still reaches that link. Tapping a change closes the sheet and takes the
 * writer to it; Apply and Discard act on the row and leave the sheet open, so a
 * run of decisions can be made in one place.
 */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { X } from "lucide-react";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";

import { PhoneIconButton } from "@/components/ui/phone-icon-button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { DocumentChanges } from "@/features/draft-review/DocumentChanges";
import { ReviewToast } from "@/features/draft-review/ReviewToast";
import type { DraftReviewController } from "@/features/draft-review/useDraftReviewController";
import type { ReviewChangesView } from "@/features/draft-review/useReviewChanges";
import { WorkChangesLink } from "@/features/draft-review/WorkChangesLink";

export function MobileChangeSheet({
  open,
  onOpenChange,
  view,
  next,
  onOpenNext,
  controller,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: ReviewChangesView;
  /** The draft after the open one, offered when this one is finished. */
  next: ReviewFileTarget | null;
  onOpenNext: (row: ReviewFileTarget) => void;
  controller: Pick<
    DraftReviewController,
    "projectId" | "workId" | "toast" | "dismissToast" | "exitInlineReview"
  >;
}) {
  const count = view.items.length;
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
            {count > 0 ? (
              <span className="ml-1 font-normal text-muted-foreground tabular-nums">{count}</span>
            ) : null}
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
          <DocumentChanges
            touch
            view={view}
            controller={controller}
            onFocused={() => onOpenChange(false)}
            next={next}
            onOpenNext={(row) => {
              onOpenChange(false);
              onOpenNext(row);
            }}
          />
          <WorkChangesLink
            touch
            projectId={controller.projectId}
            workId={controller.workId}
            onOpen={() => onOpenChange(false)}
            className="mt-1 rounded-none border-t border-border-subtle"
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
