/** WorkScreen — the project’s dedicated Work lifecycle surface. */
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
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

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

export function WorkScreen({ projectId }: { projectId: string }) {
  const { works, currentWorkId, defaultWorkId, isError, isFetching, refetch } = useWorks(projectId);
  const mutation = useWorkMutations(projectId);
  const actionInFlight = useRef(false);
  const [editing, setEditing] = useState<Work | "new" | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const focusRefs = useRef(new Map<FocusTarget, HTMLElement>());
  const [pendingFocus, setPendingFocus] = useState<PendingFocusIntent | null>(null);
  const active = works?.filter((work) => work.status === "active") ?? [];
  const archived = works?.filter((work) => work.status === "archived") ?? [];
  const registerFocus = (target: FocusTarget) => (node: HTMLElement | null) => {
    if (node) focusRefs.current.set(target, node);
    else focusRefs.current.delete(target);
  };
  useLayoutEffect(() => {
    if (!pendingFocus || works === null) return;
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
            if (action.type === "archive") setArchivedOpen(true);
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
          <p className="text-sm text-muted-foreground">
            <Trans>New chats use the current Work.</Trans>
          </p>
          <Button
            size="sm"
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

        <h3 id="active-work-heading" className="mb-2 text-sm font-medium text-foreground">
          <Trans>Active Work</Trans>
        </h3>
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
                className="min-h-36 rounded-sm border border-border-subtle p-4"
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
                  currentWorkId={currentWorkId}
                  defaultWorkId={defaultWorkId}
                  pending={mutation.isPending}
                  onSelect={(workId) => {
                    if (workId !== currentWorkId) runAction({ type: "switch", workId });
                  }}
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
                onOpenChange={setArchivedOpen}
                registerFocus={registerFocus}
                currentWorkId={currentWorkId}
                defaultWorkId={defaultWorkId}
                pending={mutation.isPending}
                onSelect={(workId) => {
                  if (workId !== currentWorkId) runAction({ type: "switch", workId });
                }}
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
    </div>
  );
}

function WorkList({
  works,
  currentWorkId,
  defaultWorkId,
  pending,
  onSelect,
  onEdit,
  registerFocus,
}: {
  works: Work[];
  currentWorkId: string | null;
  defaultWorkId: string | null;
  pending: boolean;
  onSelect: (workId: string) => void;
  onEdit: (work: Work) => void;
  registerFocus?: (target: FocusTarget) => (node: HTMLElement | null) => void;
}) {
  return (
    <ul className="grid gap-4 @2xl/project-home:grid-cols-2">
      {works.map((work) => (
        <li
          key={work.id}
          className="surface-card flex min-h-36 min-w-0 items-start gap-3 rounded-sm border border-border-subtle p-4"
        >
          <button
            type="button"
            aria-pressed={work.id === currentWorkId}
            className="focus-ring min-w-0 flex-1 rounded-sm text-left disabled:cursor-not-allowed disabled:opacity-50"
            disabled={pending}
            onClick={() => onSelect(work.id)}
          >
            <span className="flex items-center gap-1.5 font-medium text-foreground">
              {work.id === currentWorkId ? <Check className="size-4 text-primary" /> : null}
              <span className="truncate">{work.name}</span>
              {work.id === currentWorkId ? (
                <span className="text-meta font-normal text-primary">
                  <Trans>Current</Trans>
                </span>
              ) : null}
              {work.id === defaultWorkId && work.id !== currentWorkId ? (
                <span className="text-meta font-normal text-muted-foreground">
                  <Trans>Default</Trans>
                </span>
              ) : null}
            </span>
            <span className="mt-1 block line-clamp-2 text-meta text-muted-foreground">
              {work.goal || <Trans>No goal yet</Trans>}
            </span>
            {work.description ? (
              <span className="mt-2 block line-clamp-2 text-meta text-muted-foreground">
                {work.description}
              </span>
            ) : null}
            {work.unpushedChangeCount ? (
              <span className="mt-2 block text-meta text-muted-foreground">
                <Plural
                  value={work.unpushedChangeCount}
                  one="# pending change"
                  other="# pending changes"
                />
              </span>
            ) : null}
          </button>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={pending}
            aria-label={t`Edit ${work.name}`}
            className="focus-ring"
            data-work-focus={`edit:${work.id}`}
            ref={registerFocus?.(`edit:${work.id}`)}
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
  defaultWorkId,
  pending,
  onSelect,
  onEdit,
  open,
  onOpenChange,
  registerFocus,
}: {
  works: Work[];
  currentWorkId: string | null;
  defaultWorkId: string | null;
  pending: boolean;
  onSelect: (workId: string) => void;
  onEdit: (work: Work) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  registerFocus: (target: FocusTarget) => (node: HTMLElement | null) => void;
}) {
  const panelId = useId();
  const headingId = useId();
  const archivedCurrentWork = works.find((work) => work.id === currentWorkId) ?? null;
  const archivedCurrentWorkId = archivedCurrentWork?.id ?? null;
  useEffect(() => {
    if (archivedCurrentWorkId !== null) onOpenChange(true);
  }, [archivedCurrentWorkId]);

  return (
    <section className="mt-4 border-t border-border-subtle pt-3" aria-labelledby={headingId}>
      <h3 id={headingId}>
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
            {!open && archivedCurrentWork ? (
              <span className="truncate text-meta font-normal text-muted-foreground">
                <Trans>Current: {archivedCurrentWork.name}</Trans>
              </span>
            ) : null}
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
            defaultWorkId={defaultWorkId}
            pending={pending}
            onSelect={onSelect}
            onEdit={onEdit}
            registerFocus={registerFocus}
          />
        </div>
      ) : null}
    </section>
  );
}

type WorkAction = Parameters<ReturnType<typeof useWorkMutations>["mutate"]>[0];

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
      target: `edit:${action.workId}`,
      workId: action.workId,
      status: action.type === "archive" ? "archived" : "active",
    };
  if (action.type === "delete") {
    const visible = works.filter((work) => work.status === "active" || archivedOpen);
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
        <DialogFooter className="flex-col sm:flex-row">
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
