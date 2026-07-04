/** DraftReviewLifecycleRow — shared active/terminal draft row presenter. */
import { Trans } from "@lingui/react/macro";
import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import { Loader2, RotateCcw } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { isDraftUndoable } from "@/client/query/draft-undoable";
import { useUndoDraftAccept, useUndoDraftReject } from "@/client/query/useDraftReviewMutations";
import { hasActivePartialAccept } from "@/client/query/useWorkDrafts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { DraftReviewController } from "./useDraftReviewController";

export type DraftReviewLifecycleRowProps = {
  draft: ThreadDraftListItem;
  documentId: string;
  documentName: string | null | undefined;
  activeCount: number;
  controller: DraftReviewController;
  nowMs: number;
  className?: string;
  statusSlot?: ReactNode;
  activeMode: "review-only" | "review-apply-discard";
  activeCopy?: "document" | "draft";
  activeReviewLabel: ReactNode;
  terminalCopy: "draft" | "changes";
  onReview: (draftId: string) => void;
};

export function DraftReviewLifecycleRow({
  draft,
  documentId,
  documentName,
  activeCount,
  controller,
  nowMs,
  className,
  statusSlot,
  activeMode,
  activeCopy = "document",
  activeReviewLabel,
  terminalCopy,
  onReview,
}: DraftReviewLifecycleRowProps) {
  const undoAccept = useUndoDraftAccept();
  const undoReject = useUndoDraftReject();
  const busy = controller.isPending || undoAccept.isPending || undoReject.isPending;
  const resolvedDocumentName = documentName ?? draft.documentName ?? null;
  const [undoError, setUndoError] = useState<string | null>(null);

  useEffect(() => {
    setUndoError(null);
  }, [draft.draftId, draft.status]);

  function handleUndo() {
    if (draft.status === "active" || busy || !isDraftUndoable(draft, nowMs)) return;
    const mutation = draft.status === "applied" ? undoAccept : undoReject;
    setUndoError(null);
    mutation.mutate(
      {
        projectId: controller.projectId,
        workId: controller.workId,
        threadId: controller.threadId,
        documentId,
        draftId: draft.draftId,
      },
      {
        onError() {
          setUndoError("Couldn't undo that draft. Nothing changed.");
        },
      },
    );
  }

  function handleUndoPartialAccept() {
    if (!hasActivePartialAccept(draft) || busy) return;
    setUndoError(null);
    undoAccept.mutate(
      {
        projectId: controller.projectId,
        workId: controller.workId,
        threadId: controller.threadId,
        documentId,
        draftId: draft.draftId,
      },
      {
        onError() {
          setUndoError("Couldn't undo that proposal. Nothing changed.");
        },
      },
    );
  }

  if (draft.status === "active") {
    const partialAcceptedOperationCount = draft.partialAcceptedOperationCount ?? 0;
    const partialUndoLabel = partialAcceptUndoLabel({
      count: partialAcceptedOperationCount,
      documentName: resolvedDocumentName,
    });

    return (
      <div className={className} data-draft-status="active">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
        <span className="min-w-0 truncate text-sm text-foreground">
          <ActiveDraftLabel
            documentName={resolvedDocumentName}
            activeCount={activeCount}
            copy={activeCopy}
          />
        </span>
        {statusSlot}
        {undoError ? (
          <span className="truncate text-destructive text-xs" role="alert">
            {undoError}
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {hasActivePartialAccept(draft) ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={handleUndoPartialAccept}
              disabled={busy}
              title={partialUndoLabel}
              aria-label={partialUndoLabel}
              className="text-muted-foreground hover:text-foreground"
            >
              {busy ? (
                <Loader2 className="size-3 animate-spin" aria-hidden />
              ) : (
                <RotateCcw className="size-3" aria-hidden />
              )}
              {partialUndoLabel}
            </Button>
          ) : null}
          {activeMode === "review-apply-discard" ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => controller.reject(documentId, draft.draftId)}
                disabled={busy}
                className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <Trans>Discard</Trans>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => controller.accept(documentId, draft.draftId)}
                disabled={busy}
                className="text-muted-foreground hover:text-foreground"
              >
                {controller.isAccepting ? (
                  <Loader2 className="size-3 animate-spin" aria-hidden />
                ) : null}
                <Trans>Apply</Trans>
              </Button>
            </>
          ) : null}
          <Button
            type="button"
            variant="default"
            size={activeMode === "review-only" ? "sm" : "sm"}
            onClick={() => onReview(draft.draftId)}
            disabled={busy}
            className={activeMode === "review-only" ? "shrink-0" : undefined}
          >
            {activeReviewLabel}
          </Button>
        </div>
      </div>
    );
  }

  const isApplied = draft.status === "applied";
  const undoable = isDraftUndoable(draft, nowMs);
  const undoLabel = draftUndoLabel({ isApplied, documentName: resolvedDocumentName });

  return (
    <div className={className} data-draft-status={draft.status}>
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          isApplied ? "bg-primary" : "bg-muted-foreground",
        )}
      />
      <span className="min-w-0 truncate text-sm text-foreground">
        <TerminalDraftLabel
          documentName={resolvedDocumentName}
          isApplied={isApplied}
          copy={terminalCopy}
        />
      </span>
      {statusSlot}
      {undoError ? (
        <span className="truncate text-destructive text-xs" role="alert">
          {undoError}
        </span>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {undoable ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={handleUndo}
            disabled={busy}
            title={undoLabel}
            aria-label={undoLabel}
            className="text-muted-foreground hover:text-foreground"
          >
            {busy ? (
              <Loader2 className="size-3 animate-spin" aria-hidden />
            ) : (
              <RotateCcw className="size-3" aria-hidden />
            )}
            {undoLabel}
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

function ActiveDraftLabel({
  documentName,
  activeCount,
  copy,
}: {
  documentName: string | null;
  activeCount: number;
  copy: "document" | "draft";
}) {
  if (copy === "draft") {
    return activeCount > 1 ? (
      <Trans>{activeCount} AI changes to review</Trans>
    ) : (
      <Trans>AI drafted changes</Trans>
    );
  }
  if (!documentName) return <Trans>Document has changes</Trans>;
  if (activeCount > 1) {
    return (
      <Trans>
        <span className="font-medium">{documentName}</span> has {activeCount} pending changes
      </Trans>
    );
  }
  return (
    <Trans>
      <span className="font-medium">{documentName}</span> has changes
    </Trans>
  );
}

function TerminalDraftLabel({
  documentName,
  isApplied,
  copy,
}: {
  documentName: string | null;
  isApplied: boolean;
  copy: "draft" | "changes";
}) {
  if (copy === "draft") {
    return isApplied ? <Trans>Draft applied</Trans> : <Trans>Draft discarded</Trans>;
  }
  if (!documentName)
    return isApplied ? <Trans>Changes applied</Trans> : <Trans>Discarded changes</Trans>;
  return isApplied ? (
    <Trans>
      Changes applied to <span className="font-medium">{documentName}</span>
    </Trans>
  ) : (
    <Trans>
      Discarded changes to <span className="font-medium">{documentName}</span>
    </Trans>
  );
}

function draftUndoLabel({
  isApplied,
  documentName,
}: {
  isApplied: boolean;
  documentName: string | null;
}): string {
  const action = isApplied ? "Undo apply" : "Undo discard";
  return documentName ? `${action} — ${documentName}` : action;
}

function partialAcceptUndoLabel({
  count,
  documentName,
}: {
  count: number;
  documentName: string | null;
}): string {
  const action = count === 1 ? "Undo accepted proposal" : `Undo ${count} accepted proposals`;
  return documentName ? `${action} — ${documentName}` : action;
}
