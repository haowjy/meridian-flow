/**
 * DraftReviewBand — a document's review controls, as part of the identity row
 * (`DocumentIdentityBar`) rather than a header of their own: the Draft chip with
 * its menu right after the breadcrumb, then, on the right, the stepper, Show
 * changes, Discard and Apply. Everything is sized to the row's 22px box, so
 * entering or leaving review moves nothing below it.
 *
 * Narrow rows give up room in a fixed order, always on one row (the container
 * is the identity bar's own `@container`, so a closed sidebar or open dock
 * counts): the breadcrumb's middle folders become `…` (in `IdentityPath`),
 * "Show changes" becomes an icon toggle with the same name, `4 of 4` becomes
 * `4/4`, and the file name truncates. The Draft chip, Discard and Apply never
 * hide. Apply draft and Discard draft move straight to the next draft in the
 * menu, or back to live when none is left; the model is shared with the phone
 * header (`useReviewHeader`).
 *
 * Refusals the review holds are not here: they need a line of their own and
 * sit under the row (`DraftReviewFailureNotices`).
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Eye, EyeOff, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { DockRow } from "@/features/chat/docked-drafts";
import { DraftSwitcher } from "@/features/draft-review/DraftSwitcher";
import {
  ReviewFailureNotices,
  ReviewStateInline,
} from "@/features/draft-review/ReviewHeaderNotices";
import { ReviewStepper } from "@/features/draft-review/ReviewStepper";
import { useReviewFailures, useReviewHeader } from "@/features/draft-review/useReviewHeader";
import { cn } from "@/lib/utils";

export type DraftReviewBandProps = {
  documentId: string;
  draftId: string;
  /** Set for a draft-only document: closes its tab instead of returning to live. */
  onCloseDraftOnly?: () => void;
  /** Opens another draft of the Work in review (the editor's launcher). */
  onOpenDraft: (row: DockRow) => void;
  /** Opens the identity row's rename field; absent when the document cannot be renamed. */
  onRename?: () => void;
};

/** Children of the identity row's flex band: the chip, a spacer, the controls. */
export function DraftReviewBand(props: DraftReviewBandProps) {
  const header = useReviewHeader(props);
  const { controller, view, locked, finished } = header;
  const count = view.items.length;
  const listed = view.status === "ready" && count > 0;

  return (
    <>
      <DraftSwitcher
        draftOnly={header.draftOnly}
        disabled={locked}
        onShowLive={header.showLive}
        onRename={props.onRename}
      />
      <span className="min-w-1 flex-1" />
      <span
        className="flex shrink-0 items-center gap-1.5 font-sans text-xs"
        data-draft-review-controls
      >
        {listed ? (
          <>
            <ReviewStepper
              compact
              count={count}
              focusedIndex={view.focusedIndex}
              disabled={!controller.marksVisible}
              onStep={view.step}
            />
            <ShowChangesToggle
              visible={controller.marksVisible}
              onChange={controller.setMarksVisible}
            />
          </>
        ) : null}
        <ReviewStateInline
          finished={finished}
          unlisted={header.unlisted}
          completing={header.completing}
          next={header.next}
          draftOnly={header.draftOnly}
          onOpenNext={header.openDraft}
          onShowLive={header.showLive}
        />
        {finished ? null : (
          <>
            <Button
              variant="quiet"
              size="xs"
              className="h-5.5"
              aria-label={t`Discard draft`}
              disabled={locked}
              onClick={header.discardDraft}
            >
              <Trans>Discard</Trans>
            </Button>
            <Button
              size="xs"
              className="h-5.5"
              aria-label={t`Apply draft`}
              disabled={locked || !controller.canApplyReviewedDraft}
              onClick={header.applyDraft}
            >
              {controller.isApplying ? (
                <Loader2 className="size-3 animate-spin" aria-hidden />
              ) : null}
              <Trans>Apply</Trans>
            </Button>
          </>
        )}
      </span>
    </>
  );
}

/**
 * Show changes: an eye and its name in a wide row, the eye alone (named by
 * tooltip and `aria-label`) in a narrow one. One switch either way, so the
 * accessible name and state never depend on the width.
 */
function ShowChangesToggle({
  visible,
  onChange,
}: {
  visible: boolean;
  onChange: (visible: boolean) => void;
}) {
  const Icon = visible ? Eye : EyeOff;
  const name = t`Show changes`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          role="switch"
          aria-checked={visible}
          aria-label={name}
          onClick={() => onChange(!visible)}
          className={cn(
            "focus-ring inline-flex h-5.5 shrink-0 items-center gap-1.5 rounded-md border border-transparent px-1.5 text-xs transition-colors hover:bg-sidebar-accent hover:text-foreground",
            visible ? "text-jade-text" : "text-muted-foreground",
          )}
        >
          <Icon aria-hidden className="size-3.5" />
          <span className="@max-[44rem]:hidden">
            <Trans>Show changes</Trans>
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{name}</TooltipContent>
    </Tooltip>
  );
}

/** The refusals the review holds, as lines under the identity row; nothing when there are none. */
export function DraftReviewFailureNotices({
  documentId,
  draftId,
  onOpenDraft,
}: {
  documentId: string;
  draftId: string;
  onOpenDraft: (row: DockRow) => void;
}) {
  const { commandError, failedElsewhere } = useReviewFailures({ documentId, draftId });
  if (!commandError && failedElsewhere.length === 0) return null;
  return (
    <div className="shrink-0 text-caption" data-draft-review-notices>
      <ReviewFailureNotices
        commandError={commandError}
        failedElsewhere={failedElsewhere}
        onOpenNext={onOpenDraft}
        className="px-4"
      />
    </div>
  );
}
