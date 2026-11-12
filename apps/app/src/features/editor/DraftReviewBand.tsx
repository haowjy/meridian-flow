/**
 * DraftReviewBand — a document's review controls: the version chip
 * (`DocumentVersionMenu`), which takes the Live chip's place on the toolbar row, and the
 * controls on a line of their own above the toolbar (`DocumentIdentityBar`): the change
 * list, the stepper, Show changes, Discard draft and Apply draft (the per-change bar's
 * Discard and Apply act on one change; these name their scope).
 *
 * The list button, left of the stepper, opens this document's own change list
 * (`DocumentChanges`) in a popover under the row, independent of marks
 * visibility. Focusing a row closes it; dispositions leave it open until the
 * last change is handled. Completion stays in the identity row.
 *
 * The bar lays the two parts out (`children` receives them). Label collapse and
 * invisible phone hit boxes belong to the review line (document-identity-row.css).
 *
 * Refusals are not here. The focused change's bar carries the open draft's;
 * the rest sit under the row (`DraftReviewFailureNotices`).
 */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Eye, EyeOff, List } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import type { OpenDocument } from "@/client/stores";
import { PaintCapture, useAfterPaintRelease } from "@/components/app/PaintHold";
import { IconButton } from "@/components/ui/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { changeListLabel, DocumentChanges } from "@/features/draft-review/DocumentChanges";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { DiscardQuestion, ReviewActions } from "@/features/draft-review/ReviewActions";
import {
  ReviewFailureNotices,
  ReviewStateInline,
} from "@/features/draft-review/ReviewHeaderNotices";
import { ReviewStepper } from "@/features/draft-review/ReviewStepper";
import { useReviewChanges } from "@/features/draft-review/useReviewChanges";
import {
  type ReviewHeaderModel,
  useReviewFailures,
  useReviewHeader,
} from "@/features/draft-review/useReviewHeader";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { focusIsFree, lastInputWasKeyboard, moveFocus } from "@/lib/focus-follow";
import { cn } from "@/lib/utils";
import { DocumentVersionMenu } from "./DocumentVersionMenu";

export type DraftReviewBandProps = {
  projectId: string;
  document: OpenDocument;
  documentId: string;
  itemKey: string;
  /** Set for a draft-only document: closes its tab instead of returning to live. */
  onCloseDraftOnly?: () => void;
  /** Opens another draft of the Work in review (the editor's launcher); `takeFocus` as in `useReviewHeader`. */
  onOpenDraft: (row: ReviewFileTarget, takeFocus?: boolean) => void;
  /** Opens the identity row's rename field; absent when the document cannot be renamed. */
  onRename?: () => void;
  /** Puts the caret back in the document when the review closes under the writer's focus. */
  onFocusDocument: () => void;
  /** Opened by Apply or Next draft from the previous draft's controls: take the focus once they show. */
  focusOnOpen?: boolean;
  onOpenFocused?: () => void;
};

/**
 * The review's two parts, for the identity row to place: the version chip and
 * the controls. With an empty `itemKey` (no shown review) there are no parts,
 * but the wrapper stays mounted so the row beneath it keeps its identity when
 * a review begins or ends.
 */
export function DraftReviewBand({
  children,
  ...props
}: DraftReviewBandProps & {
  children: (parts: { version: ReactNode; controls: ReactNode }) => ReactNode;
}) {
  const controlsRef = useRef<HTMLSpanElement>(null);
  // The draft whose Apply or Discard ran with focus in the controls and opened
  // nothing: focus follows to what replaces them until the writer moves it.
  const [refocusFor, setRefocusFor] = useState<string | null>(null);
  const header = useReviewHeader({
    ...props,
    onEndedWithFocus: () => setRefocusFor(props.itemKey),
  });
  const questionRef = useRef<HTMLSpanElement>(null);
  const focusInControls = () =>
    [controlsRef, questionRef].some((ref) => ref.current?.contains(document.activeElement));
  const { controller, view, locked, finished } = header;
  const { status } = view;
  // The stepper walks the text changes; a pending move or delete is listed, not stepped to.
  const count = view.items.filter(({ change }) => !change.tree).length;
  const listed = view.status === "ready" && count > 0;
  // A finger's 44px targets leave no room for every control in a docked row, so the
  // version menu carries Show changes, and the list and stepper give way before
  // Discard and Apply do (document-identity-row.css, collapse 4).
  const coarse = useCoarsePointer();
  const { itemKey, focusOnOpen, onOpenFocused, onFocusDocument } = props;
  const afterPaintRelease = useAfterPaintRelease();
  useEffect(() => {
    if (!focusOnOpen || !controlsRef.current) return;
    onOpenFocused?.();
    // The pane may still be covered while the draft paints.
    afterPaintRelease(() => {
      // The change list button acts on nothing, unlike Apply and Discard.
      const first = controlsRef.current?.querySelector<HTMLElement>("button:not(:disabled)");
      if (first && focusIsFree()) moveFocus(first, { ring: lastInputWasKeyboard() });
    });
  }, [focusOnOpen, onOpenFocused, afterPaintRelease, itemKey]);
  // The pane may swap this band out with its tab when the review closes.
  const pending = useRef({ refocusFor, onFocusDocument });
  pending.current = { refocusFor, onFocusDocument };
  useEffect(
    () => () => {
      if (pending.current.refocusFor !== null && focusIsFree()) pending.current.onFocusDocument();
    },
    [],
  );
  useEffect(() => {
    if (refocusFor === null) return;
    const controls = controlsRef.current;
    if (!focusIsFree() && !controls?.contains(document.activeElement)) {
      setRefocusFor(null);
    } else if (!itemKey) {
      // The review closed: Back to live or the last change took the controls away.
      setRefocusFor(null);
      onFocusDocument();
    } else if (itemKey !== refocusFor) {
      setRefocusFor(null);
    } else if (finished) {
      const next = controls?.querySelector<HTMLElement>("[data-review-next]");
      if (next && next !== document.activeElement)
        moveFocus(next, { ring: lastInputWasKeyboard() });
    }
  }, [refocusFor, itemKey, finished, onFocusDocument]);
  if (!props.itemKey) return children({ version: null, controls: null });

  const version = (
    <>
      <PaintCapture surface={status} state={status === "loading" ? "pending" : "painted"} />
      <DocumentVersionMenu
        projectId={props.projectId}
        document={props.document}
        review={{
          draftOnly: header.draftOnly,
          disabled: locked,
          onShowLive: header.showLive,
          onRename: props.onRename,
          marks:
            coarse && listed
              ? { visible: controller.marksVisible, onChange: controller.setMarksVisible }
              : undefined,
        }}
      />
    </>
  );
  const controls = (
    <span
      ref={controlsRef}
      className="ml-auto flex shrink-0 items-center gap-1.5 font-sans text-xs"
      data-draft-review-controls
    >
      <ChangeListPopover header={header} />
      {listed ? (
        <>
          <span data-review-secondary className="contents">
            <ReviewStepper
              compact
              count={count}
              focusedIndex={view.focusedIndex}
              disabled={false}
              onStep={view.step}
            />
          </span>
          {coarse ? null : (
            <ShowChangesToggle
              visible={controller.marksVisible}
              onChange={controller.setMarksVisible}
            />
          )}
        </>
      ) : null}
      <ReviewStateInline
        finished={finished}
        completing={header.completing}
        next={header.next}
        draftOnly={header.draftOnly}
        onOpenNext={(row) => header.openDraft(row, focusInControls())}
        onShowLive={header.showLive}
      />
      {finished || header.asking ? null : (
        <ReviewActions
          scope="document"
          disabled={locked}
          applyDisabled={!header.canApply}
          applying={header.completing === "apply"}
          onDiscard={() => header.discardDraft(focusInControls())}
          onApply={() => header.applyDraft(focusInControls())}
        />
      )}
    </span>
  );
  // The question is a sentence: beside the controls when the line has room, else on a line of
  // its own, never cut by the controls' fixed width.
  const question =
    !finished && header.asking ? (
      <span ref={questionRef} className="contents">
        <DiscardQuestion
          scope="document"
          className="ml-auto"
          onKeep={header.keepDraft}
          returnFocus={() => controlsRef.current?.querySelector("[data-review-actions] button")}
          onConfirm={() => header.confirmDiscard(focusInControls())}
        />
      </span>
    ) : null;
  return children({
    version,
    controls: (
      <>
        {controls}
        {question}
      </>
    ),
  });
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
    if (view.finished) setOpen(false);
  }, [view.finished]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton
          disabled={view.finished || !!view.completing}
          label={changeListLabel(view.items.length)}
          data-review-secondary
          className="size-5.5"
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
            "focus-ring inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs transition-colors hover:bg-ink-fill hover:text-foreground",
            visible ? "text-foreground" : "text-muted-foreground",
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

/** The refusals no change bar shows, as lines under the identity row; nothing when there are none. */
export function DraftReviewFailureNotices({
  documentId,
  itemKey,
  onOpenDraft,
}: {
  documentId: string;
  itemKey: string;
  onOpenDraft: (row: ReviewFileTarget) => void;
}) {
  const { controller } = useDraftReview();
  const view = useReviewChanges(controller, { enabled: Boolean(itemKey) });
  const { commandError, failedElsewhere } = useReviewFailures({ documentId, itemKey, view });
  if (!commandError && failedElsewhere.length === 0) return null;
  return (
    <div className="shrink-0 text-xs" data-draft-review-notices>
      <ReviewFailureNotices
        itemKey={itemKey}
        commandError={commandError}
        failedElsewhere={failedElsewhere}
        onOpenNext={onOpenDraft}
        className="px-4"
      />
    </div>
  );
}
