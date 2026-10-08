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
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { FileCheck2 } from "lucide-react";
import { useMemo } from "react";
import { useWorks } from "@/client/query/useWorks";
import { useDraftReview, useEditorDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { ReviewFiles } from "@/features/draft-review/ReviewFiles";
import { nextReviewFile, type ReviewFileTarget } from "@/features/draft-review/review-files";
import { useReviewChanges } from "@/features/draft-review/useReviewChanges";
import { useReviewFileList } from "@/features/draft-review/useReviewFileList";
import { cn } from "@/lib/utils";
import { OpenFileChanges } from "./OpenFileChanges";
import { useAiDraftLauncher } from "./useAiDraftLauncher";

export function DockChangesView({ className }: { className?: string }) {
  const { groups, controller } = useDraftReview();
  const { controller: editor, groups: editorGroups } = useEditorDraftReview();
  const { openDockRow: openDraft } = useAiDraftLauncher();
  const view = useReviewChanges(editor);

  // One list per Work: the Editor's, and the Chat's when the chat is in another
  // Work. Each list's menu and count are of its own drafts.
  const {
    files,
    rows: editorRows,
    batch,
  } = useReviewFileList({
    review: { controller: editor, groups: editorGroups },
    view,
    openDraft,
  });
  const chatInOtherWork = controller.workId !== editor.workId;
  const chat = useReviewFileList({
    review: { controller, groups: chatInOtherWork ? groups : null },
    view: null,
    openDraft,
  });
  const workName = useWorkNames(editor.projectId);
  const reviewed = editor.inlineReview;

  if (files.length === 0 && chat.files.length === 0) {
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
      {files.length > 0 ? (
        <ReviewFiles
          files={files}
          batch={batch}
          title={chat.files.length > 0 ? workName(editor.workId) : undefined}
        >
          {reviewed ? (
            <OpenFileChanges
              view={view}
              controller={editor}
              next={nextReviewFile(
                editorRows,
                reviewed.documentId,
                reviewed.completion?.documentName ?? null,
              )}
              onOpenNext={(row) => openDraft(row, editor.workId)}
            />
          ) : null}
        </ReviewFiles>
      ) : null}
      {chat.files.length > 0 ? (
        <ReviewFiles files={chat.files} batch={chat.batch} title={workName(controller.workId)} />
      ) : null}
    </div>
  );
}

/** A Work's name for a heading, from the project's Works. */
function useWorkNames(projectId: string): (workId: string) => string {
  const { works, noWork } = useWorks(projectId);
  const anotherWork = t`Another Work`;
  return (workId) =>
    [...(works ?? []), noWork].find((work) => work?.id === workId)?.name ?? anotherWork;
}
