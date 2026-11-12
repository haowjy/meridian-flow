import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { DocumentTrashEntry } from "@meridian/contracts/protocol";
import { useMemo } from "react";
import { useDocumentTrash } from "@/client/query/useDocumentTrash";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { ListLine } from "@/components/ui/list-row";
import { role } from "@/components/ui/roles";
import { useMinuteClock } from "@/hooks/use-minute-clock";
import { cn } from "@/lib/utils";
import { useEntryMenu } from "../../context/ContextEntryActions";
import { DocumentRow } from "../../context/ContextTreeRows";
import { fileKindIcon } from "../../context/context-file-icon";
import {
  type TrashRestoreState,
  useDocumentTrashRestore,
} from "../../context/DocumentTrashRestoreProvider";
import { trashDragEntry } from "../../context/entry-drag/entry";
import { useEntryRow } from "../../context/entry-drag/use-entry-row";
import { formerPlace } from "../../context/TrashedDocument";
import { relativeTime } from "../../relative-time";
import { useTrashNavigation } from "../../routing/ProjectNavigationContext";
import { type SourceDrop, SourcePane } from "./SourcePane";

/**
 * Trash as a source: deleted documents, newest first. Rows dropped on it are
 * deleted at once; its rows drag out to be restored where they land. Picking
 * one shows it in main, read-only with Restore.
 */
export function TrashSource({
  projectId,
  onPicked,
  drop,
}: {
  projectId: string;
  onPicked?: () => void;
  drop: SourceDrop;
}) {
  const query = useDocumentTrash(projectId);
  const { states, restore } = useDocumentTrashRestore();
  const trash = useTrashNavigation();
  const now = useMinuteClock();
  const entries = query.data?.documents ?? [];
  return (
    <SourcePane label={t`Trash`} drop={drop}>
      {entries.map((entry) => (
        <TrashRow
          key={entry.documentId}
          entry={entry}
          now={now}
          active={entry.documentId === trash.shown}
          state={states.get(entry.documentId)}
          onOpen={() => {
            void trash.open(entry.documentId);
            onPicked?.();
          }}
          onRestore={(ids) => restore(entries.filter(({ documentId }) => ids.includes(documentId)))}
        />
      ))}
      {query.isError ? (
        <InlineErrorRow message={t`Couldn't load Trash.`} onRetry={() => void query.refetch()} />
      ) : entries.length > 0 ? null : (
        <div className="px-2">
          {query.isPending ? (
            <ListLine iconSlot status>
              <Trans>Loading Trash…</Trans>
            </ListLine>
          ) : (
            <ListLine iconSlot>
              <Trans>Nothing in the trash.</Trans>
            </ListLine>
          )}
        </div>
      )}
    </SourcePane>
  );
}

/** A deleted document: its age at the right, where it was under its name; its menu restores. */
function TrashRow({
  entry,
  now,
  active,
  state,
  onOpen,
  onRestore,
}: {
  entry: DocumentTrashEntry;
  now: number;
  active: boolean;
  state?: TrashRestoreState;
  onOpen: () => void;
  /** Restores these documents: this row, or the selection its menu acted on. */
  onRestore: (documentIds: readonly string[]) => void;
}) {
  const location = formerPlace(entry);
  const restoring = state?.kind === "restoring";
  const dragged = useMemo(() => trashDragEntry(entry), [entry]);
  const row = useEntryRow(dragged, { active, draggable: !restoring, source: "trash" });
  const menu = useEntryMenu(dragged, restoring ? [] : RESTORE, (_action, rows) =>
    onRestore(rows ? rows.map(({ ref }) => ref.id) : [entry.documentId]),
  );
  return (
    <div>
      <DocumentRow
        row={row}
        menu={menu}
        active={active}
        depth={0}
        icon={fileKindIcon(entry.name)}
        name={entry.name}
        meta={restoring ? <Trans>Restoring</Trans> : relativeTime(entry.removal.time, now)}
        detail={
          <span
            className={cn("block truncate leading-snug font-normal", role.rowSecondary)}
            title={location}
          >
            {location}
          </span>
        }
        onOpen={onOpen}
      />
      {state?.kind === "failed" ? (
        <InlineErrorRow message={state.message} className="pt-0 pr-2 pb-1 pl-3.5" />
      ) : null}
    </div>
  );
}

const RESTORE = ["restore"] as const;
