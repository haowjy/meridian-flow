/** A Work's pending file, expandable to its changes. Commands act in place; the file name opens review. Preview reads begin only when expanded. */
import { t } from "@lingui/core/macro";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import {
  clearDraftCommandFailure,
  dismissOverrode,
  draftCommandFailure,
  draftOverrode,
  useDraftCommandRecords,
} from "@/client/query/draft-command-record";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { DocumentChangeRows } from "@/features/draft-review/DocumentChangeRows";
import { DraftImagePreview, isDraftImagePath } from "@/features/draft-review/DraftImagePreview";
import {
  type DraftChangesView,
  isWholeDocumentChange,
} from "@/features/draft-review/draft-changes";
import { FileCommandStatus } from "@/features/draft-review/ReviewCompletion";
import { AppliedOverNotice } from "@/features/draft-review/ReviewHeaderNotices";
import { ReviewMessageText } from "@/features/draft-review/ReviewMessageText";
import { useDraftView } from "@/features/draft-review/useDraftView";
import type { HeadlessDiscards } from "@/features/draft-review/useHeadlessDiscards";
import type { WorkDraftCommands } from "@/features/draft-review/useWorkDraftCommands";
import { cn } from "@/lib/utils";
import { useAiDraftLauncher } from "../dock/useAiDraftLauncher";
import { workFileRowClass } from "./WorkFileRows";

export function WorkChangeFile({
  projectId,
  workId,
  file,
  controller,
  discards,
  touch,
}: {
  projectId: string;
  workId: string;
  file: ReviewFileTarget;
  /** The scope that sends this file's per-change commands. */
  controller: WorkDraftCommands;
  /** Where this file's in-place Discards live while the Work page is open. */
  discards: HeadlessDiscards;
  touch: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const { openReviewFile } = useAiDraftLauncher();
  const [previewing, setPreviewing] = useState(false);
  const records = useDraftCommandRecords();
  const draft = { projectId, workId, documentId: file.documentId, itemKey: file.draft.itemKey };
  const refused = draftCommandFailure(records, draft);
  const overrode = draftOverrode(records, draft);
  const view = useDraftView(draft, {
    controller,
    enabled: expanded,
    file,
    discards,
  });
  // No changes left is not nothing to say: a held failure or overwrite notice keeps the file until it is
  // dismissed or resolved.
  const noticed = refused !== null || overrode.length > 0;
  if (expanded && !noticed && (view.status === "gone" || view.finished)) return null;
  const wholeDocument = expanded && isWholeDocumentChange(view);
  const imageOpenable = isDraftImagePath(file.contextLocation?.path);
  const name = file.documentName || file.contextLocation?.path || t`Untitled document`;

  const review = (focusChangeIds?: readonly string[]) =>
    file.draft.binary
      ? imageOpenable && setPreviewing(true)
      : openReviewFile(file, workId, focusChangeIds);

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
            disabled={!file.contextLocation || (file.draft.binary && !imageOpenable)}
            onClick={() => review()}
          >
            <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
          </button>
        )}
        {view.completing ? <FileCommandStatus mode={view.completing} /> : null}
      </div>
      <DraftImagePreview
        target={previewing ? { projectId, workId, documentId: file.documentId, name } : null}
        onClose={() => setPreviewing(false)}
      />
      {refused && !view.items.some((item) => item.draftFailure) ? (
        <InlineErrorRow
          message={<ReviewMessageText failure={refused} />}
          onDismiss={() => clearDraftCommandFailure(draft)}
        />
      ) : null}
      <AppliedOverNotice
        items={overrode}
        onDismiss={() => dismissOverrode(draft)}
        touch={touch}
        className={touch ? "pl-11" : "pl-8"}
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
  onSelect: (changeIds: readonly string[]) => void;
  documentName?: string;
}) {
  return (
    <DocumentChangeRows
      documentName={documentName}
      showAttribution
      view={view}
      touch={touch}
      onSelect={(change) => onSelect([change.id])}
    />
  );
}
