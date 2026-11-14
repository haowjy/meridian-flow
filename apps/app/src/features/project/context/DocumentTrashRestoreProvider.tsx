/** One project-lifetime owner for Trash restore progress and outcomes, by node id. */
import { t } from "@lingui/core/macro";
import { lastSettlements } from "@meridian/project-tree";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTreeList } from "@/client/query/useProjectTree";
import type { TreeDestination } from "@/core/project-tree/tree-view";
import { useAccountId } from "./account-feature-context";
import type { EntryRef } from "./entry-drag/entry";
import { useEntryActions } from "./entry-drag/entry-actions";
import { leaveSelections } from "./entry-drag/selection";

/** What a restore needs of a Trash entry: the record names the node, the notices its name. */
export type Restorable = { ref: EntryRef; name: string };

export type TrashRestoreState = { kind: "restored" } | { kind: "failed"; message: string };

/** `restored`: the node is back in the tree, so a view of it in Trash follows it there. */
type RestoreContextValue = {
  states: ReadonlyMap<string, TrashRestoreState>;
  /** Restores entries to where they were: a `restore` record each; each shows its own outcome. */
  restore: (entries: readonly Restorable[]) => void;
  /**
   * Restores entries into a destination (a drag out of Trash). They leave the Trash list and
   * appear in the destination at once; one the server refuses goes back to Trash with its reason
   * in `states`. Either way the rows it touched offer its Undo (`tree-undo.ts`).
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
  const [states, setStates] = useState<ReadonlyMap<string, TrashRestoreState>>(() => new Map());
  // A restore the list has taken and the server has not answered, by its record's id.
  const awaiting = useRef(new Map<string, Restorable>());

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

  const fail = useCallback(
    (entry: Restorable, reason?: string) => {
      setState(entry.ref.id, {
        kind: "failed",
        message: reason
          ? t`Couldn't restore ${entry.name}. ${reason}`
          : t`Couldn't restore ${entry.name}. Try again.`,
      });
    },
    [setState],
  );

  // A refusal comes back as a settlement on the `restore` record; until then the entry is restored.
  useEffect(() => {
    const check = () => {
      for (const session of [projectList.session, accountList.session]) {
        if (!session) continue;
        const settled = lastSettlements(session.getSnapshot().doc);
        for (const [record, entry] of awaiting.current) {
          const settlement = settled.get(record);
          if (!settlement) continue;
          awaiting.current.delete(record);
          if (settlement.to === "refused") fail(entry, settlement.reason);
        }
      }
    };
    const stops = [projectList.session, accountList.session].map((session) =>
      session?.subscribe(check),
    );
    return () => {
      for (const stop of stops) stop?.();
    };
  }, [projectList.session, accountList.session, fail]);

  /**
   * Appends the entries' `restore` records, one update per list, and on a drag their moves into
   * the destination; returns whether the lists took them.
   */
  const append = useCallback(
    (entries: readonly Restorable[], destination?: TreeDestination) => {
      const held = entries.map((entry) => ({ entry, ...actions.holding(entry.ref.id) }));
      for (const list of new Set(held.map((item) => item.list))) {
        const mine = held.filter((item) => item.list === list);
        const result = list.restore(
          mine.map(({ entry }) => entry.ref.id),
          destination,
        );
        if (!result.ok) return false;
        for (const { entry } of mine) {
          const made = result.records.find(
            (record) => record.type === "restore" && record.node === entry.ref.id,
          );
          if (made) awaiting.current.set(made.id, entry);
        }
      }
      return true;
    },
    [actions],
  );

  const restore = useCallback(
    (entries: readonly Restorable[], destination?: TreeDestination) => {
      if (entries.length === 0) return;
      leaveSelections(entries.map(({ ref }) => ref));
      if (!append(entries, destination)) {
        for (const entry of entries) fail(entry);
        return;
      }
      markRestored(entries.map(({ ref }) => ref.id));
    },
    [append, fail, markRestored],
  );

  const value = useMemo(
    () => ({
      states,
      restore: (entries: readonly Restorable[]) => restore(entries),
      restoreInto: restore,
    }),
    [states, restore],
  );
  return <RestoreContext.Provider value={value}>{children}</RestoreContext.Provider>;
}
export function useDocumentTrashRestore(): RestoreContextValue {
  const value = useContext(RestoreContext);
  if (!value) throw new Error("Document Trash restore requires its project provider");
  return value;
}
