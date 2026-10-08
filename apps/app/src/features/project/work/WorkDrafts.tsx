/** The Work Files tab's Drafts to review group: manuscript documents with pending drafts from this Work. */
import { t } from "@lingui/core/macro";
import type { ParsedRequestId } from "@meridian/contracts/request-id";
import {
  clearDraftCommandFailure,
  draftCommandFailure,
  useDraftCommandRecords,
} from "@/client/query/draft-command-record";
import { activeWorkDraftGroups, useWorkDrafts } from "@/client/query/useWorkDrafts";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { sortDraftFiles } from "@/features/chat/docked-drafts";
import { ReviewMessageText } from "@/features/chat/ReviewMessageText";
import { fileKindIcon } from "../context/context-file-icon";
import { useAiDraftLauncher } from "../dock/useAiDraftLauncher";
import { RowIcon, RuledList } from "../RuledList";
import { WorkFileGroup } from "./WorkFileGroup";
import { workFileRowClass } from "./WorkFileRows";
import type { WorkFileSearch } from "./work-files-model";

export function WorkDrafts({
  projectId,
  workId,
  matchesSearch,
}: {
  projectId: string;
  workId: ParsedRequestId;
  matchesSearch: WorkFileSearch;
}) {
  const { openAiDraft } = useAiDraftLauncher();
  const query = useWorkDrafts(projectId, workId);
  const commandRecords = useDraftCommandRecords();
  // The same file order as every other list of drafts, not most-recently-updated first.
  const groups = sortDraftFiles(activeWorkDraftGroups(query.groups));
  const visible = groups.filter((group) =>
    matchesSearch(group.documentName || group.contextPath || ""),
  );
  // Drafts appear only when there is something to review; never a loading flash.
  if (query.status !== "error" && visible.length === 0) return null;
  return (
    <WorkFileGroup label={t`Drafts to review`}>
      {query.status === "error" ? (
        <InlineErrorRow
          message={t`Pending drafts couldn’t load`}
          onRetry={query.refetch}
          actionLabel={t`Retry Pending drafts`}
        />
      ) : (
        <RuledList
          className="-mx-2"
          rows={visible.map((group) => {
            const path = group.contextPath;
            const draft = {
              projectId,
              workId,
              documentId: group.documentId,
              draftId: group.draft.draftId,
            };
            const refused = draftCommandFailure(commandRecords, draft);
            return {
              key: group.documentId,
              node: (
                <>
                  <button
                    type="button"
                    className={workFileRowClass}
                    disabled={!path}
                    onClick={() => {
                      if (path)
                        openAiDraft({
                          workId,
                          documentId: group.documentId,
                          draftId: group.draft.draftId,
                          contextPath: path,
                          documentName: group.documentName ?? undefined,
                          isNewDocument: group.draft.isNewDocument === true,
                        });
                    }}
                  >
                    <RowIcon icon={fileKindIcon(group.documentName || path || "")} />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {group.documentName || path || t`Untitled manuscript`}
                    </span>
                    <span className="shrink-0 text-xs text-jade-text">{t`Pending draft`}</span>
                  </button>
                  {refused ? (
                    <InlineErrorRow
                      message={<ReviewMessageText failure={refused} />}
                      onDismiss={() => clearDraftCommandFailure(draft)}
                    />
                  ) : null}
                </>
              ),
            };
          })}
        />
      )}
    </WorkFileGroup>
  );
}
