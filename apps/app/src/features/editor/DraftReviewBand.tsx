/**
 * DraftReviewBand — a document's review controls, as part of the identity row
 * (`DocumentIdentityBar`) rather than a header of their own: the Draft chip with
 * its menu right after the breadcrumb, then, on the right, the stepper, Show
 * changes, Discard draft and Apply draft (the per-change bar's Discard and
 * Apply act on one change; these name their scope). Everything is sized to the row's 22px box, so
 * entering or leaving review moves nothing below it.
 *
 * The list button, left of the stepper, opens this document's own change list
 * (`DocumentChanges`) in a popover under the row, independent of marks
 * visibility. Focusing a row closes it; dispositions leave it open until the
 * last change is handled. Completion stays in the identity row.
 *
 * Collapse priority and invisible phone hit boxes belong to the identity row.
 *
 * Refusals the review holds are not here: they need a line of their own and
 * sit under the row (`DraftReviewFailureNotices`).
 */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Check, Eye, EyeOff, List, Loader2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";
import { PaintCapture } from "@/components/app/PaintHold";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { changeListLabel, DocumentChanges } from "@/features/draft-review/DocumentChanges";
import { DraftSwitcher } from "@/features/draft-review/DraftSwitcher";
import {
  ReviewFailureNotices,
  ReviewStateInline,
} from "@/features/draft-review/ReviewHeaderNotices";
import { ReviewStepper } from "@/features/draft-review/ReviewStepper";
import {
  type ReviewHeaderModel,
  useReviewFailures,
  useReviewHeader,
} from "@/features/draft-review/useReviewHeader";
import { cn } from "@/lib/utils";

export type DraftReviewBandProps = {
  documentId: string;
  draftId: string;
  /** Set for a draft-only document: closes its tab instead of returning to live. */
  onCloseDraftOnly?: () => void;
  /** Opens another draft of the Work in review (the editor's launcher). */
  onOpenDraft: (row: ReviewFileTarget) => void;
  /** Opens the identity row's rename field; absent when the document cannot be renamed. */
  onRename?: () => void;
};

/** Children of the identity row's flex band: the chip, a spacer, the controls. */
export function DraftReviewBand(props: DraftReviewBandProps) {
  const header = useReviewHeader(props);
  const { controller, view, locked, finished } = header;
  const { status } = view;
  const count = view.items.length;
  const listed = view.status === "ready" && count > 0;

  return (
    <>
      <PaintCapture surface={status} state={status === "loading" ? "pending" : "painted"} />
      <DraftSwitcher
        draftOnly={header.draftOnly}
        disabled={locked}
        onShowLive={header.showLive}
        onRename={props.onRename}
      />
      <span className="identity-spacer min-w-0 flex-1" />
      <span
        className="flex shrink-0 items-center gap-1.5 font-sans text-xs"
        data-draft-review-controls
      >
        <ChangeListPopover header={header} />
        {listed ? (
          <>
            <ReviewStepper
              compact
              count={count}
              focusedIndex={view.focusedIndex}
              disabled={false}
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
              className="identity-discard h-5.5"
              aria-label={t`Discard draft`}
              disabled={locked}
              onClick={header.discardDraft}
            >
              <Trash2 aria-hidden className="identity-command-icon hidden size-3.5" />
              <span className="identity-command-label">
                <Trans>Discard draft</Trans>
              </span>
              <span className="identity-command-short hidden">
                <Trans>Discard</Trans>
              </span>
            </Button>
            <Button
              size="xs"
              className="identity-apply h-5.5"
              aria-label={t`Apply draft`}
              disabled={locked || !controller.canApplyReviewedDraft}
              onClick={header.applyDraft}
            >
              {controller.isApplying ? (
                <Loader2 className="size-3 animate-spin" aria-hidden />
              ) : null}
              {controller.isApplying ? null : (
                <Check aria-hidden className="identity-command-icon hidden size-3.5" />
              )}
              <span className="identity-command-label">
                <Trans>Apply draft</Trans>
              </span>
              <span className="identity-command-short hidden">
                <Trans>Apply</Trans>
              </span>
            </Button>
          </>
        )}
      </span>
    </>
  );
}

/**
 * This document's change list, under the row: its changes, or the state line
 * that stands in for them, then the way to the Work's other drafts. An icon
 * that never gives up its place in a narrow row.
 */
function ChangeListPopover({ header }: { header: ReviewHeaderModel }) {
  const [open, setOpen] = useState(false);
  const { view } = header;
  useEffect(() => {
    if (view.finished || view.completing) setOpen(false);
  }, [view.finished, view.completing]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton
          disabled={view.finished || !!view.completing}
          tooltip={changeListLabel(view.items.length)}
          className="size-5.5 data-[state=open]:bg-sidebar-accent data-[state=open]:text-foreground"
        >
          <List aria-hidden className="size-3.5" />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        data-draft-change-list
        className="flex max-h-[min(28rem,70svh)] w-96 max-w-[calc(100vw-2rem)] flex-col p-0"
      >
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
          <DocumentChanges view={view} onFocused={() => setOpen(false)} />
        </div>
      </PopoverContent>
    </Popover>
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
            "focus-ring inline-flex h-5.5 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs transition-colors hover:bg-sidebar-accent hover:text-foreground",
            visible ? "text-jade-text" : "text-muted-foreground",
          )}
        >
          <Icon aria-hidden className="size-3.5" />
          <span className="identity-show-label">
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
  onOpenDraft: (row: ReviewFileTarget) => void;
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
