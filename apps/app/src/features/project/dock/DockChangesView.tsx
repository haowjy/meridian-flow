/**
 * DockChangesView — the dock's work-scoped Changes view (document level, v1).
 *
 * Lists every document with pending AI changes for the Work, one row each:
 * name + `+N −N` word totals + a hover-revealed Review verb. Whole-row click
 * is Review, routed through the SAME launcher the composer DraftDock uses
 * (`useAiDraftLauncher`), so opening review and switching the dock to Changes
 * stay one gesture with one code path. Per-operation change rows are a later
 * slice — this view reads only the existing client draft groups.
 */
import { Trans } from "@lingui/react/macro";
import { useMemo } from "react";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { type DockRow, dockRows } from "@/features/chat/docked-drafts";
import { DraftStatsLabel, draftStats } from "@/features/chat/draft-stats";
import { useAiDraftLauncher } from "@/features/chat/useAiDraftLauncher";
import { cn } from "@/lib/utils";

export function DockChangesView({ className }: { className?: string }) {
  const { groups, nowMs } = useDraftReview();
  const { openAiDraft } = useAiDraftLauncher();

  const rows = useMemo(
    () => dockRows(groups, nowMs).filter((row) => row.state === "pending"),
    [groups, nowMs],
  );

  return (
    <div className={cn("flex min-h-0 flex-col overflow-y-auto px-2 py-2", className)}>
      {rows.length === 0 ? (
        <p className="px-2 py-1.5 text-caption text-ink-muted">
          <Trans>No pending changes.</Trans>
        </p>
      ) : (
        rows.map((row) => (
          <ChangesDocumentRow
            key={row.documentId}
            row={row}
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
          />
        ))
      )}
    </div>
  );
}

/**
 * One document group: whole-row click Reviews it (the lane's whole-row target
 * grammar); the quiet Review verb is the hover-revealed affordance hint.
 */
function ChangesDocumentRow({ row, onReview }: { row: DockRow; onReview: () => void }) {
  const name = row.documentName ?? row.documentId;
  const stats = draftStats(row.draft);
  return (
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
  );
}
