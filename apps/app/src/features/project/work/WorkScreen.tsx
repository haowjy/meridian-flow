/** Route-controlled Work collection/detail management surface. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { parseRequestId } from "@meridian/contracts/request-id";
import type { Work } from "@meridian/contracts/works";
import { ChevronDown, Plus } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { useWorkMutations, useWorks } from "@/client/query/useWorks";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { ProjectRouteCommands, RouteWorkResolution } from "../routing/project-route";
import { WorkCard } from "./WorkCard";
import { WorkDetailScreen } from "./WorkDetailScreen";
import { WorkDialog } from "./WorkDialog";
import { WorkResourceError } from "./WorkResourceState";
import {
  focusAfterDelete,
  takeWorkCollectionFocus,
  type WorkCollectionFocusIntent,
} from "./work-focus-intent";

export type WorkScreenProps = {
  projectId: string;
  routeWork: RouteWorkResolution;
  routeCommands: ProjectRouteCommands;
  onOpenThread: (threadId: string) => void;
};

export function WorkScreen(props: WorkScreenProps) {
  const catalog = useWorks(props.projectId);
  if (props.routeWork.status === "present") {
    return (
      <WorkDetailScreen {...props} work={props.routeWork.work} catalogWorks={catalog.works ?? []} />
    );
  }
  if (props.routeWork.status === "catalog-error") {
    return (
      <div className="app-scroll">
        <div className="project-screen-column">
          <WorkResourceError label={t`Work`} retry={catalog.refetch} />
        </div>
      </div>
    );
  }
  if (props.routeWork.status === "loading") {
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
  const [dialog, setDialog] = useState<"new" | Work | null>(null);
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
  const active = works?.filter((work) => work.status === "active") ?? [];
  const archived = works?.filter((work) => work.status === "archived") ?? [];
  const headingId = useId();
  const openWork = (work: Work) => {
    const workId = parseRequestId(work.id);
    if (workId) void routeCommands.openWork({ kind: "work-detail", workId }, { replace: false });
  };
  const hrefFor = (work: Work) => {
    const workId = parseRequestId(work.id);
    return workId ? routeCommands.workHref({ kind: "work-detail", workId }) : "?screen=work";
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
            size="sm"
            className="[@media(pointer:coarse)]:min-h-11"
            onClick={() => setDialog("new")}
          >
            <Plus className="size-4" />
            <Trans>New Work</Trans>
          </Button>
        </div>
        {isError ? (
          <WorkResourceError label={t`Work`} retry={refetch} />
        ) : works === null ? (
          <LoadingCards />
        ) : (
          <>
            <section aria-labelledby="active-work-heading">
              <h2 id="active-work-heading" className="mb-3 text-sm font-medium">
                <Trans>Active Work</Trans>
              </h2>
              {active.length ? (
                <ul className="grid gap-4 @2xl/project-home:grid-cols-2">
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
                        onLifecycle={() => setDialog(work)}
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
                  <ul className="mt-3 grid gap-4 @2xl/project-home:grid-cols-2">
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
                          onLifecycle={() => setDialog(work)}
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
            error={mutation.error}
            onClose={() => {
              mutation.reset();
              setDialog(null);
            }}
            onAction={(action) => {
              const deletionFocus =
                action.type === "delete" ? focusAfterDelete(works ?? [], action.workId) : null;
              if (action.type === "archive" || action.type === "unarchive") {
                lifecycleFocus.current = {
                  workId: action.workId,
                  status: action.type === "archive" ? "archived" : "active",
                };
              }
              mutation.mutate(action, {
                onSuccess: (result) => {
                  setDialog(null);
                  if (deletionFocus) {
                    focusHandled.current = false;
                    setFocusIntent(deletionFocus);
                  }
                  if (action.type === "create" && result) openWork(result);
                },
                onError: () => {
                  lifecycleFocus.current = null;
                },
              });
            }}
          />
        ) : null}
      </section>
    </div>
  );
}

function LoadingCards() {
  return (
    <div
      role="status"
      aria-label={t`Loading Work`}
      className="grid gap-4 @2xl/project-home:grid-cols-2"
    >
      {[0, 1].map((key) => (
        <div key={key} className="surface-card rounded-lg border p-5">
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="mt-3 h-3 w-4/5" />
        </div>
      ))}
    </div>
  );
}
