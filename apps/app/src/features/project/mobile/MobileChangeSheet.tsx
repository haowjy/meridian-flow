/**
 * MobileChangeSheet — the change list on a phone: a sheet that rises over the
 * manuscript, dimmed behind it. The rows are the desktop dock's rows
 * (`ReviewChangeRow`) in their touch form. Tapping a row closes the sheet and
 * takes the writer to that change; Apply and Discard act on the row and leave
 * the sheet open, so a run of decisions can be made in one place.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { X } from "lucide-react";
import { useMemo } from "react";

import { PhoneIconButton } from "@/components/ui/phone-icon-button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import type { DraftReviewController } from "@/features/chat/useDraftReviewController";
import { ReviewChangeRow } from "@/features/draft-review/ReviewChangeRow";
import { ReviewToast } from "@/features/draft-review/ReviewToast";
import { useArrivedChanges } from "@/features/draft-review/useArrivedChanges";
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
  controller: Pick<DraftReviewController, "toast" | "dismissToast">;
}) {
  const changes = useMemo(() => view.items.map((item) => item.change), [view.items]);
  const arrived = useArrivedChanges(
    changes,
    view.status === "ready",
    view.documentId && view.draftId ? `${view.documentId}:${view.draftId}` : null,
  );
  const count = view.items.length;
  return (
    <Sheet open={open && count > 0} onOpenChange={onOpenChange}>
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
            <Trans>Changes</Trans>{" "}
            <span className="font-normal text-muted-foreground tabular-nums">{count}</span>
          </SheetTitle>
          <PhoneIconButton aria-label={t`Close the list`} onClick={() => onOpenChange(false)}>
            <X className="size-5" aria-hidden />
          </PhoneIconButton>
        </div>
        <SheetDescription className="sr-only">
          <Trans>Tap a change to go to it in the manuscript.</Trans>
        </SheetDescription>
        <ul className="flex min-h-0 flex-col gap-0.5 overflow-y-auto overscroll-contain px-2 pb-2">
          {view.items.map(({ change, failure }) => (
            <ReviewChangeRow
              key={change.classId}
              touch
              change={change}
              focused={view.focused?.classId === change.classId}
              arrived={arrived.has(change.classId)}
              disabled={view.locked}
              canApply={view.canApply}
              failure={failure}
              onFocus={() => {
                onOpenChange(false);
                view.focus(change, { scroll: true });
              }}
              onApply={() => void view.apply(change)}
              onDiscard={() => void view.discard(change)}
            />
          ))}
        </ul>
        {/* The scrim sits over the manuscript's own toast; this one is seen. */}
        <ReviewToast
          toast={controller.toast}
          onDismiss={controller.dismissToast}
          className="bottom-[calc(env(safe-area-inset-bottom)+1rem)]"
        />
      </SheetContent>
    </Sheet>
  );
}
