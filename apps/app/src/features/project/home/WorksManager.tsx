/** Live Work management for the project Home. */
import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import type { Work } from "@meridian/contracts/works";
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  MoreHorizontal,
  Plus,
  Trash2,
} from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";

export function WorksManager({ projectId }: { projectId: string }) {
  const { works, currentWorkId, isError, isFetching, refetch } = useWorks(projectId);
  const mutation = useWorkMutations(projectId);
  const actionInFlight = useRef(false);
  const [editing, setEditing] = useState<Work | "new" | null>(null);
  const active = works?.filter((work) => work.status === "active") ?? [];
  const archived = works?.filter((work) => work.status === "archived") ?? [];
  const closeDialog = () => {
    mutation.reset();
    setEditing(null);
  };
  const runAction = (action: WorkAction, closeOnSuccess = false) => {
    if (actionInFlight.current || mutation.isPending) return;
    actionInFlight.current = true;
    mutation.reset();
    mutation.mutate(action, {
      onSuccess: closeOnSuccess ? () => setEditing(null) : undefined,
      onSettled: () => {
        actionInFlight.current = false;
      },
    });
  };

  return (
    <section className="rounded-md border border-border-subtle bg-card p-4" aria-busy={isFetching}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-foreground">
            <Trans>Work</Trans>
          </h2>
          <p className="text-meta text-muted-foreground">
            <Trans>Choose the context for new writing and chats.</Trans>
          </p>
        </div>
        <Button
          size="sm"
          disabled={mutation.isPending}
          onClick={() => {
            mutation.reset();
            setEditing("new");
          }}
        >
          <Plus className="size-4" />
          <Trans>New Work</Trans>
        </Button>
      </div>

      {isError ? (
        <div className="flex items-center gap-2" role="alert">
          <p className="text-sm text-destructive">
            <Trans>Couldn't load Work.</Trans>
          </p>
          <Button variant="outline" size="sm" onClick={refetch}>
            <Trans>Try again</Trans>
          </Button>
        </div>
      ) : works === null ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Loading Work…</Trans>
        </p>
      ) : (
        <>
          <section aria-labelledby="active-work-heading">
            <h3 id="active-work-heading" className="mb-2 text-sm font-medium text-foreground">
              <Trans>Active Work</Trans>
            </h3>
            {active.length > 0 ? (
              <WorkList
                works={active}
                currentWorkId={currentWorkId}
                pending={mutation.isPending}
                onSelect={(workId) => runAction({ type: "switch", workId })}
                onEdit={(work) => {
                  mutation.reset();
                  setEditing(work);
                }}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                <Trans>No active Work yet.</Trans>
              </p>
            )}
          </section>
          {archived.length > 0 ? (
            <ArchivedWorkSection
              works={archived}
              currentWorkId={currentWorkId}
              pending={mutation.isPending}
              onSelect={(workId) => runAction({ type: "switch", workId })}
              onEdit={(work) => {
                mutation.reset();
                setEditing(work);
              }}
            />
          ) : null}
        </>
      )}

      {!editing && mutation.error ? (
        <p className="mt-3 text-sm text-destructive" role="alert">
          {mutation.error.message}
        </p>
      ) : null}

      <WorkDialog
        key={editing === "new" ? "new" : (editing?.id ?? "closed")}
        work={editing}
        pending={mutation.isPending}
        error={mutation.error}
        onClose={closeDialog}
        onAction={(action) => runAction(action, true)}
      />
    </section>
  );
}

function WorkList({
  works,
  currentWorkId,
  pending,
  onSelect,
  onEdit,
}: {
  works: Work[];
  currentWorkId: string | null;
  pending: boolean;
  onSelect: (workId: string) => void;
  onEdit: (work: Work) => void;
}) {
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {works.map((work) => (
        <li
          key={work.id}
          className="flex min-w-0 items-start gap-3 rounded-sm border border-border-subtle p-3"
        >
          <button
            type="button"
            aria-pressed={work.id === currentWorkId}
            className="min-w-0 flex-1 text-left disabled:cursor-not-allowed disabled:opacity-50"
            disabled={pending}
            onClick={() => onSelect(work.id)}
          >
            <span className="flex items-center gap-1.5 font-medium text-foreground">
              {work.id === currentWorkId ? <Check className="size-4 text-primary" /> : null}
              <span className="truncate">{work.name}</span>
            </span>
            <span className="mt-1 block line-clamp-2 text-meta text-muted-foreground">
              {work.goal || <Trans>No goal yet</Trans>}
            </span>
            <span className="mt-2 block text-meta text-muted-foreground">
              {work.status === "archived" ? <Trans>Archived</Trans> : <Trans>Active</Trans>}
              {work.unpushedChangeCount ? (
                <>
                  {" ("}
                  <Plural
                    value={work.unpushedChangeCount}
                    one="# pending change"
                    other="# pending changes"
                  />
                  {")"}
                </>
              ) : null}
            </span>
          </button>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={pending}
            aria-label={t`Edit ${work.name}`}
            onClick={() => onEdit(work)}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </li>
      ))}
    </ul>
  );
}

function ArchivedWorkSection({
  works,
  currentWorkId,
  pending,
  onSelect,
  onEdit,
}: {
  works: Work[];
  currentWorkId: string | null;
  pending: boolean;
  onSelect: (workId: string) => void;
  onEdit: (work: Work) => void;
}) {
  const panelId = useId();
  const headingId = useId();
  const archivedCurrentWorkId = works.find((work) => work.id === currentWorkId)?.id ?? null;
  const [open, setOpen] = useState(archivedCurrentWorkId !== null);

  useEffect(() => {
    if (archivedCurrentWorkId !== null) setOpen(true);
  }, [archivedCurrentWorkId]);

  return (
    <section className="mt-4 border-t border-border-subtle pt-3" aria-labelledby={headingId}>
      <h3 id={headingId}>
        <button
          type="button"
          className="focus-ring flex min-h-11 w-full items-center justify-between gap-3 rounded-sm px-1 text-left"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="text-sm font-medium text-foreground">
            <Trans>Archived Work</Trans>
            <span className="ml-2 font-normal text-muted-foreground">({works.length})</span>
          </span>
          <ChevronDown
            aria-hidden
            className={`size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
          />
        </button>
      </h3>
      {open ? (
        <div id={panelId} className="mt-2">
          <WorkList
            works={works}
            currentWorkId={currentWorkId}
            pending={pending}
            onSelect={onSelect}
            onEdit={onEdit}
          />
        </div>
      ) : null}
    </section>
  );
}

type WorkAction = Parameters<ReturnType<typeof useWorkMutations>["mutate"]>[0];

export type WorkFormValues = { name: string; goal: string; description: string };

export function workFormValues(work: Work | "new"): WorkFormValues {
  return work === "new"
    ? { name: "", goal: "", description: "" }
    : { name: work.name, goal: work.goal ?? "", description: work.description ?? "" };
}

export function workFormAction(work: Work | "new", values: WorkFormValues): WorkAction {
  const data = { name: values.name.trim(), goal: values.goal, description: values.description };
  return work === "new" ? { type: "create", data } : { type: "update", workId: work.id, data };
}

export function WorkDialog({
  work,
  pending,
  error,
  onClose,
  onAction,
}: {
  work: Work | "new" | null;
  pending: boolean;
  error: Error | null;
  onClose: () => void;
  onAction: (action: WorkAction) => void;
}) {
  const initial = work === "new" || work === null ? null : work;
  const initialValues =
    work === null ? { name: "", goal: "", description: "" } : workFormValues(work);
  const [name, setName] = useState(initialValues.name);
  const [goal, setGoal] = useState(initialValues.goal);
  const [description, setDescription] = useState(initialValues.description);
  if (!work) return null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {initial ? <Trans>Work details</Trans> : <Trans>New Work</Trans>}
          </DialogTitle>
        </DialogHeader>
        <label htmlFor="work-name" className="grid gap-1 text-sm">
          <Trans>Name</Trans>
          <Input
            id="work-name"
            value={name}
            disabled={pending}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label htmlFor="work-goal" className="grid gap-1 text-sm">
          <Trans>Goal</Trans>
          <Input
            id="work-goal"
            value={goal}
            disabled={pending}
            onChange={(event) => setGoal(event.target.value)}
          />
        </label>
        <label htmlFor="work-description" className="grid gap-1 text-sm">
          <Trans>Description</Trans>
          <Textarea
            id="work-description"
            value={description}
            disabled={pending}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error.message}
          </p>
        ) : null}
        {initial ? (
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={pending}
              onClick={() =>
                onAction({
                  type: initial.status === "archived" ? "unarchive" : "archive",
                  workId: initial.id,
                })
              }
            >
              {initial.status === "archived" ? (
                <ArchiveRestore className="size-4" />
              ) : (
                <Archive className="size-4" />
              )}
              {initial.status === "archived" ? <Trans>Unarchive</Trans> : <Trans>Archive</Trans>}
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => onAction({ type: "delete", workId: initial.id })}
            >
              <Trash2 className="size-4" />
              <Trans>Delete</Trans>
            </Button>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            disabled={pending || !name.trim()}
            onClick={() => onAction(workFormAction(work, { name, goal, description }))}
          >
            <Trans>Save Work</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
