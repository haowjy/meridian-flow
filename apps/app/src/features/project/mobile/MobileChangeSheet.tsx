/**
 * MobileChangeSheet — the change list on a phone: a sheet that rises over the
 * manuscript, dimmed behind it. It is the dock's Changes tab in touch form
 * (`ReviewFiles`): every draft file in the one file order, the open file
 * expanded in place to its changes or the state that stands in for them
 * (`OpenFileChanges`: the same one the dock shows), and the Work's Apply all
 * and Discard all. It opens whatever the open file's change count is, so a
 * formatting-only or just-finished file still reaches the other drafts.
 * Tapping a change closes the sheet and takes the writer to it; tapping another file opens that file's review; Apply and
 * Discard act on the row and leave the sheet open, so a run of decisions can be
 * made in one place.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { X } from "lucide-react";

import { PhoneIconButton } from "@/components/ui/phone-icon-button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import {
  type ReviewFile,
  ReviewFiles,
  type ReviewFilesBatch,
} from "@/features/draft-review/ReviewFiles";
import { ReviewToast } from "@/features/draft-review/ReviewToast";
import type { ReviewFileTarget } from "@/features/draft-review/review-files";
import type { DraftReviewController } from "@/features/draft-review/useDraftReviewController";
import type { ReviewChangesView } from "@/features/draft-review/useReviewChanges";
import { OpenFileChanges } from "../dock/OpenFileChanges";

export function MobileChangeSheet({
  open,
  onOpenChange,
  view,
  files,
  batch,
  next,
  onOpenNext,
  controller,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: ReviewChangesView;
  files: readonly ReviewFile[];
  batch: ReviewFilesBatch;
  /** The draft after the open one, offered when the open file is finished. */
  next: ReviewFileTarget | null;
  onOpenNext: (row: ReviewFileTarget) => void;
  controller: Pick<DraftReviewController, "toast" | "dismissToast" | "exitInlineReview">;
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
        <div className="min-h-0 overflow-y-auto overscroll-contain px-2 pb-2">
          <ReviewFiles
            touch
            batch={batch}
            files={files.map((file) => ({
              ...file,
              onOpen: () => {
                onOpenChange(false);
                file.onOpen();
              },
            }))}
          >
            <OpenFileChanges
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
          </ReviewFiles>
        </div>
        {/* The scrim sits over the manuscript's own toast: this one rides the sheet's top edge, undimmed. */}
        <ReviewToast
          toast={controller.toast}
          onDismiss={controller.dismissToast}
          className="bottom-full mb-3"
        />
      </SheetContent>
    </Sheet>
  );
}
