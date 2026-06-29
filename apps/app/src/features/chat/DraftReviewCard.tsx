/**
 * DraftReviewCard — chat-anchored review surface for an AI-produced document
 * draft. Anchored beneath the assistant turn that wrote the draft so the
 * conversation reads as "the agent suggested an edit and is now waiting on
 * the writer".
 *
 * Trust model: the live manuscript is NEVER touched until the writer accepts.
 * Copy follows that — never imply the document already changed ("Draft ready
 * to review", "Accept changes", "Keep original" / "Discard draft"). No
 * code-review jargon (commit / hunk / patch / merge).
 *
 * The card does not own the preview overlay. Cards inside an anchored
 * assistant turn live inside a react-virtuoso row that can recycle/unmount
 * when the writer scrolls — a fixed-position modal owned by the row vanishes
 * with it. The card delegates to `onReview(documentId)`; `ChatView` owns the
 * single overlay instance.
 *
 * Stack-ready render seam: the card iterates over `group.drafts` so a future
 * multi-alternative chooser is a render change here, not a refactor of the
 * data flow. The honest current shape: backend always returns at most one
 * active draft per (document, thread), and accept/reject are document-scoped
 * (`documentId`) — a real chooser will also need draft-id-addressable
 * preview/accept/reject endpoints before this seam carries weight.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { FileText, Loader2 } from "lucide-react";
import { useAcceptDraft, useRejectDraft } from "@/client/query/useDraftReviewMutations";
import type { ThreadDraftGroup } from "@/client/query/useThreadDrafts";
import { Button } from "@/components/ui/button";

export type DraftReviewCardProps = {
  threadId: string;
  group: ThreadDraftGroup;
  /** Open the (ChatView-owned) preview overlay for this group's document. */
  onReview: (documentId: string) => void;
  /** Visual variant: anchored under an assistant turn, or stacked in the unanchored fallback strip. */
  variant?: "inline" | "compact";
};

export function DraftReviewCard({
  threadId,
  group,
  onReview,
  variant = "inline",
}: DraftReviewCardProps) {
  const accept = useAcceptDraft();
  const reject = useRejectDraft();

  const documentName = group.documentName;

  const isPending = accept.isPending || reject.isPending;
  // Stack-ready render seam: today every group has length 1 (the backend
  // returns at most one active draft per document, per thread). When a
  // multi-alternative chooser lands the chooser slots in here as a render
  // change. The data plumbing (draft-id-addressable endpoints) is a separate
  // step — flag it explicitly so this doesn't read as "already there".
  const draftCount = group.drafts.length;

  function handleAccept() {
    if (isPending) return;
    accept.mutate({ threadId, documentId: group.documentId });
  }

  function handleDiscard() {
    if (isPending) return;
    reject.mutate({ threadId, documentId: group.documentId });
  }

  return (
    <section
      className={
        variant === "inline"
          ? "surface-card mt-3 mb-1 rounded-xl border border-border-subtle px-4 py-3 shadow-xs"
          : "surface-card rounded-xl border border-border-subtle px-3.5 py-2.5 shadow-xs"
      }
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
          onClick={() => onReview(group.documentId)}
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
          {accept.isPending ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
          <Trans>Accept changes</Trans>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleDiscard}
          disabled={isPending}
          className="text-muted-foreground hover:text-foreground"
        >
          {reject.isPending ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
          <Trans>Discard draft</Trans>
        </Button>
      </div>
    </section>
  );
}
