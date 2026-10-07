/**
 * Renders the Changes view in the project dock: the change list of the review
 * that is open in the Editor, then the Work's other drafts to open.
 *
 * The review belongs to the Editor's scope, so the list reads that scope's
 * controller (`useEditorDraftReview`), never the Chat's ambient one: the dock
 * sits in the Chat's boundary, and the Chat's controller never has a review
 * open.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { FileCheck2 } from "lucide-react";
import { useMemo } from "react";
import {
  clearDraftCommandFailure,
  draftCommandFailure,
  useDraftCommandRecords,
} from "@/client/query/draft-command-record";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { NewBadge } from "@/components/app/NewBadge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDraftReview, useEditorDraftReview } from "@/features/chat/DraftReviewProvider";
import { type DockRow, dockRowName, dockRows, draftAfter } from "@/features/chat/docked-drafts";
import { DraftStatsLabel, draftStats } from "@/features/chat/draft-stats";
import { ReviewMessageText } from "@/features/chat/ReviewMessageText";
import { ReviewChangeRow } from "@/features/draft-review/ReviewChangeRow";
import { useArrivedChanges } from "@/features/draft-review/useArrivedChanges";
import { useReviewChanges } from "@/features/draft-review/useReviewChanges";
import { cn } from "@/lib/utils";
import { useAiDraftLauncher } from "./useAiDraftLauncher";

export function DockChangesView({ className }: { className?: string }) {
  const { groups, controller } = useDraftReview();
  const { controller: editor, groups: editorGroups } = useEditorDraftReview();
  const { openAiDraft } = useAiDraftLauncher();
  const commandRecords = useDraftCommandRecords();

  const rows = useMemo(() => dockRows(groups), [groups]);
  const editorRows = useMemo(() => dockRows(editorGroups), [editorGroups]);
  const reviewed = editor.inlineReview;
  const reviewedRow = editorRows.find((row) => row.documentId === reviewed?.documentId) ?? null;
  const sameWork = editor.workId === controller.workId;
  // The reviewed document is listed by its changes, not as a row to open again.
  const otherRows = rows.filter((row) => !(sameWork && row.documentId === reviewed?.documentId));

  const openDraft = (row: DockRow, workId: string) =>
    row.contextPath &&
    openAiDraft({
      workId,
      documentId: row.documentId,
      draftId: row.draft.draftId,
      contextPath: row.contextPath,
      documentName: row.documentName ?? undefined,
      isNewDocument: row.isNewDocument,
    });

  if (!reviewed && rows.length === 0) {
    return (
      <div className={cn("flex min-h-0 flex-col overflow-y-auto px-2 py-2", className)}>
        {/* Empty-state form (slice-7 study): centered glyph + title + one-line
            caption — no card, no border, no button. Calm, not a dead end. */}
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 pb-10 text-center">
          <FileCheck2 aria-hidden className="mb-1 size-5 text-muted-foreground/70" />
          <p className="text-sm font-medium text-foreground">
            <Trans>No pending changes</Trans>
          </p>
          <p className="text-caption text-muted-foreground">
            <Trans>AI edits wait here for your review.</Trans>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex min-h-0 flex-col gap-2 overflow-y-auto px-2 py-2", className)}>
      {reviewed ? (
        <ChangeList
          controller={editor}
          name={reviewedRow ? documentName(reviewedRow) : t`This draft`}
          next={reviewedRow ? draftAfter(editorRows, reviewedRow.documentId) : null}
          onOpenNext={(row) => openDraft(row, editor.workId)}
        />
      ) : null}
      {otherRows.length > 0 ? (
        <div className="flex flex-col">
          {otherRows.map((row) => (
            <DraftDocumentRow
              key={row.documentId}
              row={row}
              error={draftCommandFailure(commandRecords, {
                projectId: controller.projectId,
                workId: controller.workId,
                documentId: row.documentId,
                draftId: row.draft.draftId,
              })}
              onDismissError={() =>
                clearDraftCommandFailure({
                  projectId: controller.projectId,
                  workId: controller.workId,
                  documentId: row.documentId,
                  draftId: row.draft.draftId,
                })
              }
              onReview={() => openDraft(row, controller.workId)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const documentName = (row: DockRow) => dockRowName(row, t`Untitled document`);

function ChangeList({
  controller,
  name,
  next,
  onOpenNext,
}: {
  controller: ReturnType<typeof useEditorDraftReview>["controller"];
  name: string;
  next: DockRow | null;
  onOpenNext: (row: DockRow) => void;
}) {
  const view = useReviewChanges(controller);
  const changes = useMemo(() => view.items.map((item) => item.change), [view.items]);
  const arrived = useArrivedChanges(
    changes,
    view.status === "ready",
    view.documentId && view.draftId ? `${view.documentId}:${view.draftId}` : null,
  );
  const count = view.items.length;

  return (
    <section aria-label={t`Changes in ${name}`} className="flex flex-col gap-1">
      <h3 className="flex items-baseline gap-2 px-2 pt-1 text-caption font-medium text-foreground">
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {view.status === "ready" && !view.cleared ? (
          <span className="shrink-0 text-meta font-normal text-muted-foreground tabular-nums">
            {count === 1 ? t`1 change` : t`${count} changes`}
          </span>
        ) : null}
      </h3>
      {view.status === "loading" ? (
        <div className="flex flex-col gap-1.5 px-2 py-1" aria-busy>
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
        </div>
      ) : view.cleared || (view.status === "ready" && count === 0) ? (
        <ReviewDone next={next} onOpenNext={onOpenNext} onBack={controller.exitInlineReview} />
      ) : (
        <ul className="flex flex-col gap-0.5">
          {view.items.map(({ change, failure }) => (
            <ReviewChangeRow
              key={change.classId}
              change={change}
              focused={view.focused?.classId === change.classId}
              arrived={arrived.has(change.classId)}
              disabled={view.locked}
              canApply={view.canApply}
              failure={failure}
              onFocus={() => view.focus(change, { scroll: true })}
              onApply={() => void view.apply(change)}
              onDiscard={() => void view.discard(change)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ReviewDone({
  next,
  onOpenNext,
  onBack,
}: {
  next: DockRow | null;
  onOpenNext: (row: DockRow) => void;
  onBack: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-2 px-2 py-2">
      <p className="text-caption text-muted-foreground">
        <Trans>No changes left</Trans>
      </p>
      {next ? (
        <Button size="xs" onClick={() => onOpenNext(next)}>
          <Trans>Next draft</Trans>
        </Button>
      ) : (
        <Button size="xs" variant="outline" onClick={onBack}>
          <Trans>Back to live</Trans>
        </Button>
      )}
    </div>
  );
}

function DraftDocumentRow({
  row,
  error,
  onDismissError,
  onReview,
}: {
  row: DockRow;
  /** A held failure on this row's draft, such as a Review that could not open. */
  error: Parameters<typeof ReviewMessageText>[0]["code"] | null;
  onDismissError: () => void;
  onReview: () => void;
}) {
  const stats = draftStats(row.draft);
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onReview}
        className="group focus-ring flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent/40"
      >
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{documentName(row)}</span>
        {/* The one signal that differentiates a new-document row from an edited
            one: a quiet neutral badge between the name and the stats. Its
            additions-only stats (`+N`, no `−0`) reinforce it (spec §5.5). */}
        {row.isNewDocument ? <NewBadge /> : null}
        {stats ? (
          <span className="shrink-0 text-caption">
            <DraftStatsLabel stats={stats} wordsSuffix={false} />
          </span>
        ) : null}
        <span className="shrink-0 text-caption font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          <Trans>Review</Trans>
        </span>
      </button>
      {error ? (
        <InlineErrorRow message={<ReviewMessageText code={error} />} onDismiss={onDismissError} />
      ) : null}
    </div>
  );
}
