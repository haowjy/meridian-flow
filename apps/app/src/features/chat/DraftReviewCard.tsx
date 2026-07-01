/**
 * DraftReviewCard — chat-anchored review surface for AI document drafts.
 *
 * Trust model: the live manuscript is NEVER touched until the writer accepts.
 * Copy follows that — never imply the document already changed ("Draft ready
 * to review", "Apply to chapter", "Discard draft"). No code-review jargon.
 *
 * The card does not own the preview overlay. Cards inside an anchored
 * assistant turn live inside a react-virtuoso row that can recycle/unmount
 * when the writer scrolls; `ChatView` owns the single overlay instance.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import { FileText, Loader2 } from "lucide-react";

import { isDraftUndoable } from "@/client/query/draft-undoable";
import { useUndoDraftAccept, useUndoDraftReject } from "@/client/query/useDraftReviewMutations";
import type { ThreadDraftGroup } from "@/client/query/useThreadDrafts";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/features/project/relative-time";
import { cn } from "@/lib/utils";

import { ComponentCard } from "./ComponentCard";
import { useDraftReview } from "./DraftReviewProvider";
import type { DraftReviewController } from "./useDraftReviewController";

export type DraftReviewCardProps = {
  group: ThreadDraftGroup;
  /** Visual variant: anchored under an assistant turn, or stacked in the unanchored fallback strip. */
  variant?: "inline" | "compact";
};

export function DraftReviewCard({ group, variant = "inline" }: DraftReviewCardProps) {
  const { controller, reviewableDraftsForGroup, nowMs } = useDraftReview();
  const undoAccept = useUndoDraftAccept();
  const undoReject = useUndoDraftReject();
  const { visible: reviewableDrafts, active: activeDrafts } = reviewableDraftsForGroup(group);

  if (reviewableDrafts.length === 0) return null;

  const documentName = group.documentName ?? t`Untitled document`;
  const activeCount = activeDrafts.length;
  const busy = controller.isPending || undoAccept.isPending || undoReject.isPending;

  function handleUndo(draft: ThreadDraftListItem) {
    if (draft.status === "active" || busy || !isDraftUndoable(draft, nowMs)) return;
    const mutation = draft.status === "applied" ? undoAccept : undoReject;
    mutation.mutate({
      threadId: controller.threadId,
      documentId: group.documentId,
      draftId: draft.draftId,
    });
  }

  return (
    <ComponentCard
      icon={FileText}
      tone={activeCount > 0 ? "pending" : "reversible"}
      eyebrow={<Trans>Draft</Trans>}
      title={documentName}
      hint={
        activeCount > 0 ? (
          <Trans>Your live document is untouched until you accept.</Trans>
        ) : undefined
      }
      className={variant === "inline" ? "mt-3" : "px-3.5 py-2.5"}
    >
      <div
        className="divide-y divide-border-subtle"
        data-draft-card
        data-document-id={group.documentId}
      >
        {reviewableDrafts.map((draft) => (
          <DraftRow
            key={draft.draftId}
            draft={draft}
            documentId={group.documentId}
            documentName={documentName}
            controller={controller}
            nowMs={nowMs}
            busy={busy}
            className="py-3 first:pt-0 last:pb-0"
            onUndo={handleUndo}
          />
        ))}
      </div>
    </ComponentCard>
  );
}

function DraftRow({
  draft,
  documentId,
  documentName,
  controller,
  nowMs,
  busy,
  className,
  onUndo,
}: {
  draft: ThreadDraftListItem;
  documentId: string;
  documentName: string;
  controller: DraftReviewController;
  nowMs: number;
  busy: boolean;
  className?: string;
  onUndo: (draft: ThreadDraftListItem) => void;
}) {
  if (draft.status === "active") {
    return (
      <div className={cn("min-w-0", className)} data-draft-status="active">
        <div className="flex flex-wrap items-center gap-2">
          <span className="status-pill border border-border-subtle bg-surface-subtle text-foreground">
            <Trans>Draft ready to review</Trans>
          </span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => controller.openReview(documentId, draft.draftId)}
            disabled={busy}
          >
            <Trans>Review changes</Trans>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => controller.accept(documentId, draft.draftId)}
            disabled={busy}
          >
            {controller.isAccepting ? (
              <Loader2 className="size-3 animate-spin" aria-hidden />
            ) : null}
            <Trans>Apply to chapter</Trans>
          </Button>
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
            <Trans>Discard draft</Trans>
          </Button>
        </div>
      </div>
    );
  }

  const isApplied = draft.status === "applied";
  const age = relativeTime(draft.updatedAt, nowMs);

  return (
    <div className={cn("min-w-0", className)} data-draft-status={draft.status}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="status-pill border border-border-subtle bg-surface-subtle text-muted-foreground">
          {isApplied ? <Trans>Applied to chapter</Trans> : <Trans>Discarded</Trans>}
        </span>
        <span className="truncate text-muted-foreground text-sm">
          {documentName} ·{" "}
          {isApplied ? <Trans>applied {age} ago</Trans> : <Trans>discarded {age} ago</Trans>}
        </span>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onUndo(draft)}
          disabled={busy}
          className="text-muted-foreground hover:text-foreground"
        >
          {busy ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
          {isApplied ? <Trans>Undo acceptance</Trans> : <Trans>Undo discard</Trans>}
        </Button>
      </div>
    </div>
  );
}
