/** Route-controlled Work collection/detail management surface. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { parseRequestId } from "@meridian/contracts/request-id";
import type { Work } from "@meridian/contracts/works";
import { ChevronDown, Plus } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { useWorkMutations, useWorks } from "@/client/query/useWorks";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { ProjectRouteCommands, RouteWorkResolution } from "../routing/project-route";
import { WorkCard } from "./WorkCard";
import { WorkDetailScreen } from "./WorkDetailScreen";

export type WorkScreenProps = {
  projectId: string;
  routeWork: RouteWorkResolution;
  routeCommands: ProjectRouteCommands;
  onOpenThread: (threadId: string) => void;
};

export function WorkScreen(props: WorkScreenProps) {
  const catalog = useWorks(props.projectId);
  if (props.routeWork.status === "present") {
    return <WorkDetailScreen {...props} work={props.routeWork.work} />;
  }
  if (props.routeWork.status === "catalog-error") {
    return (
      <div className="app-scroll">
        <div className="project-screen-column">
          <ResourceError label={t`Work`} retry={catalog.refetch} />
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
  useEffect(() => {
    collectionHeading.current?.focus();
  }, []);
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
            size="sm"
            className="[@media(pointer:coarse)]:min-h-11"
            onClick={() => setDialog("new")}
          >
            <Plus className="size-4" />
            <Trans>New Work</Trans>
          </Button>
        </div>
        {isError ? (
          <ResourceError label={t`Work`} retry={refetch} />
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
                        />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            ) : null}
          </>
        )}
        <WorkDialog
          work={dialog}
          pending={mutation.isPending}
          error={mutation.error}
          onClose={() => {
            mutation.reset();
            setDialog(null);
          }}
          onAction={(action) =>
            mutation.mutate(action, {
              onSuccess: (result) => {
                setDialog(null);
                if (action.type === "create" && result) openWork(result);
              },
            })
          }
        />
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
export function ResourceError({ label, retry }: { label: string; retry: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-3">
      <p className="text-sm text-destructive">
        {label} <Trans>couldn’t load</Trans>
      </p>
      <Button variant="outline" size="sm" onClick={retry}>
        <Trans>Retry</Trans> {label}
      </Button>
    </div>
  );
}

type WorkAction = Parameters<ReturnType<typeof useWorkMutations>["mutate"]>[0];
export function WorkDialog({
  work,
  pending,
  error,
  onClose,
  onAction,
}: {
  work: "new" | Work | null;
  pending: boolean;
  error: Error | null;
  onClose: () => void;
  onAction: (action: WorkAction) => void;
}) {
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const admitted = useRef(false);
  useEffect(() => {
    if (!pending) admitted.current = false;
  }, [pending]);
  if (!work) return null;
  const existing = work === "new" ? null : work;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {existing ? <Trans>Manage Work</Trans> : <Trans>New Work</Trans>}
          </DialogTitle>
        </DialogHeader>
        {existing ? (
          <p className="text-sm">
            {existing.status === "archived" ? (
              <Trans>This Work is archived.</Trans>
            ) : (
              <Trans>This Work is active.</Trans>
            )}
          </p>
        ) : (
          <>
            <label htmlFor="new-work-name" className="grid gap-1 text-sm">
              <Trans>Name</Trans>
              <Input
                id="new-work-name"
                autoFocus
                value={name}
                disabled={pending}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label htmlFor="new-work-goal" className="grid gap-1 text-sm">
              <Trans>Goal</Trans>
              <Input
                id="new-work-goal"
                value={goal}
                disabled={pending}
                onChange={(event) => setGoal(event.target.value)}
              />
            </label>
          </>
        )}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error.message}
          </p>
        ) : null}
        <DialogFooter>
          {existing ? (
            <>
              <Button
                variant="outline"
                disabled={pending}
                className="[@media(pointer:coarse)]:min-h-11"
                onClick={() => {
                  if (admitted.current) return;
                  admitted.current = true;
                  onAction({
                    type: existing.status === "archived" ? "unarchive" : "archive",
                    workId: existing.id,
                  });
                }}
              >
                {existing.status === "archived" ? (
                  <Trans>Unarchive Work</Trans>
                ) : (
                  <Trans>Archive Work</Trans>
                )}
              </Button>
              <Button
                variant="destructive"
                disabled={pending}
                className="[@media(pointer:coarse)]:min-h-11"
                onClick={() => {
                  if (admitted.current) return;
                  admitted.current = true;
                  onAction({ type: "delete", workId: existing.id });
                }}
              >
                <Trans>Delete Work</Trans>
              </Button>
            </>
          ) : (
            <Button
              disabled={pending || !name.trim()}
              className="[@media(pointer:coarse)]:min-h-11"
              onClick={() => {
                if (admitted.current) return;
                admitted.current = true;
                onAction({ type: "create", data: { name, goal } });
              }}
            >
              <Trans>Create Work</Trans>
            </Button>
          )}
          <Button
            variant="ghost"
            disabled={pending}
            onClick={onClose}
            className="[@media(pointer:coarse)]:min-h-11"
          >
            <Trans>Cancel</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
