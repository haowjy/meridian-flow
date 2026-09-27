/** Route-controlled Work collection/detail management surface. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { parseRequestId } from "@meridian/contracts/request-id";
import type { Work } from "@meridian/contracts/works";
import { Link } from "@tanstack/react-router";
import { ChevronDown, Plus } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { useWorkMutations, useWorks } from "@/client/query/useWorks";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { CreationPage } from "@/features/creation/CreationPage";
import type { ProjectRouteCommands, RouteWorkResolution } from "../routing/project-route";
import { useCreateWork, useWorkCreationRecords, useWorkCreationState } from "./useWorkCreation";
import { WorkCard } from "./WorkCard";
import { WorkDetailScreen } from "./WorkDetailScreen";
import { WorkDialog, type WorkDialogAction } from "./WorkDialog";
import {
  focusAfterDelete,
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
  const routeWorkId =
    props.routeWork.status === "present"
      ? props.routeWork.workId
      : props.routeWork.status === "unresolved"
        ? parseRequestId(props.routeWork.slug)
        : null;
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
        name={creation.name}
        goal={creation.goal}
        failed={creation.status === "failed"}
        onRetry={creation.retry}
        onDiscard={creation.discard}
      />
    );
  }
  if (props.routeWork.status === "present") {
    return (
      <WorkDetailScreen {...props} work={props.routeWork.work} catalogWorks={catalog.works ?? []} />
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
  return <WorkCollectionScreen {...props} />;
}

export function WorkCollectionScreen({ projectId, routeCommands }: WorkScreenProps) {
  const { works, isError, isFetching, refetch } = useWorks(projectId);
  const mutation = useWorkMutations(projectId);
  const creations = useWorkCreationRecords(projectId);
  const [dialog, setDialog] = useState<Work | null>(null);
  const [activeCommand, setActiveCommand] = useState<Exclude<
    WorkDialogAction["type"],
    "create"
  > | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const collectionHeading = useRef<HTMLHeadingElement>(null);
  const newWorkButton = useRef<HTMLButtonElement>(null);
  const openRefs = useRef(new Map<string, HTMLAnchorElement>());
  const lifecycleRefs = useRef(new Map<string, HTMLButtonElement>());
  const archivedDisclosure = useRef<HTMLButtonElement>(null);
  const lifecycleFocus = useRef<{ workId: string; status: Work["status"] } | null>(null);
  const focusHandled = useRef(false);
  const [focusIntent, setFocusIntent] = useState<WorkCollectionFocusIntent | null>(() =>
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
  useEffect(() => {
    const intent = lifecycleFocus.current;
    if (!intent || works === null) return;
    const committed = works.find((work) => work.id === intent.workId);
    if (committed?.status !== intent.status) return;
    const target =
      intent.status === "archived" && !archivedOpen
        ? archivedDisclosure.current
        : lifecycleRefs.current.get(intent.workId);
    if (!target) return;
    target.focus();
    lifecycleFocus.current = null;
  }, [archivedOpen, works]);
  const unfinishedCreations = creations.filter(
    (creation) => creation.status === "pending" || creation.status === "failed",
  );
  const unfinishedIds = new Set(unfinishedCreations.map((creation) => creation.workId));
  const active =
    works?.filter((work) => work.status === "active" && !unfinishedIds.has(work.id)) ?? [];
  const archived =
    works?.filter((work) => work.status === "archived" && !unfinishedIds.has(work.id)) ?? [];
  const headingId = useId();
  const openWorkId = (id: string) => {
    const workId = parseRequestId(id);
    if (workId) void routeCommands.openWork({ kind: "work-detail", workId }, { replace: false });
  };
  const openWork = (work: Work) => {
    openWorkId(work.id);
  };
  const openDialog = (work: Work) => {
    setActiveCommand(null);
    setDialog(work);
  };
  const hrefFor = (work: Work) => {
    return hrefForId(work.id);
  };
  const hrefForId = (id: string) => {
    const workId = parseRequestId(id);
    if (!workId) throw new Error("Invalid persisted Work identity");
    return routeCommands.workHref({ kind: "work-detail", workId });
  };
  return (
    <div className="app-scroll" aria-busy={isFetching}>
      <section className="project-screen-column gap-8">
        <div className="flex items-center justify-between gap-4">
          <h1 ref={collectionHeading} tabIndex={-1} className="text-xl font-semibold">
            <Trans>Work</Trans>
          </h1>
          <Button
            ref={newWorkButton}
            asChild
            size="sm"
            className="[@media(pointer:coarse)]:min-h-11"
          >
            <Link to="/p/$projectId/$" params={{ projectId, _splat: "works/new" }}>
              <Plus className="size-4" />
              <Trans>New Work</Trans>
            </Link>
          </Button>
        </div>
        {unfinishedCreations.length ? (
          <ul className="grid gap-2" aria-label={t`Work creation`}>
            {unfinishedCreations.map((creation) => (
              <li key={creation.workId} className="flex items-center justify-between gap-3">
                <Link
                  to={hrefForId(creation.workId)}
                  onClick={(event) => {
                    if (
                      event.button ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    )
                      return;
                    event.preventDefault();
                    openWorkId(creation.workId);
                  }}
                  className="focus-ring min-w-0 truncate rounded-sm text-sm font-medium hover:underline"
                >
                  {creation.request.name}
                </Link>
                <span
                  className="shrink-0 text-sm text-muted-foreground"
                  role={creation.status === "failed" ? "alert" : "status"}
                >
                  {creation.status === "failed" ? (
                    <Trans>Creation failed</Trans>
                  ) : (
                    <Trans>Creating</Trans>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {isError ? (
          <InlineErrorRow
            message={t`Work couldn’t load`}
            onRetry={refetch}
            actionLabel={t`Retry Work`}
          />
        ) : works === null ? (
          <LoadingCards />
        ) : (
          <>
            <section aria-labelledby="active-work-heading">
              <h2 id="active-work-heading" className="mb-3 text-sm font-medium">
                <Trans>Active Work</Trans>
              </h2>
              {active.length ? (
                <ul className="grid gap-4 @2xl/project-screen:grid-cols-2">
                  {active.map((work) => (
                    <li key={work.id}>
                      <WorkCard
                        work={work}
                        href={hrefFor(work)}
                        pending={mutation.isPending}
                        onOpen={(event) => {
                          if (
                            event.button ||
                            event.metaKey ||
                            event.ctrlKey ||
                            event.shiftKey ||
                            event.altKey
                          )
                            return;
                          event.preventDefault();
                          openWork(work);
                        }}
                        onLifecycle={() => openDialog(work)}
                        registerOpenFocus={(node) => {
                          if (node) openRefs.current.set(work.id, node);
                          else openRefs.current.delete(work.id);
                        }}
                        registerLifecycleFocus={(node) => {
                          if (node) lifecycleRefs.current.set(work.id, node);
                          else lifecycleRefs.current.delete(work.id);
                        }}
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  <Trans>No active Work yet.</Trans>
                </p>
              )}
            </section>
            {archived.length ? (
              <section className="border-t border-border-subtle pt-3" aria-labelledby={headingId}>
                <h2 id={headingId}>
                  <button
                    ref={archivedDisclosure}
                    type="button"
                    aria-expanded={archivedOpen}
                    onClick={() => setArchivedOpen((value) => !value)}
                    className="focus-ring flex min-h-11 w-full items-center justify-between rounded-sm text-sm font-medium"
                  >
                    <span>
                      <Trans>Archived Work</Trans>{" "}
                      <span className="font-normal text-muted-foreground">({archived.length})</span>
                    </span>
                    <ChevronDown
                      className={`size-4 transition-transform ${archivedOpen ? "rotate-180" : ""}`}
                    />
                  </button>
                </h2>
                {archivedOpen ? (
                  <ul className="mt-3 grid gap-4 @2xl/project-screen:grid-cols-2">
                    {archived.map((work) => (
                      <li key={work.id}>
                        <WorkCard
                          work={work}
                          href={hrefFor(work)}
                          pending={mutation.isPending}
                          onOpen={(event) => {
                            if (
                              event.button ||
                              event.metaKey ||
                              event.ctrlKey ||
                              event.shiftKey ||
                              event.altKey
                            )
                              return;
                            event.preventDefault();
                            openWork(work);
                          }}
                          onLifecycle={() => openDialog(work)}
                          registerOpenFocus={(node) => {
                            if (node) openRefs.current.set(work.id, node);
                            else openRefs.current.delete(work.id);
                          }}
                          registerLifecycleFocus={(node) => {
                            if (node) lifecycleRefs.current.set(work.id, node);
                            else lifecycleRefs.current.delete(work.id);
                          }}
                        />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            ) : null}
          </>
        )}
        {dialog ? (
          <WorkDialog
            work={dialog}
            pending={mutation.isPending}
            error={activeCommand ? mutation[activeCommand].error : null}
            onClose={() => {
              setActiveCommand(null);
              setDialog(null);
            }}
            onAction={(action) => {
              if (action.type === "create") return;
              setActiveCommand(action.type);
              const deletionFocus =
                action.type === "delete" ? focusAfterDelete(works ?? [], action.workId) : null;
              if (action.type === "archive" || action.type === "unarchive") {
                lifecycleFocus.current = {
                  workId: action.workId,
                  status: action.type === "archive" ? "archived" : "active",
                };
              }
              const onLifecycleSuccess = () => {
                setDialog(null);
                if (deletionFocus) {
                  focusHandled.current = false;
                  setFocusIntent(deletionFocus);
                }
              };
              const onError = () => {
                lifecycleFocus.current = null;
              };
              switch (action.type) {
                case "archive":
                  mutation.archive.mutate(action.workId, {
                    onSuccess: onLifecycleSuccess,
                    onError,
                  });
                  break;
                case "unarchive":
                  mutation.unarchive.mutate(action.workId, {
                    onSuccess: onLifecycleSuccess,
                    onError,
                  });
                  break;
                case "delete":
                  mutation.delete.mutate(action.workId, {
                    onSuccess: onLifecycleSuccess,
                    onError,
                  });
                  break;
              }
            }}
          />
        ) : null}
      </section>
    </div>
  );
}

function WorkCreationDestination({
  name,
  goal,
  failed,
  onRetry,
  onDiscard,
}: {
  name: string;
  goal: string | null;
  failed: boolean;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="app-scroll">
      <article className="project-screen-column min-w-0 gap-5 pb-12">
        <h1 className="w-fit max-w-full text-xl font-semibold [overflow-wrap:anywhere]">{name}</h1>
        {goal ? <p className="max-w-3xl whitespace-pre-line text-base leading-6">{goal}</p> : null}
        <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
          <span className="size-2 animate-pulse rounded-full bg-jade-text" aria-hidden />
          <Trans>Creating</Trans>
        </div>
        <div className="flex items-center gap-2 border-b pb-3">
          <span className="rounded-md bg-muted px-3 py-1.5 text-sm">
            <Trans>Chats</Trans>
          </span>
          <span className="rounded-md px-3 py-1.5 text-sm text-muted-foreground">
            <Trans>Files</Trans>
          </span>
        </div>
        {failed ? (
          <div
            className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/30 px-3 py-2"
            role="alert"
          >
            <p className="text-sm text-destructive">
              <Trans>Couldn’t create this Work.</Trans>
            </p>
            <Button size="sm" onClick={onRetry}>
              <Trans>Retry</Trans>
            </Button>
            <Button size="sm" variant="outline" onClick={onDiscard}>
              <Trans>Discard</Trans>
            </Button>
          </div>
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

function LoadingCards() {
  return (
    <div
      role="status"
      aria-label={t`Loading Work`}
      className="grid gap-4 @2xl/project-screen:grid-cols-2"
    >
      {[0, 1].map((key) => (
        <Card key={key} className="gap-3 px-5 py-5">
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="h-3 w-4/5" />
        </Card>
      ))}
    </div>
  );
}
