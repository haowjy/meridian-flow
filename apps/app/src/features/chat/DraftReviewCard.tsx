/**
 * DraftReviewCard — chat-anchored review surface for an AI-produced document
 * draft. Anchored beneath the assistant turn that wrote the draft so the
 * conversation reads as "the agent suggested an edit and is now waiting on
 * the writer".
 *
 * Trust model: the live manuscript is NEVER touched until the writer accepts.
 * Copy follows that — never imply the document already changed ("Draft ready
 * to review", "Apply to chapter", "Keep original" / "Discard draft"). No
 * code-review jargon (commit / hunk / patch / merge).
 *
 * The card does not own the preview overlay. Cards inside an anchored
 * assistant turn live inside a react-virtuoso row that can recycle/unmount
 * when the writer scrolls — a fixed-position modal owned by the row vanishes
 * with it. The card delegates to `onReview(documentId, draftId)`;
 * `ChatView` owns the
 * single overlay instance.
 *
 * Stack-ready render seam: the card iterates over `group.drafts` so a future
 * multi-alternative chooser is a render change here, not a refactor of the
 * data flow. The honest current shape: backend always returns at most one
 * active draft per (document, thread), and accept/reject are draft-id
 * addressable so a future chooser can route the selected draft through the
 * same seams.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { DRAFT_UNDO_RETENTION_MS } from "@meridian/contracts/drafts";
import { FileText, Loader2 } from "lucide-react";
import { useMemo } from "react";

import { useUndoDraftAccept, useUndoDraftReject } from "@/client/query/useDraftReviewMutations";
import type { ThreadDraftGroup } from "@/client/query/useThreadDrafts";
import { Button } from "@/components/ui/button";
import type { DraftReviewController } from "./useDraftReviewController";

export type DraftReviewCardProps = {
  group: ThreadDraftGroup;
  /** Shared review state machine owned by ChatView. */
  controller: DraftReviewController;
  /** Visual variant: anchored under an assistant turn, or stacked in the unanchored fallback strip. */
  variant?: "inline" | "compact";
};

export function DraftReviewCard({ group, controller, variant = "inline" }: DraftReviewCardProps) {
  const documentName = group.documentName;
  const draft = group.drafts[0] ?? null;
  const undoAccept = useUndoDraftAccept();
  const undoReject = useUndoDraftReject();

  const isPending = controller.isPending;
  // Stack-ready render seam: today every group has length 1 (the backend
  // returns at most one active draft per document, per thread). When a
  // multi-alternative chooser lands the chooser slots in here as a render
  // change; the action plumbing already carries the selected draft id.
  const draftCount = group.drafts.length;

  const isUndoPending = undoAccept.isPending || undoReject.isPending;
  const canUndoTerminalDraft = useMemo(() => {
    if (!draft || draft.status === "active") return false;
    const updatedAtMs = Date.parse(draft.updatedAt);
    return Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs <= DRAFT_UNDO_RETENTION_MS;
  }, [draft]);

  function handleAccept() {
    if (isPending || !draft || draft.status !== "active") return;
    controller.accept(group.documentId, draft.draftId);
  }

  function handleDiscard() {
    if (isPending || !draft || draft.status !== "active") return;
    controller.reject(group.documentId, draft.draftId);
  }

  function handleUndo() {
    if (!draft || draft.status === "active" || isUndoPending || !canUndoTerminalDraft) return;
    const mutation = draft.status === "applied" ? undoAccept : undoReject;
    mutation.mutate({
      threadId: controller.threadId,
      documentId: group.documentId,
      draftId: draft.draftId,
    });
  }

  const cardClassName =
    variant === "inline"
      ? "surface-card mt-3 mb-1 rounded-xl border border-border-subtle px-4 py-3 shadow-xs"
      : "surface-card rounded-xl border border-border-subtle px-3.5 py-2.5 shadow-xs";

  if (draft?.status === "discarded" || draft?.status === "applied") {
    const isApplied = draft.status === "applied";
    return (
      <section
        className={cardClassName}
        aria-label={isApplied ? t`AI draft applied` : t`AI draft discarded`}
        data-draft-card
        data-document-id={group.documentId}
        data-draft-status={draft.status}
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-surface-subtle text-muted-foreground">
            <FileText className="size-3.5" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <span className="status-pill border border-border-subtle bg-surface-subtle text-muted-foreground">
              {isApplied ? <Trans>Applied to chapter</Trans> : <Trans>Discarded</Trans>}
            </span>
            <p className="mt-1 truncate text-muted-foreground text-sm">
              {documentName ?? <Trans>Untitled document</Trans>}
            </p>
          </div>
        </div>
        {canUndoTerminalDraft ? (
          <div className="mt-3 flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleUndo}
              disabled={isUndoPending}
              className="text-muted-foreground hover:text-foreground"
            >
              {isUndoPending ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
              {isApplied ? <Trans>Undo acceptance</Trans> : <Trans>Undo discard</Trans>}
            </Button>
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section
      className={cardClassName}
      aria-label={t`AI draft ready to review`}
      data-draft-card
      data-document-id={group.documentId}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-surface-subtle text-primary">
          <FileText className="size-3.5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="status-pill border border-border-subtle bg-surface-subtle text-foreground">
              <Trans>Draft ready to review</Trans>
            </span>
            {draftCount > 1 ? (
              <span className="text-muted-foreground text-xs">
                <Trans>{draftCount} alternatives</Trans>
              </span>
            ) : null}
          </div>
          <p className="mt-1 truncate text-foreground text-sm">
            {documentName ?? <Trans>Untitled document</Trans>}
          </p>
          <p className="text-muted-foreground text-xs">
            <Trans>Your live document is untouched until you accept.</Trans>
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => draft && controller.openReview(group.documentId, draft.draftId)}
          disabled={isPending}
        >
          <Trans>Review</Trans>
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleAccept}
          disabled={isPending}
        >
          {controller.isAccepting ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
          <Trans>Apply to chapter</Trans>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleDiscard}
          disabled={isPending}
          className="text-muted-foreground hover:text-foreground"
        >
          {controller.isRejecting ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
          <Trans>Discard draft</Trans>
        </Button>
      </div>
    </section>
  );
}
