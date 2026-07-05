/** DraftReviewBar — in-editor review affordance for focused-thread AI drafts. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import { ArrowRight, ChevronLeft, ChevronRight, Loader2, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { isDraftUndoable } from "@/client/query/draft-undoable";
import { useDraftPreview } from "@/client/query/useDraftPreview";
import { useUndoDraftAccept, useUndoDraftReject } from "@/client/query/useDraftReviewMutations";
import { hasActivePartialAccept } from "@/client/query/useWorkDrafts";
import { Button } from "@/components/ui/button";

import { useDraftReview } from "./DraftReviewProvider";
import { useAiDraftLauncher } from "./useAiDraftLauncher";

export type DraftReviewBarProps = {
  documentId: string;
};

type NextDraftTarget = {
  documentId: string;
  draftId: string;
  documentName: string | null;
  contextPath: string | null;
};

export function DraftReviewBar({ documentId }: DraftReviewBarProps) {
  const { controller, groups, groupForDocument, reviewableDraftsForDocument, nowMs } =
    useDraftReview();
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

  // Guided next-document offer: the first OTHER document in the Work that still
  // has a pending draft. When this document's changes are dispositioned and
  // another document is still waiting, we offer to continue there.
  const nextPendingDoc = useMemo<NextDraftTarget | null>(() => {
    for (const candidate of groups) {
      if (candidate.documentId === documentId) continue;
      const active = candidate.drafts.find((item) => item.status === "active");
      if (active) {
        return {
          documentId: candidate.documentId,
          draftId: active.draftId,
          documentName: candidate.documentName,
          contextPath: candidate.contextPath,
        };
      }
    }
    return null;
  }, [groups, documentId]);

  const [offer, setOffer] = useState<{ appliedName: string | null; next: NextDraftTarget } | null>(
    null,
  );
  const hadActiveRef = useRef(false);
  useEffect(() => {
    const hasActive = activeDrafts.length > 0;
    const had = hadActiveRef.current;
    hadActiveRef.current = hasActive;
    if (had && !hasActive && nextPendingDoc) {
      setOffer({ appliedName: group?.documentName ?? null, next: nextPendingDoc });
      const timer = window.setTimeout(() => setOffer(null), 6000);
      return () => window.clearTimeout(timer);
    }
  }, [activeDrafts.length, nextPendingDoc, group?.documentName]);

  const activeDraftIdForPreview = draft?.status === "active" ? draft.draftId : null;
  const activePreview = useDraftPreview(
    controller.projectId,
    controller.workId,
    documentId,
    activeDraftIdForPreview,
    { enabled: Boolean(activeDraftIdForPreview) },
  );

  if (offer) {
    return (
      <NextDocumentOffer
        appliedName={offer.appliedName}
        next={offer.next}
        onReviewNext={() => {
          setOffer(null);
          openAiDraft(
            {
              documentId: offer.next.documentId,
              documentName: offer.next.documentName ?? undefined,
              contextPath: offer.next.contextPath ?? undefined,
            },
            offer.next.draftId,
          );
        }}
      />
    );
  }

  if (!group || reviewableDrafts.length === 0 || !draft) return null;

  // During inline review the stats read directly off the inline preview — one
  // primary signal, honest counts. Word deltas aren't on the wire yet, so we
  // render the edit count as the magnitude.
  const inlineEditCount =
    activePreview.preview?.status === "active" ? activePreview.preview.operations.length : null;
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

  // Slim during-review bar: one signal (Reviewing changes), honest stats, one
  // primary action (Apply all).
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
            <span aria-hidden className="size-2 rounded-full bg-primary" />
            <Trans>Reviewing changes</Trans>
          </span>
          {inlineEditCount !== null ? (
            <p className="text-muted-foreground text-xs tabular-nums" data-draft-review-stats>
              <Trans>{inlineEditCount} edits</Trans>
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

  // Out-of-review: entry banner (active) or a compact Undo receipt (terminal).
  return (
    <section className="surface-card shrink-0 border-border-subtle border-b" data-draft-review-bar>
      {draft.status === "active" ? (
        <ActiveEntryRow
          draft={draft}
          documentId={documentId}
          documentName={group.documentName ?? draft.documentName}
          activeCount={activeDrafts.length}
          controller={controller}
          busy={busy}
          onReview={openDraftInReview}
          stepper={
            reviewableDrafts.length > 1 ? (
              <Stepper index={index} count={reviewableDrafts.length} onStep={step} />
            ) : null
          }
          staleMessage={staleMessage}
        />
      ) : (
        <TerminalUndoRow
          draft={draft}
          documentId={documentId}
          documentName={group.documentName ?? draft.documentName}
          controller={controller}
          nowMs={nowMs}
        />
      )}
    </section>
  );
}

function ActiveEntryRow({
  draft,
  documentId,
  documentName,
  activeCount,
  controller,
  busy,
  onReview,
  stepper,
  staleMessage,
}: {
  draft: ThreadDraftListItem;
  documentId: string;
  documentName: string | null;
  activeCount: number;
  controller: ReturnType<typeof useDraftReview>["controller"];
  busy: boolean;
  onReview: () => void;
  stepper: React.ReactNode;
  staleMessage: string | null;
}) {
  const undoAccept = useUndoDraftAccept();
  const partialUndoBusy = busy || undoAccept.isPending;
  return (
    <div className="flex min-w-0 items-center gap-3 px-4 py-1.5">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
      <span className="min-w-0 truncate text-sm text-foreground">
        {activeCount > 1 ? (
          <Trans>{activeCount} AI changes to review</Trans>
        ) : documentName ? (
          <Trans>
            <span className="font-medium">{documentName}</span> has changes
          </Trans>
        ) : (
          <Trans>AI drafted changes</Trans>
        )}
      </span>
      {stepper}
      {staleMessage ? (
        <p className="truncate text-destructive text-xs" role="alert">
          {staleMessage}
        </p>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {hasActivePartialAccept(draft) ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() =>
              undoAccept.mutate({
                projectId: controller.projectId,
                workId: controller.workId,
                threadId: controller.threadId,
                documentId,
                draftId: draft.draftId,
              })
            }
            disabled={partialUndoBusy}
            className="text-muted-foreground hover:text-foreground"
          >
            {partialUndoBusy ? (
              <Loader2 className="size-3 animate-spin" aria-hidden />
            ) : (
              <RotateCcw className="size-3" aria-hidden />
            )}
            <Trans>Undo</Trans>
          </Button>
        ) : null}
        <Button type="button" variant="default" size="sm" onClick={onReview} disabled={busy}>
          <Trans>Review</Trans>
        </Button>
      </div>
    </div>
  );
}

/**
 * Minimal editor-side Undo receipt: the whole-draft undo the writer needs right
 * after applying/discarding from the editor, while the draft is still undoable.
 * (The transcript's ephemeral chip covers the same action after a dock apply.)
 */
function TerminalUndoRow({
  draft,
  documentId,
  documentName,
  controller,
  nowMs,
}: {
  draft: ThreadDraftListItem;
  documentId: string;
  documentName: string | null;
  controller: ReturnType<typeof useDraftReview>["controller"];
  nowMs: number;
}) {
  const undoAccept = useUndoDraftAccept();
  const undoReject = useUndoDraftReject();
  const isApplied = draft.status === "applied";
  const undoable = isDraftUndoable(draft, nowMs);
  const busy = controller.isPending || undoAccept.isPending || undoReject.isPending;

  return (
    <div className="flex min-w-0 items-center gap-3 px-4 py-1.5">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-muted-foreground" />
      <span className="min-w-0 truncate text-sm text-foreground">
        {isApplied ? (
          <Trans>
            Changes applied to <span className="font-medium">{documentName}</span>
          </Trans>
        ) : (
          <Trans>
            Discarded changes to <span className="font-medium">{documentName}</span>
          </Trans>
        )}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {undoable ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() =>
              (isApplied ? undoAccept : undoReject).mutate({
                projectId: controller.projectId,
                workId: controller.workId,
                threadId: controller.threadId,
                documentId,
                draftId: draft.draftId,
              })
            }
            disabled={busy}
            className="text-muted-foreground hover:text-foreground"
          >
            {busy ? (
              <Loader2 className="size-3 animate-spin" aria-hidden />
            ) : (
              <RotateCcw className="size-3" aria-hidden />
            )}
            <Trans>Undo</Trans>
          </Button>
        ) : (
          <span className="text-muted-foreground text-xs">
            <Trans>Undo window closed</Trans>
          </span>
        )}
      </div>
    </div>
  );
}

function NextDocumentOffer({
  appliedName,
  next,
  onReviewNext,
}: {
  appliedName: string | null;
  next: NextDraftTarget;
  onReviewNext: () => void;
}) {
  return (
    <section
      className="surface-card shrink-0 border-border-subtle border-b"
      data-draft-review-offer
    >
      <div className="flex min-w-0 items-center gap-2 px-4 py-1.5 text-sm">
        <span aria-hidden className="shrink-0 text-jade-text">
          ✓
        </span>
        <span className="min-w-0 truncate text-foreground">
          {appliedName ? (
            <Trans>
              <span className="font-medium">{appliedName}</span> applied
            </Trans>
          ) : (
            <Trans>Changes applied</Trans>
          )}
        </span>
        <button
          type="button"
          onClick={onReviewNext}
          className="focus-ring ml-auto inline-flex shrink-0 items-center gap-1 rounded-sm px-1 text-jade-text hover:text-foreground"
        >
          <Trans>Review next: {next.documentName ?? "document"}</Trans>
          <ArrowRight className="size-3.5" aria-hidden />
        </button>
      </div>
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
