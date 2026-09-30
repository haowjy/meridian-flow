/** Collection surface for Work creation and lifecycle: Active, Archived, and Deleted tabs. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { Plus, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef } from "react";
import { useWorks } from "@/client/query/useWorks";
import { useRestoringWorkIds, useWorkCommandFailures } from "@/client/query/work-command-selectors";
import { useWorkMutations } from "@/client/query/work-command-store";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { useMinuteClock } from "@/hooks/use-minute-clock";
import { RuledList } from "../RuledList";
import type { ProjectRouteCommands } from "../routing/project-route";
import { DeletedWorkList } from "./DeletedWorkList";
import { useArchiveFocusFollow } from "./useArchiveFocusFollow";
import { useWorkArchiveToggle } from "./useWorkArchiveToggle";
import type { WorkDeletion } from "./useWorkDeletion";
import { WorkActionsMenu } from "./WorkActionsMenu";
import {
  WORK_ROW_OPERATIONS,
  WorkCommandFailureRow,
  type WorkRowFailure,
} from "./WorkCommandFailureRow";
import { WorkRow } from "./WorkRow";
import { type WorkListEntry, workListEntries } from "./work-list-model";

/** The tab an Archive or Unarchive, or its retry, moves the Work to. */
const archiveTarget = (operation: "archive" | "unarchive"): "active" | "archived" =>
  operation === "archive" ? "archived" : "active";

export function WorkCollection({
  projectId,
  routeCommands,
  deletion,
}: {
  projectId: string;
  routeCommands: ProjectRouteCommands;
  deletion: WorkDeletion;
}) {
  const { works, deleted, creations, isError, isFetching, refetch } = useWorks(projectId);
  const now = useMinuteClock();
  const view = routeCommands.worksView;
  const { restore } = useWorkMutations(projectId);
  const restoring = useRestoringWorkIds(projectId);
  const failures = useWorkCommandFailures(projectId, WORK_ROW_OPERATIONS);
  const toggleArchive = useWorkArchiveToggle(projectId);
  const archiveFocus = useArchiveFocusFollow(works);
  const collectionHeading = useRef<HTMLHeadingElement>(null);
  const focusHandled = useRef(false);
  useEffect(() => {
    if (focusHandled.current) return;
    if (works === null) return;
    collectionHeading.current?.focus();
    focusHandled.current = true;
  }, [works]);
  const entries = useMemo(
    () =>
      workListEntries(
        { works: works ?? [], deleted, creations, restoring },
        deletion.windows,
        failures,
        now,
      ),
    [works, deleted, creations, restoring, deletion.windows, failures, now],
  );
  // Focus follows an Archive, or its retry, to the tab the Work moves to.
  const retry = ({ operation, workId, retry }: WorkRowFailure) =>
    operation === "archive" || operation === "unarchive"
      ? () => archiveFocus.follow(workId, archiveTarget(operation), retry())
      : undefined;
  const row = ({ work, state, failure }: WorkListEntry): ReactNode => {
    const target = { kind: "work-detail", workId: work.id } as const;
    const shared = {
      work,
      href: routeCommands.workHref(target),
      now,
      onOpen: () => void routeCommands.openWork(target, { replace: false }),
    };
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
            liveState={
              <span role="alert" className="text-destructive">
                <Trans>Not created</Trans>
              </span>
            }
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
      case "undo":
        return (
          <DeletedWorkRow
            name={work.name}
            failure={failure}
            onUndo={() => deletion.undo(work.id)}
            onDismiss={() => deletion.dismiss(work.id)}
          />
        );
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
                      work.archivedAt !== null ? "active" : "archived",
                      toggleArchive(work),
                    )
                  }
                  onDelete={() => deletion.remove(work, "list")}
                />
              }
            />
            {failure ? <WorkCommandFailureRow failure={failure} onRetry={retry(failure)} /> : null}
          </>
        );
    }
  };
  return (
    <div className="app-scroll" aria-busy={isFetching}>
      <section className="project-screen-column">
        <div className="flex items-center justify-between gap-4">
          <h1 ref={collectionHeading} tabIndex={-1} className="text-xl font-semibold">
            <Trans>Work</Trans>
          </h1>
          <NewWorkButton projectId={projectId} />
        </div>
        <div ref={archiveFocus.tabs} className="sticky top-0 z-10 mt-4 flex bg-background py-2">
          <SegmentedTabs
            label={t`Show Work`}
            value={view}
            onChange={(next) => void routeCommands.setWorksView(next)}
            options={[
              { value: "active", label: <Trans>Active</Trans> },
              { value: "archived", label: <Trans>Archived</Trans> },
              { value: "deleted", label: <Trans>Deleted</Trans> },
            ]}
          />
        </div>
        <div className="mt-2 -mx-2 [--row-rule-inset:--spacing(2)]">
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
              entries={entries.deleted}
              now={now}
              onRestore={(work) => void restore({ workId: work.id })}
            />
          ) : view === "archived" ? (
            <WorkRows
              entries={entries.archived}
              row={row}
              empty={
                <p className="px-2 py-2 text-sm text-muted-foreground">
                  <Trans>No archived Work.</Trans>
                </p>
              }
            />
          ) : (
            <WorkRows
              entries={entries.active}
              row={row}
              empty={<StartWork projectId={projectId} />}
            />
          )}
        </div>
      </section>
    </div>
  );
}

function WorkRows({
  entries,
  row,
  empty,
}: {
  entries: readonly WorkListEntry[];
  row: (entry: WorkListEntry) => ReactNode;
  empty: ReactNode;
}) {
  if (!entries.length) return empty;
  return <RuledList rows={entries.map((entry) => ({ key: entry.key, node: row(entry) }))} />;
}

function NewWorkButton({ projectId, variant }: { projectId: string; variant?: "outline" }) {
  return (
    <Button asChild size="sm" variant={variant} className="[@media(pointer:coarse)]:min-h-11">
      <Link to="/p/$projectId/$" params={{ projectId, _splat: "works/new" }}>
        <Plus aria-hidden />
        <Trans>New Work</Trans>
      </Link>
    </Button>
  );
}

/** The Active tab with no Work: what a Work is for, and the way to start one. */
function StartWork({ projectId }: { projectId: string }) {
  return (
    <div className="flex flex-col items-center px-2 py-16 text-center sm:py-20">
      <h2 className="text-base font-semibold text-foreground">
        <Trans>Start a Work</Trans>
      </h2>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        <Trans>A Work groups the chats and drafts for one piece of writing.</Trans>
      </p>
      <div className="mt-5">
        <NewWorkButton projectId={projectId} variant="outline" />
      </div>
    </div>
  );
}

function DeletedWorkRow({
  name,
  failure,
  onUndo,
  onDismiss,
}: {
  name: string;
  /** The writer's last Undo, rejected. */
  failure: WorkRowFailure | undefined;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const row = (
    <div
      role="status"
      className="flex min-h-12 min-w-0 items-center gap-3 px-2 py-1.5 text-sm text-muted-foreground"
    >
      <span className="min-w-0 truncate">
        <Trans>Deleted {name}</Trans>
      </span>
      <button type="button" className="text-button shrink-0 text-sm" onClick={onUndo}>
        <Trans>Undo</Trans>
      </button>
      <IconButton
        size="sm"
        className="ml-auto shrink-0 [@media(pointer:coarse)]:size-11"
        aria-label={t`Dismiss`}
        onClick={onDismiss}
      >
        <X aria-hidden className="size-4" />
      </IconButton>
    </div>
  );
  if (!failure) return row;
  return (
    <>
      {row}
      <div className="px-2">
        <WorkCommandFailureRow failure={failure} />
      </div>
    </>
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
