/**
 * DraftReviewHeader — the editor's chrome while a document is under inline
 * review, in one row: `Manuscript /`, the draft switcher, the stepper, Show
 * changes, Discard draft and Apply draft. Above the identity bar, review-only.
 *
 * Apply draft and Discard draft move straight to the next draft in the
 * switcher, or back to live when none is left. When the writer has handled the
 * last change, a line under the row says so and offers the next draft; the
 * review does not jump on its own, so the finished text can be read.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Loader2 } from "lucide-react";
import { useId, useMemo, useState } from "react";

import { clearedDraftName, useClearedDrafts } from "@/client/query/change-command-record";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { type DockRow, dockRows, draftAfter } from "@/features/chat/docked-drafts";
import { ReviewMessageText } from "@/features/chat/ReviewMessageText";
import { DraftSwitcher } from "@/features/draft-review/DraftSwitcher";
import { ReviewStepper } from "@/features/draft-review/ReviewStepper";
import { useDraftChangeCounts } from "@/features/draft-review/useDraftChangeCounts";
import { useReviewChanges } from "@/features/draft-review/useReviewChanges";

export type DraftReviewHeaderProps = {
  documentId: string;
  draftId: string;
  /** Set for a draft-only document: closes its tab instead of returning to live. */
  onCloseDraftOnly?: () => void;
  /** Opens another draft of the Work in review (the editor's launcher). */
  onOpenDraft: (row: DockRow) => void;
};

export function DraftReviewHeader({
  documentId,
  draftId,
  onCloseDraftOnly,
  onOpenDraft,
}: DraftReviewHeaderProps) {
  const { controller, groups } = useDraftReview();
  const view = useReviewChanges(controller);
  const rows = useMemo(() => dockRows(groups), [groups]);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const marksId = useId();
  const counts = useDraftChangeCounts(
    controller,
    rows
      .filter((row) => row.documentId !== documentId)
      .map((row) => ({
        documentId: row.documentId,
        draftId: row.draft.draftId,
      })),
    switcherOpen,
  );
  const allCounts = useMemo(() => {
    const merged = new Map(counts);
    if (view.status === "ready") merged.set(documentId, view.items.length);
    return merged;
  }, [counts, documentId, view.items.length, view.status]);

  const cleared = useClearedDrafts();
  const clearedName = clearedDraftName(cleared, {
    projectId: controller.projectId,
    workId: controller.workId,
    documentId,
    draftId,
  });
  const next = draftAfter(rows, documentId);
  const locked = controller.dispositionLocked;
  const count = view.items.length;
  // Nothing left to publish: the draft already matches live, so its commands go.
  const finished = view.cleared || (view.status === "ready" && count === 0);
  const commandError =
    controller.inlineReviewMessage?.tone === "error" ? controller.inlineReviewMessage.code : null;
  const showLive = () => (onCloseDraftOnly ?? controller.exitInlineReview)();

  /** Run a whole-draft command, then move to the next draft (or live) without waiting on it. */
  const dispose = (command: () => Promise<unknown>) => {
    if (locked) return;
    void command();
    if (next) onOpenDraft(next);
  };

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
        <DraftSwitcher
          rows={rows}
          currentDocumentId={documentId}
          currentName={clearedName}
          counts={allCounts}
          onOpenChange={setSwitcherOpen}
          draftOnly={Boolean(onCloseDraftOnly)}
          disabled={locked}
          onOpenDraft={onOpenDraft}
          onShowLive={showLive}
          onApplyAll={() => void controller.disposeDrafts("apply", draftSelections(rows))}
          onDiscardAll={() => void controller.disposeDrafts("discard", draftSelections(rows))}
        />
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
            <Button
              variant="quiet"
              size="xs"
              disabled={locked}
              onClick={() => dispose(() => controller.discard(documentId, draftId))}
            >
              <Trans>Discard draft</Trans>
            </Button>
            <Button
              size="xs"
              disabled={locked || !controller.canApplyReviewedDraft}
              onClick={() => dispose(() => controller.apply(documentId, draftId))}
            >
              {controller.isApplying ? (
                <Loader2 className="size-3 animate-spin" aria-hidden />
              ) : null}
              <Trans>Apply draft</Trans>
            </Button>
          </>
        )}
      </div>
      {commandError ? (
        <p className="px-4 pb-1.5 text-destructive" role="alert">
          <ReviewMessageText code={commandError} />
        </p>
      ) : null}
      {finished ? (
        <div className="flex items-center gap-3 border-border border-t px-4 py-1.5" role="status">
          <p className="flex-1 text-muted-foreground">
            <Trans>No changes left</Trans>
          </p>
          {next ? (
            <Button size="xs" onClick={() => onOpenDraft(next)}>
              <Trans>Next draft</Trans>
            </Button>
          ) : (
            <Button size="xs" variant="outline" onClick={showLive}>
              {onCloseDraftOnly ? <Trans>Close review</Trans> : <Trans>Back to live</Trans>}
            </Button>
          )}
        </div>
      ) : null}
    </section>
  );
}

function draftSelections(rows: readonly DockRow[]) {
  return rows.map((row) => ({ documentId: row.documentId, draftId: row.draft.draftId }));
}
