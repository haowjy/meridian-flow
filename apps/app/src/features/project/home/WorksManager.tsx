/** Live Work management for the project Home. */
import type { Work } from "@meridian/contracts/works";
import { Archive, ArchiveRestore, Check, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
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
  const { works, currentWorkId } = useWorks(projectId);
  const mutation = useWorkMutations(projectId);
  const [editing, setEditing] = useState<Work | "new" | null>(null);
  const active = works?.filter((work) => work.status === "active") ?? [];
  const archived = works?.filter((work) => work.status === "archived") ?? [];

  return (
    <section className="rounded-md border border-border-subtle bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-foreground">Works</h2>
          <p className="text-meta text-muted-foreground">
            Choose the context for new writing and chats.
          </p>
        </div>
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus className="size-4" />
          New Work
        </Button>
      </div>
      {!works ? (
        <p className="text-sm text-muted-foreground">Loading Works…</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {[...active, ...archived].map((work) => (
            <article
              key={work.id}
              className="flex min-w-0 items-start gap-3 rounded-sm border border-border-subtle p-3"
            >
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => mutation.mutate({ type: "switch", workId: work.id })}
              >
                <span className="flex items-center gap-1.5 font-medium text-foreground">
                  {work.id === currentWorkId ? <Check className="size-4 text-primary" /> : null}
                  <span className="truncate">{work.name}</span>
                </span>
                <span className="mt-1 block line-clamp-2 text-meta text-muted-foreground">
                  {work.goal || "No goal yet"}
                </span>
                <span className="mt-2 block text-meta text-muted-foreground">
                  {work.status === "archived" ? "Archived" : "Active"}
                  {work.unpushedChangeCount ? ` (${work.unpushedChangeCount} pending changes)` : ""}
                </span>
              </button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Edit ${work.name}`}
                onClick={() => setEditing(work)}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </article>
          ))}
        </div>
      )}
      <WorkDialog
        work={editing}
        pending={mutation.isPending}
        error={mutation.error}
        onClose={() => setEditing(null)}
        onAction={(action) => mutation.mutate(action, { onSuccess: () => setEditing(null) })}
      />
    </section>
  );
}

type WorkAction = Parameters<ReturnType<typeof useWorkMutations>["mutate"]>[0];
function WorkDialog({
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
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [description, setDescription] = useState("");
  if (!work) return null;
  const initial = work === "new" ? null : work;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial ? "Work details" : "New Work"}</DialogTitle>
        </DialogHeader>
        <label htmlFor="work-name" className="grid gap-1 text-sm">
          Name
          <Input
            id="work-name"
            defaultValue={initial?.name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label htmlFor="work-goal" className="grid gap-1 text-sm">
          Goal
          <Input
            id="work-goal"
            defaultValue={initial?.goal ?? ""}
            onChange={(e) => setGoal(e.target.value)}
          />
        </label>
        <label htmlFor="work-description" className="grid gap-1 text-sm">
          Description
          <Textarea
            id="work-description"
            defaultValue={initial?.description ?? ""}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        {error ? <p className="text-sm text-destructive">{error.message}</p> : null}
        {initial ? (
          <div className="flex gap-2">
            <Button
              variant="outline"
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
              {initial.status === "archived" ? "Unarchive" : "Archive"}
            </Button>
            <Button
              variant="destructive"
              onClick={() => onAction({ type: "delete", workId: initial.id })}
            >
              <Trash2 className="size-4" />
              Delete
            </Button>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={pending || !(name || initial?.name)?.trim()}
            onClick={() =>
              initial
                ? onAction({
                    type: "update",
                    workId: initial.id,
                    data: {
                      name: name || initial.name,
                      goal: goal || initial.goal || "",
                      description: description || initial.description || "",
                    },
                  })
                : onAction({ type: "create", data: { name, goal, description } })
            }
          >
            Save Work
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
