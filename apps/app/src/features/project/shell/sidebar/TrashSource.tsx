import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { TrashEntry } from "@meridian/contracts/protocol";
import { Folder } from "lucide-react";
import { useMemo } from "react";
import { useDocumentTrash } from "@/client/query/useDocumentTrash";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { GoneTitle, RowWord, useHeldRows } from "@/components/app/RowWord";
import { ListLine, ListRow } from "@/components/ui/list-row";
import { useMinuteClock } from "@/hooks/use-minute-clock";
import { useEntryMenu } from "../../context/ContextEntryActions";
import { fileKindIcon } from "../../context/context-file-icon";
import { documentPlace } from "../../context/context-schemes";
import {
  type TrashRestoreState,
  useDocumentTrashRestore,
} from "../../context/DocumentTrashRestoreProvider";
import { trashDragEntry, trashRef } from "../../context/entry-drag/entry";
import { useEntryRow } from "../../context/entry-drag/use-entry-row";
import { type TreeNoticeWords, useTreeNoticeWords } from "../../context/use-tree-notice-words";
import { relativeTime } from "../../relative-time";
import { useTrashNavigation } from "../../routing/ProjectNavigationContext";
import { type SourceDrop, SourcePane } from "./SourcePane";

/**
 * Trash as a source: its entries, newest first, a deleted folder as one entry with what its
 * delete took. Rows dropped on it are deleted at once; its rows drag out to be restored where
 * they land. Picking a document or an uploaded file shows it in main, read-only with Restore.
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
  const entries = query.data?.entries ?? [];
  const notices = useTreeNoticeWords(projectId);
  // An entry just restored stays, struck through, with its Undo, until the notice ends.
  const rows = useHeldRows(`trash:${projectId}`, entries, trashKey, (id) =>
    notices.held(id, "restore"),
  );
  return (
    <SourcePane label={t`Trash`} drop={drop}>
      {rows.length > 0 ? (
        <div className="px-2">
          {rows.map(({ row: entry, gone }) =>
            gone ? (
              <RestoredRow key={entry.nodeId} entry={entry} notices={notices} />
            ) : (
              <TrashRow
                key={entry.nodeId}
                entry={entry}
                now={now}
                active={entry.nodeId === trash.shown}
                state={states.get(entry.nodeId)}
                notices={notices}
                onOpen={() => {
                  notices.end();
                  // A folder has no page of its own yet: its menu and a drag restore it.
                  if (entry.kind === "folder") return;
                  void trash.open(entry.nodeId);
                  onPicked?.();
                }}
                onRestore={(ids) =>
                  restore(
                    entries
                      .filter(({ nodeId }) => ids.includes(nodeId))
                      .map((each) => ({ ref: trashRef(each), name: each.name })),
                  )
                }
              />
            ),
          )}
        </div>
      ) : null}
      {query.isError ? (
        <InlineErrorRow message={t`Couldn't load Trash.`} onRetry={() => void query.refetch()} />
      ) : rows.length > 0 ? null : (
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

/** A Trash entry: its age at the right, where it was deleted from under its name; its menu restores. */
const trashKey = (entry: TrashEntry) => entry.nodeId;

/** An entry restored just now: struck through in Trash, with the restore's Undo. */
function RestoredRow({ entry, notices }: { entry: TrashEntry; notices: TreeNoticeWords }) {
  const location = documentPlace(entry.scheme, entry.formerPath);
  return (
    <ListRow
      disabled
      detail={deletedFrom(entry, location)}
      onOpen={() => {}}
      icon={entry.kind === "folder" ? Folder : fileKindIcon(entry.name)}
      title={<GoneTitle>{entry.name}</GoneTitle>}
      notice={notices.word(entry.nodeId)}
    />
  );
}

function TrashRow({
  entry,
  now,
  active,
  state,
  notices,
  onOpen,
  onRestore,
}: {
  entry: TrashEntry;
  now: number;
  active: boolean;
  state?: TrashRestoreState;
  notices: TreeNoticeWords;
  onOpen: () => void;
  /** Restores these entries by node id: this row, or the selection its menu acted on. */
  onRestore: (nodeIds: readonly string[]) => void;
}) {
  const location = documentPlace(entry.scheme, entry.formerPath);
  const dragged = useMemo(() => trashDragEntry(entry), [entry]);
  const row = useEntryRow(dragged, { active, draggable: true, source: "trash" });
  const menu = useEntryMenu(dragged, RESTORE, (_action, rows) =>
    onRestore(rows ? rows.map(({ ref }) => ref.id) : [entry.nodeId]),
  );
  return (
    <ListRow
      icon={entry.kind === "folder" ? Folder : fileKindIcon(entry.name)}
      title={entry.name}
      meta={relativeTime(entry.removal.time, now)}
      detail={<span title={location}>{deletedFrom(entry, location)}</span>}
      onOpen={onOpen}
      current={active && "page"}
      selected={row.selected}
      controlProps={row.rowProps}
      menu={menu}
      revealActions
      notice={
        state?.kind === "failed" ? (
          <RowWord tone="warning" word={<Trans>Not restored</Trans>} sentence={state.message} />
        ) : (
          notices.word(entry.nodeId)
        )
      }
    />
  );
}

const RESTORE = ["restore"] as const;

/** Where it was deleted from; a folder leads with what went with it, which a narrow row keeps. */
function deletedFrom(entry: TrashEntry, location: string): string {
  if (entry.documents === 0) return t`Deleted from ${location}`;
  return plural(entry.documents, {
    one: `# document, deleted from ${location}`,
    other: `# documents, deleted from ${location}`,
  });
}
