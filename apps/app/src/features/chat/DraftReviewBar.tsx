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
import { useEffect, useMemo, useState } from "react";

import { isDraftUndoable } from "@/client/query/draft-undoable";
import { useUndoDraftAccept, useUndoDraftReject } from "@/client/query/useDraftReviewMutations";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/features/project/relative-time";

import { DraftDiffPanel } from "./DraftPreviewOverlay";
import { useDraftReview } from "./DraftReviewProvider";

export type DraftReviewBarProps = {
  documentId: string;
};

export function DraftReviewBar({ documentId }: DraftReviewBarProps) {
  const { controller, groupForDocument } = useDraftReview();
  const group = groupForDocument(documentId);
  const undoAccept = useUndoDraftAccept();
  const undoReject = useUndoDraftReject();
  const [index, setIndex] = useState(0);
  const nowMs = Date.now();
  const visibleDrafts = useMemo(
    () =>
      group?.drafts.filter((draft) => draft.status === "active" || isDraftUndoable(draft, nowMs)) ??
      [],
    [group?.drafts, nowMs],
  );

  const selectedDraft = controller.selectedDraft;
  useEffect(() => {
    const selectedIndex = visibleDrafts.findIndex(
      (draft) => draft.draftId === selectedDraft?.draftId,
    );
    if (selectedIndex >= 0) setIndex(selectedIndex);
  }, [selectedDraft?.draftId, visibleDrafts]);

  useEffect(() => {
    if (index >= visibleDrafts.length) setIndex(Math.max(0, visibleDrafts.length - 1));
  }, [index, visibleDrafts.length]);

  if (!group || visibleDrafts.length === 0) return null;

  const draft = visibleDrafts[index] ?? visibleDrafts[0];
  if (!draft) return null;

  const activeDrafts = visibleDrafts.filter((item) => item.status === "active");
  const isPanelOpen =
    draft.status === "active" &&
    selectedDraft?.documentId === documentId &&
    selectedDraft.draftId === draft.draftId;
  const busy = controller.isPending || undoAccept.isPending || undoReject.isPending;

  function step(delta: -1 | 1) {
    setIndex((current) => Math.min(visibleDrafts.length - 1, Math.max(0, current + delta)));
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
    for (const item of activeDrafts) controller.accept(documentId, item.draftId);
  }

  function discardAll() {
    for (const item of activeDrafts) controller.reject(documentId, item.draftId);
  }

  function undoDraft(item: ThreadDraftListItem) {
    if (item.status === "active" || !isDraftUndoable(item) || busy) return;
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
              <ReversibleTitle draft={draft} />
            )}
            {visibleDrafts.length > 1 ? (
              <Stepper index={index} count={visibleDrafts.length} onStep={step} />
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

function ReversibleTitle({ draft }: { draft: ThreadDraftListItem }) {
  const age = relativeTime(draft.updatedAt, Date.now());
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
