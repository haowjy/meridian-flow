/**
 * Renders the Changes view in the project dock: every draft file of the Work in
 * one stable order (`sortDraftFiles`), with the file open in the Editor expanded
 * in place to its changes in document order. Opening another file moves the
 * expansion, never the list. The Work-wide Apply all and Discard all sit at the
 * top of the list.
 *
 * The review belongs to the Editor's scope, so the list reads that scope's
 * controller (`useEditorDraftReview`), never the Chat's ambient one: the dock
 * sits in the Chat's boundary, and the Chat's controller never has a review
 * open.
 */
import { Trans } from "@lingui/react/macro";
import { FileCheck2, Loader2 } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDraftReview, useEditorDraftReview } from "@/features/chat/DraftReviewProvider";
import { type DockRow, draftAfter } from "@/features/chat/docked-drafts";
import { ReviewChangeRow } from "@/features/draft-review/ReviewChangeRow";
import { ReviewFiles } from "@/features/draft-review/ReviewFiles";
import { useArrivedChanges } from "@/features/draft-review/useArrivedChanges";
import { useReviewChanges } from "@/features/draft-review/useReviewChanges";
import { useReviewFileList } from "@/features/draft-review/useReviewFileList";
import { cn } from "@/lib/utils";
import { useAiDraftLauncher } from "./useAiDraftLauncher";

export function DockChangesView({ className }: { className?: string }) {
  const { groups, controller } = useDraftReview();
  const { controller: editor, groups: editorGroups } = useEditorDraftReview();
  const { openDockRow: openDraft } = useAiDraftLauncher();
  const view = useReviewChanges(editor);

  const {
    files,
    rows: editorRows,
    batch,
  } = useReviewFileList({
    review: { controller: editor, groups: editorGroups },
    view,
    openDraft,
    other: { controller, groups },
  });
  const reviewed = editor.inlineReview;

  if (files.length === 0) {
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
      <ReviewFiles files={files} batch={batch}>
        {reviewed ? (
          <OpenFileChanges
            view={view}
            controller={editor}
            next={draftAfter(
              editorRows,
              reviewed.documentId,
              reviewed.completion?.documentName ?? null,
            )}
            onOpenNext={(row) => openDraft(row, editor.workId)}
          />
        ) : null}
      </ReviewFiles>
    </div>
  );
}

/** The open file's body under its heading: its changes in document order, or the state that stands in for them. */
function OpenFileChanges({
  view,
  controller,
  next,
  onOpenNext,
}: {
  view: ReturnType<typeof useReviewChanges>;
  controller: ReturnType<typeof useEditorDraftReview>["controller"];
  next: DockRow | null;
  onOpenNext: (row: DockRow) => void;
}) {
  const changes = useMemo(() => view.items.map((item) => item.change), [view.items]);
  const arrived = useArrivedChanges(
    changes,
    view.status === "ready",
    view.documentId && view.draftId ? `${view.documentId}:${view.draftId}` : null,
  );

  return view.status === "loading" ? (
    <div className="flex flex-col gap-1.5 px-2 py-1" aria-busy>
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-4/5" />
    </div>
  ) : view.completing ? (
    <ReviewCompleting mode={view.completing} />
  ) : view.finished ? (
    <ReviewDone next={next} onOpenNext={onOpenNext} onBack={controller.exitInlineReview} />
  ) : view.unlisted ? (
    <p className="px-2 py-2 text-caption text-muted-foreground" role="status">
      <Trans>Formatting changes remain. Apply draft or Discard draft finishes them.</Trans>
    </p>
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
  );
}

/** The last change's command is in flight: what the writer did shows, and nothing says it is finished. */
function ReviewCompleting({ mode }: { mode: "apply" | "discard" }) {
  return (
    <p
      className="flex items-center gap-2 px-2 py-2 text-caption text-muted-foreground"
      role="status"
      aria-busy
    >
      <Loader2 className="size-3 animate-spin" aria-hidden />
      {mode === "apply" ? <Trans>Applying</Trans> : <Trans>Discarding</Trans>}
    </p>
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
