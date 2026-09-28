/**
 * A Work's two titles: the active tab in the pane band (navigation chrome) and
 * the page heading (the page's own identity). Both rename the same Work in
 * place, without moving the text, and show a rename at once through
 * `useWorkRename`. A rejected rename reopens the title that was edited with the
 * writer's text and the error.
 */
import { t } from "@lingui/core/macro";
import type { Work } from "@meridian/contracts/works";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { TabTitleField } from "../shell/TabTitleField";
import { titleChipClass } from "../shell/title-chip";
import { useWorkRename } from "./useWorkRename";

const headingClass = "min-w-0 text-xl font-semibold tracking-tight [overflow-wrap:anywhere]";

function useTitleEditing(projectId: string, work: Work) {
  const { rename } = useWorkRename(projectId, work);
  const [editing, setEditing] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  return {
    name: work.name,
    editing,
    failed,
    start: () => setEditing(work.name),
    commit: (next: string) => {
      setEditing(null);
      setFailed(false);
      rename(next, () => {
        setFailed(true);
        setEditing(next);
      });
    },
    cancel: () => {
      setEditing(null);
      setFailed(false);
    },
  };
}

function RenameFailure() {
  return (
    <p
      role="alert"
      className="absolute top-full left-0 z-20 mt-1 w-max max-w-72 rounded-md border border-border bg-popover px-2 py-1.5 text-xs font-normal text-destructive shadow-sm"
    >
      {t`Couldn’t rename this Work. Try again.`}
    </p>
  );
}

export function WorkTitleTab({
  projectId,
  work,
  variant,
}: {
  projectId: string;
  work: Work;
  variant: "tab" | "quiet";
}) {
  const title = useTitleEditing(projectId, work);
  return (
    <div className={cn(titleChipClass(variant), "relative")}>
      {title.editing !== null ? (
        <>
          <TabTitleField
            initial={title.editing}
            label={t`Rename Work`}
            onCommit={title.commit}
            onCancel={title.cancel}
          />
          {title.failed ? <RenameFailure /> : null}
        </>
      ) : (
        <span className="flex min-w-0 px-1">
          <button
            type="button"
            aria-label={t`Rename Work: ${title.name}`}
            title={title.name}
            onClick={title.start}
            className="pane-title inline-edit-trigger focus-ring min-w-0 truncate text-left"
          >
            {title.name}
          </button>
        </span>
      )}
    </div>
  );
}

/** The Work page's heading, renamed in place like the tab above it. */
export function WorkHeading({ projectId, work }: { projectId: string; work: Work }) {
  const title = useTitleEditing(projectId, work);
  return (
    <h1 className={cn(headingClass, "relative")}>
      {title.editing !== null ? (
        <>
          <TabTitleField
            initial={title.editing}
            label={t`Rename Work`}
            className="flex min-w-0"
            onCommit={title.commit}
            onCancel={title.cancel}
          />
          {title.failed ? <RenameFailure /> : null}
        </>
      ) : (
        // The heading's accessible name stays the Work's name; the tooltip says
        // what clicking it does.
        <button
          type="button"
          title={t`Rename`}
          onClick={title.start}
          className="inline-edit-trigger focus-ring text-left"
        >
          {title.name}
        </button>
      )}
    </h1>
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

/** A Work that has no server identity yet: its heading, not editable. */
export function PendingWorkHeading({ name }: { name: string }) {
  return <h1 className={headingClass}>{name}</h1>;
}
