/** One project-lifetime owner for Trash restore progress and outcomes, by node id. */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { type TrashEntry, useTrashRows } from "@/client/query/useDocumentTrash";
import { useTreeList } from "@/client/query/useProjectTree";
import type { GoneRow } from "@/components/app/RowWord";
import { endTreeNotice } from "@/core/project-tree/tree-undo";
import type { TreeDestination } from "@/core/project-tree/tree-view";
import { useAccountId } from "./account-feature-context";
import type { EntryRef } from "./entry-drag/entry";
import { useEntryActions } from "./entry-drag/entry-actions";
import { leaveSelections } from "./entry-drag/selection";

/** What a restore needs of a Trash entry: the record names the node, the notices its name. */
export type Restorable = { ref: EntryRef; name: string };

export type TrashRestoreState = { kind: "restored" };

/** `restored`: the node is back in the tree, so a view of it in Trash follows it there. */
type RestoreContextValue = {
  states: ReadonlyMap<string, TrashRestoreState>;
  /**
   * The Trash entries the latest restore took, as Trash listed them then: Trash keeps each one,
   * struck through, while the tree notice still offers that restore's Undo.
   */
  restored: readonly GoneRow<TrashEntry>[];
  /** Restores entries to where they were: a `restore` record each; each shows its own outcome. */
  restore: (entries: readonly Restorable[]) => void;
  /**
   * Restores entries into a destination (a drag out of Trash). They leave the Trash list and
   * appear in the destination at once, and the rows it touched offer its Undo (`tree-undo.ts`).
   */
  restoreInto: (entries: readonly Restorable[], destination: TreeDestination) => void;
};

const RESTORED_MARK_MS = 10_000;

const RestoreContext = createContext<RestoreContextValue | null>(null);

export function DocumentTrashRestoreProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const actions = useEntryActions(projectId);
  const accountId = useAccountId();
  const projectList = useTreeList({ kind: "project", projectId });
  const accountList = useTreeList({ kind: "account", userId: accountId });
  const listed = useTrashRows(projectId) ?? [];
  const [states, setStates] = useState<ReadonlyMap<string, TrashRestoreState>>(() => new Map());
  const [restored, setRestored] = useState<readonly GoneRow<TrashEntry>[]>([]);

  const setState = useCallback((node: string, state: TrashRestoreState | null) => {
    setStates((current) => {
      const next = new Map(current);
      if (state) next.set(node, state);
      else next.delete(node);
      return next;
    });
  }, []);

  /** The view of a restored document in Trash follows it out; the mark ends once it has had time to. */
  const markRestored = useCallback(
    (ids: readonly string[]) => {
      for (const id of ids) {
        setState(id, { kind: "restored" });
        window.setTimeout(
          () =>
            setStates((current) => {
              if (current.get(id)?.kind !== "restored") return current;
              const next = new Map(current);
              next.delete(id);
              return next;
            }),
          RESTORED_MARK_MS,
        );
      }
    },
    [setState],
  );

  // Leaving the project is leaving every place its lists' notices speak in.
  useEffect(() => {
    const sessions = [projectList.session, accountList.session];
    return () => {
      for (const session of sessions) if (session) endTreeNotice(session);
    };
  }, [projectList.session, accountList.session]);

  /** Appends the entries' `restore` records, one update per list, and on a drag their moves into the destination. */
  const append = useCallback(
    (entries: readonly Restorable[], destination?: TreeDestination) => {
      const held = entries.map((entry) => ({ entry, ...actions.holding(entry.ref.id) }));
      for (const list of new Set(held.map((item) => item.list))) {
        const mine = held.filter((item) => item.list === list);
        list.restore(
          mine.map(({ entry }) => entry.ref.id),
          destination,
        );
      }
    },
    [actions],
  );

  const restore = useCallback(
    (entries: readonly Restorable[], destination?: TreeDestination) => {
      if (entries.length === 0) return;
      leaveSelections(entries.map(({ ref }) => ref));
      const ids = new Set(entries.map(({ ref }) => ref.id));
      setRestored(
        listed.flatMap((entry, at) =>
          ids.has(entry.nodeId)
            ? [
                {
                  key: entry.nodeId,
                  row: entry,
                  after: listed
                    .slice(0, at)
                    .map((each) => each.nodeId)
                    .reverse(),
                },
              ]
            : [],
        ),
      );
      append(entries, destination);
      markRestored(entries.map(({ ref }) => ref.id));
    },
    [append, markRestored, listed],
  );

  const value = useMemo(
    () => ({
      states,
      restored,
      restore: (entries: readonly Restorable[]) => restore(entries),
      restoreInto: restore,
    }),
    [states, restored, restore],
  );
  return <RestoreContext.Provider value={value}>{children}</RestoreContext.Provider>;
}
export function useDocumentTrashRestore(): RestoreContextValue {
  const value = useContext(RestoreContext);
  if (!value) throw new Error("Document Trash restore requires its project provider");
  return value;
}
