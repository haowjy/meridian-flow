/** Pinned sidebar tree section for a project's restorable documents. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { DocumentTrashEntry } from "@meridian/contracts/protocol";
import { ArchiveRestore, Trash2 } from "lucide-react";
import { useMemo } from "react";
import { useDocumentTrash } from "@/client/query/useDocumentTrash";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { OverflowMenu } from "@/components/ui/overflow-menu";
import { useMinuteClock } from "@/hooks/use-minute-clock";
import { cn } from "@/lib/utils";
import { useProjectSurfacePrefsStore } from "../layout/surface-prefs-store";
import { relativeTime } from "../relative-time";
import { useProjectTrashNavigation } from "../routing/ProjectNavigationContext";
import { RowIcon, rowPaddingLeft } from "./ContextTreeRows";
import { fileKindIcon } from "./context-file-icon";
import {
  contextTreeFileRowClassName,
  contextTreeOverflowTriggerClassName,
} from "./context-row-geometry";
import { schemeLabel } from "./context-schemes";
import { type TrashRestoreState, useDocumentTrashRestore } from "./DocumentTrashRestoreProvider";
import { RailPaneHeader } from "./RailPaneHeader";

export function DocumentTrashSection({
  projectId,
  onPicked,
}: {
  projectId: string;
  onPicked?: () => void;
}) {
  const query = useDocumentTrash(projectId);
  const { navigate } = useProjectTrashNavigation();
  const { states, restore } = useDocumentTrashRestore();
  const expanded = useProjectSurfacePrefsStore((state) => state.railPrefs.trashExpanded);
  const setExpanded = useProjectSurfacePrefsStore((state) => state.setRailExpanded);
  const now = useMinuteClock();
  const entries = useMemo(
    () =>
      [...(query.data?.documents ?? [])].sort(
        (left, right) => Date.parse(right.removal.time) - Date.parse(left.removal.time),
      ),
    [query.data?.documents],
  );
  return (
    <section
      className={cn(
        "relative flex min-h-0 shrink flex-col border-t border-border-subtle py-1",
        expanded && "max-h-[40%]",
      )}
    >
      <RailPaneHeader
        label={t`Trash`}
        icon={Trash2}
        expanded={expanded}
        onExpandedChange={(next) => setExpanded("trash", next)}
      />
      {expanded ? (
        <div className="min-h-0 overflow-y-auto overflow-x-hidden pb-1">
          {query.isError ? (
            <p role="alert" className="py-1.5 pr-2 pl-6 text-xs text-destructive">
              <Trans>Trash couldn’t load.</Trans>{" "}
              <button type="button" onClick={() => void query.refetch()} className="text-button">
                <Trans>Retry</Trans>
              </button>
            </p>
          ) : entries.length ? (
            entries.map((entry) => (
              <TrashRow
                key={entry.documentId}
                entry={entry}
                now={now}
                state={states.get(entry.documentId)}
                onOpen={() => {
                  void navigate(entry.documentId);
                  onPicked?.();
                }}
                onRestore={() => restore(entry)}
              />
            ))
          ) : query.isPending ? (
            <div aria-busy className="min-h-8" />
          ) : (
            <p className="py-1.5 pr-2 pl-6 text-xs leading-snug text-ink-subtle">
              <Trans>Nothing in the trash.</Trans>
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}

function TrashRow({
  entry,
  now,
  state,
  onOpen,
  onRestore,
}: {
  entry: DocumentTrashEntry;
  now: number;
  state?: TrashRestoreState;
  onOpen: () => void;
  onRestore: () => void;
}) {
  const location = `${schemeLabel(entry.scheme)}/${entry.formerPath}`;
  const restoring = state?.kind === "restoring";
  const age = relativeTime(entry.removal.time, now);
  return (
    <div>
      {/* biome-ignore lint/a11y/useSemanticElements: row nests a separate kebab button. */}
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onOpen();
        }}
        className={cn(contextTreeFileRowClassName(false), "py-1")}
        style={{ paddingLeft: rowPaddingLeft(1) }}
      >
        <span className="h-7 w-4 shrink-0" aria-hidden />
        <RowIcon icon={fileKindIcon(entry.name)} />
        <span className="ml-0.5 min-w-0 flex-1">
          <span className="block truncate">{entry.name}</span>
          <span className="flex min-w-0 items-baseline gap-2 text-xs text-ink-subtle">
            <span className="min-w-0 flex-1 truncate text-left [direction:rtl]" title={location}>
              {location}
            </span>
            <span className="shrink-0 tabular-nums">
              {restoring ? (
                <Trans>Restoring</Trans>
              ) : age === "now" ? (
                <Trans>now</Trans>
              ) : (
                <Trans>{age} ago</Trans>
              )}
            </span>
          </span>
        </span>
        <div className="relative z-10 shrink-0">
          <OverflowMenu
            label={t`Actions`}
            triggerClassName={contextTreeOverflowTriggerClassName}
            triggerProps={{ disabled: restoring }}
          >
            <DropdownMenuItem onSelect={onRestore}>
              <ArchiveRestore className="size-3.5 text-muted-foreground" aria-hidden />
              <Trans>Restore</Trans>
            </DropdownMenuItem>
          </OverflowMenu>
        </div>
      </div>
      {state?.kind === "failed" ? (
        <p role="alert" className="pr-2 pb-1 pl-14 text-xs text-destructive">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
