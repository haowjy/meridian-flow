/** A Work's pending file, expandable to its changes. Commands act in place; the file name opens review. Preview reads begin only when expanded. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  clearDraftCommandFailure,
  draftCommandFailure,
  useDraftCommandRecords,
} from "@/client/query/draft-command-record";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { DocumentChangeRows } from "@/features/draft-review/DocumentChangeRows";
import {
  type DraftChangesView,
  isWholeDocumentChange,
} from "@/features/draft-review/draft-changes";
import { ReviewMessageText } from "@/features/draft-review/ReviewMessageText";
import { useDraftView } from "@/features/draft-review/useDraftView";
import type { WorkDraftCommands } from "@/features/draft-review/useWorkDraftCommands";
import { cn } from "@/lib/utils";
import { useAiDraftLauncher } from "../dock/useAiDraftLauncher";
import { workFileRowClass } from "./WorkFileRows";

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
  controller: WorkDraftCommands;
  touch: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const { openReviewFile } = useAiDraftLauncher();
  const records = useDraftCommandRecords();
  const draft = { projectId, workId, documentId: file.documentId, itemKey: file.draft.itemKey };
  const refused = draftCommandFailure(records, draft);
  const view = useDraftView(draft, { controller, enabled: expanded });
  if (
    expanded &&
    (view.status === "gone" ||
      (view.status === "ready" && view.items.length === 0 && !view.unlisted))
  )
    return null;
  const wholeDocument = expanded && isWholeDocumentChange(view);
  const name = file.documentName || file.contextLocation?.path || t`Untitled document`;

  const review = (focusOperationIds?: readonly string[]) =>
    openReviewFile(file, workId, focusOperationIds);

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
            onClick={() => setExpanded((open) => !open)}
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
            className={cn(workFileRowClass, "w-auto flex-1 pl-1", touch && "min-h-11")}
            disabled={!file.contextLocation}
            onClick={() => review()}
          >
            <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
          </button>
        )}
      </div>
      {refused && !view.items.some((item) => item.draftFailure) ? (
        <InlineErrorRow
          message={<ReviewMessageText failure={refused} />}
          onDismiss={() => clearDraftCommandFailure(draft)}
        />
      ) : null}
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
  onSelect: (operationIds: readonly string[]) => void;
  documentName?: string;
}) {
  return (
    <DocumentChangeRows
      documentName={documentName}
      showAttribution
      view={view}
      touch={touch}
      onSelect={(change) => onSelect(change.operationIds)}
      standIn={
        view.unlisted ? (
          <StateLine>
            <Trans>Formatting changes remain</Trans>
          </StateLine>
        ) : null
      }
    />
  );
}

function StateLine({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 py-2 text-caption text-muted-foreground" role="status">
      {children}
    </p>
  );
}
