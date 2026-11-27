import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { useWorks } from "@/client/query/useWorks";
import { useRestoringWorkIds, useWorkCommandFailures } from "@/client/query/work-command-selectors";
import { useWorkMutations } from "@/client/query/work-mutations";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { RowWord, withGone } from "@/components/app/RowWord";
import { Button } from "@/components/ui/button";
import { ListLine } from "@/components/ui/list-row";
import { role } from "@/components/ui/roles";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { useClock } from "@/hooks/use-clock";
import { RuledList } from "../RuledList";
import { DeletedWorkList } from "./DeletedWorkList";
import { GoneWord } from "./GoneWord";
import { useArchiveFocusFollow } from "./useArchiveFocusFollow";
import { useWorkArchiveToggle } from "./useWorkArchiveToggle";
import {
  rememberWorkPlace,
  takeWorkFocus,
  type WorkDeletion,
  type WorkPlace,
  workPlace,
} from "./useWorkDeletion";
import { WorkActionsMenu } from "./WorkActionsMenu";
import {
  WORK_ROW_OPERATIONS,
  WorkCommandFailureRow,
  type WorkRowFailure,
  workFailureLine,
} from "./WorkCommandFailureRow";
import { WorkRow } from "./WorkRow";
import {
  type ArchiveTab,
  archiveTab,
  type WorkListEntry,
  workListEntries,
} from "./work-list-model";

const archiveTarget = (operation: "archive" | "unarchive"): ArchiveTab =>
  operation === "archive" ? "archived" : "active";

export type WorksListTab = "active" | "archived" | "deleted";

export function WorkCollection({
  projectId,
  view,
  onViewChange,
  onOpen,
  onNew,
  deletion,
}: {
  projectId: string;
  view: WorksListTab;
  onViewChange: (view: WorksListTab) => void;
  onOpen: (workId: string) => void;
  onNew: () => void;
  deletion: WorkDeletion;
}) {
  const { works, deleted, creations, nameOf, isError, isFetching, refetch } = useWorks(projectId);
  const now = useClock(60_000);
  const { restore } = useWorkMutations(projectId);
  const restoring = useRestoringWorkIds(projectId);
  const failures = useWorkCommandFailures(projectId, WORK_ROW_OPERATIONS);
  const toggleArchive = useWorkArchiveToggle(projectId);
  const archiveFocus = useArchiveFocusFollow(works);
  const entries = useMemo(
    () =>
      workListEntries(
        { works: works ?? [], deleted, creations, restoring },
        deletion.windows,
        failures,
        workPlace,
      ),
    [works, deleted, creations, restoring, deletion.windows, failures],
  );
  const retry = ({ operation, workId, retry }: WorkRowFailure) =>
    operation === "archive" || operation === "unarchive"
      ? () => archiveFocus.follow(workId, archiveTarget(operation), retry())
      : undefined;
  const row = (entry: WorkListEntry, place?: WorkPlace): ReactNode => {
    if (entry.state === "gone")
      return (
        <WorkRow
          projectId={projectId}
          work={{ id: entry.work.id, name: entry.work.name, goal: null }}
          now={now}
          onOpen={() => undefined}
          gone
          notice={<GoneWord entry={entry} />}
        />
      );
    const { work, state, failure } = entry;
    const shared = { projectId, work, now, onOpen: () => onOpen(work.id) };
    switch (state) {
      case "creating":
        return (
          <WorkRow
            {...shared}
            liveState={
              <span role="status">
                <Trans>Creating</Trans>
              </span>
            }
          />
        );
      case "notCreated":
        return (
          <WorkRow
            {...shared}
            liveState={<InlineErrorRow message={<Trans>Not created</Trans>} className="p-0" />}
          />
        );
      case "restoring":
        return (
          <WorkRow
            {...shared}
            liveState={
              <span role="status">
                <Trans>Restoring</Trans>
              </span>
            }
          />
        );
      case "undo": {
        const name = nameOf(work);
        const line = failure ? workFailureLine(failure, { name }) : null;
        return (
          <WorkRow
            {...shared}
            gone
            notice={
              line ? (
                <RowWord
                  tone="warning"
                  word={line.onRetry ? <Trans>Retry</Trans> : <Trans>Not restored</Trans>}
                  label={line.onRetry ? t`Retry restoring ${name}` : undefined}
                  sentence={line.message}
                  onAction={line.onRetry}
                />
              ) : (
                <RowWord
                  word={<Trans>Undo</Trans>}
                  label={t`Undo delete of ${name}`}
                  sentence={t`Deleted just now`}
                  onAction={() => deletion.undo(work)}
                  focus={{ take: () => takeWorkFocus(work.id), back: () => workRowOf(work.id) }}
                />
              )
            }
          />
        );
      }
      case "idle":
        return (
          <>
            <WorkRow
              {...shared}
              actions={
                <WorkActionsMenu
                  work={work}
                  onToggleArchive={() =>
                    archiveFocus.follow(
                      work.id,
                      archiveTab(work) === "archived" ? "active" : "archived",
                      toggleArchive(work),
                    )
                  }
                  onDelete={() => deletion.remove(work, place)}
                />
              }
            />
            {failure ? <WorkCommandFailureRow failure={failure} onRetry={retry(failure)} /> : null}
          </>
        );
    }
  };
  return (
    <section aria-busy={isFetching} className="flex min-h-0 flex-1 flex-col">
      <div
        ref={archiveFocus.tabs}
        className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pb-2"
      >
        <SegmentedTabs
          label={t`Show Work`}
          value={view}
          onChange={onViewChange}
          options={[
            { value: "active", label: <Trans>Active</Trans> },
            { value: "archived", label: <Trans>Archived</Trans> },
            { value: "deleted", label: <Trans>Deleted</Trans> },
          ]}
        />
        <NewWorkButton onNew={onNew} />
      </div>
      <div className="-mx-2 min-h-0 flex-1 overflow-y-auto [--row-rule-inset:--spacing(2)]">
        {isError ? (
          <div className="px-2">
            <InlineErrorRow
              message={t`Work couldn’t load`}
              onRetry={refetch}
              actionLabel={t`Retry Work`}
            />
          </div>
        ) : works === null ? (
          <LoadingRows />
        ) : view === "deleted" ? (
          <DeletedWorkList
            projectId={projectId}
            entries={entries.deleted}
            list={`works:${projectId}:deleted`}
            onRestore={(work, place) => {
              rememberWorkPlace(work.id, place);
              void restore({ workId: work.id, name: work.name });
            }}
          />
        ) : view === "archived" ? (
          <WorkRows
            list={`works:${projectId}:archived`}
            entries={entries.archived}
            row={row}
            empty={
              <div className="px-0.5">
                <ListLine>
                  <Trans>No archived Work.</Trans>
                </ListLine>
              </div>
            }
          />
        ) : (
          <WorkRows
            list={`works:${projectId}:active`}
            entries={entries.active}
            row={row}
            empty={<StartWork onNew={onNew} />}
          />
        )}
      </div>
    </section>
  );
}

const workRowOf = (workId: string) =>
  document.querySelector<HTMLElement>(`[data-work-id="${CSS.escape(workId)}"]`);

function WorkRows({
  list,
  entries,
  row,
  empty,
}: {
  list: string;
  entries: readonly WorkListEntry[];
  row: (entry: WorkListEntry, place?: WorkPlace) => ReactNode;
  empty: ReactNode;
}) {
  const standsIn = (entry: WorkListEntry) => entry.state === "undo" || entry.state === "gone";
  const listed = entries.filter((entry) => !standsIn(entry));
  const undo = entries.filter(standsIn);
  const here = (entry: WorkListEntry) => workPlace(entry.work.id)?.list === list;
  const ids = listed.map((entry) => entry.work.id);
  const rows = [
    ...undo.filter((entry) => !here(entry)).map((entry) => ({ entry, place: undefined })),
    ...withGone(
      listed,
      (entry) => entry.work.id,
      undo.filter(here).map((entry) => ({
        key: entry.work.id,
        row: entry,
        after: workPlace(entry.work.id)?.after ?? [],
      })),
    ).map(({ row: entry, gone }) =>
      gone
        ? { entry, place: undefined }
        : { entry, place: { list, after: ids.slice(0, ids.indexOf(entry.work.id)).reverse() } },
    ),
  ];
  if (!rows.length) return empty;
  return (
    <RuledList
      rows={rows.map(({ entry, place }) => ({ key: entry.key, node: row(entry, place) }))}
    />
  );
}

function NewWorkButton({ onNew, variant }: { onNew: () => void; variant?: "outline" }) {
  return (
    <Button
      size="sm"
      variant={variant}
      onClick={onNew}
      className="[@media(pointer:coarse)]:min-h-11"
    >
      <Plus aria-hidden />
      <Trans>New Work</Trans>
    </Button>
  );
}

function StartWork({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex flex-col items-center px-2 py-16 text-center sm:py-20">
      <h2 className={role.sectionHeading}>
        <Trans>Start a Work</Trans>
      </h2>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        <Trans>A Work groups the chats and drafts for one piece of writing.</Trans>
      </p>
      <div className="mt-5">
        <NewWorkButton onNew={onNew} variant="outline" />
      </div>
    </div>
  );
}

function LoadingRows() {
  return (
    <div role="status" aria-label={t`Loading Work`} className="space-y-5 px-2 py-2">
      {[0, 1, 2].map((key) => (
        <div key={key} className="space-y-1.5">
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="h-3 w-3/5" />
        </div>
      ))}
    </div>
  );
}
