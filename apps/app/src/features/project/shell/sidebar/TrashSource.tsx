import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Folder } from "lucide-react";
import { useMemo } from "react";
import { type TrashEntry, useDocumentTrash } from "@/client/query/useDocumentTrash";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { withGone } from "@/components/app/RowWord";
import { ListLine, ListRow } from "@/components/ui/list-row";
import { useClock } from "@/hooks/use-clock";
import { useEntryMenu } from "../../context/ContextEntryActions";
import { fileKindIcon } from "../../context/context-file-icon";
import { schemeLocation } from "../../context/context-schemes";
import { useDocumentTrashRestore } from "../../context/DocumentTrashRestoreProvider";
import { trashDragEntry, trashRef } from "../../context/entry-drag/entry";
import { useEntryRow } from "../../context/entry-drag/use-entry-row";
import {
  type NoticePlace,
  type TreeNoticeWords,
  useTreeNoticeWords,
} from "../../context/use-tree-notice-words";
import { relativeTime } from "../../relative-time";
import { useTrashNavigation } from "../../routing/ProjectNavigationContext";
import { type SourceDrop, SourcePane } from "./SourcePane";

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
  const { restored, restore } = useDocumentTrashRestore();
  const trash = useTrashNavigation();
  const now = useClock(60_000);
  const listed = query.data?.entries;
  const place = useMemo<NoticePlace>(() => {
    const held = new Set([...(listed ?? []).map(trashKey), ...restored.map(({ key }) => key)]);
    return { holds: (node) => held.has(node), parent: () => null, open: () => true };
  }, [listed, restored]);
  const notices = useTreeNoticeWords(projectId, place);
  const entries = listed ?? [];
  const rows = withGone(
    entries,
    trashKey,
    restored.filter(({ key }) => notices.restored(key)),
  );
  return (
    <SourcePane label={t`Trash`} drop={drop} notice={notices.header}>
      {rows.length > 0 ? (
        <div className="px-2">
          {rows.map(({ row: entry, gone }) =>
            gone ? (
              <ListRow
                key={entry.nodeId}
                gone
                detail={deletedFrom(entry, schemeLocation(entry.scheme, entry.folders))}
                icon={entry.kind === "folder" ? Folder : fileKindIcon(entry.name)}
                title={entry.name}
                notice={notices.word(entry.nodeId, true)}
              />
            ) : (
              <TrashRow
                key={entry.nodeId}
                entry={entry}
                now={now}
                active={entry.nodeId === trash.shown}
                notices={notices}
                onOpen={() => {
                  notices.end();
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

const trashKey = (entry: TrashEntry) => entry.nodeId;

function TrashRow({
  entry,
  now,
  active,
  notices,
  onOpen,
  onRestore,
}: {
  entry: TrashEntry;
  now: number;
  active: boolean;
  notices: TreeNoticeWords;
  onOpen: () => void;
  onRestore: (nodeIds: readonly string[]) => void;
}) {
  const location = schemeLocation(entry.scheme, entry.folders);
  const dragged = useMemo(() => trashDragEntry(entry), [entry]);
  const row = useEntryRow(dragged, { active, draggable: true, source: "trash" });
  const menu = useEntryMenu(
    dragged,
    RESTORE,
    (_action, rows) => onRestore(rows ? rows.map(({ ref }) => ref.id) : [entry.nodeId]),
    entry.scheme === "user" ? "account" : "project",
  );
  return (
    <ListRow
      icon={entry.kind === "folder" ? Folder : fileKindIcon(entry.name)}
      title={entry.name}
      meta={entry.kept ? relativeTime(entry.kept.removal.time, now) : undefined}
      detail={<span title={location}>{deletedFrom(entry, location)}</span>}
      onOpen={onOpen}
      current={active && "page"}
      selected={row.selected}
      controlProps={row.rowProps}
      menu={menu}
      revealActions
      notice={notices.word(entry.nodeId)}
    />
  );
}

const RESTORE = ["restore"] as const;

function deletedFrom(entry: TrashEntry, location: string): string {
  if (entry.documents === 0) return t`Deleted from ${location}`;
  return plural(entry.documents, {
    one: `# document, deleted from ${location}`,
    other: `# documents, deleted from ${location}`,
  });
}
