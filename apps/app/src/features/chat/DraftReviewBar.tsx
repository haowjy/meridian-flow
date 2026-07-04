/** DraftReviewBar — in-editor review affordance for focused-thread AI drafts. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useDraftPreview } from "@/client/query/useDraftPreview";
import { Button } from "@/components/ui/button";

import { DraftReviewLifecycleRow } from "./DraftReviewLifecycleRow";
import { useDraftReview } from "./DraftReviewProvider";
import { useAiDraftLauncher } from "./useAiDraftLauncher";

export type DraftReviewBarProps = {
  documentId: string;
};

export function DraftReviewBar({ documentId }: DraftReviewBarProps) {
  const { controller, groupForDocument, reviewableDraftsForDocument, nowMs } = useDraftReview();
  const { openAiDraft } = useAiDraftLauncher();
  const group = groupForDocument(documentId);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const selectedDraftStatusRef = useRef<{
    draftId: string;
    status: ThreadDraftListItem["status"];
  } | null>(null);
  const { visible: reviewableDrafts, active: activeDrafts } =
    reviewableDraftsForDocument(documentId);

  const inlineReview = controller.inlineReview;
  const selectedVisibleDraft =
    reviewableDrafts.find((item) => item.draftId === selectedDraftId) ?? null;
  const firstActiveDraft = activeDrafts[0] ?? null;

  useEffect(() => {
    if (inlineReview?.documentId !== documentId || inlineReview.draftId === selectedDraftId) {
      return;
    }

    const selectedReviewDraft = reviewableDrafts.find(
      (item) => item.draftId === inlineReview.draftId,
    );
    if (selectedReviewDraft?.status === "active") setSelectedDraftId(inlineReview.draftId);
  }, [
    documentId,
    reviewableDrafts,
    inlineReview?.documentId,
    inlineReview?.draftId,
    selectedDraftId,
  ]);
  const draft = selectedVisibleDraft ?? firstActiveDraft ?? reviewableDrafts[0] ?? null;

  useEffect(() => {
    if (!draft) {
      selectedDraftStatusRef.current = null;
      setSelectedDraftId(null);
      return;
    }

    const previous = selectedDraftStatusRef.current;
    const advancedDraft = firstActiveDraft;
    if (
      previous?.draftId === draft.draftId &&
      previous.status === "active" &&
      draft.status !== "active" &&
      advancedDraft
    ) {
      selectedDraftStatusRef.current = {
        draftId: draft.draftId,
        status: draft.status,
      };
      setSelectedDraftId(advancedDraft.draftId);
      return;
    }

    selectedDraftStatusRef.current = { draftId: draft.draftId, status: draft.status };
    if (draft.draftId !== selectedDraftId) setSelectedDraftId(draft.draftId);
  }, [draft, selectedDraftId, firstActiveDraft]);

  const activeDraftIdForPreview = draft?.status === "active" ? draft.draftId : null;
  const activePreview = useDraftPreview(
    controller.projectId,
    controller.workId,
    documentId,
    activeDraftIdForPreview,
    { enabled: Boolean(activeDraftIdForPreview) },
  );

  if (!group || reviewableDrafts.length === 0 || !draft) return null;

  // During inline review the stats line reads directly off the inline hunk
  // model — one primary signal, honest counts. hunkCount from the operation
  // summary avoids double-counting hunks shared across operations.
  const inlineStats =
    activePreview.preview?.status === "active"
      ? {
          operations: activePreview.preview.operations.length,
          regions: activePreview.preview.hunks.length,
        }
      : null;
  const index = Math.max(
    0,
    reviewableDrafts.findIndex((item) => item.draftId === draft.draftId),
  );
  const isInlineReviewing =
    draft.status === "active" &&
    inlineReview?.documentId === documentId &&
    inlineReview.draftId === draft.draftId;
  const busy = controller.isPending;
  const applyBlockedByDiscard = controller.isInlineDiscardPending;
  const staleMessage =
    controller.staleDraft?.draftId === draft.draftId ? controller.staleDraftMessage : null;
  const cannotPlaceMessage =
    controller.cannotPlaceDraft?.documentId === documentId &&
    controller.cannotPlaceDraft.draftId === draft.draftId
      ? "This draft can’t be placed automatically. Copy what you need or discard it."
      : null;

  function step(delta: -1 | 1) {
    const nextIndex = Math.min(reviewableDrafts.length - 1, Math.max(0, index + delta));
    controller.exitReview();
    setSelectedDraftId(reviewableDrafts[nextIndex]?.draftId ?? null);
  }

  function openDraftInReview() {
    if (draft.status !== "active") return;
    openAiDraft(
      {
        documentId,
        documentName: group?.documentName ?? null,
      },
      draft.draftId,
    );
  }

  // Slim during-review bar: one signal (Reviewing draft), honest stats, one
  // primary action (Apply all). The bar reads as a continuation of the
  // editor's own chrome — same `surface-card` shell as the entry banner,
  // tinted subtly with the review-added accents so "you're in review" is
  // legible without recoloring the shell.
  // The out-of-review entry banner still lives in this component but keeps
  // its multi-affordance shape until wave F2 moves it out.
  if (isInlineReviewing) {
    return (
      <section
        className="surface-card shrink-0 border-border-subtle border-b"
        data-draft-review-bar
        data-draft-review-mode="inline"
      >
        <div className="flex flex-wrap items-center gap-3 px-4 py-2">
          <span
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground"
            data-draft-review-status
          >
            <span
              aria-hidden
              // Small accent dot in the review-added tone so the bar reads
              // as jade-inflected without swallowing the toolbar chrome.
              className="size-2 rounded-full bg-primary"
            />
            <Trans>Reviewing draft</Trans>
          </span>
          {inlineStats ? (
            <p className="text-muted-foreground text-xs tabular-nums" data-draft-review-stats>
              <Trans>
                {inlineStats.operations} operations · {inlineStats.regions} regions
              </Trans>
            </p>
          ) : null}
          {staleMessage ? (
            <p className="text-destructive text-xs" role="alert">
              {staleMessage}
            </p>
          ) : null}
          {cannotPlaceMessage ? (
            <p className="text-muted-foreground text-xs" role="alert">
              {cannotPlaceMessage}
            </p>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => controller.exitInlineReview()}
              disabled={busy}
              className="text-muted-foreground hover:text-foreground"
            >
              <Trans>Cancel</Trans>
            </Button>
            {cannotPlaceMessage ? null : (
              <Button
                type="button"
                size="sm"
                variant="default"
                onClick={() => controller.accept(documentId, draft.draftId)}
                disabled={busy || applyBlockedByDiscard}
              >
                {controller.isAccepting ? (
                  <Loader2 className="size-3 animate-spin" aria-hidden />
                ) : null}
                {applyBlockedByDiscard ? (
                  <Trans>Finishing discard…</Trans>
                ) : (
                  <Trans>Apply all</Trans>
                )}
              </Button>
            )}
          </div>
        </div>
      </section>
    );
  }

  // Entry banner — a single-line row above the toolbar. One signal +
  // one primary action. Multi-draft: keep the stepper.
  return (
    <section className="surface-card shrink-0 border-border-subtle border-b" data-draft-review-bar>
      <DraftReviewLifecycleRow
        draft={draft}
        documentId={documentId}
        documentName={group.documentName ?? draft.documentName}
        activeCount={activeDrafts.length}
        controller={controller}
        nowMs={nowMs}
        className="flex min-w-0 items-center gap-3 px-4 py-1.5"
        statusSlot={
          <>
            {reviewableDrafts.length > 1 ? (
              <Stepper index={index} count={reviewableDrafts.length} onStep={step} />
            ) : null}
            {staleMessage && draft.status === "active" ? (
              <p className="truncate text-destructive text-xs" role="alert">
                {staleMessage}
              </p>
            ) : null}
          </>
        }
        activeMode="review-only"
        activeCopy="draft"
        activeReviewLabel={<Trans>Open AI draft</Trans>}
        terminalCopy="draft"
        onReview={openDraftInReview}
      />
    </section>
  );
}

function Stepper({
  index,
  count,
  onStep,
}: {
  index: number;
  count: number;
  onStep: (delta: -1 | 1) => void;
}) {
  return (
    <div className="inline-flex items-center gap-1 text-muted-foreground text-xs">
      <button
        type="button"
        className="focus-ring grid size-6 place-items-center rounded-md hover:bg-surface-subtle hover:text-foreground disabled:opacity-40"
        onClick={() => onStep(-1)}
        disabled={index === 0}
        aria-label={t`Previous draft`}
      >
        <ChevronLeft className="size-3.5" aria-hidden />
      </button>
      <span className="tabular-nums">
        {index + 1} / {count}
      </span>
      <button
        type="button"
        className="focus-ring grid size-6 place-items-center rounded-md hover:bg-surface-subtle hover:text-foreground disabled:opacity-40"
        onClick={() => onStep(1)}
        disabled={index >= count - 1}
        aria-label={t`Next draft`}
      >
        <ChevronRight className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
