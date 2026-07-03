/** DraftReviewBar — in-editor review affordance for focused-thread AI drafts. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import { ChevronLeft, ChevronRight, Loader2, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { isDraftUndoable } from "@/client/query/draft-undoable";
import { useDraftPreview } from "@/client/query/useDraftPreview";
import { useUndoDraftAccept, useUndoDraftReject } from "@/client/query/useDraftReviewMutations";
import { Button } from "@/components/ui/button";

import { DraftDiffPanel } from "./DraftDiffPanel";
import { useDraftReview } from "./DraftReviewProvider";
import { useAiDraftLauncher } from "./useAiDraftLauncher";

export type DraftReviewBarProps = {
  documentId: string;
};

export function DraftReviewBar({ documentId }: DraftReviewBarProps) {
  const { controller, groupForDocument, reviewableDraftsForDocument, nowMs } = useDraftReview();
  const { openAiDraft } = useAiDraftLauncher();
  const group = groupForDocument(documentId);
  const undoAccept = useUndoDraftAccept();
  const undoReject = useUndoDraftReject();
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const selectedDraftStatusRef = useRef<{
    draftId: string;
    status: ThreadDraftListItem["status"];
  } | null>(null);
  const { visible: reviewableDrafts, active: activeDrafts } =
    reviewableDraftsForDocument(documentId);

  const selectedDraft = controller.selectedDraft;
  const inlineReview = controller.inlineReview;
  const selectedVisibleDraft =
    reviewableDrafts.find((item) => item.draftId === selectedDraftId) ?? null;
  const firstActiveDraft = activeDrafts[0] ?? null;

  useEffect(() => {
    if (selectedDraft?.documentId !== documentId || selectedDraft.draftId === selectedDraftId) {
      return;
    }

    const selectedReviewDraft = reviewableDrafts.find(
      (item) => item.draftId === selectedDraft.draftId,
    );
    if (selectedReviewDraft?.status === "active") setSelectedDraftId(selectedDraft.draftId);
  }, [
    documentId,
    reviewableDrafts,
    selectedDraft?.documentId,
    selectedDraft?.draftId,
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

  // Prefetch the review preview so the "Review draft" button can pick inline
  // vs panel before entering review mode. `DraftDiffPanel` reads from the same
  // query cache, so this doesn't add a second network trip. The hook is
  // called unconditionally (rules-of-hooks) and guarded by the enabled flag.
  const activeDraftIdForPreview = draft?.status === "active" ? draft.draftId : null;
  const activePreview = useDraftPreview(
    controller.projectId,
    controller.workId,
    documentId,
    activeDraftIdForPreview,
    {
      enabled: Boolean(activeDraftIdForPreview),
    },
  );

  if (!group || reviewableDrafts.length === 0 || !draft) return null;

  const previewMode: "inline" | "panel" | null =
    activePreview.preview?.status === "active" ? activePreview.preview.recommendedSurface : null;
  const fallbackReason =
    activePreview.preview?.status === "active" &&
    activePreview.preview.recommendedSurface === "panel"
      ? (activePreview.preview.fallbackReason ?? null)
      : null;
  // During inline review the stats line reads directly off the inline hunk
  // model — one primary signal, honest counts. hunkCount from the operation
  // summary avoids double-counting hunks shared across operations.
  const inlineStats =
    activePreview.preview?.status === "active" && activePreview.preview.inlineModelPresent
      ? {
          operations: activePreview.preview.operations.length,
          regions: activePreview.preview.hunks.length,
        }
      : null;
  const index = Math.max(
    0,
    reviewableDrafts.findIndex((item) => item.draftId === draft.draftId),
  );
  const isPanelOpen =
    draft.status === "active" &&
    selectedDraft?.documentId === documentId &&
    selectedDraft.draftId === draft.draftId;
  const isInlineReviewing =
    draft.status === "active" &&
    inlineReview?.documentId === documentId &&
    inlineReview.draftId === draft.draftId;
  const busy = controller.isPending || undoAccept.isPending || undoReject.isPending;
  const applyBlockedByDiscard = controller.isInlineDiscardPending;
  const staleMessage =
    controller.staleDraft?.draftId === draft.draftId ? controller.staleDraftMessage : null;
  const activeDraftRevisionToken =
    activePreview.preview?.status === "active"
      ? activePreview.preview.draftRevisionToken
      : undefined;

  function step(delta: -1 | 1) {
    const nextIndex = Math.min(reviewableDrafts.length - 1, Math.max(0, index + delta));
    controller.exitReview();
    setSelectedDraftId(reviewableDrafts[nextIndex]?.draftId ?? null);
  }

  function openDraftInReview() {
    if (draft.status !== "active") return;
    // Server-side thresholds may downgrade this diff to the docked panel.
    // Route through the launcher either way; when previewMode is "panel"
    // the panel-mode fallback surfaces below the editor. When it's
    // "inline" the launcher collapses rails and navigates to Context.
    if (previewMode === "panel") {
      controller.openReview(documentId, draft.draftId);
      return;
    }
    openAiDraft(
      {
        documentId,
        documentName: group?.documentName ?? null,
      },
      draft.draftId,
    );
  }

  function undoDraft(item: ThreadDraftListItem) {
    if (item.status === "active" || !isDraftUndoable(item, nowMs) || busy) return;
    const mutation = item.status === "applied" ? undoAccept : undoReject;
    mutation.mutate({
      projectId: controller.projectId,
      workId: controller.workId,
      documentId,
      draftId: item.draftId,
    });
  }

  // Slim during-review bar: one signal (Reviewing draft), honest stats, one
  // primary action (Apply all). The bar reads as a continuation of the
  // editor's own chrome — same `surface-card` shell as the entry banner and
  // the existing DraftDiffPanel, tinted subtly with the review-added
  // accents so "you're in review" is legible without recoloring the shell.
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
            <Button
              type="button"
              size="sm"
              variant="default"
              onClick={() =>
                controller.accept(documentId, draft.draftId, {
                  draftRevisionToken: activeDraftRevisionToken,
                })
              }
              disabled={busy || applyBlockedByDiscard}
            >
              {controller.isAccepting ? (
                <Loader2 className="size-3 animate-spin" aria-hidden />
              ) : null}
              {applyBlockedByDiscard ? <Trans>Finishing discard…</Trans> : <Trans>Apply all</Trans>}
            </Button>
          </div>
        </div>
      </section>
    );
  }

  // Entry banner — a single-line row above the toolbar. One signal +
  // one primary action. Multi-draft: keep the stepper. Panel-fallback:
  // primary action still says "Open AI draft" (the launcher decides
  // whether to open the panel or inline review); the fallback reason is
  // demoted to a `title` attr so it appears on hover without stealing
  // vertical space.
  const activeSubtitle: string | null =
    previewMode === "panel" ? panelFallbackHint(fallbackReason) : null;

  return (
    <section className="surface-card shrink-0 border-border-subtle border-b" data-draft-review-bar>
      <div className="flex min-w-0 items-center gap-3 px-4 py-1.5">
        {draft.status === "active" ? (
          <>
            <span
              className="inline-flex min-w-0 items-center gap-2 text-sm font-medium text-foreground"
              title={staleMessage ?? activeSubtitle ?? undefined}
            >
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
              <span className="truncate">
                {activeDrafts.length > 1 ? (
                  <Trans>{activeDrafts.length} AI changes to review</Trans>
                ) : (
                  <Trans>AI drafted changes</Trans>
                )}
              </span>
            </span>
            {reviewableDrafts.length > 1 ? (
              <Stepper index={index} count={reviewableDrafts.length} onStep={step} />
            ) : null}
            {staleMessage ? (
              <p className="truncate text-destructive text-xs" role="alert">
                {staleMessage}
              </p>
            ) : null}
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={openDraftInReview}
              disabled={busy}
              className="ml-auto shrink-0"
            >
              <Trans>Open AI draft</Trans>
            </Button>
          </>
        ) : (
          // Terminal state (applied / discarded): compact undo bar. State
          // + Undo, nothing else. Copy stays honest: "Draft applied" /
          // "Draft discarded" — never leaks internal ids or count.
          <>
            <span className="inline-flex min-w-0 items-center gap-2 text-sm text-foreground">
              <span
                aria-hidden
                className={
                  draft.status === "applied"
                    ? "size-1.5 shrink-0 rounded-full bg-primary"
                    : "size-1.5 shrink-0 rounded-full bg-muted-foreground"
                }
              />
              <span className="truncate font-medium">
                {draft.status === "applied" ? (
                  <Trans>Draft applied</Trans>
                ) : (
                  <Trans>Draft discarded</Trans>
                )}
              </span>
            </span>
            {reviewableDrafts.length > 1 ? (
              <Stepper index={index} count={reviewableDrafts.length} onStep={step} />
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => undoDraft(draft)}
              disabled={busy}
              className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
            >
              {busy ? (
                <Loader2 className="size-3 animate-spin" aria-hidden />
              ) : (
                <RotateCcw className="size-3" aria-hidden />
              )}
              <Trans>Undo</Trans>
            </Button>
          </>
        )}
      </div>

      {isPanelOpen ? (
        <DraftDiffPanel
          controller={controller}
          documentId={documentId}
          draftId={draft.draftId}
          className="max-h-[min(60vh,44rem)] border-border-subtle border-t bg-background"
        />
      ) : null}
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

// (Note: the docked DraftDiffPanel — for `openReview` from another surface —
// is rendered under the bar when `controller.selectedDraft.documentId ===
// documentId`. See the `isPanelOpen` render at the bottom of the section.)

/** Hover-hint string shown on the primary "Open AI draft" action when the
 *  server has downgraded this diff to the docked panel. One clause. */
function panelFallbackHint(reason: string | null): string {
  switch (reason) {
    case "rewrite_threshold":
      return t`Rewrites most of the chapter; opens as a changes panel.`;
    case "hunk_density":
      return t`Too dense to review inline; opens as a changes panel.`;
    case "block_churn":
      return t`Paragraphs moved; opens as a changes panel.`;
    default:
      return t`Opens as a changes panel.`;
  }
}
