/**
 * DraftReviewHeader — the editor's chrome while a document is under inline
 * review, in one row: `Manuscript /`, the draft switcher, the stepper, Show
 * changes, Discard draft and Apply draft. Above the identity bar, review-only.
 *
 * Apply draft and Discard draft move straight to the next draft in the
 * switcher, or back to live when none is left. The model is shared with the
 * phone header (`useReviewHeader`); this is the desktop layout.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Loader2 } from "lucide-react";
import { useId } from "react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { DockRow } from "@/features/chat/docked-drafts";
import { DraftSwitcher } from "@/features/draft-review/DraftSwitcher";
import { ReviewHeaderNotices } from "@/features/draft-review/ReviewHeaderNotices";
import { ReviewStepper } from "@/features/draft-review/ReviewStepper";
import { useReviewHeader } from "@/features/draft-review/useReviewHeader";

export type DraftReviewHeaderProps = {
  documentId: string;
  draftId: string;
  /** Set for a draft-only document: closes its tab instead of returning to live. */
  onCloseDraftOnly?: () => void;
  /** Opens another draft of the Work in review (the editor's launcher). */
  onOpenDraft: (row: DockRow) => void;
};

export function DraftReviewHeader(props: DraftReviewHeaderProps) {
  const header = useReviewHeader(props);
  const { controller, view, locked, finished } = header;
  const marksId = useId();
  const count = view.items.length;

  return (
    <section
      className="flex shrink-0 flex-col border-border border-b bg-dock-surface text-caption"
      aria-label={t`Draft review`}
      data-draft-review-header
    >
      <div className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 px-4 py-1">
        <span className="shrink-0 text-muted-foreground">
          <Trans>Manuscript /</Trans>
        </span>
        <DraftSwitcher {...header.switcher} />
        <span className="flex-1" />
        {view.status === "ready" && count > 0 ? (
          <>
            <ReviewStepper
              count={count}
              focusedIndex={view.focusedIndex}
              disabled={!controller.marksVisible}
              onStep={view.step}
            />
            <label
              htmlFor={marksId}
              className="inline-flex cursor-pointer items-center gap-1.5 text-muted-foreground select-none"
            >
              <Switch
                id={marksId}
                checked={controller.marksVisible}
                onCheckedChange={controller.setMarksVisible}
                aria-label={t`Show changes`}
                className="h-4 w-7 [&>span]:size-3 [&>span[data-state=checked]]:translate-x-3"
              />
              <Trans>Show changes</Trans>
            </label>
          </>
        ) : null}
        {finished ? null : (
          <>
            <Button variant="quiet" size="xs" disabled={locked} onClick={header.discardDraft}>
              <Trans>Discard draft</Trans>
            </Button>
            <Button
              size="xs"
              disabled={locked || !controller.canApplyReviewedDraft}
              onClick={header.applyDraft}
            >
              {controller.isApplying ? (
                <Loader2 className="size-3 animate-spin" aria-hidden />
              ) : null}
              <Trans>Apply draft</Trans>
            </Button>
          </>
        )}
      </div>
      <ReviewHeaderNotices
        commandError={header.commandError}
        finished={finished}
        next={header.next}
        draftOnly={header.switcher.draftOnly}
        onOpenNext={header.switcher.onOpenDraft}
        onShowLive={header.showLive}
      />
    </section>
  );
}
