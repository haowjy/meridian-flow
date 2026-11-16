import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { TrashEntry } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { Folder } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useDocumentTrash, useTrashDiscards } from "@/client/query/useDocumentTrash";
import { useProjectTrees } from "@/client/query/useProjectTrees";
import { useWorks } from "@/client/query/useWorks";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { withGone } from "@/components/app/RowWord";
import { ListLine, ListRow } from "@/components/ui/list-row";
import { workOwnerKey } from "@/features/draft-review/draft-owner-key";
import { discardDrafts } from "@/features/draft-review/useWorkBranchCommands";
import { useMinuteClock } from "@/hooks/use-minute-clock";
import { useDraftCommandOwner } from "../../context/account-feature-context";
import { useEntryMenu } from "../../context/ContextEntryActions";
import { fileKindIcon } from "../../context/context-file-icon";
import { documentPlace } from "../../context/context-schemes";
import { useDocumentTrashRestore } from "../../context/DocumentTrashRestoreProvider";
import { trashDragEntry, trashRef } from "../../context/entry-drag/entry";
import { useEntryRow } from "../../context/entry-drag/use-entry-row";
import { useRestoreDiscard } from "../../context/use-restore-discard";
import {
  type NoticePlace,
  type TreeNoticeWords,
  useTreeNoticeWords,
} from "../../context/use-tree-notice-words";
import { relativeTime } from "../../relative-time";
import { useTrashNavigation } from "../../routing/ProjectNavigationContext";
import { type SourceDrop, SourcePane } from "./SourcePane";
import { type DiscardEntry, TrashDiscardRow } from "./TrashDiscardRow";

/**
 * Trash as a source: its entries, newest first, a deleted folder as one entry with what its
 * delete took, and each Discard as one entry with the drafts it took. Rows dropped on it are deleted at once; its rows drag out to be restored where
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
  const { restored, restore } = useDocumentTrashRestore();
  const trash = useTrashNavigation();
  const now = useMinuteClock();
  const listed = query.data?.entries;
  const place = useMemo<NoticePlace>(() => {
    const held = new Set([...(listed ?? []).map(trashKey), ...restored.map(({ key }) => key)]);
    return { holds: (node) => held.has(node), parent: () => null, open: () => true };
  }, [listed, restored]);
  const notices = useTreeNoticeWords(projectId, place);
  const entries = listed ?? [];
  // An entry just restored stays, struck through, with its Undo, until the notice ends.
  const rows = withGone(
    entries,
    trashKey,
    restored.filter(({ key }) => notices.restored(key)),
  );
  const discards = useTrashDiscardRows(projectId);
  const lines = [
    ...rows.map(({ row, gone }) => ({ at: row.removal.time, entry: row, gone, discard: null })),
    ...discards.rows.map((discard) => ({
      at: discard.entry.at,
      entry: null,
      gone: false,
      discard,
    })),
  ].sort((left, right) => right.at.localeCompare(left.at));
  return (
    <SourcePane label={t`Trash`} drop={drop} notice={notices.header}>
      {lines.length > 0 ? (
        <div className="px-2">
          {lines.map(({ entry, gone, discard }) =>
            discard ? (
              <TrashDiscardRow
                key={discard.entry.commandId}
                entry={discard.entry}
                names={discard.names}
                workName={discard.workName}
                now={now}
                state={discards.states.get(discard.entry.commandId)}
                onRestore={() => {
                  notices.end();
                  discards.restore(discard.entry);
                }}
                onUndo={discards.undoOf(discard.entry)}
                undo={discards.undoing.get(discard.entry.commandId)}
              />
            ) : !entry ? null : gone ? (
              <ListRow
                key={entry.nodeId}
                gone
                detail={deletedFrom(entry, documentPlace(entry.scheme, entry.formerPath))}
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
      {query.isError || discards.isError ? (
        <InlineErrorRow
          message={t`Couldn't load Trash.`}
          onRetry={() => {
            void query.refetch();
            void discards.refetch();
          }}
        />
      ) : lines.length > 0 ? null : (
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
  /** Restores these entries by node id: this row, or the selection its menu acted on. */
  onRestore: (nodeIds: readonly string[]) => void;
}) {
  const location = documentPlace(entry.scheme, entry.formerPath);
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
      meta={relativeTime(entry.removal.time, now)}
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

/** Where it was deleted from; a folder leads with what went with it, which a narrow row keeps. */
function deletedFrom(entry: TrashEntry, location: string): string {
  if (entry.documents === 0) return t`Deleted from ${location}`;
  return plural(entry.documents, {
    one: `# document, deleted from ${location}`,
    other: `# documents, deleted from ${location}`,
  });
}

/**
 * Trash's Discard entries with what names them: each document by its name in the tree, a
 * created one by the name its creation had, and the Work they were taken from. An entry restored
 * here stays, struck through, until the next restore or the pane closes.
 */
function useTrashDiscardRows(projectId: string) {
  const query = useTrashDiscards(projectId);
  const trees = useProjectTrees(projectId);
  const { works, deleted, nameOf } = useWorks(projectId);
  const { states, restore } = useRestoreDiscard(projectId);
  const queryClient = useQueryClient();
  const owner = useDraftCommandOwner();
  const restored = useRef(
    new Map<string, { entry: DiscardEntry; listedThen: ReadonlySet<string> }>(),
  );
  const [undoing, setUndoing] = useState<ReadonlyMap<string, "sending" | "failed">>(new Map());
  const mark = (commandId: string, state: "sending" | "failed" | null) =>
    setUndoing((current) => {
      const next = new Map(current);
      if (state) next.set(commandId, state);
      else next.delete(commandId);
      return next;
    });
  const listed = query.data?.entries ?? [];
  for (const entry of listed)
    if (states.get(entry.commandId)?.kind === "restored" && !restored.current.has(entry.commandId))
      restored.current.set(entry.commandId, {
        entry,
        listedThen: new Set(listed.map(({ commandId }) => commandId)),
      });
  // A new Discard of a restored draft is the next thing done to it: the restore's Undo ends.
  for (const [commandId, { entry: held, listedThen }] of restored.current) {
    const took = new Set(documentsOf(held));
    if (
      listed.some(
        (entry) =>
          !listedThen.has(entry.commandId) &&
          documentsOf(entry).some((document) => took.has(document)),
      )
    )
      restored.current.delete(commandId);
  }
  const entries = [
    ...listed,
    ...[...restored.current.values()]
      .map(({ entry }) => entry)
      .filter((held) => !listed.some((entry) => entry.commandId === held.commandId)),
  ];
  const rows = entries.map((entry) => {
    const created = new Map(entry.tree.created.map((node) => [node.node, node.name]));
    const names = documentsOf(entry).map(
      (documentId) =>
        created.get(documentId) ?? trees.find(documentId)?.file.name ?? t`Untitled document`,
    );
    const work = [...(works ?? []), ...deleted].find(({ id }) => id === entry.workId);
    return { entry, names, workName: work ? nameOf(work) : null };
  });
  return {
    rows,
    states,
    isError: query.isError,
    refetch: query.refetch,
    undoing,
    /** The Undo of a restore made here: the drafts go back to Trash as a new Discard entry. */
    undoOf: (entry: DiscardEntry) => {
      const state = states.get(entry.commandId);
      if (state?.kind !== "restored" || !state.branchId || !entry.workId) return undefined;
      const { branchId } = state;
      const ownerKey = workOwnerKey({ id: entry.workId });
      return () => {
        if (undoing.get(entry.commandId) === "sending") return;
        mark(entry.commandId, "sending");
        void discardDrafts(queryClient, owner, {
          projectId,
          ownerKey,
          branchId,
          documentIds: documentsOf(entry),
        }).then((outcome) => {
          if (outcome.kind !== "done") return mark(entry.commandId, "failed");
          // The restored row gives way to the new entry the refetch lists.
          restored.current.delete(entry.commandId);
          mark(entry.commandId, null);
        });
      };
    },
    restore: (entry: DiscardEntry) => {
      restored.current.clear();
      restore({
        commandId: entry.commandId,
        branchId: entry.branchId,
        documentIds: documentsOf(entry),
      });
    },
  };
}

/** What a Discard took: its drafts' documents and every node its tree half settled. */
const documentsOf = (entry: DiscardEntry) => [
  ...new Set([...entry.drafts.map((draft) => draft.documentId), ...entry.tree.nodes]),
];
