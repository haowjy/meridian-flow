/**
 * WorkTitleTab — the Work's name as the active tab the Work page rises into,
 * renamed in place inside the tab like the chat title. The new name shows at
 * once; a rejected rename restores the old name and reopens the field with the
 * writer's text and the error.
 */
import { t } from "@lingui/core/macro";
import type { Work } from "@meridian/contracts/works";
import { useState } from "react";
import { useWorkMutations } from "@/client/query/useWorks";
import { cn } from "@/lib/utils";
import { TabTitleField, titleChipClass } from "../shell/TabTitleField";

export function WorkTitleTab({
  projectId,
  work,
  variant,
}: {
  projectId: string;
  work: Work;
  variant: "tab" | "quiet";
}) {
  const chipClass = titleChipClass(variant);
  const update = useWorkMutations(projectId).update;
  const [editing, setEditing] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const name = optimistic ?? work.name;
  if (editing !== null)
    return (
      <div className={cn(chipClass, "relative")}>
        <TabTitleField
          initial={editing}
          label={t`Rename Work`}
          onCommit={(next) => {
            setEditing(null);
            setFailed(false);
            setOptimistic(next);
            update.mutate(
              { workId: work.id, data: { name: next } },
              {
                onSettled: () => setOptimistic(null),
                onError: () => {
                  setFailed(true);
                  setEditing(next);
                },
              },
            );
          }}
          onCancel={() => {
            setEditing(null);
            setFailed(false);
          }}
        />
        {failed ? (
          <p
            role="alert"
            className="absolute top-full left-0 z-20 mt-1 w-max max-w-72 rounded-md border border-border bg-popover px-2 py-1.5 text-xs text-destructive shadow-sm"
          >
            {t`Couldn’t rename this Work. Try again.`}
          </p>
        ) : null}
      </div>
    );
  return (
    <div className={chipClass}>
      <span className="flex min-w-0 px-1">
        <button
          type="button"
          aria-label={t`Rename Work: ${name}`}
          title={name}
          onClick={() => setEditing(name)}
          className="pane-title inline-edit-trigger focus-ring min-w-0 truncate text-left"
        >
          {name}
        </button>
      </span>
    </div>
  );
}

/** A Work that has no server identity yet: its name in the tab, not editable. */
export function PendingWorkTitleTab({ name, variant }: { name: string; variant: "tab" | "quiet" }) {
  return (
    <div className={titleChipClass(variant)}>
      <span className="pane-title min-w-0 truncate px-1">{name}</span>
    </div>
  );
}
