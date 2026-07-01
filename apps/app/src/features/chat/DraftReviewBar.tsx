/** DraftReviewBar — in-editor review affordance for focused-thread AI drafts. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileText,
  Loader2,
  RotateCcw,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { isDraftUndoable } from "@/client/query/draft-undoable";
import { useUndoDraftAccept, useUndoDraftReject } from "@/client/query/useDraftReviewMutations";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/features/project/relative-time";

import { DraftDiffPanel } from "./DraftDiffPanel";
import { useDraftReview } from "./DraftReviewProvider";

export type DraftReviewBarProps = {
  documentId: string;
};

export function DraftReviewBar({ documentId }: DraftReviewBarProps) {
  const { controller, groupForDocument, reviewableDraftsForDocument, nowMs } = useDraftReview();
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

  if (!group || reviewableDrafts.length === 0 || !draft) return null;

  const index = Math.max(
    0,
    reviewableDrafts.findIndex((item) => item.draftId === draft.draftId),
  );
  const isPanelOpen =
    draft.status === "active" &&
    selectedDraft?.documentId === documentId &&
    selectedDraft.draftId === draft.draftId;
  const busy = controller.isPending || undoAccept.isPending || undoReject.isPending;

  function step(delta: -1 | 1) {
    const nextIndex = Math.min(reviewableDrafts.length - 1, Math.max(0, index + delta));
    setSelectedDraftId(reviewableDrafts[nextIndex]?.draftId ?? null);
  }

  function openCurrentDraft() {
    if (draft.status !== "active") return;
    controller.openReview(documentId, draft.draftId);
  }

  function togglePanel() {
    if (isPanelOpen) {
      controller.closeReview();
      return;
    }
    openCurrentDraft();
  }

  function applyAll() {
    controller.acceptAll(
      documentId,
      activeDrafts.map((item) => item.draftId),
    );
  }

  function discardAll() {
    controller.rejectAll(
      documentId,
      activeDrafts.map((item) => item.draftId),
    );
  }

  function undoDraft(item: ThreadDraftListItem) {
    if (item.status === "active" || !isDraftUndoable(item, nowMs) || busy) return;
    const mutation = item.status === "applied" ? undoAccept : undoReject;
    mutation.mutate({ threadId: controller.threadId, documentId, draftId: item.draftId });
  }

  return (
    <section className="surface-card shrink-0 border-border-subtle border-b" data-draft-review-bar>
      <div className="flex flex-wrap items-center gap-3 px-4 py-2">
        <div className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-subtle text-primary">
          {draft.status === "applied" ? (
            <CheckCircle2 className="size-3.5" aria-hidden />
          ) : (
            <FileText className="size-3.5" aria-hidden />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {draft.status === "active" ? (
              <p className="text-sm font-medium text-foreground">
                {activeDrafts.length > 1 ? (
                  <Trans>{activeDrafts.length} changes to review</Trans>
                ) : (
                  <Trans>AI drafted changes to this chapter</Trans>
                )}
              </p>
            ) : (
              <ReversibleTitle draft={draft} nowMs={nowMs} />
            )}
            {reviewableDrafts.length > 1 ? (
              <Stepper index={index} count={reviewableDrafts.length} onStep={step} />
            ) : null}
          </div>
          {draft.status === "active" ? (
            <p className="text-xs text-muted-foreground">
              <Trans>Your live text is untouched.</Trans>
            </p>
          ) : null}
        </div>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {draft.status === "active" ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={togglePanel}
                disabled={busy}
              >
                {isPanelOpen ? <Trans>Hide changes</Trans> : <Trans>Show changes</Trans>}
              </Button>
              {activeDrafts.length > 1 ? (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={discardAll}
                    disabled={busy}
                  >
                    <Trans>Discard all</Trans>
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={applyAll}
                    disabled={busy}
                  >
                    <Trans>Apply all</Trans>
                  </Button>
                </>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => controller.reject(documentId, draft.draftId)}
                disabled={busy}
                className="text-muted-foreground hover:text-foreground"
              >
                {controller.isRejecting ? (
                  <Loader2 className="size-3 animate-spin" aria-hidden />
                ) : null}
                <Trans>Discard</Trans>
              </Button>
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={() => controller.accept(documentId, draft.draftId)}
                disabled={busy}
              >
                {controller.isAccepting ? (
                  <Loader2 className="size-3 animate-spin" aria-hidden />
                ) : null}
                <Trans>Apply</Trans>
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => undoDraft(draft)}
              disabled={busy}
              className="text-muted-foreground hover:text-foreground"
            >
              {busy ? (
                <Loader2 className="size-3 animate-spin" aria-hidden />
              ) : (
                <RotateCcw className="size-3" aria-hidden />
              )}
              {draft.status === "applied" ? (
                <Trans>Undo acceptance</Trans>
              ) : (
                <Trans>Undo discard</Trans>
              )}
            </Button>
          )}
        </div>
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

function ReversibleTitle({ draft, nowMs }: { draft: ThreadDraftListItem; nowMs: number }) {
  const age = relativeTime(draft.updatedAt, nowMs);
  const isApplied = draft.status === "applied";
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="status-pill border border-border-subtle bg-surface-subtle text-muted-foreground">
        {isApplied ? <Trans>Applied to this chapter</Trans> : <Trans>Discarded</Trans>}
      </span>
      <span className="text-muted-foreground">
        {isApplied ? <Trans>applied {age} ago</Trans> : <Trans>discarded {age} ago</Trans>}
      </span>
    </div>
  );
}
