/** A Work's pending file, expandable to its changes. Commands act in place; the file name opens review. Preview reads begin only when expanded. */
import { t } from "@lingui/core/macro";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import { DocumentChangeRows } from "@/features/draft-review/DocumentChangeRows";
import { DraftCommandStatus } from "@/features/draft-review/DraftCommandStatus";
import { DraftImagePreview, isDraftImagePath } from "@/features/draft-review/DraftImagePreview";
import {
  type DraftChangesView,
  isWholeDocumentChange,
} from "@/features/draft-review/draft-changes";
import type { ReviewFocus } from "@/features/draft-review/review-model";
import { useDraftView } from "@/features/draft-review/useDraftView";
import type { WorkBranchCommands } from "@/features/draft-review/useWorkBranchCommands";
import { cn } from "@/lib/utils";
import { useAiDraftLauncher } from "../dock/useAiDraftLauncher";

export function WorkChangeFile({
  projectId,
  workId,
  file,
  controller,
  touch,
}: {
  projectId: string;
  workId: string;
  file: ReviewFileTarget;
  /** The scope that sends this file's per-change commands. */
  controller: WorkBranchCommands;
  touch: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const { openReviewFile } = useAiDraftLauncher();
  const [previewing, setPreviewing] = useState(false);
  const draft = { projectId, workId, documentId: file.documentId, itemKey: file.draft.itemKey };
  const view = useDraftView(draft, { controller, enabled: expanded, item: file.draft });
  if (
    !controller.owner.state(file.draft.itemKey).pending &&
    expanded &&
    (view.status === "gone" || (view.status === "ready" && view.items.length === 0))
  )
    return null;
  const wholeDocument = expanded && isWholeDocumentChange(view);
  const imageOpenable = isDraftImagePath(file.contextLocation?.path);
  const name = file.documentName || file.contextLocation?.path || t`Untitled document`;

  const review = (focus?: ReviewFocus) => {
    controller.dismissNotice();
    return file.draft.hasDraft
      ? openReviewFile(file, workId, focus)
      : imageOpenable && setPreviewing(true);
  };

  return (
    <>
      <div className="flex min-w-0 items-center">
        {wholeDocument ? (
          <span aria-hidden className={cn("shrink-0", touch ? "size-11" : "size-8")} />
        ) : (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={t`Changes in ${name}`}
            onClick={() => {
              controller.dismissNotice();
              setExpanded((open) => !open);
            }}
            className={cn(
              "focus-ring grid shrink-0 place-items-center rounded-md text-ink-subtle transition-colors hover:bg-dropdown-hover motion-reduce:transition-none",
              touch ? "size-11" : "size-8",
            )}
          >
            <ChevronRight
              aria-hidden
              className={cn(
                "size-4 transition-transform motion-reduce:transition-none",
                expanded && "rotate-90",
              )}
            />
          </button>
        )}
        {wholeDocument ? (
          <div className="min-w-0 flex-1">
            <FileChanges view={view} touch={touch} onSelect={review} documentName={name} />
          </div>
        ) : (
          <button
            type="button"
            className={cn(
              "focus-ring flex min-h-10 w-full min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors motion-reduce:transition-none hover:bg-dropdown-hover",
              "w-auto flex-1 pl-1",
              touch && "min-h-11",
            )}
            disabled={!file.contextLocation || (file.draft.hasDraft === false && !imageOpenable)}
            onClick={() => review()}
          >
            <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
          </button>
        )}
      </div>
      <DraftCommandStatus itemKey={file.draft.itemKey} />
      <DraftImagePreview
        target={previewing ? { projectId, workId, documentId: file.documentId, name } : null}
        onClose={() => setPreviewing(false)}
      />
      {expanded && !wholeDocument ? (
        <div className={cn("pb-1.5", touch ? "pl-11" : "pl-8")}>
          <FileChanges view={view} touch={touch} onSelect={review} />
        </div>
      ) : null}
    </>
  );
}

function FileChanges({
  view,
  touch,
  onSelect,
  documentName,
}: {
  view: DraftChangesView;
  touch: boolean;
  onSelect: (focus: ReviewFocus) => void;
  documentName?: string;
}) {
  return (
    <DocumentChangeRows
      documentName={documentName}
      showAttribution
      view={view}
      touch={touch}
      onSelect={onSelect}
    />
  );
}
