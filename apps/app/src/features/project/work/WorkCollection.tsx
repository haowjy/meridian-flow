/** Collection surface for Work creation and lifecycle: Active, Archived, and Deleted tabs. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { parseRequestId } from "@meridian/contracts/request-id";
import type { Work } from "@meridian/contracts/works";
import { Link } from "@tanstack/react-router";
import { Plus, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { useWorks } from "@/client/query/useWorks";
import { useRestoringWorkIds } from "@/client/query/work-command-selectors";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { useMinuteClock } from "@/hooks/use-minute-clock";
import { cn } from "@/lib/utils";
import type { ProjectRouteCommands } from "../routing/project-route";
import {
  DeletedWorkList,
  RestoreFailure,
  restorableWorks,
  useWorkRestore,
} from "./DeletedWorkList";
import { useArchiveFocusFollow } from "./useArchiveFocusFollow";
import { useWorkArchiveToggle } from "./useWorkArchiveToggle";
import { useWorkCreationRecords } from "./useWorkCreation";
import type { WorkDeletion } from "./useWorkDeletion";
import { WorkActionsMenu } from "./WorkActionsMenu";
import { WorkRow } from "./WorkRow";

export function WorkCollection({
  projectId,
  routeCommands,
  deletion,
}: {
  projectId: string;
  routeCommands: ProjectRouteCommands;
  deletion: WorkDeletion;
}) {
  const { works, deleted, isError, isFetching, refetch } = useWorks(projectId);
  const creations = useWorkCreationRecords(projectId);
  const now = useMinuteClock();
  const view = routeCommands.worksView;
  const restore = useWorkRestore(projectId);
  const restoring = useRestoringWorkIds(projectId);
  const collectionHeading = useRef<HTMLHeadingElement>(null);
  const archiveToggle = useWorkArchiveToggle(projectId);
  const archiveFocus = useArchiveFocusFollow(works, archiveToggle);
  const focusHandled = useRef(false);
  useEffect(() => {
    if (focusHandled.current) return;
    if (works === null) return;
    collectionHeading.current?.focus();
    focusHandled.current = true;
  }, [works]);
  const unfinishedCreations = creations.filter(
    (creation) => creation.status === "pending" || creation.status === "failed",
  );
  const unfinishedIds = new Set(unfinishedCreations.map((creation) => creation.workId));
  // A deleting Work has already left `works`; its Undo row stands in its tab.
  const listed = (status: Work["status"]) =>
    works?.filter((work) => work.status === status && !unfinishedIds.has(work.id)) ?? [];
  const active = listed("active");
  const archived = listed("archived");
  const undoable = new Set(deletion.windows.map((window) => window.workId));
  const openWorkId = (id: string) => {
    const workId = parseRequestId(id);
    if (workId) void routeCommands.openWork({ kind: "work-detail", workId }, { replace: false });
  };
  const hrefForId = (id: string) => {
    const workId = parseRequestId(id);
    if (!workId) throw new Error("Invalid persisted Work identity");
    return routeCommands.workHref({ kind: "work-detail", workId });
  };
  const row = (work: Work) => (
    <WorkRow
      work={work}
      href={hrefForId(work.id)}
      now={now}
      onOpen={() => openWorkId(work.id)}
      actions={
        <WorkActionsMenu
          work={work}
          onToggleArchive={() => archiveFocus.toggleArchive(work)}
          onDelete={() => deletion.remove(work, "list")}
        />
      }
    />
  );
  // A rejected Archive, Unarchive or Delete returns the Work to its tab with
  // the failure under it. A restoring Work already shows in the tab it returns to.
  const failureRow = (work: Work) => {
    const archiveFailure = archiveToggle.failureFor(work.id);
    if (archiveFailure)
      return (
        <InlineErrorRow
          message={
            archiveFailure.operation === "archive"
              ? t`Work couldn’t be archived`
              : t`Work couldn’t be unarchived`
          }
          onRetry={() => archiveFocus.retry(work.id)}
          actionLabel={t`Retry`}
          onDismiss={archiveFailure.dismiss}
        />
      );
    const deleteFailure = deletion.failures.get(work.id);
    if (deleteFailure)
      return (
        <InlineErrorRow
          message={t`Work couldn’t be deleted`}
          onRetry={() => deletion.remove(work, "list")}
          actionLabel={t`Retry`}
          onDismiss={deleteFailure.dismiss}
        />
      );
    return null;
  };
  const listRow = (work: Work) => {
    const failure = failureRow(work);
    return {
      key: work.id,
      node: restoring.has(work.id) ? (
        <WorkRow
          work={work}
          href={hrefForId(work.id)}
          now={now}
          onOpen={() => openWorkId(work.id)}
          status={
            <span role="status">
              <Trans>Restoring</Trans>
            </span>
          }
        />
      ) : failure ? (
        <>
          {row(work)}
          {failure}
        </>
      ) : (
        row(work)
      ),
    };
  };
  // Each deleted Work keeps its own Undo row in the tab it left, newest first.
  const undoRows = (status: Work["status"]) =>
    [...deletion.windows].reverse().flatMap((window) => {
      const work = deleted.find((entry) => entry.id === window.workId);
      if (!work || work.status !== status) return [];
      return [
        {
          key: `deleted-${work.id}`,
          node: (
            <DeletedWorkRow
              name={work.name}
              undoError={window.undoError}
              onUndo={() => deletion.undo(work.id)}
              onDismiss={() => deletion.dismiss(work.id)}
            />
          ),
        },
      ];
    });
  const activeRows: { key: string; node: ReactNode }[] = [
    ...unfinishedCreations.map((creation) => ({
      key: `creation-${creation.workId}`,
      node: (
        <WorkRow
          work={{
            name: creation.request.name,
            goal: creation.request.goal ?? null,
            lastActivityAt: "",
          }}
          href={hrefForId(creation.workId)}
          now={now}
          onOpen={() => openWorkId(creation.workId)}
          status={
            creation.status === "failed" ? (
              <span role="alert" className="text-destructive">
                <Trans>Not created</Trans>
              </span>
            ) : (
              <span role="status">
                <Trans>Creating</Trans>
              </span>
            )
          }
        />
      ),
    })),
    ...undoRows("active"),
    ...active.map(listRow),
  ];
  const archivedRows = [...undoRows("archived"), ...archived.map(listRow)];
  return (
    <div className="app-scroll" aria-busy={isFetching}>
      <section className="project-screen-column">
        <div className="flex items-center justify-between gap-4">
          <h1 ref={collectionHeading} tabIndex={-1} className="text-xl font-semibold">
            <Trans>Work</Trans>
          </h1>
          <Button asChild size="sm" className="[@media(pointer:coarse)]:min-h-11">
            <Link to="/p/$projectId/$" params={{ projectId, _splat: "works/new" }}>
              <Plus aria-hidden />
              <Trans>New Work</Trans>
            </Link>
          </Button>
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
              works={restorableWorks(deleted, now, undoable)}
              now={now}
              restore={restore}
            />
          ) : view === "archived" ? (
            <RowList rows={archivedRows} empty={<Trans>No archived Work.</Trans>} />
          ) : (
            <RowList rows={activeRows} empty={<Trans>No active Work yet.</Trans>} />
          )}
        </div>
      </section>
    </div>
  );
}

function RowList({
  rows,
  empty,
}: {
  rows: readonly { key: string; node: ReactNode }[];
  empty: ReactNode;
}) {
  if (!rows.length) return <p className="px-2 py-2 text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="min-w-0">
      {rows.map((item, index) => (
        <li key={item.key} className={cn("relative", index < rows.length - 1 && "row-rule")}>
          {item.node}
        </li>
      ))}
    </ul>
  );
}

function DeletedWorkRow({
  name,
  undoError,
  onUndo,
  onDismiss,
}: {
  name: string;
  /** Why the writer's last Undo was rejected. */
  undoError: Error | null;
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
  if (!undoError) return row;
  return (
    <>
      {row}
      <div className="px-2">
        <RestoreFailure error={undoError} onRetry={onUndo} />
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
