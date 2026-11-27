import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useAccountId } from "@/client/account/account-context";
import { type TrashEntry, useDocumentTrash } from "@/client/query/useDocumentTrash";
import { useTreeList } from "@/client/query/useProjectTree";
import type { GoneRow } from "@/components/app/RowWord";
import { endTreeNotice } from "@/core/project-tree/tree-undo";
import type { TreeDestination } from "@/core/project-tree/tree-view";
import type { EntryRef } from "./entry-drag/entry";
import { useEntryActions } from "./entry-drag/entry-actions";
import { leaveSelections } from "./entry-drag/selection";

export type Restorable = { ref: EntryRef; name: string };

export type TrashRestoreState = { kind: "restored" };

type RestoreContextValue = {
  states: ReadonlyMap<string, TrashRestoreState>;
  restored: readonly GoneRow<TrashEntry>[];
  restore: (entries: readonly Restorable[]) => void;
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
  const listed = useDocumentTrash(projectId).data?.entries ?? [];
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

  useEffect(() => {
    const sessions = [projectList.session, accountList.session];
    return () => {
      for (const session of sessions) if (session) endTreeNotice(session);
    };
  }, [projectList.session, accountList.session]);

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
