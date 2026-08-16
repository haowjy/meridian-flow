/** WorkScreen — the project’s dedicated Work lifecycle surface. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Work } from "@meridian/contracts/works";
import { Archive, ArchiveRestore, ChevronDown, Plus, Trash2 } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";

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
import { Textarea } from "@/components/ui/textarea";
import { WorkCard } from "./WorkCard";

export function WorkScreen({ projectId }: { projectId: string }) {
  const { works, isError, isFetching, refetch } = useWorks(projectId);
  const mutation = useWorkMutations(projectId);
  const actionInFlight = useRef(false);
  const [editing, setEditing] = useState<Work | "new" | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const focusRefs = useRef(new Map<FocusTarget, HTMLElement>());
  const [pendingFocus, setPendingFocus] = useState<PendingFocusIntent | null>(null);
  const active = works?.filter((work) => work.status === "active") ?? [];
  const archived = works?.filter((work) => work.status === "archived") ?? [];
  const nonDialogError = !editing ? mutation.error : null;
  const errorPlacement = getWorkErrorPlacement(mutation.variables, works ?? []);
  const registerFocus = (target: FocusTarget) => (node: HTMLElement | null) => {
    if (node) focusRefs.current.set(target, node);
    else focusRefs.current.delete(target);
  };
  useLayoutEffect(() => {
    if (!pendingFocus) return;
    if (pendingFocus.kind === "cancel") {
      const target = focusRefs.current.get(pendingFocus.target);
      if (!target?.isConnected) return;
      target.focus();
      setPendingFocus(null);
      return;
    }
    if (works === null) return;
    if (!focusIntentHasCommitted(pendingFocus, works)) return;
    const exact = focusRefs.current.get(pendingFocus.target);
    const target = exact?.isConnected
      ? exact
      : pendingFocus.target.startsWith("edit:")
        ? focusRefs.current.get("archived-disclosure")
        : undefined;
    if (!target?.isConnected) return;
    target.focus();
    setPendingFocus(null);
  }, [pendingFocus, works, archivedOpen]);
  const closeDialog = () => {
    mutation.reset();
    setPendingFocus({ kind: "cancel", target: editing === "new" ? "new" : `edit:${editing?.id}` });
    setEditing(null);
  };
  const runAction = (action: WorkAction, closeOnSuccess = false) => {
    if (actionInFlight.current || mutation.isPending) return;
    actionInFlight.current = true;
    mutation.reset();
    mutation.mutate(action, {
      onSuccess: closeOnSuccess
        ? (result) => {
            const intent = focusIntentForAction(action, works ?? [], result, archivedOpen);
            setEditing(null);
            setPendingFocus(intent);
          }
        : undefined,
      onSettled: () => {
        actionInFlight.current = false;
      },
    });
  };

  return (
    <div className="app-scroll" aria-busy={isFetching}>
      <section className="project-screen-column gap-8">
        <h1 className="sr-only">
          <Trans>Work</Trans>
        </h1>
        <div className="flex flex-col items-start gap-3 @2xl/project-home:flex-row @2xl/project-home:items-center @2xl/project-home:justify-between">
          <Button
            size="sm"
            className="[@media(pointer:coarse)]:min-h-11"
            disabled={mutation.isPending}
            data-work-focus="new"
            ref={registerFocus("new")}
            onClick={() => {
              mutation.reset();
              setEditing("new");
            }}
          >
            <Plus className="size-4" />
            <Trans>New Work</Trans>
          </Button>
        </div>

        <h2 id="active-work-heading" className="mb-2 text-sm font-medium text-foreground">
          <Trans>Active Work</Trans>
        </h2>
        {isError ? (
          <div className="flex items-center gap-2" role="alert">
            <p className="text-sm text-destructive">
              <Trans>Work couldn’t load</Trans>
            </p>
            <Button variant="outline" size="sm" onClick={refetch}>
              <Trans>Retry</Trans>
            </Button>
          </div>
        ) : works === null ? (
          <section
            role="status"
            aria-label={t`Loading Work`}
            className="grid gap-4 @2xl/project-home:grid-cols-2"
          >
            <span className="sr-only">
              <Trans>Loading Work</Trans>
            </span>
            {[0, 1].map((index) => (
              <div
                key={index}
                aria-hidden
                className="surface-card rounded-lg border border-border-subtle px-5 py-5"
              >
                <Skeleton className="h-4 w-2/5 motion-reduce:animate-none" />
                <Skeleton className="mt-3 h-3 w-4/5 motion-reduce:animate-none" />
                <Skeleton className="mt-2 h-3 w-1/3 motion-reduce:animate-none" />
              </div>
            ))}
          </section>
        ) : (
          <>
            <section aria-labelledby="active-work-heading">
              {active.length > 0 ? (
                <WorkList
                  works={active}
                  pending={mutation.isPending}
                  error={errorPlacement.section === "active" ? nonDialogError : null}
                  errorWorkId={errorPlacement.workId}
                  onEdit={(work) => {
                    mutation.reset();
                    setEditing(work);
                  }}
                  registerFocus={registerFocus}
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
                open={archivedOpen}
                onOpenChange={(open) => {
                  setArchivedOpen(open);
                }}
                registerFocus={registerFocus}
                pending={mutation.isPending}
                error={errorPlacement.section === "archived" ? nonDialogError : null}
                errorWorkId={errorPlacement.workId}
                onEdit={(work) => {
                  mutation.reset();
                  setEditing(work);
                }}
              />
            ) : null}
          </>
        )}

        <WorkDialog
          key={editing === "new" ? "new" : (editing?.id ?? "closed")}
          work={editing}
          pending={mutation.isPending}
          error={mutation.error}
          onClose={closeDialog}
          onAction={(action) => runAction(action, true)}
        />
      </section>
    </div>
  );
}

function WorkList({
  works,
  pending,
  error,
  errorWorkId,
  onEdit,
  registerFocus,
}: {
  works: Work[];
  pending: boolean;
  error: Error | null;
  errorWorkId: string | null;
  onEdit: (work: Work) => void;
  registerFocus?: (target: FocusTarget) => (node: HTMLElement | null) => void;
}) {
  return (
    <ul className="grid gap-4 @2xl/project-home:grid-cols-2">
      {works.map((work) => (
        <li key={work.id} className="min-w-0">
          <WorkCard
            work={work}
            pending={pending}
            error={error && errorWorkId === work.id ? error : null}
            onEdit={() => onEdit(work)}
            registerEditFocus={registerFocus?.(`edit:${work.id}`)}
          />
        </li>
      ))}
      {error && errorWorkId === null ? (
        <li className="text-sm text-destructive" role="alert" data-work-error="active-boundary">
          {error.message}
        </li>
      ) : null}
    </ul>
  );
}

function ArchivedWorkSection({
  works,
  pending,
  error,
  errorWorkId,
  onEdit,
  open,
  onOpenChange,
  registerFocus,
}: {
  works: Work[];
  pending: boolean;
  error: Error | null;
  errorWorkId: string | null;
  onEdit: (work: Work) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  registerFocus: (target: FocusTarget) => (node: HTMLElement | null) => void;
}) {
  const panelId = useId();
  const headingId = useId();

  return (
    <section className="mt-4 border-t border-border-subtle pt-3" aria-labelledby={headingId}>
      <h2 id={headingId}>
        <button
          type="button"
          className="focus-ring flex min-h-11 w-full items-center justify-between gap-3 rounded-sm px-1 text-left"
          aria-expanded={open}
          data-work-focus="archived-disclosure"
          ref={registerFocus("archived-disclosure")}
          aria-controls={open ? panelId : undefined}
          onClick={() => onOpenChange(!open)}
        >
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 text-sm font-medium text-foreground">
              <Trans>Archived Work</Trans>
              <span className="ml-2 font-normal text-muted-foreground">({works.length})</span>
            </span>
          </span>
          <ChevronDown
            aria-hidden
            className={`size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
          />
        </button>
      </h2>
      {open ? (
        <div id={panelId} className="mt-2">
          <WorkList
            works={works}
            pending={pending}
            error={error}
            errorWorkId={errorWorkId}
            onEdit={onEdit}
            registerFocus={registerFocus}
          />
        </div>
      ) : error ? (
        <p
          className="mt-2 text-sm text-destructive"
          role="alert"
          data-work-error="archived-boundary"
        >
          {error.message}
        </p>
      ) : null}
    </section>
  );
}

type WorkAction = Parameters<ReturnType<typeof useWorkMutations>["mutate"]>[0];

function getWorkErrorPlacement(
  action: WorkAction | undefined,
  works: Work[],
): { section: Work["status"]; workId: string | null } {
  if (!action || action.type === "create") return { section: "active", workId: null };
  const work = works.find((candidate) => candidate.id === action.workId);
  return {
    section: work?.status ?? (action.type === "unarchive" ? "archived" : "active"),
    workId: work?.id ?? null,
  };
}

type FocusTarget = "new" | "archived-disclosure" | `edit:${string}`;
type PendingFocusIntent =
  | { kind: "cancel"; target: FocusTarget }
  | { kind: "present"; target: FocusTarget; workId: string; status: Work["status"] }
  | { kind: "deleted"; target: FocusTarget; workId: string };

function focusIntentForAction(
  action: WorkAction,
  works: Work[],
  result: unknown,
  archivedOpen: boolean,
): PendingFocusIntent {
  if (action.type === "create") {
    const created = result as Work;
    return { kind: "present", target: "new", workId: created.id, status: created.status };
  }
  if (action.type === "update")
    return {
      kind: "present",
      target: `edit:${action.workId}`,
      workId: action.workId,
      status: works.find((work) => work.id === action.workId)?.status ?? "active",
    };
  if (action.type === "archive" || action.type === "unarchive")
    return {
      kind: "present",
      target:
        action.type === "archive" && !archivedOpen
          ? "archived-disclosure"
          : `edit:${action.workId}`,
      workId: action.workId,
      status: action.type === "archive" ? "archived" : "active",
    };
  if (action.type === "delete") {
    const visible = [
      ...works.filter((work) => work.status === "active"),
      ...(archivedOpen ? works.filter((work) => work.status === "archived") : []),
    ];
    const index = visible.findIndex((work) => work.id === action.workId);
    const sibling = visible[index + 1] ?? visible[index - 1];
    return {
      kind: "deleted",
      target: sibling ? `edit:${sibling.id}` : "new",
      workId: action.workId,
    };
  }
  throw new Error("Switch does not close the Work dialog");
}

function focusIntentHasCommitted(intent: PendingFocusIntent, works: Work[]): boolean {
  if (intent.kind === "cancel") return true;
  if (intent.kind === "deleted") return !works.some((work) => work.id === intent.workId);
  return works.some((work) => work.id === intent.workId && work.status === intent.status);
}

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
      <DialogContent
        className="[@media(pointer:coarse)]:[&>button:last-child]:size-11"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const nameInput = document.getElementById("work-name") as HTMLInputElement | null;
          nameInput?.focus();
          nameInput?.select();
        }}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
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
              className="[@media(pointer:coarse)]:min-h-11"
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
              className="[@media(pointer:coarse)]:min-h-11"
              disabled={pending}
              onClick={() => onAction({ type: "delete", workId: initial.id })}
            >
              <Trash2 className="size-4" />
              <Trans>Delete</Trans>
            </Button>
          </div>
        ) : null}
        <DialogFooter className="flex-col sm:flex-row">
          <Button
            variant="outline"
            className="[@media(pointer:coarse)]:min-h-11"
            disabled={pending}
            onClick={onClose}
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button
            className="[@media(pointer:coarse)]:min-h-11"
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
