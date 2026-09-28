/** Collection surface for Work creation, lifecycle, and list rows. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { parseRequestId } from "@meridian/contracts/request-id";
import type { Work } from "@meridian/contracts/works";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Plus, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useWorks } from "@/client/query/useWorks";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { SectionLabel } from "@/components/ui/section-label";
import { Skeleton } from "@/components/ui/skeleton";
import { useMinuteClock } from "@/hooks/use-minute-clock";
import { cn } from "@/lib/utils";
import type { ProjectRouteCommands } from "../routing/project-route";
import { RecentlyDeletedWork, restorableWorks, useWorkRestore } from "./RecentlyDeletedWork";
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
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [deletedOpen, setDeletedOpen] = useState(false);
  const restore = useWorkRestore(projectId);
  const collectionHeading = useRef<HTMLHeadingElement>(null);
  const deleteState = deletion.state;
  const archiveToggle = useWorkArchiveToggle(projectId);
  const archiveFocus = useArchiveFocusFollow(works, archivedOpen, archiveToggle.toggle);
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
  const active =
    works?.filter(
      (work) =>
        work.status === "active" &&
        !unfinishedIds.has(work.id) &&
        deleteState.failed?.id !== work.id &&
        !(deleteState.deleted?.id === work.id && !deleteState.restorePending),
    ) ?? [];
  const archived =
    works?.filter((work) => work.status === "archived" && !unfinishedIds.has(work.id)) ?? [];
  const failedWork = deleteState.failed;
  const restoring = deleted.find((work) => work.id === restore.restoringId);
  const undoableId =
    deleteState.deleted && !deleteState.restorePending ? deleteState.deleted.id : undefined;
  const archivedListId = useId();
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
      registerOpenFocus={archiveFocus.registerOpenFocus(work.id)}
      actions={
        <WorkActionsMenu
          work={work}
          disabled={archiveToggle.isPending}
          onToggleArchive={() => archiveFocus.toggleArchive(work)}
          onDelete={() => deletion.remove(work, "list")}
        />
      }
    />
  );
  const activeRows: { key: string; node: React.ReactNode }[] = [
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
    ...(deleteState.deleted && !deleteState.restorePending
      ? [
          {
            key: `deleted-${deleteState.deleted.id}`,
            node: (
              <DeletedWorkRow
                name={deleteState.deleted.name}
                onUndo={deletion.undo}
                onDismiss={deletion.dismiss}
              />
            ),
          },
        ]
      : []),
    ...(failedWork
      ? [
          {
            key: `failed-${failedWork.id}`,
            node: (
              <>
                {row(failedWork)}
                <InlineErrorRow
                  message={t`Work couldn’t be deleted`}
                  onRetry={deletion.retry}
                  actionLabel={t`Retry`}
                />
              </>
            ),
          },
        ]
      : []),
    ...(restoring
      ? [
          {
            key: restoring.id,
            node: (
              <WorkRow
                work={restoring}
                href={hrefForId(restoring.id)}
                now={now}
                onOpen={() => openWorkId(restoring.id)}
                status={
                  <span role="status">
                    <Trans>Restoring</Trans>
                  </span>
                }
              />
            ),
          },
        ]
      : []),
    ...active.map((work) => ({ key: work.id, node: row(work) })),
  ];
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
        <div className="mt-6 -mx-2 [--row-rule-inset:--spacing(2)]">
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
          ) : (
            <>
              <section aria-label={t`Active Work`}>
                <h2 className="px-2 pb-2">
                  <SectionLabel variant="group">
                    <Trans>Active</Trans>
                  </SectionLabel>
                </h2>
                {activeRows.length ? (
                  <ul className="min-w-0">
                    {activeRows.map((item, index) => (
                      <li
                        key={item.key}
                        className={cn("relative", index < activeRows.length - 1 && "row-rule")}
                      >
                        {item.node}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="px-2 py-2 text-sm text-muted-foreground">
                    <Trans>No active Work yet.</Trans>
                  </p>
                )}
              </section>
              {archived.length ? (
                <section data-disclosure className="pt-7" aria-label={t`Archived Work`}>
                  <h2>
                    <button
                      ref={archiveFocus.archivedDisclosure}
                      type="button"
                      aria-expanded={archivedOpen}
                      aria-controls={archivedListId}
                      onClick={() => setArchivedOpen((value) => !value)}
                      className="focus-ring flex min-h-8 items-center gap-1.5 rounded-sm px-2 [@media(pointer:coarse)]:min-h-11"
                    >
                      <SectionLabel variant="group">
                        <Trans>Archived</Trans>
                      </SectionLabel>
                      <span className="text-meta tabular-nums text-ink-subtle">
                        {archived.length}
                      </span>
                      <ChevronRight
                        aria-hidden
                        className={cn(
                          "size-3.5 text-ink-subtle transition-transform motion-reduce:transition-none",
                          archivedOpen && "rotate-90",
                        )}
                      />
                    </button>
                  </h2>
                  {archivedOpen ? (
                    <ul id={archivedListId} className="mt-1 min-w-0">
                      {archived.map((work, index) => (
                        <li
                          key={work.id}
                          className={cn("relative", index < archived.length - 1 && "row-rule")}
                        >
                          {row(work)}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </section>
              ) : null}
              <RecentlyDeletedWork
                works={restorableWorks(deleted, now, undoableId)}
                now={now}
                restore={restore}
                open={deletedOpen}
                onOpenChange={setDeletedOpen}
              />
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function DeletedWorkRow({
  name,
  onUndo,
  onDismiss,
}: {
  name: string;
  onUndo?: () => void;
  onDismiss?: () => void;
}) {
  return (
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
