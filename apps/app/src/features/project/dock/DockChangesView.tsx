/**
 * DockChangesView — the dock's work-scoped Changes view.
 *
 * Lists every document with pending AI changes for the Work, one row each:
 * name + `+N −N` word totals + a hover-revealed Review verb. Whole-row click
 * is Review, routed through the SAME launcher the composer DraftDock uses
 * (`useAiDraftLauncher`), so opening review and switching the dock to Changes
 * stay one gesture with one code path.
 *
 * The document CURRENTLY under inline review expands to flat per-operation
 * rows beneath its header: quiet verb (Rewrote / Added / Removed) · short
 * excerpt. Rows read the live preview operations (`useDraftPreview`); clicking
 * one highlights and scrolls the matching span in the manuscript through the
 * controller (`focusReviewOperation`) — the review surface owns the editor
 * handle, this view only names the operation. Per-op word deltas are not on
 * the wire yet, so no `+N −N` is invented here.
 */
import { Trans } from "@lingui/react/macro";
import type { ReviewOperation } from "@meridian/contracts/drafts";
import { useMemo, useState } from "react";
import { useDraftPreview } from "@/client/query/useDraftPreview";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { type DockRow, dockRows } from "@/features/chat/docked-drafts";
import { DraftStatsLabel, draftStats } from "@/features/chat/draft-stats";
import { useAiDraftLauncher } from "@/features/chat/useAiDraftLauncher";
import { cn } from "@/lib/utils";

export function DockChangesView({ className }: { className?: string }) {
  const { groups, nowMs, controller } = useDraftReview();
  const { openAiDraft } = useAiDraftLauncher();

  const rows = useMemo(
    () => dockRows(groups, nowMs).filter((row) => row.state === "pending"),
    [groups, nowMs],
  );

  const inlineReview = controller.inlineReview;
  const preview = useDraftPreview(
    controller.projectId,
    controller.workId,
    inlineReview?.documentId ?? null,
    inlineReview?.draftId ?? null,
    { enabled: Boolean(inlineReview) },
  );
  const reviewOperations = preview.preview?.status === "active" ? preview.preview.operations : null;

  return (
    <div className={cn("flex min-h-0 flex-col overflow-y-auto px-2 py-2", className)}>
      {rows.length === 0 ? (
        <p className="px-2 py-1.5 text-caption text-ink-muted">
          <Trans>No pending changes.</Trans>
        </p>
      ) : (
        rows.map((row) => (
          <ChangesDocumentGroup
            key={row.documentId}
            row={row}
            operations={row.documentId === inlineReview?.documentId ? reviewOperations : null}
            onReview={() =>
              openAiDraft(
                {
                  documentId: row.documentId,
                  contextPath: row.contextPath ?? undefined,
                  documentName: row.documentName ?? undefined,
                },
                row.draft.draftId,
              )
            }
            onFocusOperation={controller.focusReviewOperation}
          />
        ))
      )}
    </div>
  );
}

/**
 * One document group: the header row Reviews it (the lane's whole-row target
 * grammar). When this document is under review, its operations render as flat
 * change rows beneath the header.
 */
function ChangesDocumentGroup({
  row,
  operations,
  onReview,
  onFocusOperation,
}: {
  row: DockRow;
  operations: ReviewOperation[] | null;
  onReview: () => void;
  onFocusOperation: (operationId: string) => void;
}) {
  const name = row.documentName ?? row.documentId;
  const stats = draftStats(row.draft);
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onReview}
        className="group focus-ring flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent/40"
      >
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{name}</span>
        {stats ? (
          <span className="shrink-0">
            <DraftStatsLabel stats={stats} wordsSuffix={false} />
          </span>
        ) : null}
        <span className="shrink-0 text-caption font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          <Trans>Review</Trans>
        </span>
      </button>
      {operations && operations.length > 0 ? (
        <ReviewOperationRows operations={operations} onFocusOperation={onFocusOperation} />
      ) : null}
    </div>
  );
}

/**
 * Flat per-operation rows for the document under review. Local active state is
 * the click echo — clicking scrolls the manuscript and marks the row; the
 * editor is the source of truth for the span, this is just the index into it.
 */
function ReviewOperationRows({
  operations,
  onFocusOperation,
}: {
  operations: ReviewOperation[];
  onFocusOperation: (operationId: string) => void;
}) {
  const [activeOperationId, setActiveOperationId] = useState<string | null>(null);
  return (
    <ol className="flex flex-col gap-0.5 pb-1 pl-3">
      {operations.map((operation) => (
        <li key={operation.operationId}>
          <button
            type="button"
            onClick={() => {
              setActiveOperationId(operation.operationId);
              onFocusOperation(operation.operationId);
            }}
            className={cn(
              "focus-ring flex w-full items-baseline gap-1.5 rounded-md px-2 py-1 text-left text-caption transition-colors",
              activeOperationId === operation.operationId
                ? "bg-surface-subtle text-foreground"
                : "text-ink-muted hover:bg-sidebar-accent/40 hover:text-foreground",
            )}
          >
            <span className="shrink-0 font-medium text-foreground">
              <OperationVerb classification={operation.classification} />
            </span>
            <span className="min-w-0 flex-1 truncate">
              <OperationExcerpt operation={operation} />
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

/** Canon quiet verb from the server classification — rename collapses to Rewrote. */
function OperationVerb({ classification }: { classification: ReviewOperation["classification"] }) {
  switch (classification) {
    case "addition":
      return <Trans>Added</Trans>;
    case "removal":
      return <Trans>Removed</Trans>;
    default:
      return <Trans>Rewrote</Trans>;
  }
}

/**
 * Short excerpt for the row: the resulting text, or the removed text when the
 * operation only deletes. Server excerpts are pre-truncated at word bounds.
 */
function OperationExcerpt({ operation }: { operation: ReviewOperation }) {
  const excerpt = operation.afterExcerpt?.trim() || operation.beforeExcerpt?.trim() || null;
  if (!excerpt) return null;
  return (
    <>
      <span aria-hidden>· </span>
      <span aria-hidden>“</span>
      {excerpt}
      <span aria-hidden>”</span>
    </>
  );
}
