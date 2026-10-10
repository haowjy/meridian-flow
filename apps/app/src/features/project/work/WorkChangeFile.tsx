/**
 * WorkChangeFile — one draft file in the Work page's "Changes to review": its
 * name (opens the file's review at the top), a New badge, a refusal
 * held on its draft with Dismiss, and a disclosure that expands the row in place
 * to that file's changes. Expanding is the only thing that reads the file's
 * preview, so a Work with many drafts previews none of them until asked.
 *
 * The rows are `DocumentChangeRows` over `useDraftChanges` (the Editor's own
 * model when this draft is its open review). A change row's body opens the
 * file's review focused on that change; Apply, Discard and the chat link act
 * where they are and never change the screen.
 */

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
import { NewBadge } from "@/components/app/NewBadge";
import { DocumentChangeRows } from "@/features/draft-review/DocumentChangeRows";
import { ReviewMessageText } from "@/features/draft-review/ReviewMessageText";
import { useDraftChanges } from "@/features/draft-review/useDraftChanges";
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
  const draft = { projectId, workId, documentId: file.documentId, draftId: file.draft.draftId };
  const refused = draftCommandFailure(records, draft);
  const name = file.documentName || file.contextPath || t`Untitled manuscript`;

  const review = (focusOperationIds?: readonly string[]) =>
    openReviewFile(file, workId, focusOperationIds);

  return (
    <>
      <div className="flex min-w-0 items-center">
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
        <button
          type="button"
          className={cn(workFileRowClass, "w-auto flex-1 pl-1", touch && "min-h-11")}
          disabled={!file.contextPath}
          onClick={() => review()}
        >
          <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
          {file.isNewDocument ? <NewBadge /> : null}
        </button>
      </div>
      {refused ? (
        <InlineErrorRow
          message={<ReviewMessageText failure={refused} />}
          onDismiss={() => clearDraftCommandFailure(draft)}
        />
      ) : null}
      {expanded ? (
        <div className={cn("pb-1.5", touch ? "pl-11" : "pl-8")}>
          <FileChanges
            draft={draft}
            isNewDocument={file.isNewDocument}
            controller={controller}
            touch={touch}
            onSelect={review}
          />
        </div>
      ) : null}
    </>
  );
}

function FileChanges({
  draft,
  isNewDocument,
  controller,
  touch,
  onSelect,
}: {
  draft: { projectId: string; workId: string; documentId: string; draftId: string };
  isNewDocument: boolean;
  controller: WorkDraftCommands;
  touch: boolean;
  onSelect: (operationIds: readonly string[]) => void;
}) {
  // A new document is applied whole: there is no change list to read.
  const view = useDraftChanges(draft, { controller, enabled: !isNewDocument });
  if (isNewDocument) {
    return (
      <StateLine>
        <Trans>New document. Review it to apply.</Trans>
      </StateLine>
    );
  }
  return (
    <DocumentChangeRows
      view={view}
      touch={touch}
      onSelect={(change) => onSelect(change.operationIds)}
      standIn={
        view.unlisted ? (
          <StateLine>
            <Trans>Formatting changes remain. Review the draft to apply or discard them.</Trans>
          </StateLine>
        ) : view.status === "gone" ? (
          <StateLine>
            <Trans>No changes left</Trans>
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
