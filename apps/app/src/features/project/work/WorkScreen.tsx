/** Route-controlled Work collection/detail management surface. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { parseRequestId } from "@meridian/contracts/request-id";
import type { Work } from "@meridian/contracts/works";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Plus, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { useWorkMutations, useWorks } from "@/client/query/useWorks";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { SectionLabel } from "@/components/ui/section-label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { CreationPage } from "@/features/creation/CreationPage";
import { useMinuteClock } from "@/hooks/use-minute-clock";
import { cn } from "@/lib/utils";
import type { ProjectRouteCommands, RouteWorkResolution } from "../routing/project-route";
import { useCreateWork, useWorkCreationRecords, useWorkCreationState } from "./useWorkCreation";
import { WorkActionsMenu } from "./WorkActionsMenu";
import { WorkDetailScreen, WorkScreenHeader } from "./WorkDetailScreen";
import { WorkRow } from "./WorkRow";
import {
  emptyWorkDeleteState,
  type WorkDeleteState,
  workDeleteTransition,
} from "./work-delete-state";
import {
  holdWorkCollectionFocus,
  takeWorkCollectionFocus,
  type WorkCollectionFocusIntent,
} from "./work-focus-intent";

export type WorkScreenProps = {
  projectId: string;
  routeWork: RouteWorkResolution;
  routeCommands: ProjectRouteCommands;
};

export function WorkScreen(props: WorkScreenProps) {
  const createWork = useCreateWork(props.projectId, props.routeCommands);
  const catalog = useWorks(props.projectId);
  const mutations = useWorkMutations(props.projectId);
  const [deleteState, setDeleteState] = useState<WorkDeleteState>(emptyWorkDeleteState);
  const deleteWork = (work: Work, from: "detail" | "list") => {
    setDeleteState((state) => workDeleteTransition(state, { type: "delete", work }));
    if (from === "detail") {
      holdWorkCollectionFocus(props.projectId, { kind: "heading" });
      void props.routeCommands.closeWork({ replace: true });
    }
    mutations.delete.mutate(work.id, {
      onError: () =>
        setDeleteState((state) => workDeleteTransition(state, { type: "delete-failed" })),
    });
  };
  const retryDelete = () => {
    const work = deleteState.failed;
    if (!work) return;
    setDeleteState((state) => workDeleteTransition(state, { type: "retry" }));
    mutations.delete.mutate(work.id, {
      onError: () =>
        setDeleteState((state) => workDeleteTransition(state, { type: "delete-failed" })),
    });
  };
  const undoDelete = () => {
    const work = deleteState.deleted;
    if (!work) return;
    setDeleteState((state) => workDeleteTransition(state, { type: "undo" }));
    mutations.restore.mutate(work.id, {
      onSuccess: () => setDeleteState(emptyWorkDeleteState()),
      onError: () =>
        setDeleteState((state) => workDeleteTransition(state, { type: "restore-failed" })),
    });
  };
  const routeWorkId =
    props.routeWork.status === "present"
      ? props.routeWork.workId
      : props.routeWork.status === "unresolved"
        ? parseRequestId(props.routeWork.slug)
        : null;
  useEffect(() => {
    if (props.routeWork.status === "new") {
      setDeleteState(emptyWorkDeleteState());
      return;
    }
    if (
      props.routeWork.status === "present" &&
      (deleteState.failed || (deleteState.deleted && routeWorkId !== deleteState.deleted.id))
    ) {
      setDeleteState(emptyWorkDeleteState());
    }
  }, [deleteState.deleted, deleteState.failed, props.routeWork.status, routeWorkId]);
  const creation = useWorkCreationState(props.projectId, routeWorkId, props.routeCommands);
  if (props.routeWork.status === "new") {
    return (
      <NewWorkPage projectId={props.projectId} onCreate={(request) => createWork.create(request)} />
    );
  }
  if (
    creation.status !== "none" &&
    creation.status !== "confirmed" &&
    routeWorkId &&
    creation.name
  ) {
    return (
      <WorkCreationDestination
        projectId={props.projectId}
        name={creation.name}
        goal={creation.goal}
        failed={creation.status === "failed"}
        routeCommands={props.routeCommands}
        onRetry={creation.retry}
        onDiscard={creation.discard}
      />
    );
  }
  if (props.routeWork.status === "present") {
    return (
      <WorkDetailScreen
        {...props}
        work={props.routeWork.work}
        onDeleteWork={(work) => deleteWork(work, "detail")}
      />
    );
  }
  if (props.routeWork.status === "unresolved" && props.routeWork.reason === "error") {
    return (
      <div className="app-scroll">
        <div className="project-screen-column">
          <InlineErrorRow
            message={t`Work couldn’t load`}
            onRetry={catalog.refetch}
            actionLabel={t`Retry Work`}
          />
        </div>
      </div>
    );
  }
  if (props.routeWork.status === "unresolved") {
    return (
      <div className="app-scroll">
        <div className="project-screen-column">
          <p className="text-sm text-muted-foreground">
            <Trans>Loading Work…</Trans>
          </p>
        </div>
      </div>
    );
  }
  return (
    <WorkCollectionScreen
      {...props}
      deleteState={deleteState}
      onDeleteWork={(work) => deleteWork(work, "list")}
      onUndoDelete={undoDelete}
      onDismissDelete={() => setDeleteState(emptyWorkDeleteState())}
      onRetryDelete={retryDelete}
    />
  );
}

export function WorkCollectionScreen({
  projectId,
  routeCommands,
  deleteState = emptyWorkDeleteState(),
  onDeleteWork,
  onUndoDelete,
  onDismissDelete,
  onRetryDelete,
}: WorkScreenProps & {
  deleteState?: WorkDeleteState;
  onDeleteWork?: (work: Work) => void;
  onUndoDelete?: () => void;
  onDismissDelete?: () => void;
  onRetryDelete?: () => void;
}) {
  const { works, isError, isFetching, refetch } = useWorks(projectId);
  const mutation = useWorkMutations(projectId);
  const creations = useWorkCreationRecords(projectId);
  const now = useMinuteClock();
  const [archivedOpen, setArchivedOpen] = useState(false);
  const collectionHeading = useRef<HTMLHeadingElement>(null);
  const newWorkButton = useRef<HTMLAnchorElement>(null);
  const openRefs = useRef(new Map<string, HTMLAnchorElement>());
  const archivedDisclosure = useRef<HTMLButtonElement>(null);
  const lifecycleFocus = useRef<{ workId: string; status: Work["status"] } | null>(null);
  const focusHandled = useRef(false);
  const [focusIntent] = useState<WorkCollectionFocusIntent | null>(() =>
    takeWorkCollectionFocus(projectId),
  );
  useEffect(() => {
    if (focusHandled.current) return;
    if (works === null) return;
    if (!focusIntent || focusIntent.kind === "heading") {
      collectionHeading.current?.focus();
      focusHandled.current = true;
      return;
    }
    if (focusIntent.kind === "new-work") {
      newWorkButton.current?.focus();
      focusHandled.current = true;
      return;
    }
    const target = works.find((work) => work.id === focusIntent.workId);
    if (target?.status === "archived" && !archivedOpen) {
      setArchivedOpen(true);
      return;
    }
    const node = openRefs.current.get(focusIntent.workId);
    if (node) {
      node.focus();
      focusHandled.current = true;
    }
  }, [archivedOpen, focusIntent, works]);
  // After Archive or Unarchive, focus follows the row to its new section.
  useEffect(() => {
    const intent = lifecycleFocus.current;
    if (!intent || works === null) return;
    const committed = works.find((work) => work.id === intent.workId);
    if (committed?.status !== intent.status) return;
    const target =
      intent.status === "archived" && !archivedOpen
        ? archivedDisclosure.current
        : openRefs.current.get(intent.workId);
    if (!target) return;
    target.focus();
    lifecycleFocus.current = null;
  }, [archivedOpen, works]);
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
  const registerOpen = (id: string) => (node: HTMLAnchorElement | null) => {
    if (node) openRefs.current.set(id, node);
    else openRefs.current.delete(id);
  };
  const toggleArchive = (work: Work) => {
    const archiving = work.status !== "archived";
    lifecycleFocus.current = { workId: work.id, status: archiving ? "archived" : "active" };
    (archiving ? mutation.archive : mutation.unarchive).mutate(work.id, {
      onError: () => {
        lifecycleFocus.current = null;
      },
    });
  };
  const row = (work: Work) => (
    <WorkRow
      work={work}
      href={hrefForId(work.id)}
      now={now}
      onOpen={() => openWorkId(work.id)}
      registerOpenFocus={registerOpen(work.id)}
      actions={
        <WorkActionsMenu
          work={work}
          disabled={mutation.isPending}
          onToggleArchive={() => toggleArchive(work)}
          onDelete={() => onDeleteWork?.(work)}
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
                onUndo={onUndoDelete}
                onDismiss={onDismissDelete}
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
                  onRetry={onRetryDelete}
                  actionLabel={t`Retry`}
                />
              </>
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
            <Link
              ref={newWorkButton}
              to="/p/$projectId/$"
              params={{ projectId, _splat: "works/new" }}
            >
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
                <section className="pt-7" aria-label={t`Archived Work`}>
                  <h2>
                    <button
                      ref={archivedDisclosure}
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

export function WorkCreationDestination({
  projectId,
  name,
  goal,
  failed,
  routeCommands,
  onRetry,
  onDiscard,
}: {
  projectId: string;
  name: string;
  goal: string | null;
  failed: boolean;
  routeCommands: ProjectRouteCommands;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="app-scroll">
      <article className="project-screen-column min-w-0 gap-5 pb-12">
        <WorkScreenHeader
          onBack={() => {
            holdWorkCollectionFocus(projectId, { kind: "heading" });
            void routeCommands.closeWork({ replace: true });
          }}
          title={
            <h1 className="min-w-0 max-w-full text-xl font-semibold [overflow-wrap:anywhere]">
              {name}
            </h1>
          }
          description={
            goal ? <p className="max-w-3xl whitespace-pre-line text-body">{goal}</p> : null
          }
          status={
            <div
              className={`flex items-center gap-2 text-xs ${failed ? "text-destructive" : "text-muted-foreground"}`}
              role="status"
            >
              {!failed ? (
                <span className="size-2 animate-pulse rounded-full bg-jade-text" aria-hidden />
              ) : null}
              {failed ? <Trans>Not created</Trans> : <Trans>Creating</Trans>}
            </div>
          }
          view="chats"
          onViewChange={() => {}}
          pending
          tools={
            <>
              <div className="relative min-w-0 flex-1">
                <Input
                  type="search"
                  aria-label={t`Search chats`}
                  placeholder={t`Search chats`}
                  disabled
                  className="h-8 [@media(pointer:coarse)]:h-11"
                />
              </div>
              <Button size="sm" disabled className="[@media(pointer:coarse)]:min-h-11">
                <Trans>New chat</Trans>
              </Button>
            </>
          }
        />
        {failed ? (
          <>
            <p className="text-sm text-destructive" role="alert">
              <Trans>Couldn’t create this Work.</Trans>
            </p>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={onRetry}>
                <Trans>Retry</Trans>
              </Button>
              <Button size="sm" variant="outline" onClick={onDiscard}>
                <Trans>Discard</Trans>
              </Button>
            </div>
          </>
        ) : null}
        <div className="py-2">
          <p className="text-sm font-medium">
            <Trans>Start a chat in this Work</Trans>
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            <Trans>Chats you start here stay with this Work.</Trans>
          </p>
        </div>
      </article>
    </div>
  );
}

function NewWorkPage({
  projectId,
  onCreate,
}: {
  projectId: string;
  onCreate: (request: { name: string; goal?: string }) => void;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  return (
    <CreationPage
      backTo={`/p/${projectId}/works`}
      backLabel={"All Work"}
      title={"New Work"}
      submitLabel={"Create Work"}
      onSubmit={() =>
        onCreate({
          name: nameRef.current?.value ?? "",
          goal: descriptionRef.current?.value.trim() || undefined,
        })
      }
    >
      <div className="grid gap-1.5">
        <label htmlFor="work-name" className="text-sm font-medium">
          <Trans>Name</Trans>
        </label>
        <Input
          ref={nameRef}
          id="work-name"
          name="creation-name"
          autoFocus
          autoComplete="off"
          maxLength={120}
          placeholder="Name this Work"
          className="h-[38px] bg-card text-[15px]"
        />
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="work-description" className="text-sm font-medium">
          <Trans>What is this Work for?</Trans>{" "}
          <span className="font-normal text-muted-foreground">
            <Trans>Optional</Trans>
          </span>
        </label>
        <Textarea
          ref={descriptionRef}
          id="work-description"
          placeholder="The purpose or context for this Work"
          className="min-h-16 resize-none bg-card text-sm"
        />
        <p className="text-xs text-muted-foreground">
          <Trans>The AI reads this in every chat in this Work.</Trans>
        </p>
      </div>
    </CreationPage>
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
