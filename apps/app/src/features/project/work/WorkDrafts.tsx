/** The Work Files tab's Drafts to review group: manuscript documents with pending drafts from this Work. */
import { t } from "@lingui/core/macro";
import { Plural } from "@lingui/react/macro";
import type { ParsedRequestId } from "@meridian/contracts/request-id";
import { activeWorkDraftGroups, useWorkDrafts } from "@/client/query/useWorkDrafts";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { fileKindIcon } from "../context/context-file-icon";
import { usePostApplyDraftGroupProjections } from "../draft-apply-recovery/DraftApplyRecoveryProvider";
import { RowIcon, RuledList } from "../RuledList";
import type { ProjectRouteCommands } from "../routing/project-route";
import { WorkFileGroup } from "./WorkFileGroup";
import { workFileRowClass } from "./WorkFileRows";
import type { WorkFileSearch } from "./work-files-model";

export function WorkDrafts({
  projectId,
  workId,
  commands,
  matchesSearch,
}: {
  projectId: string;
  workId: ParsedRequestId;
  commands: ProjectRouteCommands;
  matchesSearch: WorkFileSearch;
}) {
  const query = useWorkDrafts(projectId, workId);
  const groups = activeWorkDraftGroups(
    usePostApplyDraftGroupProjections(query.groups, projectId, workId).commandEligibleGroups,
  );
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
            return {
              key: group.documentId,
              node: (
                <button
                  type="button"
                  className={workFileRowClass}
                  disabled={!path}
                  onClick={() => {
                    if (path)
                      void commands.openWorkContext(
                        { kind: "work-context", workId, scheme: "manuscript", path },
                        { replace: false },
                      );
                  }}
                >
                  <RowIcon icon={fileKindIcon(group.documentName || path || "")} />
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {group.documentName || path || t`Untitled manuscript`}
                  </span>
                  <span className="shrink-0 text-xs text-jade-text">
                    <Plural
                      value={group.drafts.length}
                      one="# pending draft"
                      other="# pending drafts"
                    />
                  </span>
                </button>
              ),
            };
          })}
        />
      )}
    </WorkFileGroup>
  );
}
